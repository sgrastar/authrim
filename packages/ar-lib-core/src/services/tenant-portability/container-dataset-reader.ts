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

/** Largest row a container may carry (transfer limit, without its newline). */
export const TENANT_BACKUP_CONTAINER_MAX_ROW_BYTES = MAX_ROW_BYTES;

/**
 * Largest SQL row (its JSON plus newline) a restore target accepts. Validation, restore and
 * read-back refuse larger SQL rows up front with `backup_sqlite_row_too_large`. Raising it needs
 * its own design: D1 stores at most about 2 MB per value.
 */
export const TENANT_BACKUP_SQLITE_RESTORE_MAX_ROW_BYTES = 256 * 1024;

/** Throw the permanent `backup_sqlite_row_too_large` for an SQL row a restore target refuses. */
export function assertTenantBackupSqliteRowFits(rowJson: string): void {
  if (new TextEncoder().encode(rowJson).length + 1 > TENANT_BACKUP_SQLITE_RESTORE_MAX_ROW_BYTES)
    throw new Error('backup_sqlite_row_too_large');
}

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
