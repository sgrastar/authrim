import type { MigrationSchemaFamily } from '../control-plane/migration-stream-contract';
import { TENANT_DATASET_POLICIES } from './dataset-registry';
import type { DatabaseAdapter } from '../../db/adapter';
import type { BackupSchemaTable } from './sqlite-schema-types';

interface PackedColumnRow {
  name: string;
  type: string;
  non_null: number;
  dflt_value: string | null;
  pk: number;
  hidden: number;
}

interface PackedIndexRow {
  name: string;
  is_unique: number;
  origin: string;
  partial: number;
  sql: string | null;
  columns: Array<{
    seqno: number;
    name: string | null;
    coll: string;
    descending: number;
    key: number;
  }>;
}

interface PackedForeignKeyRow {
  id: number;
  seq: number;
  parent_table: string;
  child_column: string;
  parent_column: string | null;
  on_update: string;
  on_delete: string;
}

interface PackedTriggerRow {
  name: string;
  sql: string;
}

interface PackedSchemaRow {
  name: string;
  sql: string;
  flag_type: string;
  wr: number;
  strict: number;
  columns_json: string;
  indexes_json: string;
  foreign_keys_json: string;
  triggers_json: string;
}

function unpackSchema(packed: PackedSchemaRow): BackupSchemaTable {
  const columns = JSON.parse(packed.columns_json) as PackedColumnRow[];
  const indexes = JSON.parse(packed.indexes_json) as PackedIndexRow[];
  const foreignKeys = JSON.parse(packed.foreign_keys_json) as PackedForeignKeyRow[];
  return {
    name: packed.name,
    sql: packed.sql,
    withoutRowid: packed.wr === 1,
    strict: packed.strict === 1,
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
    indexes: indexes.map((index) => ({
      name: index.name,
      unique: index.is_unique === 1,
      origin: index.origin,
      partial: index.partial === 1,
      sql: index.sql,
      columns: index.columns.map((column) => ({
        position: column.seqno,
        name: column.name,
        collation: column.coll ?? 'BINARY',
        descending: column.descending === 1,
        key: column.key === 1,
      })),
    })),
    triggers: JSON.parse(packed.triggers_json) as PackedTriggerRow[],
  };
}

/** Read only a trusted registry table. The coordinator must fence DDL across planning/capture. */
export async function readBackupSqliteSchema(
  database: Pick<DatabaseAdapter, 'query' | 'queryOne'>,
  table: string
): Promise<BackupSchemaTable> {
  if (!/^[a-z][a-z0-9_]*$/.test(table) || table.startsWith('tenant_backup_')) {
    throw new Error('backup_schema_invalid_table');
  }
  return (await readSchemas(database, [table]))[0];
}

async function readSchemas(
  database: Pick<DatabaseAdapter, 'query'>,
  tables: readonly string[]
): Promise<BackupSchemaTable[]> {
  if (!tables.length) return [];
  if (tables.some((table) => !/^[a-z][a-z0-9_]*$/.test(table)))
    throw new Error('backup_schema_invalid_table');
  // SQLite does not reliably correlate an outer column passed to a table-valued PRAGMA.
  // Keep every PRAGMA argument a trusted literal, then combine the independent reads.
  const selects = tables.map(
    (table) => `SELECT '${table}' AS name,
      (SELECT sql FROM sqlite_schema WHERE type='table' AND name='${table}' AND sql IS NOT NULL) AS sql,
      (SELECT type FROM pragma_table_list WHERE schema='main' AND name='${table}') AS flag_type,
      (SELECT wr FROM pragma_table_list WHERE schema='main' AND name='${table}') AS wr,
      (SELECT strict FROM pragma_table_list WHERE schema='main' AND name='${table}') AS strict,
      (SELECT json_group_array(json_object(
        'name',name,'type',type,'non_null',"notnull",'dflt_value',dflt_value,
        'pk',pk,'hidden',hidden
      )) FROM (SELECT * FROM pragma_table_xinfo('${table}') ORDER BY cid)) AS columns_json,
      (SELECT json_group_array(json_object(
        'name',il.name,'is_unique',il."unique",'origin',il.origin,'partial',il.partial,
        'sql',(SELECT sql FROM sqlite_schema WHERE type='index' AND name=il.name),
        'columns',(SELECT json_group_array(json_object(
          'seqno',seqno,'name',name,'coll',coll,'descending',"desc",'key',key
        )) FROM (SELECT * FROM pragma_index_xinfo(il.name) ORDER BY seqno))
      )) FROM (SELECT * FROM pragma_index_list('${table}') ORDER BY name) AS il) AS indexes_json,
      (SELECT json_group_array(json_object(
        'id',id,'seq',seq,'parent_table',"table",'child_column',"from",
        'parent_column',"to",'on_update',on_update,'on_delete',on_delete
      )) FROM (SELECT * FROM pragma_foreign_key_list('${table}') ORDER BY id,seq)) AS foreign_keys_json,
      (SELECT json_group_array(json_object('name',name,'sql',sql))
       FROM (SELECT name,sql FROM sqlite_schema
             WHERE type='trigger' AND tbl_name='${table}' AND sql IS NOT NULL ORDER BY name)) AS triggers_json`
  );
  const packed = await database.query<PackedSchemaRow>(
    `SELECT * FROM (${selects.join(' UNION ALL ')}) ORDER BY name`
  );
  if (
    packed.length !== tables.length ||
    packed.some((row) => row.flag_type !== 'table' || typeof row.sql !== 'string')
  )
    throw new Error('backup_schema_missing_table');
  return packed.map(unpackSchema);
}

/** Discover a complete family schema from an already authorized DB. Never accepts a requested table subset. */
export async function readBackupSqliteDatabaseSchema(
  database: Pick<DatabaseAdapter, 'query' | 'queryOne'>,
  family: MigrationSchemaFamily,
  signal: AbortSignal
): Promise<BackupSchemaTable[]> {
  signal.throwIfAborted();
  const before = await readBackupSqliteBoundarySchemaDigest(database, signal);
  const rows = await database.query<{ name: string }>(
    "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name"
  );
  if (rows.length > 4096) throw new Error('backup_schema_table_limit');
  const result: BackupSchemaTable[] = [];
  const classified: string[] = [];
  for (const { name } of rows) {
    signal.throwIfAborted();
    // These two tables are local capture scratch, never tenant source data.
    if (name === 'tenant_backup_snapshots' || name === 'tenant_backup_preimages') continue;
    // D1 creates this reserved provider metadata table; its rows are not tenant data.
    if (name === '_cf_METADATA' || name === '_cf_KV') continue;
    const policies = TENANT_DATASET_POLICIES.filter(
      (policy) => policy.family === family && policy.table === name
    );
    if (policies.length !== 1) throw new Error('backup_schema_unclassified_table');
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error('backup_schema_invalid_table');
    classified.push(name);
  }
  // Four tables keep every packed PRAGMA compound SELECT below D1's term limit. Run four
  // independent reads together; the before/after digest still rejects any schema change across the
  // complete observation.
  const pages: string[][] = [];
  for (let offset = 0; offset < classified.length; offset += 4)
    pages.push(classified.slice(offset, offset + 4));
  for (let offset = 0; offset < pages.length; offset += 4) {
    signal.throwIfAborted();
    const group = await Promise.all(
      pages.slice(offset, offset + 4).map((page) => readSchemas(database, page))
    );
    result.push(...group.flat());
  }
  const after = await readBackupSqliteBoundarySchemaDigest(database, signal);
  signal.throwIfAborted();
  if (after !== before) throw new Error('backup_schema_changed_during_inspection');
  return result;
}

/**
 * Fast boundary fingerprint for schema objects that affect captured rows. Capture triggers are
 * checked atomically by the snapshot start statement, so excluding them keeps the result bounded.
 */
export async function readBackupSqliteBoundarySchemaDigest(
  database: Pick<DatabaseAdapter, 'queryOne'>,
  signal: AbortSignal
): Promise<string> {
  signal.throwIfAborted();
  const row = await database.queryOne<{ definitions_json: string }>(
    `SELECT json_group_array(json_object(
      'name',name,'type',type,'table',tbl_name,'sql',sql
    )) AS definitions_json FROM (
      SELECT name,type,tbl_name,sql FROM sqlite_schema
      WHERE name NOT GLOB 'sqlite_*'
        AND NOT (type='trigger' AND name GLOB 'tenant_backup_*')
      ORDER BY type,name
    )`
  );
  signal.throwIfAborted();
  if (!row || typeof row.definitions_json !== 'string')
    throw new Error('backup_schema_definition_digest');
  const bytes = new TextEncoder().encode(row.definitions_json);
  if (bytes.length > 4 * 1024 * 1024) throw new Error('backup_schema_definition_limit');
  const hashed = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hashed), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
