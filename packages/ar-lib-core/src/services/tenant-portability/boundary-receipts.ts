import { sqliteBoundaryClockParameter } from './sqlite-boundary-clock';
import type { DatabaseAdapter } from '../../db/adapter';
import type { TenantMutationBoundary } from './mutation-admission';

export interface BackupBoundaryIdentity {
  environmentId: string;
  tenantId: string;
  boundaryId: string;
  operationId: string;
  inventoryDigest: string;
}
export interface BackupBoundaryParticipant {
  resourceId: string;
  snapshotId: string;
}

/** Trusted coordinator only: the sealed inventory, not a public request, supplies participants. */
export class TenantBackupBoundaryReceipts {
  constructor(
    private readonly database: Pick<DatabaseAdapter, 'queryOne'>,
    private readonly databaseClock = false
  ) {}

  private identity(input: BackupBoundaryIdentity, now: number): string[] {
    const ids = [input.boundaryId, input.environmentId, input.tenantId, input.operationId];
    if (
      ids.some((id) => !/^[A-Za-z0-9_.:-]{1,256}$/.test(id)) ||
      !/^[a-f0-9]{64}$/.test(input.inventoryDigest) ||
      !Number.isSafeInteger(now) ||
      now < 0
    )
      throw new Error('backup_boundary_receipt_input');
    return [...ids, input.inventoryDigest];
  }

  private serializeParticipants(participants: readonly BackupBoundaryParticipant[]): string {
    if (
      participants.length < 1 ||
      participants.length > 64 ||
      new Set(participants.map((item) => item.resourceId)).size !== participants.length ||
      participants.some((item) =>
        [item.resourceId, item.snapshotId].some((id) => !/^[A-Za-z0-9_.:-]{1,256}$/.test(id))
      )
    )
      throw new Error('backup_boundary_participants_invalid');
    return JSON.stringify(
      participants
        .map(({ resourceId, snapshotId }) => ({ resourceId, snapshotId }))
        .sort((a, b) => (a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0))
    );
  }

  async assertHeld(input: BackupBoundaryIdentity, now: number): Promise<void> {
    const identity = this.identity(input, now);
    const held = await this.database.queryOne(
      `SELECT id FROM tenant_backup_mutation_boundaries WHERE id=? AND environment_id=?
       AND tenant_id=? AND operation_id=? AND inventory_digest=? AND state='held'
       AND created_at<=? AND deadline_at>${sqliteBoundaryClockParameter(this.databaseClock)}`,
      [...identity, now, now]
    );
    if (!held) throw new Error('backup_boundary_not_held');
  }

  /** Failure cleanup is restricted to the same pinned attempt, including operation and inventory. */
  async abort(input: BackupBoundaryIdentity, now: number): Promise<void> {
    const identity = this.identity(input, now);
    await this.database.queryOne(
      `UPDATE tenant_backup_mutation_boundaries SET state='aborted'
       WHERE id=? AND environment_id=? AND tenant_id=? AND operation_id=? AND inventory_digest=?
       AND state IN ('draining','held') AND created_at<=? RETURNING id`,
      [...identity, now]
    );
  }

  /** Read-only response recovery; never restart snapshots after a successful release. */
  async readReleased(
    input: BackupBoundaryIdentity,
    participants: readonly BackupBoundaryParticipant[],
    now: number
  ): Promise<TenantMutationBoundary | null> {
    const identity = this.identity(input, now);
    const serialized = this.serializeParticipants(participants);
    return this.database.queryOne<TenantMutationBoundary>(
      `SELECT b.* FROM tenant_backup_mutation_boundaries b
       JOIN tenant_backup_boundary_plans p ON p.boundary_id=b.id
       WHERE b.id=? AND b.environment_id=? AND b.tenant_id=? AND b.operation_id=? AND b.inventory_digest=?
       AND b.state='released' AND b.released_at<=${sqliteBoundaryClockParameter(this.databaseClock)} AND p.participants_json=?`,
      [...identity, now, serialized]
    );
  }

  /** Freeze the complete required list before holding the gate. Exact replay is harmless. */
  async plan(
    input: BackupBoundaryIdentity,
    participants: readonly BackupBoundaryParticipant[],
    now: number
  ): Promise<boolean> {
    const identity = this.identity(input, now);
    const serialized = this.serializeParticipants(participants);
    await this.database.queryOne(
      `INSERT INTO tenant_backup_boundary_plans(boundary_id,participants_json,participant_count)
       SELECT id,?,? FROM tenant_backup_mutation_boundaries
       WHERE id=? AND environment_id=? AND tenant_id=? AND operation_id=? AND inventory_digest=?
       AND state='draining' AND created_at<=? AND deadline_at>${sqliteBoundaryClockParameter(this.databaseClock)}
       AND NOT EXISTS (SELECT 1 FROM tenant_backup_boundary_plans WHERE boundary_id=?)
       RETURNING boundary_id`,
      [serialized, participants.length, ...identity, now, now, input.boundaryId]
    );
    return !!(await this.database.queryOne(
      `SELECT p.boundary_id FROM tenant_backup_boundary_plans p
       JOIN tenant_backup_mutation_boundaries b ON b.id=p.boundary_id
       WHERE b.id=? AND b.environment_id=? AND b.tenant_id=? AND b.operation_id=? AND b.inventory_digest=?
       AND b.state IN ('draining','held') AND b.created_at<=? AND b.deadline_at>${sqliteBoundaryClockParameter(this.databaseClock)}
       AND p.participants_json=?`,
      [...identity, now, now, serialized]
    ));
  }

  /** Call only after verifying the exact participant snapshot is active under this boundary. */
  async acknowledge(
    input: BackupBoundaryIdentity,
    participant: BackupBoundaryParticipant,
    now: number
  ): Promise<boolean> {
    const identity = this.identity(input, now);
    if (
      [participant.resourceId, participant.snapshotId].some(
        (id) => !/^[A-Za-z0-9_.:-]{1,256}$/.test(id)
      )
    )
      throw new Error('backup_boundary_participant_invalid');
    await this.database.queryOne(
      `INSERT INTO tenant_backup_boundary_receipts(boundary_id,resource_id,snapshot_id,acknowledged_at)
       SELECT b.id,?,?,${sqliteBoundaryClockParameter(this.databaseClock)} FROM tenant_backup_mutation_boundaries b
       JOIN tenant_backup_boundary_plans p ON p.boundary_id=b.id
       WHERE b.id=? AND b.environment_id=? AND b.tenant_id=? AND b.operation_id=? AND b.inventory_digest=?
       AND b.state='held' AND b.created_at<=? AND b.deadline_at>${sqliteBoundaryClockParameter(this.databaseClock)}
       AND EXISTS (SELECT 1 FROM json_each(p.participants_json)
         WHERE json_extract(value,'$.resourceId')=? AND json_extract(value,'$.snapshotId')=?)
       AND NOT EXISTS (SELECT 1 FROM tenant_backup_boundary_receipts WHERE boundary_id=b.id AND resource_id=?)
       RETURNING boundary_id`,
      [
        participant.resourceId,
        participant.snapshotId,
        now,
        ...identity,
        now,
        now,
        participant.resourceId,
        participant.snapshotId,
        participant.resourceId,
      ]
    );
    return !!(await this.database.queryOne(
      `SELECT r.boundary_id FROM tenant_backup_boundary_receipts r
       JOIN tenant_backup_mutation_boundaries b ON b.id=r.boundary_id
       WHERE b.id=? AND b.environment_id=? AND b.tenant_id=? AND b.operation_id=? AND b.inventory_digest=?
       AND b.state='held' AND b.created_at<=? AND b.deadline_at>${sqliteBoundaryClockParameter(this.databaseClock)}
       AND r.resource_id=? AND r.snapshot_id=? AND r.acknowledged_at<=${sqliteBoundaryClockParameter(this.databaseClock)}`,
      [...identity, now, now, participant.resourceId, participant.snapshotId, now]
    ));
  }

  /** Persist the complete verified participant set in one database round trip. */
  async acknowledgeAll(
    input: BackupBoundaryIdentity,
    participants: readonly BackupBoundaryParticipant[],
    now: number
  ): Promise<boolean> {
    const identity = this.identity(input, now);
    const serialized = this.serializeParticipants(participants);
    await this.database.queryOne(
      `INSERT INTO tenant_backup_boundary_receipts
       (boundary_id,resource_id,snapshot_id,acknowledged_at)
       SELECT b.id,json_extract(participant.value,'$.resourceId'),
         json_extract(participant.value,'$.snapshotId'),${sqliteBoundaryClockParameter(this.databaseClock)}
       FROM tenant_backup_mutation_boundaries b
       JOIN tenant_backup_boundary_plans p ON p.boundary_id=b.id,
       json_each(p.participants_json) participant
       WHERE b.id=? AND b.environment_id=? AND b.tenant_id=? AND b.operation_id=?
       AND b.inventory_digest=? AND b.state='held' AND b.created_at<=?
       AND b.deadline_at>${sqliteBoundaryClockParameter(this.databaseClock)}
       AND p.participants_json=?
       ON CONFLICT(boundary_id,resource_id) DO NOTHING
       RETURNING boundary_id`,
      [now, ...identity, now, now, serialized]
    );
    return !!(await this.database.queryOne(
      `SELECT p.boundary_id FROM tenant_backup_boundary_plans p
       JOIN tenant_backup_mutation_boundaries b ON b.id=p.boundary_id
       WHERE b.id=? AND b.environment_id=? AND b.tenant_id=? AND b.operation_id=?
       AND b.inventory_digest=? AND b.state='held' AND b.created_at<=?
       AND b.deadline_at>${sqliteBoundaryClockParameter(this.databaseClock)}
       AND p.participants_json=? AND p.participant_count=(
         SELECT count(*) FROM tenant_backup_boundary_receipts r WHERE r.boundary_id=p.boundary_id
       )`,
      [...identity, now, now, serialized]
    ));
  }

  /** Atomically release only with all receipts; replay reads the original immutable release. */
  async release(
    input: BackupBoundaryIdentity,
    now: number
  ): Promise<TenantMutationBoundary | null> {
    const identity = this.identity(input, now);
    await this.database.queryOne(
      `UPDATE tenant_backup_mutation_boundaries SET state='released',released_at=${sqliteBoundaryClockParameter(this.databaseClock)}
       WHERE id=? AND environment_id=? AND tenant_id=? AND operation_id=? AND inventory_digest=?
       AND state='held' AND created_at<=? AND deadline_at>${sqliteBoundaryClockParameter(this.databaseClock)}
       AND EXISTS (SELECT 1 FROM tenant_backup_boundary_plans p WHERE p.boundary_id=id
         AND p.participant_count=(SELECT count(*) FROM tenant_backup_boundary_receipts r WHERE r.boundary_id=p.boundary_id))
       AND NOT EXISTS (SELECT 1 FROM tenant_backup_boundary_receipts r WHERE r.boundary_id=id AND r.acknowledged_at>${sqliteBoundaryClockParameter(this.databaseClock)})
       RETURNING id`,
      [now, ...identity, now, now, now]
    );
    return this.database.queryOne<TenantMutationBoundary>(
      `SELECT * FROM tenant_backup_mutation_boundaries
       WHERE id=? AND environment_id=? AND tenant_id=? AND operation_id=? AND inventory_digest=?
       AND state='released' AND released_at<=${sqliteBoundaryClockParameter(this.databaseClock)}`,
      [...identity, now]
    );
  }
}
