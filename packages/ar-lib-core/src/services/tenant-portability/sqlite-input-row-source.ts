import type { TenantBackupInputReceipts } from './input-receipts';

type ReplayInput = Parameters<TenantBackupInputReceipts['replay']>[2];
interface RowCursor {
  version: 1;
  bundleId: string;
  datasetId: string;
  sequence: number;
  offset: number;
}
function fail(): never {
  throw new Error('backup_sqlite_input_row_invalid');
}

/**
 * One NDJSON row from immutable encrypted input receipts. The start sequence must be pinned by
 * the validated input planner, and the cursor is operation-owned. This preserves split UTF-8 and
 * rows across frames without rereading earlier rows. The caller still applies installed row policy.
 */
export async function readNextSqliteInputRow(input: {
  receipts: Pick<TenantBackupInputReceipts, 'replay'>;
  replayInput: ReplayInput;
  datasetId: string;
  firstSequence: number;
  sourceCursor: string | null;
  planDigest: string;
  assertValidatedPlan: (digest: string, bundleId: string, datasetId: string) => Promise<void>;
}): Promise<{ rowJson: string; nextCursor: string } | null> {
  const bundleId = input.replayInput.expected.bundleId;
  const datasetId = input.datasetId;
  const first = input.firstSequence;
  if (
    !Number.isSafeInteger(first) ||
    first < 1 ||
    first >= input.replayInput.limits.maxFrames ||
    !/^[a-f0-9]{64}$/.test(input.planDigest)
  )
    fail();
  if (
    !input.replayInput.manifest.datasets.some(
      (dataset) =>
        dataset.id === datasetId &&
        dataset.store === 'database' &&
        dataset.disposition === 'include'
    )
  )
    fail();
  let cursor: RowCursor = { version: 1, bundleId, datasetId, sequence: first, offset: 0 };
  if (input.sourceCursor !== null) {
    if (typeof input.sourceCursor !== 'string' || input.sourceCursor.length > 4096) fail();
    try {
      cursor = JSON.parse(input.sourceCursor) as RowCursor;
    } catch {
      fail();
    }
    if (
      !cursor ||
      Object.keys(cursor).sort().join(',') !== 'bundleId,datasetId,offset,sequence,version' ||
      cursor.version !== 1 ||
      cursor.bundleId !== bundleId ||
      cursor.datasetId !== datasetId ||
      !Number.isSafeInteger(cursor.sequence) ||
      cursor.sequence < first ||
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 0
    )
      fail();
  }
  async function authorize(): Promise<void> {
    input.replayInput.signal.throwIfAborted();
    await input.assertValidatedPlan(input.planDigest, bundleId, datasetId);
    input.replayInput.signal.throwIfAborted();
  }
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let fragments: string[] = [];
  let rowBytes = 0;
  function append(text: string): void {
    if (!text) return;
    while (fragments.length && fragments[fragments.length - 1].length <= text.length)
      text = fragments.pop() + text;
    fragments.push(text);
  }
  while (cursor.sequence < input.replayInput.limits.maxFrames) {
    await authorize();
    const event = await input.receipts.replay(bundleId, cursor.sequence, input.replayInput);
    if (event.kind === 'dataset_end') {
      if (event.datasetId !== datasetId || cursor.offset !== 0 || rowBytes) fail();
      await authorize();
      return null;
    }
    if (
      event.kind !== 'chunk' ||
      event.datasetId !== datasetId ||
      cursor.offset >= event.bytes.length ||
      (cursor.offset > 0 && event.bytes[cursor.offset - 1] !== 10)
    )
      fail();
    const newline = event.bytes.indexOf(10, cursor.offset);
    const end = newline < 0 ? event.bytes.length : newline;
    const part = event.bytes.subarray(cursor.offset, end);
    rowBytes += part.length;
    if (rowBytes > 16 * 1024 * 1024) fail();
    append(decoder.decode(part, { stream: newline < 0 }));
    if (newline >= 0) {
      const rowJson = fragments.join('');
      if (!rowBytes) fail();
      // Shape/business validation belongs to the installed SQLite dataset policy.
      try {
        const row: unknown = JSON.parse(rowJson);
        if (!row || typeof row !== 'object' || Array.isArray(row)) fail();
      } catch {
        fail();
      }
      cursor = {
        ...cursor,
        sequence: newline + 1 === event.bytes.length ? cursor.sequence + 1 : cursor.sequence,
        offset: newline + 1 === event.bytes.length ? 0 : newline + 1,
      };
      await authorize();
      return { rowJson, nextCursor: JSON.stringify(cursor) };
    }
    cursor = { ...cursor, sequence: cursor.sequence + 1, offset: 0 };
  }
  return fail();
}
