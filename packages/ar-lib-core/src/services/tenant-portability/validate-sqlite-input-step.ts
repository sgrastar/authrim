import type { TenantBackupStepContext, TenantBackupStepResult } from './operation-executor';
import type { DatabaseAdapter } from '../../db/adapter';
import type { SqliteDatasetInspectionPolicy } from './sqlite-dataset-inspector';
import type { TenantBundleManifest } from './bundle-manifest';
import { DatabaseTenantBundleReferenceIndex } from './validation-index';
import { inspectSqliteInputRow } from './sqlite-input-inspection';

function fail(): never {
  throw new Error('backup_sqlite_validation_step_invalid');
}
interface Cursor {
  version: 1;
  sessionId: string;
  bundleId: string;
  datasetId: string;
  sourceCursor: string | null;
  rows: number;
}

/** One installed-policy SQL row inspection per slice; dataset completion is not whole-input validity. */
export async function runSqliteInputValidationStep(
  context: TenantBackupStepContext,
  input: {
    database: Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>;
    now: () => number;
    sessionId: string;
    policy: SqliteDatasetInspectionPolicy;
    manifest: TenantBundleManifest;
    assertPinnedInput: () => Promise<void>;
    readNextRow: (cursor: string | null) => Promise<{ rowJson: string; nextCursor: string } | null>;
  }
): Promise<TenantBackupStepResult> {
  const { operation, lease, signal } = context;
  if (
    operation.kind !== 'import' ||
    operation.state !== 'running' ||
    operation.phase !== 'validate_sqlite_dataset' ||
    operation.id !== lease.operationId ||
    operation.tenant_id !== lease.tenantId ||
    input.manifest.source.tenantId !== lease.tenantId
  )
    fail();
  let cursor: Cursor;
  try {
    cursor = JSON.parse(operation.cursor_json ?? 'null') as Cursor;
  } catch {
    return fail();
  }
  if (
    !cursor ||
    Object.keys(cursor).sort().join(',') !==
      'bundleId,datasetId,rows,sessionId,sourceCursor,version' ||
    cursor.version !== 1 ||
    cursor.sessionId !== input.sessionId ||
    cursor.bundleId !== input.manifest.bundleId ||
    cursor.datasetId !== input.policy.dataset.id ||
    !Number.isSafeInteger(cursor.rows) ||
    cursor.rows < 0 ||
    cursor.rows >= Number.MAX_SAFE_INTEGER ||
    (cursor.sourceCursor !== null &&
      (typeof cursor.sourceCursor !== 'string' ||
        !cursor.sourceCursor ||
        cursor.sourceCursor.length > 4096)) ||
    (cursor.rows === 0) !== (cursor.sourceCursor === null)
  )
    fail();
  const assertPinned = async () => {
    signal.throwIfAborted();
    await input.assertPinnedInput();
    signal.throwIfAborted();
  };
  await assertPinned();
  const index = await DatabaseTenantBundleReferenceIndex.resume(
    input.database,
    input.sessionId,
    lease,
    input.now
  );
  const row = await input.readNextRow(cursor.sourceCursor);
  await assertPinned();
  if (!row)
    return {
      phase: 'advance_validation_dataset',
      cursor: JSON.stringify(cursor),
      disposition: 'continue',
    };
  if (
    typeof row.nextCursor !== 'string' ||
    !row.nextCursor ||
    row.nextCursor.length > 4096 ||
    row.nextCursor === cursor.sourceCursor
  )
    fail();
  await inspectSqliteInputRow({
    policy: input.policy,
    manifest: input.manifest,
    rowJson: row.rowJson,
    rowOrdinal: cursor.rows,
    index,
    assertPinnedInput: assertPinned,
  });
  return {
    phase: 'validate_sqlite_dataset',
    cursor: JSON.stringify({ ...cursor, rows: cursor.rows + 1, sourceCursor: row.nextCursor }),
    disposition: 'continue',
  };
}
