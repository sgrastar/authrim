interface Cursor {
  version: 2;
  offset: number;
}

function fail(): never {
  throw new Error('backup_container_dataset_invalid');
}

/** Read one NDJSON row from an already authenticated dataset byte range. */
export function readNextTenantBackupContainerRow(
  bytes: Uint8Array,
  sourceCursor: string | null
): { rowJson: string; nextCursor: string } | null {
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
    cursor.offset > bytes.length ||
    (cursor.offset > 0 && bytes[cursor.offset - 1] !== 10)
  )
    fail();
  if (cursor.offset === bytes.length) return null;
  const newline = bytes.indexOf(10, cursor.offset);
  if (newline < 0 || newline === cursor.offset || newline - cursor.offset > 16 * 1024 * 1024)
    fail();
  let rowJson: string;
  try {
    rowJson = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(cursor.offset, newline)
    );
    const row: unknown = JSON.parse(rowJson);
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail();
  } catch {
    fail();
  }
  return { rowJson, nextCursor: JSON.stringify({ version: 2, offset: newline + 1 }) };
}
