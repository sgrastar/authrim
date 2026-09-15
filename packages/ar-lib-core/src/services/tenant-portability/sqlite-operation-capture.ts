import type { DatabaseAdapter } from '../../db/adapter';
import type { TenantBackupStepContext, TenantBackupStepResult } from './operation-executor';
import type { TenantBackupSnapshotResources } from './snapshot-resources';
import { verifyLiveSqliteTenantDatasetPlan } from './sqlite-dataset-plan';
import { sqliteCapturePlan, sqliteSnapshotStartOrResumeStatement } from './sqlite-capture-plan';

type Plan = Parameters<typeof verifyLiveSqliteTenantDatasetPlan>[0];

/**
 * Start one SQL resource of a sealed operation plan. The coordinator must supply a live boundary
 * guard covering routing, DDL and the other stores; an operation lease alone is insufficient.
 * Required capture tables/triggers must already be installed under that guard.
 * Successful return proves this resource started, not that the cross-store snapshot is complete.
 */
export interface TenantBackupSqliteCaptureInput {
  context: TenantBackupStepContext;
  resources: TenantBackupSnapshotResources;
  inventory: Plan['inventory'];
  source: { resourceId: string; database: Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'> };
  resourceId: string;
  family: Plan['family'];
  firstOrdinal: number;
  selection: Plan['selection'];
  snapshotId: string;
  /** Resolved from authenticated tenant metadata, not the incoming API request. */
  tenantKey?: string;
  assertBoundary: () => Promise<void>;
}

export type TenantBackupSqlitePreparationInput = Omit<TenantBackupSqliteCaptureInput, 'snapshotId'>;

async function verifyCaptureInput(input: TenantBackupSqlitePreparationInput) {
  const { context, source, resourceId } = input;
  const { lease, signal } = context;
  signal.throwIfAborted();
  if (source.resourceId !== resourceId) throw new Error('backup_resource_destination_changed');
  const head = await input.inventory.head();
  if (head.operation_id !== lease.operationId || head.tenant_id !== lease.tenantId)
    throw new Error('backup_snapshot_inventory_owner');
  await input.assertBoundary();
  return verifyLiveSqliteTenantDatasetPlan({
    inventory: input.inventory,
    database: source.database,
    family: input.family,
    resourceId,
    firstOrdinal: input.firstOrdinal,
    selection: input.selection,
    signal,
  });
}

/**
 * Install at most one table's three capture triggers per call, before snapshot admission.
 * assertBoundary must hold an exclusive source DDL/admission guard across the call; a lease check
 * alone is insufficient. Retry inspects existing definitions and never replaces a trigger.
 * Migrations must already have installed the scratch tables. Missing capture protection while any
 * snapshot is active is an error, not permission to silently repair a potentially incomplete image.
 */
export async function prepareTenantBackupSqliteCapture(
  input: TenantBackupSqlitePreparationInput,
  tableOrdinal: number
): Promise<{ nextTableOrdinal: number; complete: boolean }> {
  const schemas = await verifyCaptureInput(input);
  const plan = sqliteCapturePlan(schemas);
  if (
    !Number.isSafeInteger(tableOrdinal) ||
    tableOrdinal < 0 ||
    tableOrdinal >= plan.schemas.length
  )
    throw new Error('backup_snapshot_install_cursor');
  const database = input.source.database;
  const table = plan.schemas[tableOrdinal].table;
  const triggers = plan.triggers.filter((trigger) => trigger.table === table);
  const missing: typeof triggers = [];
  for (const trigger of triggers) {
    const installed = await database.queryOne<{ type: string; tbl_name: string; sql: string }>(
      'SELECT type,tbl_name,sql FROM sqlite_schema WHERE name=?',
      [trigger.name]
    );
    if (!installed) missing.push(trigger);
    else if (
      installed.type !== 'trigger' ||
      installed.tbl_name !== table ||
      installed.sql.trim().replace(/;+$/, '') !== trigger.sql
    )
      throw new Error('backup_snapshot_trigger_conflict');
  }
  for (const trigger of missing) {
    input.context.signal.throwIfAborted();
    await input.inventory.head();
    await input.assertBoundary();
    if (
      await database.queryOne(
        "SELECT id FROM tenant_backup_snapshots WHERE state='capturing' LIMIT 1"
      )
    )
      throw new Error('backup_snapshot_install_during_capture');
    const result = await database.execute(trigger.sql);
    if (!result.success) throw new Error('backup_snapshot_trigger_install_failed');
  }
  input.context.signal.throwIfAborted();
  await input.inventory.head();
  await input.assertBoundary();
  return { nextTableOrdinal: tableOrdinal + 1, complete: tableOrdinal + 1 === plan.schemas.length };
}

export async function startTenantBackupSqliteCapture(
  input: TenantBackupSqliteCaptureInput
): Promise<void> {
  const { context, resources, source, resourceId, snapshotId } = input;
  const { lease, signal } = context;
  const schemas = await verifyCaptureInput(input);
  // Validate the complete SQL before recording a reservation; keep uncertain writes discoverable.
  const statement = sqliteSnapshotStartOrResumeStatement(
    schemas,
    snapshotId,
    lease.tenantId,
    input.tenantKey
  );
  await resources.reserve(lease, resourceId, snapshotId);
  signal.throwIfAborted();
  await input.assertBoundary();
  await resources.assertCaptureOwner(lease, resourceId, snapshotId);
  const result = await source.database.execute(statement.sql, statement.params);
  if (!result.success || result.rowsAffected !== 1)
    throw new Error('backup_snapshot_start_rejected');
  signal.throwIfAborted();
  await resources.assertCaptureOwner(lease, resourceId, snapshotId);
  await input.assertBoundary();
}

/** One persisted installation/start step; cross-store admission remains the coordinator's guard. */
export async function runTenantBackupSqliteCaptureStep(
  input: TenantBackupSqliteCaptureInput
): Promise<TenantBackupStepResult> {
  const { operation, lease, signal } = input.context;
  signal.throwIfAborted();
  if (
    operation.kind !== 'export' ||
    operation.state !== 'running' ||
    operation.id !== lease.operationId ||
    operation.tenant_id !== lease.tenantId ||
    !['prepare_sqlite_capture', 'start_sqlite_capture'].includes(operation.phase)
  )
    throw new Error('backup_capture_step_context');
  const head = await input.inventory.headForLease(lease);
  if (head.state !== 'sealed') throw new Error('backup_capture_step_unsealed');
  let cursor: unknown;
  try {
    cursor = JSON.parse(operation.cursor_json ?? 'null');
  } catch {
    throw new Error('backup_capture_step_cursor');
  }
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor))
    throw new Error('backup_capture_step_cursor');
  const value = cursor as Record<string, unknown>;
  if (
    Object.keys(value).length !== 5 ||
    value.version !== 1 ||
    value.resourceId !== input.resourceId ||
    value.snapshotId !== input.snapshotId ||
    value.inventoryDigest !== head.chain_digest ||
    typeof value.tableOrdinal !== 'number' ||
    !Number.isSafeInteger(value.tableOrdinal) ||
    value.tableOrdinal < 0
  )
    throw new Error('backup_capture_step_cursor');
  let phase: string;
  if (operation.phase === 'prepare_sqlite_capture') {
    const result = await prepareTenantBackupSqliteCapture(input, value.tableOrdinal);
    value.tableOrdinal = result.nextTableOrdinal;
    phase = result.complete ? 'start_sqlite_capture' : operation.phase;
  } else {
    await startTenantBackupSqliteCapture(input);
    phase = 'advance_capture_resource';
  }
  signal.throwIfAborted();
  await input.inventory.headForLease(lease);
  await input.assertBoundary();
  return { phase, cursor: JSON.stringify(value), disposition: 'continue' };
}
