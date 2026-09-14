import type { TenantBackupStepContext, TenantBackupStepResult } from './operation-executor';
import type { TenantBundleManifest } from './bundle-manifest';
import type { SqliteDatasetInspectionPolicy } from './sqlite-dataset-inspector';
import { openPlannedSqliteRestoreTarget } from './sqlite-restore-plan';

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

/**
 * Apply one validated SQL row per durable slice. Sources must come from the pinned validated
 * input set and installed module policy; this is not a generic JSON upload or live-table writer.
 * EOF advances to dataset verification, never activation or ready. Checkpointing belongs to the
 * common executor, so an uncertain write is retried at the same cursor without replacing a row.
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
  return runStep(context, input, false);
}
export async function runSqliteRestoreDatasetVerificationStep(
  context: TenantBackupStepContext,
  input: RestoreStepInput
): Promise<TenantBackupStepResult> {
  return runStep(context, input, true);
}
async function runStep(
  context: TenantBackupStepContext,
  input: RestoreStepInput,
  verify: boolean
): Promise<TenantBackupStepResult> {
  context.signal.throwIfAborted();
  if (
    context.operation.phase !== (verify ? 'verify_sqlite_dataset' : 'apply_sqlite_dataset') ||
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
  if (
    Object.keys(cursor).sort().join(',') !==
      (verify
        ? 'datasetId,rowsVerified,rowsWritten,sourceCursor,targetId,targetOrdinal,verifySourceCursor,version'
        : 'datasetId,rowsWritten,sourceCursor,targetId,targetOrdinal,version') ||
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
  if ((cursor.sourceCursor === null) !== (cursor.rowsWritten === 0)) invalid();
  if (
    verify &&
    (!Number.isSafeInteger(cursor.rowsVerified) ||
      (cursor.rowsVerified as number) < 0 ||
      (cursor.rowsVerified as number) > (cursor.rowsWritten as number) ||
      (cursor.verifySourceCursor !== null &&
        (typeof cursor.verifySourceCursor !== 'string' ||
          !cursor.verifySourceCursor ||
          cursor.verifySourceCursor.length > 4096)) ||
      (cursor.verifySourceCursor === null) !== (cursor.rowsVerified === 0))
  )
    invalid();
  const current = cursor as unknown as SqliteRestoreDatasetCursor & {
    verifySourceCursor?: string | null;
    rowsVerified?: number;
  };
  const sourceCursor = verify ? (current.verifySourceCursor ?? null) : current.sourceCursor;
  const manifest = structuredClone(input.manifest);
  const policy = {
    ...structuredClone({ ...input.policy, inspectRow: undefined }),
    inspectRow: input.policy.inspectRow,
  };
  if (manifest.source.tenantId !== context.lease.tenantId) invalid();
  const head = await input.inventory.headForLease(context.lease);
  const target = await openPlannedSqliteRestoreTarget({ ...input, context });
  const next = await input.readNextValidatedRow({
    datasetId: current.datasetId,
    sourceCursor,
    planDigest: head.chain_digest,
  });
  context.signal.throwIfAborted();
  // A source read may yield long enough for cancellation, routing or validation state to change.
  await input.inventory.headForLease(context.lease);
  await input.assertValidatedUnpublishedPlan(head.chain_digest);
  if (next === null) {
    if (verify) {
      if (current.rowsVerified !== current.rowsWritten) invalid();
      await target.verifyDataset(policy, current.rowsWritten);
      return {
        phase: 'advance_restore_dataset',
        cursor: JSON.stringify(current),
        disposition: 'continue',
      };
    }
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
  if (verify) {
    if ((current.rowsVerified ?? 0) >= current.rowsWritten) invalid();
    await target.verifyRow(policy, manifest, next.rowJson);
  } else await target.writeRow(policy, manifest, next.rowJson);
  context.signal.throwIfAborted();
  return {
    phase: verify ? 'verify_sqlite_dataset' : 'apply_sqlite_dataset',
    cursor: JSON.stringify(
      verify
        ? {
            ...current,
            verifySourceCursor: next.nextCursor,
            rowsVerified: (current.rowsVerified ?? 0) + 1,
          }
        : { ...current, sourceCursor: next.nextCursor, rowsWritten: current.rowsWritten + 1 }
    ),
    disposition: 'continue',
  };
}
