import type { TenantBackupStepContext, TenantBackupStepResult } from './operation-executor';
import type { TenantBundleManifest } from './bundle-manifest';
import {
  cloneSqliteDatasetInspectionPolicy,
  TENANT_BACKUP_RESTORE_AUTHORITY_REQUIRED,
  type SqliteDatasetInspectionPolicy,
} from './sqlite-dataset-inspector';
import { openPlannedSqliteRestoreTarget } from './sqlite-restore-plan';
import { sqliteRestoreVerifyRowBudget } from './sqlite-restore-target';
import { assertTenantBackupSqliteRowFits } from './container-dataset-reader';

type TargetInput = Parameters<typeof openPlannedSqliteRestoreTarget>[0];
export interface SqliteRestoreDatasetCursor {
  version: 1;
  targetId: string;
  targetOrdinal: number;
  datasetId: string;
  sourceCursor: string | null;
  rowsWritten: number;
}
function invalid(): never {
  throw new Error('backup_restore_step_invalid');
}

/** A row the requester may not restore keeps its reason; any other transform error is generic. */
function rowTransformFailure(error: unknown): Error {
  return new Error(
    error instanceof Error && error.message === TENANT_BACKUP_RESTORE_AUTHORITY_REQUIRED
      ? TENANT_BACKUP_RESTORE_AUTHORITY_REQUIRED
      : 'backup_restore_row_transform_failed'
  );
}

/**
 * Apply validated SQL rows in bounded durable batches. Sources must come from the pinned validated
 * input set and installed module policy; this is not a generic JSON upload or live-table writer.
 */
type RestoreStepInput = Omit<TargetInput, 'context'> & {
  policy: SqliteDatasetInspectionPolicy;
  manifest: TenantBundleManifest;
  readNextValidatedRow: (input: {
    datasetId: string;
    sourceCursor: string | null;
    planDigest: string;
  }) => Promise<{ rowJson: string; nextCursor: string } | null>;
};
export async function runSqliteRestoreDatasetStep(
  context: TenantBackupStepContext,
  input: RestoreStepInput
): Promise<TenantBackupStepResult> {
  return runStep(context, input, 'write');
}
export async function runSqliteRestoreDatasetDeferredStep(
  context: TenantBackupStepContext,
  input: RestoreStepInput
): Promise<TenantBackupStepResult> {
  return runStep(context, input, 'defer');
}
export async function runSqliteRestoreDatasetVerificationStep(
  context: TenantBackupStepContext,
  input: RestoreStepInput
): Promise<TenantBackupStepResult> {
  return runStep(context, input, 'verify');
}
async function runStep(
  context: TenantBackupStepContext,
  input: RestoreStepInput,
  mode: 'write' | 'defer' | 'verify'
): Promise<TenantBackupStepResult> {
  if (mode === 'write') return runWriteBatch(context, input);
  if (mode === 'verify') return runVerifyBatch(context, input);
  return runSingleStep(context, input, mode);
}

const RESTORE_BATCH_BYTES = 4 * 1024 * 1024;
/** Rows one D1 write or read-back call may carry (the restore target's own bound). */
const RESTORE_CALL_ROWS = 500;

/**
 * Rows per transition. Plain rows go to D1 in several bounded calls; rows with per-row hold side
 * effects keep the original small batch.
 */
/** Most rows one write or verify page (one transition of one dataset) carries. */
export const RESTORE_PAGE_ROWS_MAX = 2000;

/**
 * D1 round trips one restore transition may spend on work that grows with its rows and datasets:
 * rows whose installed transform issues its own statements (`restoreTransform.statementsPerRow`;
 * each such row counts as its write or read-back plus those statements), each dataset's count
 * check, opening restore targets and reconciling generated rows. Rows of other datasets are
 * bounded by the row limits alone.
 *
 * Each round trip waits for D1, about 75 ms from a location far from the database, and the
 * scheduler never stops a transition midway: this keeps one transition short. (D1's documented
 * 1,000 queries per invocation did not apply in a measured run, and one `batch()` call counted as
 * one; the value is a tuning knob, not a platform limit.)
 */
export const RESTORE_STATEMENT_BUDGET = 500;

/**
 * Round trips of one call's own checks (authorization and liveness) or one dataset's count check
 * (its count and foreign-key queries with their checks).
 */
export const RESTORE_DATASET_STATEMENTS = 12;

/** Statements one row of `policy` costs against that budget; 0 when its transform issues none. */
export function restoreRowStatements(policy: SqliteDatasetInspectionPolicy): number {
  const issued = policy.restoreTransform?.statementsPerRow ?? 0;
  if (!Number.isSafeInteger(issued) || issued < 0 || issued + 1 > RESTORE_STATEMENT_BUDGET)
    invalid();
  return issued ? issued + 1 : 0;
}

/** Rows of `policy` one transition may carry within the statement budget. */
export function restoreStatementRows(policy: SqliteDatasetInspectionPolicy): number {
  const statements = restoreRowStatements(policy);
  return statements ? Math.floor(RESTORE_STATEMENT_BUDGET / statements) : Number.POSITIVE_INFINITY;
}

function restoreBatchRows(policy: SqliteDatasetInspectionPolicy): number {
  return Math.min(policy.restoreHold ? 250 : RESTORE_PAGE_ROWS_MAX, restoreStatementRows(policy));
}

/** D1 queries one verify transition may spend on row read-back. */
export const RESTORE_VERIFY_QUERY_BUDGET = 400;

/** Verify transitions also stop where wide rows would exceed the read-back query budget. */
function verifyBatchRows(policy: SqliteDatasetInspectionPolicy): number {
  return Math.min(
    restoreBatchRows(policy),
    sqliteRestoreVerifyRowBudget(policy, RESTORE_VERIFY_QUERY_BUDGET)
  );
}

function calls<T>(values: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < values.length; start += RESTORE_CALL_ROWS)
    chunks.push(values.slice(start, start + RESTORE_CALL_ROWS));
  return chunks;
}

async function runVerifyBatch(
  context: TenantBackupStepContext,
  input: RestoreStepInput
): Promise<TenantBackupStepResult> {
  if (
    context.operation.phase !== 'verify_sqlite_dataset' ||
    context.operation.kind !== 'import' ||
    context.operation.state !== 'running'
  )
    invalid();
  let current: SqliteRestoreDatasetCursor & {
    verifySourceCursor: string | null;
    rowsVerified: number;
  };
  try {
    current = JSON.parse(context.operation.cursor_json ?? 'null') as typeof current;
  } catch {
    return invalid();
  }
  if (
    !current ||
    Object.keys(current).sort().join(',') !==
      'datasetId,rowsVerified,rowsWritten,sourceCursor,targetId,targetOrdinal,verifySourceCursor,version' ||
    current.version !== 1 ||
    current.targetId !== input.targetId ||
    current.targetOrdinal !== input.ordinal ||
    current.datasetId !== input.policy.dataset.id ||
    !Number.isSafeInteger(current.rowsWritten) ||
    !Number.isSafeInteger(current.rowsVerified) ||
    current.rowsWritten < 0 ||
    current.rowsVerified < 0 ||
    current.rowsVerified > current.rowsWritten ||
    (current.verifySourceCursor !== null &&
      (typeof current.verifySourceCursor !== 'string' || !current.verifySourceCursor))
  )
    invalid();
  const manifest = structuredClone(input.manifest);
  const policy = cloneSqliteDatasetInspectionPolicy(input.policy);
  if (manifest.source.tenantId !== context.lease.tenantId) invalid();
  const head = await input.inventory.headForLease(context.lease);
  await input.assertValidatedUnpublishedPlan(head.chain_digest);
  const rows: string[] = [];
  const heldRows: string[] = [];
  let bytes = 0;
  let processedRows = 0;
  let sourceCursor = current.verifySourceCursor;
  let sourceComplete = false;
  for (let index = 0; index < verifyBatchRows(policy); index++) {
    context.signal.throwIfAborted();
    let next: Awaited<ReturnType<RestoreStepInput['readNextValidatedRow']>>;
    try {
      next = await input.readNextValidatedRow({
        datasetId: current.datasetId,
        sourceCursor,
        planDigest: head.chain_digest,
      });
    } catch {
      throw new Error('backup_restore_source_read_failed');
    }
    if (next === null) {
      sourceComplete = true;
      break;
    }
    if (
      typeof next.rowJson !== 'string' ||
      typeof next.nextCursor !== 'string' ||
      !next.nextCursor ||
      next.nextCursor === sourceCursor
    )
      invalid();
    const held = policy.restoreHold
      ? await policy.restoreHold.shouldHold(context, next.rowJson)
      : false;
    let rowJson = next.rowJson;
    if (!held)
      try {
        rowJson = policy.restoreTransform
          ? await policy.restoreTransform.transform(context, next.rowJson, 'verify')
          : next.rowJson;
      } catch (error) {
        throw rowTransformFailure(error);
      }
    const rowBytes = new TextEncoder().encode(rowJson).length;
    if (!rowJson) invalid();
    // Rows the restore target cannot hold fail permanently here instead of in the target. Every
    // other row is far below the batch bound, so a batch always takes at least one row.
    assertTenantBackupSqliteRowFits(rowJson);
    if (processedRows && bytes + rowBytes > RESTORE_BATCH_BYTES) break;
    if (held) heldRows.push(next.rowJson);
    else rows.push(rowJson);
    bytes += rowBytes;
    processedRows += 1;
    sourceCursor = next.nextCursor;
  }
  await input.inventory.headForLease(context.lease);
  await input.assertValidatedUnpublishedPlan(head.chain_digest);
  for (const rowJson of heldRows) await policy.restoreHold?.verify(context, rowJson);
  if (policy.restoreDisposition !== 'reference_only' && rows.length) {
    let target: Awaited<ReturnType<typeof openPlannedSqliteRestoreTarget>>;
    try {
      target = await openPlannedSqliteRestoreTarget({ ...input, context });
      for (const chunk of calls(rows)) await target.verifyRows(policy, manifest, chunk);
    } catch {
      throw new Error('backup_restore_row_verify_failed');
    }
  }
  const rowsVerified = current.rowsVerified + rows.length;
  if (rowsVerified > current.rowsWritten) invalid();
  if (sourceComplete) {
    if (rowsVerified !== current.rowsWritten) invalid();
    if (policy.restoreDisposition !== 'reference_only') {
      try {
        const target = await openPlannedSqliteRestoreTarget({ ...input, context });
        await target.verifyDataset(policy, current.rowsWritten);
      } catch {
        throw new Error('backup_restore_dataset_verify_failed');
      }
    }
    return {
      phase: 'advance_restore_dataset',
      cursor: JSON.stringify({ ...current, verifySourceCursor: sourceCursor, rowsVerified }),
      disposition: 'continue',
    };
  }
  return {
    phase: 'verify_sqlite_dataset',
    cursor: JSON.stringify({ ...current, verifySourceCursor: sourceCursor, rowsVerified }),
    disposition: 'continue',
  };
}

async function runWriteBatch(
  context: TenantBackupStepContext,
  input: RestoreStepInput
): Promise<TenantBackupStepResult> {
  if (
    context.operation.phase !== 'apply_sqlite_dataset' ||
    context.operation.kind !== 'import' ||
    context.operation.state !== 'running'
  )
    invalid();
  let current: SqliteRestoreDatasetCursor;
  try {
    current = JSON.parse(context.operation.cursor_json ?? 'null') as SqliteRestoreDatasetCursor;
  } catch {
    return invalid();
  }
  if (
    !current ||
    Object.keys(current).sort().join(',') !==
      'datasetId,rowsWritten,sourceCursor,targetId,targetOrdinal,version' ||
    current.version !== 1 ||
    current.targetId !== input.targetId ||
    current.targetOrdinal !== input.ordinal ||
    current.datasetId !== input.policy.dataset.id ||
    !Number.isSafeInteger(current.rowsWritten) ||
    current.rowsWritten < 0 ||
    (current.sourceCursor !== null &&
      (typeof current.sourceCursor !== 'string' || !current.sourceCursor))
  )
    invalid();
  const manifest = structuredClone(input.manifest);
  const policy = cloneSqliteDatasetInspectionPolicy(input.policy);
  if (manifest.source.tenantId !== context.lease.tenantId) invalid();
  const head = await input.inventory.headForLease(context.lease);
  await input.assertValidatedUnpublishedPlan(head.chain_digest);
  const rows: string[] = [];
  const heldRows: string[] = [];
  let bytes = 0;
  let processedRows = 0;
  let sourceCursor = current.sourceCursor;
  let sourceComplete = false;
  for (let index = 0; index < restoreBatchRows(policy); index++) {
    context.signal.throwIfAborted();
    let next: Awaited<ReturnType<RestoreStepInput['readNextValidatedRow']>>;
    try {
      next = await input.readNextValidatedRow({
        datasetId: current.datasetId,
        sourceCursor,
        planDigest: head.chain_digest,
      });
    } catch {
      throw new Error('backup_restore_source_read_failed');
    }
    if (next === null) {
      if (!processedRows) return runSingleStep(context, input, 'write', null);
      sourceComplete = true;
      break;
    }
    if (
      typeof next.rowJson !== 'string' ||
      typeof next.nextCursor !== 'string' ||
      !next.nextCursor ||
      next.nextCursor.length > 4096 ||
      next.nextCursor === sourceCursor
    )
      invalid();
    const held = policy.restoreHold
      ? await policy.restoreHold.shouldHold(context, next.rowJson)
      : false;
    let rowJson = next.rowJson;
    if (!held)
      try {
        rowJson = policy.restoreTransform
          ? await policy.restoreTransform.transform(context, next.rowJson, 'write')
          : next.rowJson;
      } catch (error) {
        throw rowTransformFailure(error);
      }
    const rowBytes = new TextEncoder().encode(rowJson).length;
    if (!rowJson) invalid();
    assertTenantBackupSqliteRowFits(rowJson);
    if (processedRows && bytes + rowBytes > RESTORE_BATCH_BYTES) break;
    if (held) heldRows.push(next.rowJson);
    else rows.push(rowJson);
    bytes += rowBytes;
    processedRows += 1;
    sourceCursor = next.nextCursor;
  }
  await input.inventory.headForLease(context.lease);
  await input.assertValidatedUnpublishedPlan(head.chain_digest);
  for (const rowJson of heldRows) await policy.restoreHold?.write(context, rowJson);
  if (policy.restoreDisposition !== 'reference_only') {
    let target: Awaited<ReturnType<typeof openPlannedSqliteRestoreTarget>>;
    try {
      target = await openPlannedSqliteRestoreTarget({ ...input, context });
    } catch {
      throw new Error('backup_restore_target_open_failed');
    }
    try {
      for (const chunk of calls(rows)) await target.writeRows(policy, manifest, chunk);
    } catch {
      throw new Error('backup_restore_row_write_failed');
    }
  }
  context.signal.throwIfAborted();
  if (sourceComplete) {
    if (policy.restoreDisposition === 'reference_only')
      return {
        phase: 'verify_sqlite_dataset',
        cursor: JSON.stringify({
          ...current,
          sourceCursor,
          rowsWritten: current.rowsWritten + rows.length,
          verifySourceCursor: null,
          rowsVerified: 0,
        }),
        disposition: 'continue',
      };
    if (policy.deferredColumns?.length)
      return {
        phase: 'apply_sqlite_dataset_deferred',
        cursor: JSON.stringify({
          ...current,
          sourceCursor,
          rowsWritten: current.rowsWritten + rows.length,
          deferredSourceCursor: null,
          rowsDeferred: 0,
        }),
        disposition: 'continue',
      };
    return {
      phase: 'verify_sqlite_dataset',
      cursor: JSON.stringify({
        ...current,
        sourceCursor,
        rowsWritten: current.rowsWritten + rows.length,
        verifySourceCursor: null,
        rowsVerified: 0,
      }),
      disposition: 'continue',
    };
  }
  return {
    phase: 'apply_sqlite_dataset',
    cursor: JSON.stringify({
      ...current,
      sourceCursor,
      rowsWritten: current.rowsWritten + rows.length,
    }),
    disposition: 'continue',
  };
}

async function runSingleStep(
  context: TenantBackupStepContext,
  input: RestoreStepInput,
  mode: 'write' | 'defer' | 'verify',
  prefetched?: Awaited<ReturnType<RestoreStepInput['readNextValidatedRow']>>
): Promise<TenantBackupStepResult> {
  context.signal.throwIfAborted();
  const phase = {
    write: 'apply_sqlite_dataset',
    defer: 'apply_sqlite_dataset_deferred',
    verify: 'verify_sqlite_dataset',
  }[mode];
  if (
    context.operation.phase !== phase ||
    context.operation.kind !== 'import' ||
    context.operation.state !== 'running'
  )
    invalid();
  let value: unknown;
  try {
    value = JSON.parse(context.operation.cursor_json ?? 'null');
  } catch {
    return invalid();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const cursor = value as Record<string, unknown>;
  const expectedKeys =
    mode === 'write'
      ? 'datasetId,rowsWritten,sourceCursor,targetId,targetOrdinal,version'
      : mode === 'defer'
        ? 'datasetId,deferredSourceCursor,rowsDeferred,rowsWritten,sourceCursor,targetId,targetOrdinal,version'
        : 'datasetId,rowsVerified,rowsWritten,sourceCursor,targetId,targetOrdinal,verifySourceCursor,version';
  if (
    Object.keys(cursor).sort().join(',') !== expectedKeys ||
    cursor.version !== 1 ||
    cursor.targetId !== input.targetId ||
    cursor.targetOrdinal !== input.ordinal ||
    cursor.datasetId !== input.policy.dataset.id ||
    !Number.isSafeInteger(cursor.rowsWritten) ||
    (cursor.rowsWritten as number) < 0 ||
    (cursor.rowsWritten as number) >= Number.MAX_SAFE_INTEGER ||
    (cursor.sourceCursor !== null &&
      (typeof cursor.sourceCursor !== 'string' ||
        !cursor.sourceCursor ||
        cursor.sourceCursor.length > 4096))
  )
    invalid();
  // Held rows advance the authenticated source cursor without increasing target row count.
  if (cursor.sourceCursor === null && cursor.rowsWritten !== 0) invalid();
  if (
    mode === 'verify' &&
    (!Number.isSafeInteger(cursor.rowsVerified) ||
      (cursor.rowsVerified as number) < 0 ||
      (cursor.rowsVerified as number) > (cursor.rowsWritten as number) ||
      (cursor.verifySourceCursor !== null &&
        (typeof cursor.verifySourceCursor !== 'string' ||
          !cursor.verifySourceCursor ||
          cursor.verifySourceCursor.length > 4096)) ||
      (cursor.verifySourceCursor === null && cursor.rowsVerified !== 0))
  )
    invalid();
  if (
    mode === 'defer' &&
    (!Number.isSafeInteger(cursor.rowsDeferred) ||
      (cursor.rowsDeferred as number) < 0 ||
      (cursor.rowsDeferred as number) > (cursor.rowsWritten as number) ||
      (cursor.deferredSourceCursor !== null &&
        (typeof cursor.deferredSourceCursor !== 'string' ||
          !cursor.deferredSourceCursor ||
          cursor.deferredSourceCursor.length > 4096)) ||
      (cursor.deferredSourceCursor === null) !== (cursor.rowsDeferred === 0))
  )
    invalid();
  const current = cursor as unknown as SqliteRestoreDatasetCursor & {
    deferredSourceCursor?: string | null;
    rowsDeferred?: number;
    verifySourceCursor?: string | null;
    rowsVerified?: number;
  };
  const sourceCursor =
    mode === 'verify'
      ? (current.verifySourceCursor ?? null)
      : mode === 'defer'
        ? (current.deferredSourceCursor ?? null)
        : current.sourceCursor;
  const manifest = structuredClone(input.manifest);
  const policy = cloneSqliteDatasetInspectionPolicy(input.policy);
  if (manifest.source.tenantId !== context.lease.tenantId) invalid();
  const head = await input.inventory.headForLease(context.lease);
  let next: Awaited<ReturnType<RestoreStepInput['readNextValidatedRow']>>;
  if (prefetched === null) next = null;
  else
    try {
      next = await input.readNextValidatedRow({
        datasetId: current.datasetId,
        sourceCursor,
        planDigest: head.chain_digest,
      });
    } catch {
      throw new Error('backup_restore_source_read_failed');
    }
  context.signal.throwIfAborted();
  // A source read may yield long enough for cancellation, routing or validation state to change.
  await input.inventory.headForLease(context.lease);
  await input.assertValidatedUnpublishedPlan(head.chain_digest);
  if (next === null) {
    if (policy.restoreDisposition === 'reference_only') {
      if (mode === 'defer') invalid();
      if (mode === 'verify') {
        if (current.rowsVerified !== current.rowsWritten) invalid();
        return {
          phase: 'advance_restore_dataset',
          cursor: JSON.stringify(current),
          disposition: 'continue',
        };
      }
      if (current.sourceCursor === null && current.rowsWritten === 0)
        return {
          phase: 'advance_restore_dataset',
          cursor: JSON.stringify({ ...current, verifySourceCursor: null, rowsVerified: 0 }),
          disposition: 'continue',
        };
      return {
        phase: 'verify_sqlite_dataset',
        cursor: JSON.stringify({ ...current, verifySourceCursor: null, rowsVerified: 0 }),
        disposition: 'continue',
      };
    }
    let target: Awaited<ReturnType<typeof openPlannedSqliteRestoreTarget>>;
    try {
      target = await openPlannedSqliteRestoreTarget({ ...input, context });
    } catch {
      throw new Error('backup_restore_target_open_failed');
    }
    if (mode === 'write' && current.sourceCursor === null && current.rowsWritten === 0) {
      try {
        await target.verifyDataset(policy, 0);
      } catch {
        throw new Error('backup_restore_dataset_verify_failed');
      }
      return {
        phase: 'advance_restore_dataset',
        cursor: JSON.stringify({ ...current, verifySourceCursor: null, rowsVerified: 0 }),
        disposition: 'continue',
      };
    }
    if (mode === 'verify') {
      if (current.rowsVerified !== current.rowsWritten) invalid();
      try {
        await target.verifyDataset(policy, current.rowsWritten);
      } catch {
        throw new Error('backup_restore_dataset_verify_failed');
      }
      return {
        phase: 'advance_restore_dataset',
        cursor: JSON.stringify(current),
        disposition: 'continue',
      };
    }
    if (mode === 'defer') {
      if (current.rowsDeferred !== current.rowsWritten) invalid();
      return {
        phase: 'verify_sqlite_dataset',
        cursor: JSON.stringify({
          version: 1,
          targetId: current.targetId,
          targetOrdinal: current.targetOrdinal,
          datasetId: current.datasetId,
          sourceCursor: current.sourceCursor,
          rowsWritten: current.rowsWritten,
          verifySourceCursor: null,
          rowsVerified: 0,
        }),
        disposition: 'continue',
      };
    }
    if (policy.deferredColumns?.length && current.rowsWritten > 0)
      return {
        phase: 'apply_sqlite_dataset_deferred',
        cursor: JSON.stringify({
          ...current,
          deferredSourceCursor: null,
          rowsDeferred: 0,
        }),
        disposition: 'continue',
      };
    return {
      phase: 'verify_sqlite_dataset',
      cursor: JSON.stringify({ ...current, verifySourceCursor: null, rowsVerified: 0 }),
      disposition: 'continue',
    };
  }
  if (
    typeof next.rowJson !== 'string' ||
    typeof next.nextCursor !== 'string' ||
    !next.nextCursor ||
    next.nextCursor.length > 4096 ||
    next.nextCursor === sourceCursor
  )
    invalid();
  if (policy.restoreDisposition === 'reference_only') {
    if (mode === 'defer') invalid();
  } else {
    const held = policy.restoreHold
      ? await policy.restoreHold.shouldHold(context, next.rowJson)
      : false;
    if (held) {
      if (mode === 'defer') invalid();
      await input.inventory.headForLease(context.lease);
      await input.assertValidatedUnpublishedPlan(head.chain_digest);
      if (mode === 'verify') await policy.restoreHold?.verify(context, next.rowJson);
      else await policy.restoreHold?.write(context, next.rowJson);
      context.signal.throwIfAborted();
      return {
        phase,
        cursor: JSON.stringify(
          mode === 'verify'
            ? { ...current, verifySourceCursor: next.nextCursor }
            : { ...current, sourceCursor: next.nextCursor }
        ),
        disposition: 'continue',
      };
    }
    let rowJson: string;
    try {
      rowJson = policy.restoreTransform
        ? await policy.restoreTransform.transform(context, next.rowJson, mode)
        : next.rowJson;
    } catch (error) {
      throw rowTransformFailure(error);
    }
    if (typeof rowJson !== 'string' || !rowJson) invalid();
    assertTenantBackupSqliteRowFits(rowJson);
    // Mapping or other installed transforms may yield; recheck the exact plan before mutation.
    await input.inventory.headForLease(context.lease);
    await input.assertValidatedUnpublishedPlan(head.chain_digest);
    let target: Awaited<ReturnType<typeof openPlannedSqliteRestoreTarget>>;
    try {
      target = await openPlannedSqliteRestoreTarget({ ...input, context });
    } catch {
      throw new Error('backup_restore_target_open_failed');
    }
    if (mode === 'verify') {
      if ((current.rowsVerified ?? 0) >= current.rowsWritten) invalid();
      try {
        await target.verifyRow(policy, manifest, rowJson);
      } catch {
        throw new Error('backup_restore_row_verify_failed');
      }
    } else if (mode === 'defer') {
      if ((current.rowsDeferred ?? 0) >= current.rowsWritten) invalid();
      try {
        await target.restoreDeferredRow(policy, manifest, rowJson);
      } catch {
        throw new Error('backup_restore_deferred_write_failed');
      }
    } else {
      try {
        await target.writeRow(policy, manifest, rowJson);
      } catch {
        throw new Error('backup_restore_row_write_failed');
      }
    }
  }
  if (mode === 'verify') {
    if ((current.rowsVerified ?? 0) >= current.rowsWritten) invalid();
  } else if (mode === 'defer') {
    if ((current.rowsDeferred ?? 0) >= current.rowsWritten) invalid();
  }
  context.signal.throwIfAborted();
  return {
    phase,
    cursor: JSON.stringify(
      mode === 'verify'
        ? {
            ...current,
            verifySourceCursor: next.nextCursor,
            rowsVerified: (current.rowsVerified ?? 0) + 1,
          }
        : mode === 'defer'
          ? {
              ...current,
              deferredSourceCursor: next.nextCursor,
              rowsDeferred: (current.rowsDeferred ?? 0) + 1,
            }
          : { ...current, sourceCursor: next.nextCursor, rowsWritten: current.rowsWritten + 1 }
    ),
    disposition: 'continue',
  };
}
