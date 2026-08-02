import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import type { ControlTenantPlacementMigrationState } from '@authrim/ar-lib-core/control-plane';
import type { ControlService } from './service';
import {
  classifyTenantMigrationSchema,
  inspectTenantMigrationSchema,
  orderTenantMigrationTables,
  type TenantMigrationForeignKey,
  type TenantMigrationOwnershipRule,
  type TenantMigrationTableColumn,
  type TenantMigrationTableInventory,
} from './tenant-placement-migration-inventory';
import { buildTenantMigrationCapturePlan } from './tenant-placement-migration-capture';
import {
  applyTenantMigrationBackfillPage,
  applyTenantMigrationOutboxBatch,
  buildTenantMigrationPurgeQuery,
  readTenantMigrationBackfillPage,
  readTenantMigrationOutboxBatch,
  type TenantMigrationTransferExecutor,
} from './tenant-placement-migration-transfer';

const LEASE_SECONDS = 2 * 60;
const INSTALL_BATCH_SIZE = 20;
const INVENTORY_BATCH_SIZE = 40;
const PURGE_BATCH_SIZE = 100;
const EMPTY_CHECKSUM = '0'.repeat(64);

interface ActiveOperationRow {
  operation_id: string;
  environment_id: string;
  tenant_id: string;
  migration_state: ControlTenantPlacementMigrationState;
  source_policy_generation: number;
  target_policy_generation: number;
  owner_id: string | null;
  fencing_token: number;
  lease_expires_at: number | null;
}

interface MigrationShardRow {
  operation_id: string;
  environment_id: string;
  tenant_id: string;
  data_role: 'tenant_core/default' | 'tenant_core/users' | 'tenant_pii';
  residency_policy_id: string;
  residency_partition: string;
  source_shard_id: string;
  source_assignment_generation: number;
  target_shard_id: string | null;
  target_assignment_generation: number | null;
  shard_state: string;
  table_cursor_json: string;
  source_row_count: number | null;
  target_row_count: number | null;
  last_observed_source_sequence: number;
  last_applied_source_sequence: number;
  capture_fencing_token: number | null;
}

interface DatabaseRouteRow {
  source_database_id: string;
  target_database_id: string | null;
}

interface InventoryRow {
  table_name: string;
  ownership_json: string;
  disposition: 'migrate' | 'retain_target_local';
  primary_key_json: string;
  columns_json: string;
  foreign_keys_json: string;
}

interface VerificationCursor {
  phase: 'preliminary' | 'final';
  tableIndex: number;
  cursor: Record<string, unknown> | null;
  rowCount: number;
  checksum: string;
  baselineSequence: number;
}

interface OutboxStatus {
  maxSequence: number;
  pendingCount: number;
}

function primary(database: D1Database): D1DatabaseSession {
  if (typeof database.withSession !== 'function') throw new Error('d1_sessions_api_required');
  return database.withSession('first-primary');
}

function rowsEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, '0')).join('');
}

function parseJsonObject(value: string, code: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(code);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(code);
  return parsed as Record<string, unknown>;
}

function parseJsonArray<T>(value: string, code: string): T[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(code);
  }
  if (!Array.isArray(parsed)) throw new Error(code);
  return parsed as T[];
}

export class TenantPlacementMigrationReconciler {
  constructor(
    private readonly database: D1Database,
    private readonly control: ControlService,
    private readonly d1: TenantMigrationTransferExecutor,
    private readonly now: () => number
  ) {}

  async reconcile(limit = 5): Promise<number> {
    let processed = 0;
    for (; processed < limit; processed += 1) {
      const claimed = await this.claimNext();
      if (!claimed) break;
      try {
        await this.process(claimed);
      } catch (error) {
        await this.block(claimed, error);
      } finally {
        await this.release(claimed);
      }
    }
    return processed;
  }

  private async claimNext(): Promise<ActiveOperationRow | null> {
    const session = primary(this.database);
    const now = this.now();
    const candidate = await session
      .prepare(
        `SELECT operation_id, environment_id, tenant_id, migration_state,
                source_policy_generation, target_policy_generation,
                owner_id, fencing_token, lease_expires_at
           FROM control_tenant_placement_migrations
          WHERE migration_state NOT IN (
            'complete', 'canceled', 'blocked', 'source_quarantined'
          ) AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
          ORDER BY created_at, operation_id
          LIMIT 1`
      )
      .bind(now)
      .first<ActiveOperationRow>();
    if (!candidate) return null;
    const ownerId = `placement-reconciler:${crypto.randomUUID()}`;
    const fencingToken = Number(candidate.fencing_token) + 1;
    const result = await session
      .prepare(
        `UPDATE control_tenant_placement_migrations
            SET owner_id = ?, fencing_token = ?, lease_expires_at = ?, updated_at = ?
          WHERE operation_id = ? AND environment_id = ?
            AND fencing_token = ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`
      )
      .bind(
        ownerId,
        fencingToken,
        now + LEASE_SECONDS,
        now,
        candidate.operation_id,
        candidate.environment_id,
        candidate.fencing_token,
        now
      )
      .run();
    if (Number(result.meta?.changes ?? 0) !== 1) return null;
    return { ...candidate, owner_id: ownerId, fencing_token: fencingToken };
  }

  private async release(operation: ActiveOperationRow): Promise<void> {
    const session = primary(this.database);
    await session
      .prepare(
        `UPDATE control_tenant_placement_migrations
            SET owner_id = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE operation_id = ? AND environment_id = ? AND owner_id = ? AND fencing_token = ?`
      )
      .bind(
        this.now(),
        operation.operation_id,
        operation.environment_id,
        operation.owner_id,
        operation.fencing_token
      )
      .run();
  }

  private async block(operation: ActiveOperationRow, error: unknown): Promise<void> {
    const code =
      error instanceof Error && /^[a-z0-9_:-]{1,200}$/u.test(error.message)
        ? error.message
        : 'control_tenant_placement_migration_internal_error';
    const session = primary(this.database);
    await session
      .prepare(
        `UPDATE control_tenant_placement_migrations
            SET migration_state = 'blocked', last_error_code = ?, updated_at = ?
          WHERE operation_id = ? AND environment_id = ? AND owner_id = ? AND fencing_token = ?
            AND migration_state NOT IN ('complete', 'canceled', 'cutover_committed')`
      )
      .bind(
        code,
        this.now(),
        operation.operation_id,
        operation.environment_id,
        operation.owner_id,
        operation.fencing_token
      )
      .run();
  }

  private async process(operation: ActiveOperationRow): Promise<void> {
    switch (operation.migration_state) {
      case 'planning':
        await this.transition(operation, 'planning', 'targets_provisioning');
        return;
      case 'targets_provisioning':
        await this.reconcileTarget(operation);
        return;
      case 'inventory_verifying':
        await this.reconcileInventory(operation);
        return;
      case 'capture_installing':
        await this.reconcileCapture(operation);
        return;
      case 'backfilling':
        await this.reconcileBackfill(operation);
        return;
      case 'catching_up':
        await this.reconcileOutbox(operation);
        return;
      case 'verifying':
        await this.reconcileVerification(operation, 'preliminary');
        return;
      case 'write_fencing':
        await this.reconcileWriteFence(operation);
        return;
      case 'cutover_ready':
      case 'cutover_committed':
        return;
      case 'source_quarantined':
        return;
      case 'purge_pending':
        await this.reconcilePurge(operation);
        return;
      case 'complete':
      case 'canceled':
      case 'blocked':
        return;
    }
  }

  private async quarantinedPurgeShard(
    operation: ActiveOperationRow
  ): Promise<MigrationShardRow | null> {
    return primary(this.database)
      .prepare(
        `SELECT operation_id, environment_id, tenant_id, data_role, residency_policy_id,
                residency_partition, source_shard_id, source_assignment_generation,
                target_shard_id, target_assignment_generation, shard_state, table_cursor_json,
                source_row_count, target_row_count, last_observed_source_sequence,
                last_applied_source_sequence, capture_fencing_token
           FROM control_tenant_placement_migration_shards
          WHERE operation_id = ? AND shard_state = 'quarantined'
          ORDER BY CASE WHEN data_role = 'tenant_core/default' THEN 1 ELSE 0 END,
                   data_role, residency_partition, source_shard_id
          LIMIT 1`
      )
      .bind(operation.operation_id)
      .first<MigrationShardRow>();
  }

  private purgeTableIndex(shard: MigrationShardRow): number {
    const cursor = parseJsonObject(
      shard.table_cursor_json,
      'control_tenant_placement_purge_cursor_invalid'
    );
    if (!Number.isSafeInteger(cursor.purgeTableIndex) || Number(cursor.purgeTableIndex) < 0) {
      throw new Error('control_tenant_placement_purge_cursor_invalid');
    }
    return Number(cursor.purgeTableIndex);
  }

  private async reconcilePurge(operation: ActiveOperationRow): Promise<void> {
    const shard = await this.quarantinedPurgeShard(operation);
    if (!shard) {
      await this.completePurge(operation);
      return;
    }
    const [route, storedInventory] = await Promise.all([
      this.databaseRoutes(shard),
      this.loadInventory(shard),
    ]);
    const inventory = orderTenantMigrationTables(storedInventory).reverse();
    const tableIndex = this.purgeTableIndex(shard);
    if (tableIndex > inventory.length) {
      throw new Error('control_tenant_placement_purge_cursor_invalid');
    }

    if (tableIndex < inventory.length) {
      if (!Number.isSafeInteger(shard.capture_fencing_token) || shard.capture_fencing_token! < 1) {
        throw new Error('control_tenant_placement_purge_capture_invalid');
      }
      const tenantKey = await this.tenantKey(operation);
      const table = inventory[tableIndex];
      const capture = await buildTenantMigrationCapturePlan({
        operationId: operation.operation_id,
        tenantId: operation.tenant_id,
        tenantKey,
        sourceShardId: shard.source_shard_id,
        migrationGeneration: operation.target_policy_generation,
        fencingToken: shard.capture_fencing_token!,
        inventory: [table],
        now: this.now(),
      });
      const uninstalled = await this.d1.queryD1Batch(route.source_database_id, capture.uninstall);
      if (
        uninstalled.length !== capture.uninstall.length ||
        uninstalled.some((result) => result.success !== true)
      ) {
        throw new Error('control_tenant_placement_purge_trigger_cleanup_failed');
      }
      const query = buildTenantMigrationPurgeQuery({
        table,
        tenantId: operation.tenant_id,
        tenantKey,
        limit: PURGE_BATCH_SIZE,
      });
      const result = await this.d1.queryD1(route.source_database_id, query.sql, query.params);
      const changes = Number(result[0]?.meta?.changes ?? -1);
      if (
        result.length !== 1 ||
        result[0]?.success !== true ||
        !Number.isSafeInteger(changes) ||
        changes < 0 ||
        changes > PURGE_BATCH_SIZE
      ) {
        throw new Error('control_tenant_placement_source_purge_failed');
      }
      if (changes < PURGE_BATCH_SIZE) {
        await primary(this.database)
          .prepare(
            `UPDATE control_tenant_placement_migration_shards
                SET table_cursor_json = ?, updated_at = ?
              WHERE operation_id = ? AND source_shard_id = ? AND shard_state = 'quarantined'
                AND table_cursor_json = ?`
          )
          .bind(
            JSON.stringify({ purgeTableIndex: tableIndex + 1 }),
            this.now(),
            operation.operation_id,
            shard.source_shard_id,
            shard.table_cursor_json
          )
          .run();
      }
      return;
    }

    const outbox = await this.d1.queryD1(
      route.source_database_id,
      `DELETE FROM tenant_placement_migration_outbox
        WHERE source_sequence IN (
          SELECT source_sequence
            FROM tenant_placement_migration_outbox
           WHERE operation_id = ? AND tenant_id = ?
           ORDER BY source_sequence
           LIMIT ?
        )`,
      [operation.operation_id, operation.tenant_id, PURGE_BATCH_SIZE]
    );
    const outboxChanges = Number(outbox[0]?.meta?.changes ?? -1);
    if (
      outbox.length !== 1 ||
      outbox[0]?.success !== true ||
      !Number.isSafeInteger(outboxChanges) ||
      outboxChanges < 0 ||
      outboxChanges > PURGE_BATCH_SIZE
    ) {
      throw new Error('control_tenant_placement_source_outbox_purge_failed');
    }
    if (outboxChanges === PURGE_BATCH_SIZE) return;

    const now = this.now();
    const statements = [
      primary(this.database)
        .prepare(
          `UPDATE control_tenant_placement_migration_shards
              SET shard_state = 'purged', purged_at = ?, updated_at = ?
            WHERE operation_id = ? AND source_shard_id = ? AND shard_state = 'quarantined'`
        )
        .bind(now, now, operation.operation_id, shard.source_shard_id),
      primary(this.database)
        .prepare(
          `UPDATE control_tenant_shard_assignments
              SET assignment_state = 'retired', updated_at = ?
            WHERE environment_id = ? AND tenant_id = ? AND data_role = ?
              AND residency_policy_id = ? AND residency_partition = ?
              AND shard_id = ? AND assignment_generation = ?
              AND assignment_state = 'quarantined'`
        )
        .bind(
          now,
          operation.environment_id,
          operation.tenant_id,
          shard.data_role,
          shard.residency_policy_id,
          shard.residency_partition,
          shard.source_shard_id,
          shard.source_assignment_generation
        ),
    ];
    const results = await this.database.batch(statements);
    if (
      results.length !== statements.length ||
      results.some((result) => result.success !== true) ||
      results.some((result) => Number(result.meta?.changes ?? 0) !== 1)
    ) {
      throw new Error('control_tenant_placement_source_purge_checkpoint_failed');
    }
  }

  private async completePurge(operation: ActiveOperationRow): Promise<void> {
    const remaining = await primary(this.database)
      .prepare(
        `SELECT COUNT(*) AS count
           FROM control_tenant_placement_migration_shards
          WHERE operation_id = ? AND shard_state <> 'purged'`
      )
      .bind(operation.operation_id)
      .first<{ count: number }>();
    if (!remaining || Number(remaining.count) !== 0) {
      throw new Error('control_tenant_placement_source_purge_incomplete');
    }
    const now = this.now();
    const statements = [
      primary(this.database)
        .prepare(
          `UPDATE control_tenant_placement_migrations
              SET migration_state = 'complete', active_operation_key = NULL,
                  completed_at = ?, updated_at = ?
            WHERE operation_id = ? AND environment_id = ? AND migration_state = 'purge_pending'
              AND owner_id = ? AND fencing_token = ?`
        )
        .bind(
          now,
          now,
          operation.operation_id,
          operation.environment_id,
          operation.owner_id,
          operation.fencing_token
        ),
      primary(this.database)
        .prepare(
          `UPDATE control_operations
              SET status = 'succeeded', completed_at = COALESCE(completed_at, ?), updated_at = ?
            WHERE operation_id = ? AND environment_id = ? AND status = 'running'`
        )
        .bind(now, now, operation.operation_id, operation.environment_id),
      primary(this.database)
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type, actor_id,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           ) VALUES (?, ?, ?, 'tenant_placement_migration.source_purge_complete', 'system',
                     'control-worker', 'tenant_placement_migration', ?, 'succeeded', '{}', ?)`
        )
        .bind(
          `audit:${operation.operation_id}:source-purge-complete`,
          operation.environment_id,
          operation.operation_id,
          operation.operation_id,
          now
        ),
    ];
    const results = await this.database.batch(statements);
    if (
      results.length !== statements.length ||
      results.some((result) => result.success !== true) ||
      Number(results[0]?.meta?.changes ?? 0) !== 1
    ) {
      throw new Error('control_tenant_placement_source_purge_complete_failed');
    }
  }

  private async transition(
    operation: ActiveOperationRow,
    expected: ControlTenantPlacementMigrationState,
    next: ControlTenantPlacementMigrationState,
    extraSql = '',
    extraParams: unknown[] = []
  ): Promise<void> {
    const session = primary(this.database);
    const result = await session
      .prepare(
        `UPDATE control_tenant_placement_migrations
            SET migration_state = ?, updated_at = ? ${extraSql}
          WHERE operation_id = ? AND environment_id = ? AND migration_state = ?
            AND owner_id = ? AND fencing_token = ?`
      )
      .bind(
        next,
        this.now(),
        ...extraParams,
        operation.operation_id,
        operation.environment_id,
        expected,
        operation.owner_id,
        operation.fencing_token
      )
      .run();
    if (Number(result.meta?.changes ?? 0) !== 1) {
      throw new Error('control_tenant_placement_migration_lease_lost');
    }
  }

  private async shard(
    operation: ActiveOperationRow,
    state: string
  ): Promise<MigrationShardRow | null> {
    return primary(this.database)
      .prepare(
        `SELECT operation_id, environment_id, tenant_id, data_role, residency_policy_id,
                residency_partition, source_shard_id, source_assignment_generation,
                target_shard_id, target_assignment_generation, shard_state, table_cursor_json,
                source_row_count, target_row_count, last_observed_source_sequence,
                last_applied_source_sequence, capture_fencing_token
           FROM control_tenant_placement_migration_shards
          WHERE operation_id = ? AND shard_state = ?
          ORDER BY data_role, residency_partition, source_shard_id
          LIMIT 1`
      )
      .bind(operation.operation_id, state)
      .first<MigrationShardRow>();
  }

  private async reconcileTarget(operation: ActiveOperationRow): Promise<void> {
    const shard = await this.shard(operation, 'target_pending');
    if (!shard) {
      await this.transition(operation, 'targets_provisioning', 'inventory_verifying');
      return;
    }
    const request = await this.control.requestTenantShard(
      {
        environmentId: operation.environment_id,
        tenantId: operation.tenant_id,
        dataRole: shard.data_role,
        residencyPolicyId: shard.residency_policy_id,
        residencyPartition: shard.residency_partition,
        allocationScope: 'tenant_exclusive',
        ownerTenantId: operation.tenant_id,
        idempotencyKey: `placement-target:${operation.operation_id}:${shard.source_shard_id}`,
      },
      operation.environment_id
    );
    if (!request.operation || request.operation.status !== 'succeeded') {
      if (request.operation?.status === 'blocked') {
        throw new Error(
          request.operation.lastErrorCode ?? 'control_tenant_placement_target_blocked'
        );
      }
      return;
    }
    const session = primary(this.database);
    const generation = await session
      .prepare(
        `SELECT COALESCE(MAX(assignment_generation), 0) + 1 AS next_generation
           FROM control_tenant_shard_assignments
          WHERE environment_id = ? AND tenant_id = ? AND data_role = ?
            AND residency_partition = ?`
      )
      .bind(
        operation.environment_id,
        operation.tenant_id,
        shard.data_role,
        shard.residency_partition
      )
      .first<{ next_generation: number }>();
    if (!generation || !Number.isSafeInteger(generation.next_generation)) {
      throw new Error('control_tenant_placement_target_generation_invalid');
    }
    const now = this.now();
    const statements = [
      session
        .prepare(
          `INSERT OR IGNORE INTO control_tenant_shard_assignments (
             environment_id, tenant_id, data_role, residency_policy_id, residency_partition,
             shard_id, assignment_generation, assignment_state, source_operation_id,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
        )
        .bind(
          operation.environment_id,
          operation.tenant_id,
          shard.data_role,
          shard.residency_policy_id,
          shard.residency_partition,
          request.plan.shardId,
          generation.next_generation,
          operation.operation_id,
          now,
          now
        ),
      session
        .prepare(
          `UPDATE control_tenant_placement_migration_shards
              SET target_shard_id = ?, target_assignment_generation = ?,
                  shard_state = 'inventory_pending', updated_at = ?
            WHERE operation_id = ? AND source_shard_id = ? AND shard_state = 'target_pending'
              AND EXISTS (
                SELECT 1 FROM control_tenant_placement_migrations migration
                 WHERE migration.operation_id = control_tenant_placement_migration_shards.operation_id
                   AND migration.owner_id = ? AND migration.fencing_token = ?
              )`
        )
        .bind(
          request.plan.shardId,
          generation.next_generation,
          now,
          operation.operation_id,
          shard.source_shard_id,
          operation.owner_id,
          operation.fencing_token
        ),
    ];
    const results = await this.database.batch(statements);
    if (results.some((result) => result.success !== true)) {
      throw new Error('control_tenant_placement_target_assignment_failed');
    }
  }

  private async databaseRoutes(shard: MigrationShardRow): Promise<DatabaseRouteRow> {
    const row = await primary(this.database)
      .prepare(
        `SELECT source_observed.provider_resource_id AS source_database_id,
                target_observed.provider_resource_id AS target_database_id
           FROM control_tenant_shards source_shard
           JOIN control_desired_resources source_desired
             ON source_desired.environment_id = source_shard.environment_id
            AND source_desired.desired_resource_id = source_shard.d1_desired_resource_id
           JOIN control_observed_resources source_observed
             ON source_observed.environment_id = source_desired.environment_id
            AND source_observed.desired_resource_id = source_desired.desired_resource_id
            AND source_observed.resource_kind = 'd1' AND source_observed.observed_state = 'present'
           LEFT JOIN control_tenant_shards target_shard
             ON target_shard.environment_id = source_shard.environment_id
            AND target_shard.shard_id = ?
           LEFT JOIN control_desired_resources target_desired
             ON target_desired.environment_id = target_shard.environment_id
            AND target_desired.desired_resource_id = target_shard.d1_desired_resource_id
           LEFT JOIN control_observed_resources target_observed
             ON target_observed.environment_id = target_desired.environment_id
            AND target_observed.desired_resource_id = target_desired.desired_resource_id
            AND target_observed.resource_kind = 'd1' AND target_observed.observed_state = 'present'
          WHERE source_shard.environment_id = ? AND source_shard.shard_id = ?`
      )
      .bind(shard.target_shard_id, shard.environment_id, shard.source_shard_id)
      .first<DatabaseRouteRow>();
    if (!row?.source_database_id || (shard.target_shard_id && !row.target_database_id)) {
      throw new Error('control_tenant_placement_database_route_unavailable');
    }
    return row;
  }

  private async reconcileInventory(operation: ActiveOperationRow): Promise<void> {
    const shard = await this.shard(operation, 'inventory_pending');
    if (!shard) {
      const inventoryRows = await primary(this.database)
        .prepare(
          `SELECT source_shard_id, table_name, columns_digest
             FROM control_tenant_placement_migration_inventory
            WHERE operation_id = ? ORDER BY source_shard_id, table_name`
        )
        .bind(operation.operation_id)
        .all<Record<string, unknown>>();
      const digest = await sha256(inventoryRows.results);
      await this.transition(
        operation,
        'inventory_verifying',
        'capture_installing',
        ', inventory_digest = ?, inventory_verified_at = ?',
        [digest, this.now()]
      );
      return;
    }
    const route = await this.databaseRoutes(shard);
    const [sourceSchema, targetSchema] = await Promise.all([
      inspectTenantMigrationSchema(this.d1, route.source_database_id),
      inspectTenantMigrationSchema(this.d1, route.target_database_id!),
    ]);
    if (!rowsEqual(sourceSchema, targetSchema)) {
      throw new Error('control_tenant_placement_schema_mismatch');
    }
    const inventory = classifyTenantMigrationSchema(shard.data_role, sourceSchema);
    if (inventory.state !== 'ready') {
      throw new Error(inventory.blockedReasons[0] ?? 'control_tenant_placement_inventory_blocked');
    }
    const now = this.now();
    const inserts = [];
    for (const table of inventory.tables) {
      inserts.push(
        primary(this.database)
          .prepare(
            `INSERT OR IGNORE INTO control_tenant_placement_migration_inventory (
               operation_id, source_shard_id, table_name, ownership_kind, disposition,
               primary_key_json, columns_json, foreign_keys_json, ownership_json,
               columns_digest, inventory_state, observed_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?)`
          )
          .bind(
            operation.operation_id,
            shard.source_shard_id,
            table.table,
            table.ownership.kind,
            table.disposition,
            JSON.stringify(table.primaryKey),
            JSON.stringify(table.columns),
            JSON.stringify(table.foreignKeys ?? []),
            JSON.stringify(table.ownership),
            await sha256({ columns: table.columns, foreignKeys: table.foreignKeys ?? [] }),
            now
          )
      );
    }
    for (let offset = 0; offset < inserts.length; offset += INVENTORY_BATCH_SIZE) {
      const results = await this.database.batch(
        inserts.slice(offset, offset + INVENTORY_BATCH_SIZE)
      );
      if (results.some((result) => result.success !== true)) {
        throw new Error('control_tenant_placement_inventory_persist_failed');
      }
    }
    const count = await primary(this.database)
      .prepare(
        `SELECT COUNT(*) AS count
           FROM control_tenant_placement_migration_inventory
          WHERE operation_id = ? AND source_shard_id = ? AND inventory_state = 'verified'`
      )
      .bind(operation.operation_id, shard.source_shard_id)
      .first<{ count: number }>();
    if (Number(count?.count) !== inventory.tables.length) {
      throw new Error('control_tenant_placement_inventory_persist_failed');
    }
    await primary(this.database)
      .prepare(
        `UPDATE control_tenant_placement_migration_shards
            SET inventory_table_count = ?, inventory_verified_at = ?,
                shard_state = 'capture_pending', updated_at = ?
          WHERE operation_id = ? AND source_shard_id = ? AND shard_state = 'inventory_pending'
            AND EXISTS (
              SELECT 1 FROM control_tenant_placement_migrations migration
               WHERE migration.operation_id = control_tenant_placement_migration_shards.operation_id
                 AND migration.owner_id = ? AND migration.fencing_token = ?
            )`
      )
      .bind(
        inventory.tables.length,
        now,
        now,
        operation.operation_id,
        shard.source_shard_id,
        operation.owner_id,
        operation.fencing_token
      )
      .run();
  }

  private async loadInventory(shard: MigrationShardRow): Promise<TenantMigrationTableInventory[]> {
    const result = await primary(this.database)
      .prepare(
        `SELECT table_name, ownership_json, disposition, primary_key_json,
                columns_json, foreign_keys_json
           FROM control_tenant_placement_migration_inventory
          WHERE operation_id = ? AND source_shard_id = ? AND inventory_state = 'verified'
          ORDER BY table_name`
      )
      .bind(shard.operation_id, shard.source_shard_id)
      .all<InventoryRow>();
    return result.results.map((row) => ({
      table: row.table_name,
      ownership: parseJsonObject(
        row.ownership_json,
        'control_tenant_placement_inventory_snapshot_invalid'
      ) as unknown as TenantMigrationOwnershipRule,
      disposition: row.disposition,
      primaryKey: parseJsonArray<string>(
        row.primary_key_json,
        'control_tenant_placement_inventory_snapshot_invalid'
      ),
      columns: parseJsonArray<TenantMigrationTableColumn>(
        row.columns_json,
        'control_tenant_placement_inventory_snapshot_invalid'
      ),
      foreignKeys: parseJsonArray<TenantMigrationForeignKey>(
        row.foreign_keys_json,
        'control_tenant_placement_inventory_snapshot_invalid'
      ),
    }));
  }

  private async tenantKey(operation: ActiveOperationRow): Promise<string> {
    const row = await primary(this.database)
      .prepare(
        `SELECT observed.provider_resource_id AS source_database_id
           FROM control_tenant_placement_migration_shards migration_shard
           JOIN control_tenant_shards shard
             ON shard.environment_id = migration_shard.environment_id
            AND shard.shard_id = migration_shard.source_shard_id
           JOIN control_desired_resources desired
             ON desired.environment_id = shard.environment_id
            AND desired.desired_resource_id = shard.d1_desired_resource_id
           JOIN control_observed_resources observed
             ON observed.environment_id = desired.environment_id
            AND observed.desired_resource_id = desired.desired_resource_id
            AND observed.resource_kind = 'd1' AND observed.observed_state = 'present'
          WHERE migration_shard.operation_id = ?
            AND migration_shard.data_role = 'tenant_core/default'
          LIMIT 1`
      )
      .bind(operation.operation_id)
      .first<{ source_database_id: string }>();
    if (!row) throw new Error('control_tenant_placement_default_source_unavailable');
    const result = await this.d1.queryD1(
      row.source_database_id,
      'SELECT tenant_key FROM tenants WHERE id = ? LIMIT 1',
      [operation.tenant_id]
    );
    const tenant = result[0]?.results?.[0] as { tenant_key?: unknown } | undefined;
    if (
      result.length !== 1 ||
      result[0]?.success !== true ||
      typeof tenant?.tenant_key !== 'string'
    ) {
      throw new Error('control_tenant_placement_tenant_key_unavailable');
    }
    return tenant.tenant_key;
  }

  private async reconcileCapture(operation: ActiveOperationRow): Promise<void> {
    const shard = await this.shard(operation, 'capture_pending');
    if (!shard) {
      await this.transition(operation, 'capture_installing', 'backfilling');
      return;
    }
    const [route, inventory, tenantKey] = await Promise.all([
      this.databaseRoutes(shard),
      this.loadInventory(shard),
      this.tenantKey(operation),
    ]);
    const plan = await buildTenantMigrationCapturePlan({
      operationId: operation.operation_id,
      tenantId: operation.tenant_id,
      tenantKey,
      sourceShardId: shard.source_shard_id,
      migrationGeneration: operation.target_policy_generation,
      fencingToken: operation.fencing_token,
      inventory,
      now: this.now(),
    });
    for (let offset = 0; offset < plan.install.length; offset += INSTALL_BATCH_SIZE) {
      const results = await this.d1.queryD1Batch(
        route.source_database_id,
        plan.install.slice(offset, offset + INSTALL_BATCH_SIZE)
      );
      if (
        results.length !== Math.min(INSTALL_BATCH_SIZE, plan.install.length - offset) ||
        results.some((result) => result.success !== true)
      ) {
        throw new Error('control_tenant_placement_capture_install_failed');
      }
    }
    const verification = await this.d1.queryD1(
      route.source_database_id,
      `SELECT operation_id, tenant_id, source_shard_id, migration_generation,
              capture_state, fencing_token
         FROM tenant_placement_migration_captures
        WHERE operation_id = ?`,
      [operation.operation_id]
    );
    const capture = verification[0]?.results?.[0] as Record<string, unknown> | undefined;
    if (
      verification.length !== 1 ||
      verification[0]?.success !== true ||
      capture?.tenant_id !== operation.tenant_id ||
      capture?.source_shard_id !== shard.source_shard_id ||
      capture?.migration_generation !== operation.target_policy_generation ||
      capture?.capture_state !== 'capturing' ||
      capture?.fencing_token !== operation.fencing_token
    ) {
      throw new Error('control_tenant_placement_capture_verification_failed');
    }
    const now = this.now();
    await primary(this.database)
      .prepare(
        `UPDATE control_tenant_placement_migration_shards
            SET shard_state = 'backfilling', capture_fencing_token = ?, capture_installed_at = ?,
                table_cursor_json = '{"tableIndex":0,"cursor":null}',
                source_row_count = 0, target_row_count = 0, updated_at = ?
          WHERE operation_id = ? AND source_shard_id = ? AND shard_state = 'capture_pending'
            AND EXISTS (
              SELECT 1 FROM control_tenant_placement_migrations migration
               WHERE migration.operation_id = control_tenant_placement_migration_shards.operation_id
                 AND migration.owner_id = ? AND migration.fencing_token = ?
            )`
      )
      .bind(
        operation.fencing_token,
        now,
        now,
        operation.operation_id,
        shard.source_shard_id,
        operation.owner_id,
        operation.fencing_token
      )
      .run();
  }

  private async reconcileBackfill(operation: ActiveOperationRow): Promise<void> {
    const shard = await this.shard(operation, 'backfilling');
    if (!shard) {
      await this.transition(operation, 'backfilling', 'catching_up');
      return;
    }
    const [route, storedInventory, tenantKey] = await Promise.all([
      this.databaseRoutes(shard),
      this.loadInventory(shard),
      this.tenantKey(operation),
    ]);
    const inventory = orderTenantMigrationTables(storedInventory);
    const cursor = parseJsonObject(
      shard.table_cursor_json,
      'control_tenant_placement_backfill_cursor_invalid'
    );
    const tableIndex = cursor.tableIndex;
    if (!Number.isSafeInteger(tableIndex) || (tableIndex as number) < 0) {
      throw new Error('control_tenant_placement_backfill_cursor_invalid');
    }
    if ((tableIndex as number) >= inventory.length) {
      await primary(this.database)
        .prepare(
          `UPDATE control_tenant_placement_migration_shards
              SET shard_state = 'catching_up', backfill_completed_at = ?, updated_at = ?
            WHERE operation_id = ? AND source_shard_id = ? AND shard_state = 'backfilling'`
        )
        .bind(this.now(), this.now(), operation.operation_id, shard.source_shard_id)
        .run();
      return;
    }
    const table = inventory[tableIndex as number];
    const primaryCursor =
      cursor.cursor === null ? null : (cursor.cursor as Record<string, unknown> | undefined);
    if (cursor.cursor !== null && (!primaryCursor || Array.isArray(primaryCursor))) {
      throw new Error('control_tenant_placement_backfill_cursor_invalid');
    }
    const page = await readTenantMigrationBackfillPage({
      executor: this.d1,
      sourceDatabaseId: route.source_database_id,
      table,
      tenantId: operation.tenant_id,
      tenantKey,
      cursor: primaryCursor ?? null,
    });
    await applyTenantMigrationBackfillPage({
      executor: this.d1,
      targetDatabaseId: route.target_database_id!,
      table,
      tenantId: operation.tenant_id,
      tenantKey,
      rows: page.rows,
    });
    const next = page.done
      ? { tableIndex: (tableIndex as number) + 1, cursor: null }
      : { tableIndex, cursor: page.nextCursor };
    await primary(this.database)
      .prepare(
        `UPDATE control_tenant_placement_migration_shards
            SET table_cursor_json = ?,
                source_row_count = COALESCE(source_row_count, 0) + ?,
                target_row_count = COALESCE(target_row_count, 0) + ?, updated_at = ?
          WHERE operation_id = ? AND source_shard_id = ? AND shard_state = 'backfilling'
            AND table_cursor_json = ?`
      )
      .bind(
        JSON.stringify(next),
        page.rows.length,
        page.rows.length,
        this.now(),
        operation.operation_id,
        shard.source_shard_id,
        shard.table_cursor_json
      )
      .run();
  }

  private async reconcileOutbox(operation: ActiveOperationRow): Promise<void> {
    const shard = await this.shard(operation, 'catching_up');
    if (!shard) {
      await this.transition(operation, 'catching_up', 'verifying');
      return;
    }
    if (!shard.capture_fencing_token) {
      throw new Error('control_tenant_placement_capture_fence_missing');
    }
    const [route, inventory, tenantKey] = await Promise.all([
      this.databaseRoutes(shard),
      this.loadInventory(shard),
      this.tenantKey(operation),
    ]);
    if (await this.applyNextOutboxBatch(operation, shard, route, inventory, tenantKey)) return;
    const status = await this.outboxStatus(operation, shard, route.source_database_id);
    if (status.pendingCount !== 0 || status.maxSequence !== shard.last_applied_source_sequence) {
      await this.synchronizeAppliedSequence(operation, shard, status);
      return;
    }
    const cursor = this.newVerificationCursor('preliminary', status.maxSequence);
    await primary(this.database)
      .prepare(
        `UPDATE control_tenant_placement_migration_shards
            SET shard_state = 'verifying', last_observed_source_sequence = ?,
                table_cursor_json = ?, updated_at = ?
          WHERE operation_id = ? AND source_shard_id = ? AND shard_state = 'catching_up'
            AND last_applied_source_sequence = ?`
      )
      .bind(
        status.maxSequence,
        JSON.stringify(cursor),
        this.now(),
        operation.operation_id,
        shard.source_shard_id,
        shard.last_applied_source_sequence
      )
      .run();
  }

  private newVerificationCursor(
    phase: VerificationCursor['phase'],
    baselineSequence: number
  ): VerificationCursor {
    return {
      phase,
      tableIndex: 0,
      cursor: null,
      rowCount: 0,
      checksum: EMPTY_CHECKSUM,
      baselineSequence,
    };
  }

  private verificationCursor(
    value: string,
    expectedPhase: VerificationCursor['phase']
  ): VerificationCursor {
    const parsed = parseJsonObject(value, 'control_tenant_placement_verification_cursor_invalid');
    if (
      parsed.phase !== expectedPhase ||
      !Number.isSafeInteger(parsed.tableIndex) ||
      Number(parsed.tableIndex) < 0 ||
      (parsed.cursor !== null &&
        (!parsed.cursor || typeof parsed.cursor !== 'object' || Array.isArray(parsed.cursor))) ||
      !Number.isSafeInteger(parsed.rowCount) ||
      Number(parsed.rowCount) < 0 ||
      typeof parsed.checksum !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(parsed.checksum) ||
      !Number.isSafeInteger(parsed.baselineSequence) ||
      Number(parsed.baselineSequence) < 0
    ) {
      throw new Error('control_tenant_placement_verification_cursor_invalid');
    }
    return parsed as unknown as VerificationCursor;
  }

  private async outboxStatus(
    operation: ActiveOperationRow,
    shard: MigrationShardRow,
    sourceDatabaseId: string
  ): Promise<OutboxStatus> {
    if (!shard.capture_fencing_token) {
      throw new Error('control_tenant_placement_capture_fence_missing');
    }
    const status = await this.d1.queryD1(
      sourceDatabaseId,
      `SELECT COALESCE(MAX(source_sequence), 0) AS max_sequence,
              COALESCE(SUM(CASE WHEN delivery_state = 'pending' THEN 1 ELSE 0 END), 0)
                AS pending_count
         FROM tenant_placement_migration_outbox
        WHERE operation_id = ? AND tenant_id = ? AND capture_fencing_token = ?`,
      [operation.operation_id, operation.tenant_id, shard.capture_fencing_token]
    );
    const row = status[0]?.results?.[0] as
      | { max_sequence?: unknown; pending_count?: unknown }
      | undefined;
    if (
      status.length !== 1 ||
      status[0]?.success !== true ||
      !Number.isSafeInteger(row?.max_sequence) ||
      !Number.isSafeInteger(row?.pending_count)
    ) {
      throw new Error('control_tenant_placement_outbox_status_invalid');
    }
    return {
      maxSequence: row!.max_sequence as number,
      pendingCount: row!.pending_count as number,
    };
  }

  private async synchronizeAppliedSequence(
    operation: ActiveOperationRow,
    shard: MigrationShardRow,
    status: OutboxStatus
  ): Promise<void> {
    if (status.pendingCount !== 0 || status.maxSequence <= shard.last_applied_source_sequence) {
      return;
    }
    await primary(this.database)
      .prepare(
        `UPDATE control_tenant_placement_migration_shards
            SET last_observed_source_sequence = ?, last_applied_source_sequence = ?, updated_at = ?
          WHERE operation_id = ? AND source_shard_id = ?
            AND last_applied_source_sequence = ?`
      )
      .bind(
        status.maxSequence,
        status.maxSequence,
        this.now(),
        operation.operation_id,
        shard.source_shard_id,
        shard.last_applied_source_sequence
      )
      .run();
  }

  private async applyNextOutboxBatch(
    operation: ActiveOperationRow,
    shard: MigrationShardRow,
    route: DatabaseRouteRow,
    inventory: readonly TenantMigrationTableInventory[],
    tenantKey: string
  ): Promise<boolean> {
    if (!shard.capture_fencing_token) {
      throw new Error('control_tenant_placement_capture_fence_missing');
    }
    const records = await readTenantMigrationOutboxBatch({
      executor: this.d1,
      sourceDatabaseId: route.source_database_id,
      operationId: operation.operation_id,
      tenantId: operation.tenant_id,
      fencingToken: shard.capture_fencing_token,
      afterSequence: Number(shard.last_applied_source_sequence),
    });
    if (records.length === 0) return false;
    const applied = await applyTenantMigrationOutboxBatch({
      executor: this.d1,
      sourceDatabaseId: route.source_database_id,
      targetDatabaseId: route.target_database_id!,
      operationId: operation.operation_id,
      tenantId: operation.tenant_id,
      tenantKey,
      fencingToken: shard.capture_fencing_token,
      inventory,
      records,
      now: this.now(),
    });
    await primary(this.database)
      .prepare(
        `UPDATE control_tenant_placement_migration_shards
              SET last_observed_source_sequence = ?, last_applied_source_sequence = ?, updated_at = ?
            WHERE operation_id = ? AND source_shard_id = ?
              AND last_applied_source_sequence = ?`
      )
      .bind(
        applied.lastAppliedSequence,
        applied.lastAppliedSequence,
        this.now(),
        operation.operation_id,
        shard.source_shard_id,
        shard.last_applied_source_sequence
      )
      .run();
    return true;
  }

  private async reconcileVerification(
    operation: ActiveOperationRow,
    phase: VerificationCursor['phase']
  ): Promise<void> {
    const shard = await this.shard(operation, 'verifying');
    if (!shard) {
      if (phase !== 'preliminary') {
        throw new Error('control_tenant_placement_final_verification_incomplete');
      }
      const now = this.now();
      const reset = this.newVerificationCursor('final', 0);
      const results = await this.database.batch([
        primary(this.database)
          .prepare(
            `UPDATE control_tenant_placement_migrations
                SET migration_state = 'write_fencing', write_fence_state = 'requested',
                    write_fence_started_at = COALESCE(write_fence_started_at, ?), updated_at = ?
              WHERE operation_id = ? AND environment_id = ? AND migration_state = 'verifying'
                AND owner_id = ? AND fencing_token = ?
                AND NOT EXISTS (
                  SELECT 1 FROM control_tenant_placement_migration_shards shard
                   WHERE shard.operation_id = control_tenant_placement_migrations.operation_id
                     AND shard.shard_state <> 'verified'
                )`
          )
          .bind(
            now,
            now,
            operation.operation_id,
            operation.environment_id,
            operation.owner_id,
            operation.fencing_token
          ),
        primary(this.database)
          .prepare(
            `UPDATE control_tenant_placement_migration_shards
                SET shard_state = 'verifying', table_cursor_json = ?,
                    source_row_count = NULL, target_row_count = NULL,
                    source_checksum = NULL, target_checksum = NULL, verified_at = NULL,
                    updated_at = ?
              WHERE operation_id = ? AND shard_state = 'verified'`
          )
          .bind(JSON.stringify(reset), now, operation.operation_id),
      ]);
      if (
        results.some((result) => result.success !== true) ||
        Number(results[0]?.meta?.changes ?? 0) !== 1 ||
        Number(results[1]?.meta?.changes ?? 0) < 1
      ) {
        throw new Error('control_tenant_placement_write_fence_transition_failed');
      }
      return;
    }
    const [route, storedInventory, tenantKey] = await Promise.all([
      this.databaseRoutes(shard),
      this.loadInventory(shard),
      this.tenantKey(operation),
    ]);
    const inventory = orderTenantMigrationTables(storedInventory);
    const current = this.verificationCursor(shard.table_cursor_json, phase);
    const statusBefore = await this.outboxStatus(operation, shard, route.source_database_id);
    if (
      statusBefore.pendingCount !== 0 ||
      statusBefore.maxSequence !== current.baselineSequence ||
      statusBefore.maxSequence !== shard.last_applied_source_sequence
    ) {
      if (await this.applyNextOutboxBatch(operation, shard, route, inventory, tenantKey)) return;
      const status = await this.outboxStatus(operation, shard, route.source_database_id);
      if (status.pendingCount !== 0 || status.maxSequence !== shard.last_applied_source_sequence) {
        await this.synchronizeAppliedSequence(operation, shard, status);
        return;
      }
      await primary(this.database)
        .prepare(
          `UPDATE control_tenant_placement_migration_shards
              SET table_cursor_json = ?, updated_at = ?
            WHERE operation_id = ? AND source_shard_id = ? AND shard_state = 'verifying'
              AND table_cursor_json = ?`
        )
        .bind(
          JSON.stringify(this.newVerificationCursor(phase, status.maxSequence)),
          this.now(),
          operation.operation_id,
          shard.source_shard_id,
          shard.table_cursor_json
        )
        .run();
      return;
    }
    if (current.tableIndex >= inventory.length) {
      const finalStatus = await this.outboxStatus(operation, shard, route.source_database_id);
      if (finalStatus.pendingCount !== 0 || finalStatus.maxSequence !== current.baselineSequence) {
        await primary(this.database)
          .prepare(
            `UPDATE control_tenant_placement_migration_shards
                SET table_cursor_json = ?, updated_at = ?
              WHERE operation_id = ? AND source_shard_id = ? AND shard_state = 'verifying'
                AND table_cursor_json = ?`
          )
          .bind(
            JSON.stringify(this.newVerificationCursor(phase, finalStatus.maxSequence)),
            this.now(),
            operation.operation_id,
            shard.source_shard_id,
            shard.table_cursor_json
          )
          .run();
        return;
      }
      const nextState = phase === 'final' ? 'write_fenced' : 'verified';
      await primary(this.database)
        .prepare(
          `UPDATE control_tenant_placement_migration_shards
              SET shard_state = ?, source_row_count = ?, target_row_count = ?,
                  source_checksum = ?, target_checksum = ?, verified_at = ?,
                  write_fenced_at = CASE WHEN ? = 'write_fenced' THEN ? ELSE write_fenced_at END,
                  updated_at = ?
            WHERE operation_id = ? AND source_shard_id = ? AND shard_state = 'verifying'
              AND table_cursor_json = ?`
        )
        .bind(
          nextState,
          current.rowCount,
          current.rowCount,
          current.checksum,
          current.checksum,
          this.now(),
          nextState,
          this.now(),
          this.now(),
          operation.operation_id,
          shard.source_shard_id,
          shard.table_cursor_json
        )
        .run();
      return;
    }
    const table = inventory[current.tableIndex];
    const [sourcePage, targetPage] = await Promise.all([
      readTenantMigrationBackfillPage({
        executor: this.d1,
        sourceDatabaseId: route.source_database_id,
        table,
        tenantId: operation.tenant_id,
        tenantKey,
        cursor: current.cursor,
      }),
      readTenantMigrationBackfillPage({
        executor: this.d1,
        sourceDatabaseId: route.target_database_id!,
        table,
        tenantId: operation.tenant_id,
        tenantKey,
        cursor: current.cursor,
      }),
    ]);
    if (
      sourcePage.done !== targetPage.done ||
      !rowsEqual(sourcePage.nextCursor, targetPage.nextCursor) ||
      !rowsEqual(sourcePage.rows, targetPage.rows)
    ) {
      const mismatchStatus = await this.outboxStatus(operation, shard, route.source_database_id);
      if (
        mismatchStatus.pendingCount !== 0 ||
        mismatchStatus.maxSequence !== current.baselineSequence
      ) {
        await this.synchronizeAppliedSequence(operation, shard, mismatchStatus);
        return;
      }
      throw new Error('control_tenant_placement_verification_mismatch');
    }
    const checksum = await sha256({ previous: current.checksum, rows: sourcePage.rows });
    const next: VerificationCursor = sourcePage.done
      ? {
          ...current,
          tableIndex: current.tableIndex + 1,
          cursor: null,
          rowCount: current.rowCount + sourcePage.rows.length,
          checksum,
        }
      : {
          ...current,
          cursor: sourcePage.nextCursor,
          rowCount: current.rowCount + sourcePage.rows.length,
          checksum,
        };
    await primary(this.database)
      .prepare(
        `UPDATE control_tenant_placement_migration_shards
            SET table_cursor_json = ?, updated_at = ?
          WHERE operation_id = ? AND source_shard_id = ? AND shard_state = 'verifying'
            AND table_cursor_json = ?`
      )
      .bind(
        JSON.stringify(next),
        this.now(),
        operation.operation_id,
        shard.source_shard_id,
        shard.table_cursor_json
      )
      .run();
  }

  private async reconcileWriteFence(operation: ActiveOperationRow): Promise<void> {
    const shard = await this.shard(operation, 'verifying');
    if (!shard) {
      await this.transition(
        operation,
        'write_fencing',
        'cutover_ready',
        ", write_fence_state = 'active'"
      );
      return;
    }
    if (!shard.capture_fencing_token) {
      throw new Error('control_tenant_placement_capture_fence_missing');
    }
    const [route, inventory, tenantKey] = await Promise.all([
      this.databaseRoutes(shard),
      this.loadInventory(shard),
      this.tenantKey(operation),
    ]);
    const captureResult = await this.d1.queryD1(
      route.source_database_id,
      `UPDATE tenant_placement_migration_captures
          SET capture_state = 'write_fenced', write_fenced_at = COALESCE(write_fenced_at, ?),
              updated_at = ?
        WHERE operation_id = ? AND tenant_id = ? AND source_shard_id = ?
          AND fencing_token = ? AND capture_state IN ('capturing', 'write_fenced')`,
      [
        this.now(),
        this.now(),
        operation.operation_id,
        operation.tenant_id,
        shard.source_shard_id,
        shard.capture_fencing_token,
      ]
    );
    if (captureResult.length !== 1 || captureResult[0]?.success !== true) {
      throw new Error('control_tenant_placement_write_fence_failed');
    }
    const capture = await this.d1.queryD1(
      route.source_database_id,
      `SELECT capture_state, fencing_token
         FROM tenant_placement_migration_captures
        WHERE operation_id = ? AND tenant_id = ? AND source_shard_id = ?`,
      [operation.operation_id, operation.tenant_id, shard.source_shard_id]
    );
    const captureRow = capture[0]?.results?.[0] as Record<string, unknown> | undefined;
    if (
      capture.length !== 1 ||
      capture[0]?.success !== true ||
      captureRow?.capture_state !== 'write_fenced' ||
      captureRow.fencing_token !== shard.capture_fencing_token
    ) {
      throw new Error('control_tenant_placement_write_fence_verification_failed');
    }
    if (await this.applyNextOutboxBatch(operation, shard, route, inventory, tenantKey)) {
      return;
    }
    const status = await this.outboxStatus(operation, shard, route.source_database_id);
    if (status.pendingCount !== 0 || status.maxSequence !== shard.last_applied_source_sequence) {
      await this.synchronizeAppliedSequence(operation, shard, status);
      return;
    }
    const cursor = this.verificationCursor(shard.table_cursor_json, 'final');
    if (cursor.baselineSequence !== status.maxSequence) {
      await primary(this.database)
        .prepare(
          `UPDATE control_tenant_placement_migration_shards
              SET table_cursor_json = ?, updated_at = ?
            WHERE operation_id = ? AND source_shard_id = ? AND shard_state = 'verifying'
              AND table_cursor_json = ?`
        )
        .bind(
          JSON.stringify(this.newVerificationCursor('final', status.maxSequence)),
          this.now(),
          operation.operation_id,
          shard.source_shard_id,
          shard.table_cursor_json
        )
        .run();
      return;
    }
    await this.reconcileVerification(operation, 'final');
  }
}
