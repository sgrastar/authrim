import type { TenantBackupStepContext, TenantBackupStepResult } from './operation-executor';
import type { DatabaseAdapter } from '../../db/adapter';
import type { SqliteDatasetInspectionPolicy } from './sqlite-dataset-inspector';
import type { TenantBundleManifest } from './bundle-manifest';
import { DatabaseTenantBundleReferenceIndex } from './validation-index';
import { inspectSqliteInputRow } from './sqlite-input-inspection';
import {
  assertTenantBackupSqliteRowFits,
  TENANT_BACKUP_CONTAINER_MAX_ROW_BYTES,
} from './container-dataset-reader';

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

const VALIDATION_BATCH_ROWS = 1000;
const VALIDATION_BATCH_BYTES = 4 * 1024 * 1024;
/** Index records plus reference edges written by one batch (~2 D1 round trips per 50). */
const VALIDATION_BATCH_ENTRIES = 4000;

/** Inspect one bounded dataset batch and save only the batch-level operation checkpoint. */
export async function runSqliteInputValidationStep(
  context: TenantBackupStepContext,
  input: {
    database: Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'> &
      Partial<Pick<DatabaseAdapter, 'batch'>>;
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
  // With D1 batches the whole slice's index entries are written together (idempotent, read back);
  // without them each entry is written and read back on its own.
  const records: Parameters<
    DatabaseTenantBundleReferenceIndex['recordInspectionBatch']
  >[0]['records'][number][] = [];
  const references: Parameters<
    DatabaseTenantBundleReferenceIndex['recordInspectionBatch']
  >[0]['references'][number][] = [];
  const collector: Pick<DatabaseTenantBundleReferenceIndex, 'recordOnce' | 'referenceOnce'> = {
    async recordOnce(bundleId, sourceId, record) {
      records.push({ bundleId, sourceId, record });
      return true;
    },
    async referenceOnce(bundleId, sourceEdgeId, dependency) {
      references.push({ bundleId, sourceEdgeId, dependency });
    },
  };
  const batched = Boolean(input.database.batch);
  let sourceCursor = cursor.sourceCursor;
  let rows = cursor.rows;
  let bytes = 0;
  let complete = false;
  for (let count = 0; count < VALIDATION_BATCH_ROWS; count++) {
    const row = await input.readNextRow(sourceCursor);
    if (!row) {
      complete = true;
      break;
    }
    if (
      typeof row.nextCursor !== 'string' ||
      !row.nextCursor ||
      row.nextCursor.length > 4096 ||
      row.nextCursor === sourceCursor
    )
      fail();
    const rowBytes = new TextEncoder().encode(row.rowJson).length;
    // The batch bound limits a slice's total; a single row may exceed it (up to the container's
    // row limit) and is then validated alone, so every slice makes progress.
    if (rowBytes > TENANT_BACKUP_CONTAINER_MAX_ROW_BYTES)
      throw new Error('backup_sqlite_row_too_large');
    // SQL rows must also fit the restore target, or restore would fail on them much later.
    if (input.policy.dataset.store === 'database') assertTenantBackupSqliteRowFits(row.rowJson);
    if (count > 0 && bytes + rowBytes > VALIDATION_BATCH_BYTES) break;
    const recordCount = records.length;
    const referenceCount = references.length;
    await inspectSqliteInputRow({
      context,
      policy: input.policy,
      manifest: input.manifest,
      rowJson: row.rowJson,
      rowOrdinal: rows,
      index: batched ? collector : index,
      assertPinnedInput: async () => {},
    });
    if (count > 0 && records.length + references.length > VALIDATION_BATCH_ENTRIES) {
      // Leave this row for the next slice; its entries were only collected, never written.
      records.length = recordCount;
      references.length = referenceCount;
      break;
    }
    sourceCursor = row.nextCursor;
    rows++;
    bytes += rowBytes;
  }
  if (records.length || references.length)
    await index.recordInspectionBatch({ records, references });
  await assertPinned();
  return {
    phase: complete ? 'advance_validation_dataset' : 'validate_sqlite_dataset',
    cursor: JSON.stringify({ ...cursor, rows, sourceCursor }),
    disposition: 'continue',
  };
}
