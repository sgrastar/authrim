import type { BackupSchemaIndex } from './sqlite-schema-types';

/** Closed expression vocabulary from deployed schemas; never executable bundle SQL. */
export type SnapshotUniqueTerm =
  | { kind: 'column'; column: string }
  | { kind: 'coalesce_empty'; column: string }
  | { kind: 'json_extract'; column: string; path: string }
  | {
      kind: 'conditional_column' | 'conditional_coalesce_empty';
      column: string;
      conditions: readonly { column: string; equals: string }[];
    };

function indexBody(table: string, index: BackupSchemaIndex): string | null {
  if (!index.sql || !index.unique) return null;
  const header =
    /^\s*CREATE\s+UNIQUE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z][a-z0-9_]*)"?\s+ON\s+"?([a-z][a-z0-9_]*)"?\s*\(/i.exec(
      index.sql
    );
  if (!header || header[1] !== index.name || header[2] !== table) return null;
  let depth = 1;
  let quoted = false;
  for (let offset = header[0].length; offset < index.sql.length; offset++) {
    const character = index.sql[offset];
    if (character === "'") {
      if (quoted && index.sql[offset + 1] === "'") offset++;
      else quoted = !quoted;
    } else if (!quoted && character === '(') depth++;
    else if (!quoted && character === ')') {
      depth--;
      if (depth === 0) {
        const tail = index.sql
          .slice(offset + 1)
          .trim()
          .replace(/;$/, '')
          .trim();
        if (tail && !/^WHERE\s+[\s\S]+$/i.test(tail)) return null;
        return index.sql.slice(header[0].length, offset);
      }
    }
  }
  return null;
}

function splitTerms(body: string): string[] | null {
  const terms: string[] = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  for (let offset = 0; offset < body.length; offset++) {
    const character = body[offset];
    if (character === "'") {
      if (quoted && body[offset + 1] === "'") offset++;
      else quoted = !quoted;
    } else if (!quoted && character === '(') depth++;
    else if (!quoted && character === ')') depth--;
    else if (!quoted && character === ',' && depth === 0) {
      terms.push(body.slice(start, offset).trim());
      start = offset + 1;
    }
    if (depth < 0) return null;
  }
  terms.push(body.slice(start).trim());
  return !quoted && depth === 0 && terms.every(Boolean) ? terms : null;
}

function parseConditional(value: string, columns: readonly string[]): SnapshotUniqueTerm | null {
  const match = /^CASE\s+WHEN\s+([\s\S]+?)\s+THEN\s+([\s\S]+?)\s+ELSE\s+NULL\s+END$/i.exec(value);
  if (!match) return null;
  const conditions = match[1].split(/\s+AND\s+/i).map((condition) => {
    const parsed = /^"?([a-z][a-z0-9_]*)"?\s*=\s*'([A-Za-z0-9_.:-]{0,64})'$/i.exec(
      condition.trim()
    );
    return parsed ? { column: parsed[1], equals: parsed[2] } : null;
  });
  if (
    !conditions.length ||
    conditions.some((condition) => !condition || !columns.includes(condition.column))
  )
    return null;
  const result = /^"?([a-z][a-z0-9_]*)"?$/i.exec(match[2].trim());
  const coalesced = /^COALESCE\s*\(\s*"?([a-z][a-z0-9_]*)"?\s*,\s*''\s*\)$/i.exec(match[2].trim());
  const column = result?.[1] ?? coalesced?.[1];
  if (!column || !columns.includes(column)) return null;
  return {
    kind: coalesced ? 'conditional_coalesce_empty' : 'conditional_column',
    column,
    conditions: conditions as { column: string; equals: string }[],
  };
}

export function readSnapshotUniqueTerms(
  table: string,
  columns: readonly string[],
  index: BackupSchemaIndex
): SnapshotUniqueTerm[] | null {
  const body = indexBody(table, index);
  const rawTerms = body === null ? null : splitTerms(body);
  if (!rawTerms) return null;
  const result: SnapshotUniqueTerm[] = [];
  for (const raw of rawTerms) {
    const value = raw.replace(/\s+(?:ASC|DESC)\s*$/i, '').trim();
    const coalesced = /^COALESCE\s*\(\s*"?([a-z][a-z0-9_]*)"?\s*,\s*''\s*\)$/i.exec(value);
    const extracted =
      /^json_extract\s*\(\s*"?([a-z][a-z0-9_]*)"?\s*,\s*'(\$(?:\.[a-z_][a-z0-9_]*)+)'\s*\)$/i.exec(
        value
      );
    const plain = /^"?([a-z][a-z0-9_]*)"?$/i.exec(value);
    const conditional = parseConditional(value, columns);
    const column = coalesced?.[1] ?? extracted?.[1] ?? plain?.[1] ?? conditional?.column;
    if (!column || !columns.includes(column)) return null;
    if (conditional) result.push(conditional);
    else if (coalesced) result.push({ kind: 'coalesce_empty', column });
    else if (extracted?.[2]) result.push({ kind: 'json_extract', column, path: extracted[2] });
    else if (plain) result.push({ kind: 'column', column });
    else return null;
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
    case 'conditional_column':
    case 'conditional_coalesce_empty': {
      if (
        !term.conditions.length ||
        term.conditions.some(
          (condition) =>
            !columns.includes(condition.column) || !/^[A-Za-z0-9_.:-]{0,64}$/.test(condition.equals)
        )
      )
        throw new Error('snapshot_invalid_unique_expression');
      const conditions = term.conditions
        .map((condition) => `"${alias}"."${condition.column}"='${condition.equals}'`)
        .join(' AND ');
      const selected = term.kind === 'conditional_coalesce_empty' ? `coalesce(${value},'')` : value;
      return `(CASE WHEN ${conditions} THEN ${selected} ELSE NULL END)`;
    }
    default:
      throw new Error('snapshot_invalid_unique_expression');
  }
}
