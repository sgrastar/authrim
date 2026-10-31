import type { DatabaseAdapter } from '../../db/adapter';
import type { TenantBackupStepContext, TenantBackupStepResult } from './operation-executor';
import type { TenantBackupSnapshotResources } from './snapshot-resources';
import {
  readPersistedSqliteCaptureSchemas,
  verifyLiveSqliteTenantDatasetPlan,
} from './sqlite-dataset-plan';
import { sqliteCapturePlan, sqliteSnapshotStartOrResumeStatement } from './sqlite-capture-plan';
import { readBackupSqliteBoundarySchemaDigest } from './sqlite-schema-reader';

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
  source: {
    resourceId: string;
    database: Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute' | 'batch'>;
  };
  resourceId: string;
  family: Plan['family'];
  firstOrdinal: number;
  tableCount?: number;
  captureCount?: number;
  expectedBoundarySchemaDigest?: string;
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
 * Install all remaining capture triggers in D1-sized batches before snapshot admission.
 * assertBoundary must hold an exclusive source DDL/admission guard across the call; a lease check
 * alone is insufficient. Retry inspects existing definitions and never replaces a trigger.
 * Migrations must already have installed the scratch tables. Missing capture protection while any
 * snapshot is active is an error, not permission to silently repair a potentially incomplete image.
 */
export async function prepareTenantBackupSqliteCapture(
  input: TenantBackupSqlitePreparationInput,
  tableOrdinal: number
): Promise<{ nextTableOrdinal: number; complete: boolean; boundarySchemaDigest?: string }> {
  const schemas = await verifyCaptureInput(input);
  const plan = sqliteCapturePlan(schemas);
  if (
    !Number.isSafeInteger(tableOrdinal) ||
    tableOrdinal < 0 ||
    tableOrdinal >= plan.schemas.length
  )
    throw new Error('backup_snapshot_install_cursor');
  const database = input.source.database;
  // Verify the complete plan once, then install all remaining triggers in D1-sized batches during
  // the same operation slice. Persisted resume still starts at tableOrdinal, but scheduler latency is
  // paid per physical database instead of once per 32 tables.
  let nextTableOrdinal = tableOrdinal;
  while (nextTableOrdinal < plan.schemas.length) {
    // D1 batch accepts up to 100 statements. Each table has at most three capture triggers.
    const batchEnd = Math.min(plan.schemas.length, nextTableOrdinal + 32);
    const tables = new Set(
      plan.schemas.slice(nextTableOrdinal, batchEnd).map((schema) => schema.table)
    );
    const triggers = plan.triggers.filter((trigger) => tables.has(trigger.table));
    const installed = triggers.length
      ? await database.query<{ name: string; type: string; tbl_name: string; sql: string }>(
          `SELECT name,type,tbl_name,sql FROM sqlite_schema WHERE name IN (${triggers
            .map(() => '?')
            .join(',')})`,
          triggers.map((trigger) => trigger.name)
        )
      : [];
    const installedByName = new Map(installed.map((trigger) => [trigger.name, trigger]));
    const missing = triggers.filter((trigger) => {
      const found = installedByName.get(trigger.name);
      if (!found) return true;
      if (
        found.type !== 'trigger' ||
        found.tbl_name !== trigger.table ||
        found.sql.trim().replace(/;+$/, '') !== trigger.sql
      )
        throw new Error('backup_snapshot_trigger_conflict');
      return false;
    });
    if (missing.length) {
      input.context.signal.throwIfAborted();
      await input.inventory.head();
      await input.assertBoundary();
      if (
        await database.queryOne(
          "SELECT id FROM tenant_backup_snapshots WHERE state='capturing' LIMIT 1"
        )
      )
        throw new Error('backup_snapshot_install_during_capture');
      const results = await database.batch(missing.map((trigger) => ({ sql: trigger.sql })));
      if (results.length !== missing.length || results.some((result) => !result.success))
        throw new Error('backup_snapshot_trigger_install_failed');
    }
    nextTableOrdinal = batchEnd;
  }
  input.context.signal.throwIfAborted();
  await input.inventory.head();
  await input.assertBoundary();
  return {
    nextTableOrdinal,
    complete: true,
    boundarySchemaDigest: await readBackupSqliteBoundarySchemaDigest(
      database,
      input.context.signal
    ),
  };
}

export async function startTenantBackupSqliteCapture(
  input: TenantBackupSqliteCaptureInput
): Promise<void> {
  const prepared = await prepareTenantBackupSqliteCaptureStart(input);
  await prepared(input.assertBoundary);
}

/**
 * Perform the expensive complete-plan verification before the short cross-store write hold.
 * The returned start rechecks a compact schema fingerprint under the hold, then relies on the
 * atomic start statement for exact capture-trigger and primary-key validation.
 */
export async function prepareTenantBackupSqliteCaptureStart(
  input: TenantBackupSqliteCaptureInput
): Promise<(assertBoundary: () => Promise<void>) => Promise<void>> {
  const { context, resources, source, resourceId, snapshotId } = input;
  const { lease, signal } = context;
  const expectedSchemaDigest = input.expectedBoundarySchemaDigest;
  const schemas = expectedSchemaDigest
    ? await readPersistedSqliteCaptureSchemas({
        inventory: input.inventory,
        lease,
        family: input.family,
        resourceId,
        firstOrdinal: input.firstOrdinal,
        tableCount: input.tableCount ?? 0,
        captureCount: input.captureCount ?? 0,
      })
    : await verifyCaptureInput(input);
  const preparedSchemaDigest =
    expectedSchemaDigest ?? (await readBackupSqliteBoundarySchemaDigest(source.database, signal));
  // Validate the complete SQL before entering the hold or recording a reservation.
  const statement = sqliteSnapshotStartOrResumeStatement(
    schemas,
    snapshotId,
    lease.tenantId,
    input.tenantKey
  );
  // Persist write-ahead ownership before the short cross-store hold. A failed admission keeps the
  // reservation for idempotent retry and cancellation cleanup, while the hold only performs the
  // compact schema check and atomic source snapshot start.
  await resources.reserve(lease, resourceId, snapshotId);
  await resources.assertCaptureOwner(lease, resourceId, snapshotId);
  return async (assertBoundary) => {
    signal.throwIfAborted();
    await assertBoundary();
    if (
      (await readBackupSqliteBoundarySchemaDigest(source.database, signal)) !== preparedSchemaDigest
    )
      throw new Error('backup_schema_changed_during_boundary');
    await assertBoundary();
    // The durable reservation and live operation lease were verified immediately before the
    // cross-store hold. Avoid repeating that remote check before the atomic source write. The
    // post-write check remains mandatory so cancellation racing the write is retained for cleanup.
    const result = await source.database.execute(statement.sql, statement.params);
    if (!result.success || result.rowsAffected !== 1)
      throw new Error('backup_snapshot_start_rejected');
    signal.throwIfAborted();
    await resources.assertCaptureOwner(lease, resourceId, snapshotId);
    await assertBoundary();
  };
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
