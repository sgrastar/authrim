import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import type { VerifiedTenantBackupV2 } from './backup-reader';

const MAX_ROWS_PER_DATASET = 100_000;
const SAFE_COLUMN = /^[a-z][a-z0-9_]{0,127}$/u;

function invalid(): never {
  throw new Error('aws_backup_dataset_invalid');
}

export function parsePortableRow(value: string): PortableSqliteRow {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    return invalid();
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) invalid();
  const row = decoded as Record<string, unknown>;
  if (
    Object.keys(row).some((name) => {
      const cell = row[name];
      return (
        !SAFE_COLUMN.test(name) ||
        !Array.isArray(cell) ||
        cell.length !== 2 ||
        !['null', 'text', 'integer', 'real', 'blob'].includes(cell[0] as string) ||
        (cell[0] === 'null' ? cell[1] !== null : typeof cell[1] !== 'string')
      );
    })
  ) {
    invalid();
  }
  return row as PortableSqliteRow;
}

export async function readVerifiedRows(
  backup: VerifiedTenantBackupV2,
  datasetId: string
): Promise<PortableSqliteRow[]> {
  const dataset = backup.dataset(datasetId);
  if (dataset.rows > MAX_ROWS_PER_DATASET) invalid();
  const rows: PortableSqliteRow[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  while (true) {
    const next = await dataset.readNextRow(cursor);
    if (!next) break;
    if (!next.nextCursor || cursors.has(next.nextCursor) || rows.length >= MAX_ROWS_PER_DATASET) {
      invalid();
    }
    cursors.add(next.nextCursor);
    rows.push(parsePortableRow(next.rowJson));
    cursor = next.nextCursor;
  }
  if (rows.length !== dataset.rows) invalid();
  return rows;
}

export function rowText(row: PortableSqliteRow, name: string): string {
  const cell = row[name];
  if (!cell || cell[0] !== 'text' || typeof cell[1] !== 'string') invalid();
  return cell[1];
}

export function rowNullableText(row: PortableSqliteRow, name: string): string | null {
  const cell = row[name];
  if (!cell || cell[0] === 'null') return null;
  return rowText(row, name);
}

export function rowInteger(row: PortableSqliteRow, name: string, minimum = 0): number {
  const cell = row[name];
  if (!cell || cell[0] !== 'integer' || typeof cell[1] !== 'string') invalid();
  if (!/^-?(?:0|[1-9][0-9]*)$/u.test(cell[1])) invalid();
  const value = Number(cell[1]);
  if (!Number.isSafeInteger(value) || value < minimum) invalid();
  return value;
}

export function rowOptionalInteger(row: PortableSqliteRow, name: string): number | null {
  const cell = row[name];
  if (!cell || cell[0] === 'null') return null;
  return rowInteger(row, name);
}

export function rowSqliteValue(row: PortableSqliteRow, name: string): string | number | null {
  const cell = row[name];
  if (!cell) invalid();
  if (cell[0] === 'null') return null;
  if (cell[0] === 'text') return rowText(row, name);
  if (cell[0] === 'integer' || cell[0] === 'real') {
    const value = Number(cell[1]);
    if (!Number.isFinite(value) || (cell[0] === 'integer' && !Number.isSafeInteger(value)))
      invalid();
    return value;
  }
  // Mapping and settings tables have no opaque BLOB fields in this limited profile.
  return invalid();
}
