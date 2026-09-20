import type { SchemaTable } from './schema-inventory.js';
import { classifyPrimaryKey } from './inventory.js';
import { renderPortableMigrationSql } from '../../packages/ar-lib-core/src/migrations/sql-portability.js';

function portableDefinition(sql: string): string {
  for (const token of [
    '__AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__',
    '__AUTHRIM_NOW_EPOCH_MILLISECONDS__',
    '__AUTHRIM_NOW_EPOCH_SECONDS__',
  ])
    sql = sql.replaceAll(renderPortableMigrationSql(token, 'sqlite'), token);
  return sql;
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

function rowidAlias(table: SchemaTable): string | undefined {
  if (
    table.withoutRowid ||
    classifyPrimaryKey(table).columns.some((column) => column.guarantee === 'integer_rowid_alias')
  )
    return undefined;
  const columns = new Set(table.columns.map((column) => column.name.toLowerCase()));
  if (columns.has('__authrim_original_rowid'))
    throw new Error('primary_key_reserved_column_collision');
  const alias = ['rowid', '_rowid_', 'oid'].find((name) => !columns.has(name));
  if (!alias) throw new Error(`primary_key_inaccessible_rowid:${table.name}`);
  return alias;
}

/** Split CREATE TABLE fields without splitting expressions, quoted values or comments. */
function fields(sql: string): { start: number; end: number }[] {
  const result = [];
  let depth = 0;
  let start = -1;
  let mode: 'normal' | 'single' | 'double' | 'bracket' | 'backtick' | 'line' | 'block' = 'normal';
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index];
    const next = sql[index + 1];
    if (mode === 'line') {
      if (char === '\n') mode = 'normal';
      continue;
    }
    if (mode === 'block') {
      if (char === '*' && next === '/') {
        mode = 'normal';
        index++;
      }
      continue;
    }
    if (mode !== 'normal') {
      const end = { single: "'", double: '"', bracket: ']', backtick: '`' }[mode];
      if (char === end) {
        if (next === end && mode !== 'bracket') index++;
        else mode = 'normal';
      }
      continue;
    }
    if (char === '-' && next === '-') {
      mode = 'line';
      index++;
      continue;
    }
    if (char === '/' && next === '*') {
      mode = 'block';
      index++;
      continue;
    }
    if (char === "'") {
      mode = 'single';
      continue;
    }
    if (char === '"') {
      mode = 'double';
      continue;
    }
    if (char === '[') {
      mode = 'bracket';
      continue;
    }
    if (char === '`') {
      mode = 'backtick';
      continue;
    }
    if (char === '(') {
      if (depth++ === 0) start = index + 1;
      continue;
    }
    if (char === ')') {
      if (--depth === 0) {
        result.push({ start, end: index });
        return result;
      }
      continue;
    }
    if (char === ',' && depth === 1) {
      result.push({ start, end: index });
      start = index + 1;
    }
  }
  throw new Error('primary_key_create_table_unparsed');
}

export function addPrimaryKeyNotNull(table: SchemaTable): string {
  const needed = new Set(
    classifyPrimaryKey(table)
      .columns.filter((column) => column.guarantee === 'nullable_primary_key')
      .map((column) => column.name)
  );
  if (!needed.size) return table.sql;
  let sql = table.sql;
  for (const field of fields(sql).reverse()) {
    const definition = sql
      .slice(field.start, field.end)
      .replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/u, '');
    const token = definition.match(
      /^(?:"((?:[^"]|"")+)"|`((?:[^`]|``)+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))/u
    );
    const name =
      token?.[1]?.replaceAll('""', '"') ??
      token?.[2]?.replaceAll('``', '`') ??
      token?.[3] ??
      token?.[4];
    if (name && needed.delete(name))
      sql = sql.slice(0, field.end) + '\n NOT NULL\n' + sql.slice(field.end);
  }
  if (needed.size)
    throw new Error(`primary_key_columns_unparsed:${table.name}:${[...needed].join(',')}`);
  return sql;
}

export function buildPrimaryKeyMigration(schema: {
  tables: SchemaTable[];
  objects: Array<{ type: string; name: string; table: string; sql: string }>;
  alternateTableSql?: ReadonlyMap<string, string>;
}): { sql: string; tightened: string[]; rebuilt: string[] } {
  const tightened = schema.tables
    .filter((table) =>
      classifyPrimaryKey(table).columns.some(
        (column) => column.guarantee === 'nullable_primary_key'
      )
    )
    .map((table) => table.name);
  if (!tightened.length) return { sql: '', tightened: [], rebuilt: [] };
  // DROP may cascade into otherwise unchanged child tables. Preserve the complete
  // reverse-FK closure, including cycles, before dropping any original table.
  const rebuild = new Set(tightened);
  let changed = true;
  while (changed) {
    changed = false;
    for (const table of schema.tables)
      if (
        !rebuild.has(table.name) &&
        table.foreignKeys.some((key) => rebuild.has(key.parentTable))
      ) {
        rebuild.add(table.name);
        changed = true;
      }
  }
  const tables = schema.tables.filter((table) => rebuild.has(table.name));
  const dropOrder: SchemaTable[] = [];
  const remaining = new Set(tables.map((table) => table.name));
  while (remaining.size) {
    const ready = tables.filter(
      (table) =>
        remaining.has(table.name) &&
        !tables.some(
          (child) =>
            child.name !== table.name &&
            remaining.has(child.name) &&
            child.foreignKeys.some((key) => key.parentTable === table.name)
        )
    );
    if (!ready.length)
      throw new Error(`primary_key_cyclic_dependencies:${[...remaining].join(',')}`);
    for (const table of ready) {
      dropOrder.push(table);
      remaining.delete(table.name);
    }
  }
  const attached = schema.objects.filter((object) => rebuild.has(object.table));
  const views = schema.objects.filter((object) => object.type === 'view');
  const sql = [
    '-- Apply this entire migration and its history record as one atomic D1 batch.',
    '-- NULL identities are not repaired, removed or assigned automatically.',
    'CREATE TABLE "__authrim_pk_guard" (target TEXT NOT NULL, violations INTEGER NOT NULL CONSTRAINT primary_key_integrity_preflight CHECK (violations = 0));',
  ];
  const guard = (target: string, expression: string) =>
    sql.push(`INSERT INTO "__authrim_pk_guard" VALUES (${literal(target)}, ${expression});`);
  for (const table of tables) {
    guard(
      `schema:${table.name}`,
      `(SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=${literal(table.name)} AND sql IN (${[
        table.sql,
        schema.alternateTableSql?.get(table.name),
      ]
        .filter((value): value is string => value !== undefined)
        .map(literal)
        .join(',')})))`
    );
    const keys = classifyPrimaryKey(table).columns.filter(
      (column) => column.guarantee === 'nullable_primary_key'
    );
    if (keys.length)
      guard(
        `null-primary-key:${table.name}`,
        `(SELECT count(*) FROM ${quote(table.name)} WHERE ${keys.map((key) => `${quote(key.name)} IS NULL`).join(' OR ')})`
      );
  }
  const tableNames = tables.map((table) => literal(table.name)).join(',');
  const objects = [...attached.filter((object) => object.type !== 'view'), ...views];
  for (const object of objects)
    guard(
      `object:${object.name}`,
      `(SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type=${literal(object.type)} AND name=${literal(object.name)} AND sql=${literal(object.sql)}))`
    );
  const expectedNames = objects.map((object) => literal(object.name)).join(',') || "''";
  guard(
    'unknown-schema-objects',
    `(SELECT count(*) FROM sqlite_schema WHERE sql IS NOT NULL AND (type='view' OR (type IN ('index','trigger') AND tbl_name IN (${tableNames}))) AND name NOT IN (${expectedNames}))`
  );
  guard(
    'unknown-dependent-table',
    `(WITH candidates AS MATERIALIZED (SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name NOT GLOB '__cf_*' AND name NOT IN (${tableNames})) SELECT count(*) FROM candidates s JOIN pragma_foreign_key_list(s.name) f WHERE f."table" IN (${tableNames}))`
  );
  for (const table of tables) {
    const columns = table.columns
      .filter((column) => !column.generated)
      .map((column) => quote(column.name))
      .join(',');
    const rowid = rowidAlias(table);
    sql.push(
      `CREATE TABLE ${quote(`__authrim_pk_copy_${table.name}`)} AS SELECT ${rowid ? `${quote(rowid)} AS "__authrim_original_rowid",` : ''}${columns} FROM ${quote(table.name)};`
    );
  }
  const sequences = tables
    .filter((table) => /\bAUTOINCREMENT\b/i.test(table.sql))
    .map((table) => literal(table.name));
  if (sequences.length)
    sql.push(
      `CREATE TABLE "__authrim_pk_sequences" AS SELECT name, seq FROM sqlite_sequence WHERE name IN (${sequences.join(',')});`
    );
  sql.push('PRAGMA defer_foreign_keys = ON;');
  for (const object of objects)
    if (object.type === 'trigger' || object.type === 'view')
      sql.push(`DROP ${object.type.toUpperCase()} ${quote(object.name)};`);
  for (const table of dropOrder) sql.push(`DROP TABLE ${quote(table.name)};`);
  for (const table of tables) sql.push(portableDefinition(addPrimaryKeyNotNull(table)) + ';');
  // Foreign keys can target standalone UNIQUE indexes, so restore indexes before
  // preparing any INSERT into dependent tables. Triggers wait until data is copied.
  for (const object of objects)
    if (object.type === 'index') sql.push(portableDefinition(object.sql) + ';');
  for (const table of tables) {
    const columns = table.columns
      .filter((column) => !column.generated)
      .map((column) => quote(column.name))
      .join(',');
    const rowid = rowidAlias(table);
    sql.push(
      `INSERT INTO ${quote(table.name)} (${rowid ? `${quote(rowid)},` : ''}${columns}) SELECT ${rowid ? '"__authrim_original_rowid",' : ''}${columns} FROM ${quote(`__authrim_pk_copy_${table.name}`)};`
    );
  }
  if (sequences.length)
    sql.push(
      `DELETE FROM sqlite_sequence WHERE name IN (${sequences.join(',')});`,
      'INSERT INTO sqlite_sequence (name,seq) SELECT name,seq FROM "__authrim_pk_sequences";',
      'DROP TABLE "__authrim_pk_sequences";'
    );
  for (const object of objects)
    if (object.type !== 'index') sql.push(portableDefinition(object.sql) + ';');
  guard('foreign-key-check', '(SELECT count(*) FROM pragma_foreign_key_check)');
  for (const table of tables) sql.push(`DROP TABLE ${quote(`__authrim_pk_copy_${table.name}`)};`);
  sql.push('DROP TABLE "__authrim_pk_guard";', 'PRAGMA defer_foreign_keys = OFF;');
  return { sql: sql.join('\n\n') + '\n', tightened, rebuilt: tables.map((table) => table.name) };
}
