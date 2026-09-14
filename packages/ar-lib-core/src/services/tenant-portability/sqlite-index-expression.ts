import type { BackupSchemaIndex } from './sqlite-schema-types';

/** Closed expression vocabulary from deployed schemas; never executable bundle SQL. */
export type SnapshotUniqueTerm =
  | { kind: 'column'; column: string }
  | { kind: 'coalesce_empty'; column: string }
  | { kind: 'json_extract'; column: string; path: string };

export function readSnapshotUniqueTerms(
  table: string,
  columns: readonly string[],
  index: BackupSchemaIndex
): SnapshotUniqueTerm[] | null {
  if (!index.sql || !index.unique) return null;
  const header =
    /^\s*CREATE\s+UNIQUE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z][a-z0-9_]*)"?\s+ON\s+"?([a-z][a-z0-9_]*)"?\s*\(([\s\S]*?)\)\s*(?:WHERE\s+[\s\S]*?)?;?\s*$/i.exec(
      index.sql
    );
  if (!header || header[1] !== index.name || header[2] !== table) return null;
  const body = header[3];
  // Every comma consumed here separates complete supported terms, including function arguments.
  const term =
    /\s*(?:COALESCE\s*\(\s*"?([a-z][a-z0-9_]*)"?\s*,\s*''\s*\)|json_extract\s*\(\s*"?([a-z][a-z0-9_]*)"?\s*,\s*'(\$(?:\.[a-z_][a-z0-9_]*)+)'\s*\)|"?([a-z][a-z0-9_]*)"?)(?:\s+(?:ASC|DESC))?\s*(,|$)/iy;
  const result: SnapshotUniqueTerm[] = [];
  while (term.lastIndex < body.length) {
    const match = term.exec(body);
    if (!match) return null;
    const column = match[1] ?? match[2] ?? match[4];
    if (!columns.includes(column)) return null;
    result.push(
      match[1]
        ? { kind: 'coalesce_empty', column }
        : match[2]
          ? { kind: 'json_extract', column, path: match[3] }
          : { kind: 'column', column }
    );
    if (match[5] === ',' && term.lastIndex === body.length) return null;
  }
  const keys = index.columns.filter((column) => column.key);
  if (
    !result.length ||
    keys.length !== result.length ||
    keys.some(
      (key, i) =>
        key.collation.toUpperCase() !== 'BINARY' ||
        (result[i].kind === 'column' ? key.name !== result[i].column : key.name !== null)
    )
  )
    return null;
  return result;
}

export function snapshotUniqueTermSql(
  term: SnapshotUniqueTerm,
  alias: string,
  columns: readonly string[]
): string {
  if (
    !/^[a-z][a-z0-9_]*$/i.test(alias) ||
    !/^[a-z][a-z0-9_]*$/.test(term.column) ||
    !columns.includes(term.column)
  )
    throw new Error('snapshot_invalid_unique_expression');
  const value = `"${alias}"."${term.column}"`;
  switch (term.kind) {
    case 'column':
      return value;
    case 'coalesce_empty':
      return `coalesce(${value},'')`;
    case 'json_extract':
      if (!/^\$(?:\.[a-z_][a-z0-9_]*)+$/i.test(term.path))
        throw new Error('snapshot_invalid_unique_expression');
      // A partial JSON index can coexist with malformed JSON outside its predicate.
      // Totalize extraction before broadening the conflict lookup to a safe superset.
      return `(CASE WHEN json_valid(${value}) THEN json_extract(${value},'${term.path}') END)`;
    default:
      throw new Error('snapshot_invalid_unique_expression');
  }
}
