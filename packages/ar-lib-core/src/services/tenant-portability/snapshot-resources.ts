import type { DatabaseAdapter } from '../../db/adapter';
import type { TenantBackupLease } from './operation-store';
import type { TenantBackupStepContext } from './operation-executor';
import {
  cleanupSqliteBackupSnapshotPage,
  tombstoneSqliteBackupSnapshot,
} from './sqlite-snapshot-cleanup';

type Database = Pick<DatabaseAdapter, 'queryOne' | 'execute'>;
interface SnapshotResource {
  resource_id: string;
  snapshot_id: string;
  cleaned: number;
}

/** Durable write-ahead ownership, retained after cancellation for retry and audit. */
export class TenantBackupSnapshotResources {
  constructor(
    private readonly database: Database,
    private readonly now: () => number
  ) {}

  private params(lease: Readonly<TenantBackupLease>): unknown[] {
    const timestamp = this.now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('backup_resource_clock');
    return [
      lease.tenantId,
      lease.operationId,
      lease.owner,
      lease.fencingToken,
      timestamp,
      timestamp,
    ];
  }

  private async assertCancellation(lease: Readonly<TenantBackupLease>): Promise<void> {
    const live = await this.database.queryOne(
      `SELECT id FROM tenant_backup_operations WHERE tenant_id=? AND id=? AND lease_owner=?
      AND fencing_token=? AND lease_expires_at>? AND updated_at<=? AND state='cancelling'`,
      this.params(lease)
    );
    if (!live) throw new Error('backup_resource_fenced');
  }

  private async assertRunning(lease: Readonly<TenantBackupLease>): Promise<void> {
    const live = await this.database.queryOne(
      `SELECT id FROM tenant_backup_operations WHERE tenant_id=? AND id=? AND lease_owner=?
      AND fencing_token=? AND lease_expires_at>? AND updated_at<=? AND state='running'`,
      this.params(lease)
    );
    if (!live) throw new Error('backup_resource_fenced');
  }

  async assertCaptureOwner(
    lease: Readonly<TenantBackupLease>,
    resourceId: string,
    snapshotId: string
  ): Promise<void> {
    const live = await this.database.queryOne(
      `SELECT r.snapshot_id FROM tenant_backup_snapshot_resources r
      JOIN tenant_backup_operations o ON o.id=r.operation_id AND o.tenant_id=r.tenant_id
      WHERE r.resource_id=? AND r.snapshot_id=? AND r.cleaned=0
      AND o.tenant_id=? AND o.id=? AND o.lease_owner=? AND o.fencing_token=?
      AND o.lease_expires_at>? AND o.updated_at<=? AND o.state='running'`,
      [resourceId, snapshotId, ...this.params(lease)]
    );
    if (!live) throw new Error('backup_resource_fenced');
  }

  /** Resolve the immutable snapshot identity recorded before the source write began. */
  async loadCapture(
    lease: Readonly<TenantBackupLease>,
    resourceId: string
  ): Promise<{ resourceId: string; snapshotId: string }> {
    if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(resourceId)) throw new Error('backup_resource_identity');
    const row = await this.database.queryOne<SnapshotResource>(
      `SELECT r.resource_id,r.snapshot_id,r.cleaned FROM tenant_backup_snapshot_resources r
      JOIN tenant_backup_operations o ON o.id=r.operation_id AND o.tenant_id=r.tenant_id
      WHERE r.resource_id=? AND r.cleaned=0 AND o.tenant_id=? AND o.id=? AND o.lease_owner=?
      AND o.fencing_token=? AND o.lease_expires_at>? AND o.updated_at<=? AND o.state='running'`,
      [resourceId, ...this.params(lease)]
    );
    if (!row) throw new Error('backup_resource_fenced');
    return { resourceId: row.resource_id, snapshotId: row.snapshot_id };
  }

  /** Resource ID is the authenticated physical DB ID, never a request-supplied binding name. */
  async reserve(
    lease: Readonly<TenantBackupLease>,
    resourceId: string,
    snapshotId: string
  ): Promise<void> {
    if (![resourceId, snapshotId].every((value) => /^[A-Za-z0-9_.:-]{1,256}$/.test(value)))
      throw new Error('backup_resource_identity');
    const row = await this.database.queryOne<SnapshotResource>(
      `INSERT INTO tenant_backup_snapshot_resources(operation_id,tenant_id,resource_id,snapshot_id)
      SELECT id,tenant_id,?,? FROM tenant_backup_operations WHERE tenant_id=? AND id=?
      AND lease_owner=? AND fencing_token=? AND lease_expires_at>? AND updated_at<=? AND state='running'
      ON CONFLICT(operation_id,resource_id) DO UPDATE SET cleaned=cleaned
      WHERE snapshot_id=excluded.snapshot_id AND cleaned=0
      RETURNING resource_id,snapshot_id,cleaned`,
      [resourceId, snapshotId, ...this.params(lease)]
    );
    if (!row) throw new Error('backup_resource_reservation_conflict');
  }

  /**
   * One resource and <=100 preimages per slice. Resolver must reopen the recorded physical DB,
   * not substitute the tenant's current routing destination after a topology change.
   * This returns SQL-resource completion only; other resource families need their own cleanup.
   */
  async cleanupCancellationPage(
    context: TenantBackupStepContext,
    resolve: (
      resourceId: string,
      signal: AbortSignal
    ) => Promise<{ resourceId: string; database: Database }>
  ): Promise<{ done: boolean }> {
    const { lease, signal } = context;
    signal.throwIfAborted();
    await this.assertCancellation(lease);
    const row = await this.database.queryOne<SnapshotResource>(
      `SELECT resource_id,snapshot_id,cleaned FROM tenant_backup_snapshot_resources
      WHERE tenant_id=? AND operation_id=? AND cleaned=0 ORDER BY resource_id LIMIT 1`,
      [lease.tenantId, lease.operationId]
    );
    if (!row) {
      await this.assertCancellation(lease);
      return { done: true };
    }
    const source = await resolve(row.resource_id, signal);
    signal.throwIfAborted();
    if (source.resourceId !== row.resource_id)
      throw new Error('backup_resource_destination_changed');
    await this.assertCancellation(lease);
    await tombstoneSqliteBackupSnapshot(source.database, row.snapshot_id, lease.tenantId);
    signal.throwIfAborted();
    await this.assertCancellation(lease);
    const result = await cleanupSqliteBackupSnapshotPage(
      source.database,
      row.snapshot_id,
      lease.tenantId,
      true
    );
    signal.throwIfAborted();
    await this.assertCancellation(lease);
    if (!result.complete) return { done: false };
    const marked = await this.database.queryOne(
      `UPDATE tenant_backup_snapshot_resources SET cleaned=1 WHERE resource_id=? AND snapshot_id=?
      AND tenant_id=? AND operation_id=? AND EXISTS (SELECT 1 FROM tenant_backup_operations o
      WHERE o.tenant_id=? AND o.id=? AND o.lease_owner=? AND o.fencing_token=?
      AND o.lease_expires_at>? AND o.updated_at<=? AND o.state='cancelling') RETURNING resource_id`,
      [row.resource_id, row.snapshot_id, lease.tenantId, lease.operationId, ...this.params(lease)]
    );
    if (!marked) throw new Error('backup_resource_fenced');
    // Recheck all receipts next slice, including an empty inventory. Never infer overall cleanup.
    return { done: false };
  }

  /** Release one SQL snapshot page after artifact verification and before publication. */
  async cleanupPublishedPage(
    context: TenantBackupStepContext,
    resolve: (
      resourceId: string,
      signal: AbortSignal
    ) => Promise<{ resourceId: string; database: Database }>
  ): Promise<{ done: boolean }> {
    const { lease, signal } = context;
    signal.throwIfAborted();
    await this.assertRunning(lease);
    const row = await this.database.queryOne<SnapshotResource>(
      `SELECT resource_id,snapshot_id,cleaned FROM tenant_backup_snapshot_resources
      WHERE tenant_id=? AND operation_id=? AND cleaned=0 ORDER BY resource_id LIMIT 1`,
      [lease.tenantId, lease.operationId]
    );
    if (!row) {
      await this.assertRunning(lease);
      return { done: true };
    }
    const source = await resolve(row.resource_id, signal);
    signal.throwIfAborted();
    if (source.resourceId !== row.resource_id)
      throw new Error('backup_resource_destination_changed');
    await this.assertRunning(lease);
    await tombstoneSqliteBackupSnapshot(source.database, row.snapshot_id, lease.tenantId);
    signal.throwIfAborted();
    await this.assertRunning(lease);
    const result = await cleanupSqliteBackupSnapshotPage(
      source.database,
      row.snapshot_id,
      lease.tenantId,
      true
    );
    signal.throwIfAborted();
    await this.assertRunning(lease);
    if (!result.complete) return { done: false };
    const marked = await this.database.queryOne(
      `UPDATE tenant_backup_snapshot_resources SET cleaned=1 WHERE resource_id=? AND snapshot_id=?
      AND tenant_id=? AND operation_id=? AND EXISTS (SELECT 1 FROM tenant_backup_operations o
      WHERE o.tenant_id=? AND o.id=? AND o.lease_owner=? AND o.fencing_token=?
      AND o.lease_expires_at>? AND o.updated_at<=? AND o.state='running') RETURNING resource_id`,
      [row.resource_id, row.snapshot_id, lease.tenantId, lease.operationId, ...this.params(lease)]
    );
    if (!marked) throw new Error('backup_resource_fenced');
    return { done: false };
  }

  /** Publication guard: every recorded SQL snapshot must have completed durable cleanup. */
  async assertReleased(lease: Readonly<TenantBackupLease>): Promise<void> {
    const timestamp = this.now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('backup_resource_clock');
    const state = await this.database.queryOne<{ active: number; dirty: number; total: number }>(
      `SELECT
        EXISTS (SELECT 1 FROM tenant_backup_operations WHERE tenant_id=? AND id=? AND lease_owner=?
          AND fencing_token=? AND lease_expires_at>? AND updated_at<=? AND state='running') AS active,
        EXISTS (SELECT 1 FROM tenant_backup_snapshot_resources
          WHERE tenant_id=? AND operation_id=? AND cleaned=0) AS dirty,
        (SELECT count(*) FROM tenant_backup_snapshot_resources
          WHERE tenant_id=? AND operation_id=?) AS total`,
      [
        lease.tenantId,
        lease.operationId,
        lease.owner,
        lease.fencingToken,
        timestamp,
        timestamp,
        lease.tenantId,
        lease.operationId,
        lease.tenantId,
        lease.operationId,
      ]
    );
    if (!state?.active || state.dirty || state.total < 1)
      throw new Error('backup_resource_not_released');
  }
}
