interface Cursor {
  version: 2;
  offset: number;
}

const MAX_ROW_BYTES = 16 * 1024 * 1024;

function fail(): never {
  throw new Error('backup_container_dataset_invalid');
}

/** Parse a dataset cursor: a byte offset at a row start inside a dataset of `length` bytes. */
export function parseTenantBackupContainerRowCursor(
  sourceCursor: string | null,
  length: number
): number {
  let cursor: Cursor = { version: 2, offset: 0 };
  if (sourceCursor !== null) {
    try {
      cursor = JSON.parse(sourceCursor) as Cursor;
    } catch {
      fail();
    }
  }
  if (
    cursor?.version !== 2 ||
    !Number.isSafeInteger(cursor.offset) ||
    cursor.offset < 0 ||
    cursor.offset > length
  )
    fail();
  return cursor.offset;
}

/** Validate one NDJSON row (without its newline) and build the cursor of the next row. */
export function decodeTenantBackupContainerRow(
  row: Uint8Array,
  offset: number
): { rowJson: string; nextCursor: string } {
  if (!row.length || row.length > MAX_ROW_BYTES) fail();
  let rowJson: string;
  try {
    rowJson = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(row);
    const value: unknown = JSON.parse(rowJson);
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  } catch {
    fail();
  }
  return {
    rowJson,
    nextCursor: JSON.stringify({ version: 2, offset: offset + row.length + 1 }),
  };
}

export const TENANT_BACKUP_CONTAINER_MAX_ROW_BYTES = MAX_ROW_BYTES;

/** Read one NDJSON row from an already authenticated dataset byte range. */
export function readNextTenantBackupContainerRow(
  bytes: Uint8Array,
  sourceCursor: string | null
): { rowJson: string; nextCursor: string } | null {
  const offset = parseTenantBackupContainerRowCursor(sourceCursor, bytes.length);
  if (offset > 0 && bytes[offset - 1] !== 10) fail();
  if (offset === bytes.length) return null;
  const newline = bytes.indexOf(10, offset);
  if (newline < 0) fail();
  return decodeTenantBackupContainerRow(bytes.subarray(offset, newline), offset);
}
