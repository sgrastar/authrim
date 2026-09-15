import type { MigrationSchemaFamily } from '../control-plane/migration-stream-contract';
import { TENANT_DATASET_POLICIES } from './dataset-registry';
import type { DatabaseAdapter } from '../../db/adapter';
import type { BackupSchemaTable } from './sqlite-schema-types';

/** Read only a trusted registry table. The coordinator must fence DDL across planning/capture. */
export async function readBackupSqliteSchema(
  database: Pick<DatabaseAdapter, 'query' | 'queryOne'>,
  table: string
): Promise<BackupSchemaTable> {
  if (!/^[a-z][a-z0-9_]*$/.test(table) || table.startsWith('tenant_backup_')) {
    throw new Error('backup_schema_invalid_table');
  }
  return readSchema(database, table);
}

async function readSchema(
  database: Pick<DatabaseAdapter, 'query' | 'queryOne'>,
  table: string
): Promise<BackupSchemaTable> {
  const definition = await database.queryOne<{ sql: string }>(
    "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ? AND sql IS NOT NULL",
    [table]
  );
  const flags = await database.queryOne<{ type: string; wr: number; strict: number }>(
    "SELECT type, wr, strict FROM pragma_table_list WHERE schema = 'main' AND name = ?",
    [table]
  );
  if (!definition || flags?.type !== 'table') throw new Error('backup_schema_missing_table');
  const columns = await database.query<{
    name: string;
    type: string;
    non_null: number;
    dflt_value: string | null;
    pk: number;
    hidden: number;
  }>(
    'SELECT name, type, "notnull" AS non_null, dflt_value, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid',
    [table]
  );
  const indexes = await database.query<{
    name: string;
    is_unique: number;
    origin: string;
    partial: number;
  }>(
    'SELECT name, "unique" AS is_unique, origin, partial FROM pragma_index_list(?) ORDER BY name',
    [table]
  );
  const foreignKeys = await database.query<{
    id: number;
    seq: number;
    parent_table: string;
    child_column: string;
    parent_column: string | null;
    on_update: string;
    on_delete: string;
  }>(
    'SELECT id, seq, "table" AS parent_table, "from" AS child_column, "to" AS parent_column, on_update, on_delete FROM pragma_foreign_key_list(?) ORDER BY id, seq',
    [table]
  );
  const result: BackupSchemaTable = {
    name: table,
    sql: definition.sql,
    withoutRowid: flags.wr === 1,
    strict: flags.strict === 1,
    columns: columns.map((column) => ({
      name: column.name,
      type: column.type,
      notNull: column.non_null === 1,
      defaultSql: column.dflt_value,
      primaryKeyPosition: column.pk,
      generated: column.hidden !== 0,
    })),
    foreignKeys: foreignKeys.map((key) => ({
      id: key.id,
      position: key.seq,
      parentTable: key.parent_table,
      column: key.child_column,
      parentColumn: key.parent_column,
      onUpdate: key.on_update,
      onDelete: key.on_delete,
    })),
    indexes: [],
  };
  for (const index of indexes) {
    const definition = await database.queryOne<{ sql: string | null }>(
      "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?",
      [index.name]
    );
    const columns = await database.query<{
      seqno: number;
      name: string | null;
      coll: string;
      descending: number;
      key: number;
    }>(
      'SELECT seqno, name, coll, "desc" AS descending, key FROM pragma_index_xinfo(?) ORDER BY seqno',
      [index.name]
    );
    result.indexes.push({
      name: index.name,
      unique: index.is_unique === 1,
      origin: index.origin,
      partial: index.partial === 1,
      sql: definition?.sql ?? null,
      columns: columns.map((column) => ({
        position: column.seqno,
        name: column.name,
        collation: column.coll ?? 'BINARY',
        descending: column.descending === 1,
        key: column.key === 1,
      })),
    });
  }
  result.triggers = await database.query<{ name: string; sql: string }>(
    "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=? AND sql IS NOT NULL ORDER BY name",
    [table]
  );
  return result;
}

/** Discover a complete family schema from an already authorized DB. Never accepts a requested table subset. */
export async function readBackupSqliteDatabaseSchema(
  database: Pick<DatabaseAdapter, 'query' | 'queryOne'>,
  family: MigrationSchemaFamily,
  signal: AbortSignal
): Promise<BackupSchemaTable[]> {
  signal.throwIfAborted();
  const before = await schemaDefinitionsDigest(database, signal);
  const rows = await database.query<{ name: string }>(
    "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name"
  );
  if (rows.length > 4096) throw new Error('backup_schema_table_limit');
  const result: BackupSchemaTable[] = [];
  for (const { name } of rows) {
    signal.throwIfAborted();
    // These two tables are local capture scratch, never tenant source data.
    if (name === 'tenant_backup_snapshots' || name === 'tenant_backup_preimages') continue;
    // D1 creates this reserved provider metadata table; its rows are not tenant data.
    if (name === '_cf_METADATA') continue;
    const policies = TENANT_DATASET_POLICIES.filter(
      (policy) => policy.family === family && policy.table === name
    );
    if (policies.length !== 1) throw new Error('backup_schema_unclassified_table');
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error('backup_schema_invalid_table');
    result.push(await readSchema(database, name));
  }
  const after = await schemaDefinitionsDigest(database, signal);
  signal.throwIfAborted();
  if (after !== before) throw new Error('backup_schema_changed_during_inspection');
  return result;
}

/** D1 does not authorize schema_version. Hash bounded pages of schema definitions instead. */
async function schemaDefinitionsDigest(
  database: Pick<DatabaseAdapter, 'query'>,
  signal: AbortSignal
): Promise<string> {
  let after = '',
    afterType = '',
    digest = '0'.repeat(64),
    count = 0;
  for (;;) {
    signal.throwIfAborted();
    const rows = await database.query<{
      name: string;
      type: string;
      tbl_name: string;
      sql: string | null;
    }>(
      "SELECT name,type,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND (type>? OR (type=? AND name>?)) ORDER BY type,name LIMIT 16",
      [afterType, afterType, after]
    );
    if (!rows.length) return digest;
    count += rows.length;
    if (count > 16384) throw new Error('backup_schema_object_limit');
    const bytes = new TextEncoder().encode(JSON.stringify([digest, rows]));
    if (bytes.length > 4 * 1024 * 1024) throw new Error('backup_schema_definition_limit');
    const hashed = await crypto.subtle.digest('SHA-256', bytes);
    digest = Array.from(new Uint8Array(hashed), (byte) => byte.toString(16).padStart(2, '0')).join(
      ''
    );
    after = rows[rows.length - 1].name;
    afterType = rows[rows.length - 1].type;
  }
}
