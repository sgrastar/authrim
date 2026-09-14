/**
 * Per-database copy-on-write capture primitive for SQLite/D1.
 * A coordinator must establish a cross-store boundary before calling the result a tenant snapshot.
 * Install only from trusted, introspected schema metadata, never from an uploaded bundle.
 */
export interface SnapshotTableSchema {
  table: string;
  tenantColumn: string;
  columns: readonly string[];
  primaryKey: readonly string[];
  /** Every additional unique key; expression/partial indexes require a specialized adapter. */
  uniqueKeys: readonly (readonly string[])[];
}

/** Same-database parent ownership; reference values must use the parent's key storage types. */
export interface ParentSnapshotTableSchema extends Omit<SnapshotTableSchema, 'tenantColumn'> {
  parent: {
    schema: SnapshotTableSchema;
    /** Child columns in the exact order of the parent's complete primary key. */
    childColumns: readonly string[];
  };
}

export type CaptureSchema = SnapshotTableSchema | ParentSnapshotTableSchema;

export const SQLITE_SNAPSHOT_SCHEMA = `
CREATE TABLE IF NOT EXISTS tenant_backup_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('capturing', 'sealed', 'invalid'))
);
CREATE INDEX IF NOT EXISTS tenant_backup_snapshots_capture
  ON tenant_backup_snapshots(state, tenant_id, id);
CREATE TABLE IF NOT EXISTS tenant_backup_preimages (
  snapshot_id TEXT NOT NULL REFERENCES tenant_backup_snapshots(id) ON DELETE CASCADE,
  source_table TEXT NOT NULL,
  record_key TEXT NOT NULL,
  present INTEGER NOT NULL CHECK (present IN (0, 1)),
  row_json TEXT,
  PRIMARY KEY (snapshot_id, source_table, record_key),
  CHECK ((present = 0 AND row_json IS NULL) OR (present = 1 AND row_json IS NOT NULL))
);
`;

function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error('snapshot_invalid_identifier');
  return `"${value}"`;
}

function isStringKeyList(value: unknown): value is readonly (readonly string[])[] {
  return (
    Array.isArray(value) &&
    value.every(
      (key: unknown) =>
        Array.isArray(key) && key.every((column: unknown) => typeof column === 'string')
    )
  );
}

function validateSchema(schema: CaptureSchema): void {
  identifier(schema.table);
  if (schema.table.startsWith('tenant_backup_')) throw new Error('snapshot_internal_table');

  if (schema.columns.length === 0 || new Set(schema.columns).size !== schema.columns.length) {
    throw new Error('snapshot_invalid_columns');
  }
  for (const column of schema.columns) identifier(column);
  if ('parent' in schema) {
    if ('parent' in schema.parent.schema || schema.parent.schema.table === schema.table) {
      throw new Error('snapshot_parent_chain_unsupported');
    }
    validateSchema(schema.parent.schema);
    if (
      schema.parent.childColumns.length !== schema.parent.schema.primaryKey.length ||
      new Set(schema.parent.childColumns).size !== schema.parent.childColumns.length ||
      schema.parent.childColumns.some((column) => !schema.columns.includes(column))
    )
      throw new Error('snapshot_parent_key_invalid');
  } else {
    identifier(schema.tenantColumn);
    if (!schema.columns.includes(schema.tenantColumn))
      throw new Error('snapshot_missing_tenant_column');
  }
  if (
    schema.primaryKey.length === 0 ||
    new Set(schema.primaryKey).size !== schema.primaryKey.length
  ) {
    throw new Error('snapshot_missing_primary_key');
  }
  if (!isStringKeyList(schema.uniqueKeys)) throw new Error('snapshot_missing_unique_keys');
  for (const key of schema.uniqueKeys) {
    if (key.length === 0 || new Set(key).size !== key.length)
      throw new Error('snapshot_invalid_unique_key');
    for (const column of key) {
      if (!schema.columns.includes(column)) throw new Error('snapshot_unknown_unique_column');
    }
  }
  for (const column of schema.primaryKey) {
    if (!schema.columns.includes(column)) throw new Error('snapshot_unknown_primary_key');
  }
}

// Tagged values preserve BLOBs and integers outside JavaScript's safe integer range.
// Restore decoders must handle these tags; plain JSON.parse is not a SQL value decoder.
function encodedValue(alias: string, column: string): string {
  const value = `${alias}.${identifier(column)}`;
  return `json_array(typeof(${value}), CASE typeof(${value})
    WHEN 'null' THEN NULL
    WHEN 'blob' THEN hex(${value})
    WHEN 'integer' THEN CAST(${value} AS TEXT)
    WHEN 'real' THEN printf('%!.17g', ${value})
    ELSE ${value} END)`;
}

function recordKey(schema: Pick<SnapshotTableSchema, 'primaryKey'>, alias: string): string {
  return `json_array(${schema.primaryKey.map((column) => encodedValue(alias, column)).join(', ')})`;
}

function rowJson(schema: CaptureSchema, alias: string): string {
  // Bound JSON function arity for wide schemas such as oauth_clients. Tagged values
  // are arrays even for SQL NULL, so json_patch cannot delete a null-valued column.
  const chunks: string[] = [];
  for (let offset = 0; offset < schema.columns.length; offset += 16) {
    chunks.push(
      `json_object(${schema.columns
        .slice(offset, offset + 16)
        .map((column) => `'${column}', ${encodedValue(alias, column)}`)
        .join(', ')})`
    );
  }
  return chunks.reduce((previous, chunk) => `json_patch(${previous}, ${chunk})`);
}

/** Resolve parent membership against its original row, including deletion and tenant moves. */
function ownedAtBoundary(schema: CaptureSchema, alias: string, snapshot: string): string {
  if (!('parent' in schema)) {
    return `${alias}.${identifier(schema.tenantColumn)} = ${snapshot}.tenant_id`;
  }
  const parent = schema.parent.schema;
  const childKey = recordKey({ primaryKey: schema.parent.childColumns }, alias);
  const originalKey = recordKey(parent, 'owner_live');
  // Keep the ordinary key equality for indexed lookup. The encoded equality below
  // additionally enforces exact storage types, matching the preimage key format.
  const parentLookup = parent.primaryKey
    .map(
      (column, index) =>
        `owner_live.${identifier(column)} = ${alias}.${identifier(schema.parent.childColumns[index])}`
    )
    .join(' AND ');
  return `(EXISTS (
    SELECT 1 FROM tenant_backup_preimages AS owner_previous
    WHERE owner_previous.snapshot_id = ${snapshot}.id
      AND owner_previous.source_table = '${parent.table}'
      AND owner_previous.record_key = ${childKey} AND owner_previous.present = 1
  ) OR EXISTS (
    SELECT 1 FROM ${identifier(parent.table)} AS owner_live
    WHERE owner_live.${identifier(parent.tenantColumn)} = ${snapshot}.tenant_id
      AND ${parentLookup}
      AND ${originalKey} = ${childKey}
      AND NOT EXISTS (
        SELECT 1 FROM tenant_backup_preimages AS owner_marker
        WHERE owner_marker.snapshot_id = ${snapshot}.id
          AND owner_marker.source_table = '${parent.table}'
          AND owner_marker.record_key = ${originalKey}
      )
  ))`;
}

/** Capture the first preimage per snapshot, including inserts and ownership/key moves. */
export function sqliteSnapshotTriggers(schema: CaptureSchema): string {
  validateSchema(schema);
  const table = identifier(schema.table);
  // DB NOT NULL is mandatory. This additional capture guard prevents OR IGNORE /
  // OR REPLACE from journaling an invalid pre-constraint identity.
  const guard = `
    SELECT RAISE(ABORT, 'snapshot_invalid_row_identity')
    WHERE (${schema.primaryKey.map((column) => `NEW.${identifier(column)} IS NULL`).join(' OR ')})
      AND EXISTS (SELECT 1 FROM tenant_backup_snapshots AS snapshot
        WHERE snapshot.state = 'capturing' AND ${ownedAtBoundary(schema, 'NEW', 'snapshot')});`;
  const capture = (alias: 'OLD' | 'NEW', present: boolean) => `
    INSERT INTO tenant_backup_preimages
      (snapshot_id, source_table, record_key, present, row_json)
    SELECT snapshot.id, '${schema.table}', ${recordKey(schema, alias)}, ${present ? 1 : 0},
      ${present ? rowJson(schema, alias) : 'NULL'}
    FROM tenant_backup_snapshots AS snapshot
    WHERE snapshot.state = 'capturing' AND ${ownedAtBoundary(schema, alias, 'snapshot')}
    ON CONFLICT (snapshot_id, source_table, record_key) DO NOTHING;`;
  const conflicts = [schema.primaryKey, ...schema.uniqueKeys]
    .map(
      (key) =>
        `(${key.map((column) => `existing.${identifier(column)} = NEW.${identifier(column)}`).join(' AND ')})`
    )
    .join(' OR ');
  // REPLACE deletes conflicts without DELETE triggers when recursive_triggers is OFF.
  // Capture conflicts before that implicit deletion; UPSERT also safely uses this path.
  const captureConflicts = `
    INSERT INTO tenant_backup_preimages
      (snapshot_id, source_table, record_key, present, row_json)
    SELECT snapshot.id, '${schema.table}', ${recordKey(schema, 'existing')}, 1,
      ${rowJson(schema, 'existing')}
    FROM ${table} AS existing
    JOIN tenant_backup_snapshots AS snapshot ON ${ownedAtBoundary(schema, 'existing', 'snapshot')}
    WHERE snapshot.state = 'capturing' AND (${conflicts})
    ON CONFLICT (snapshot_id, source_table, record_key) DO NOTHING;`;
  // Capture before the row mutation: other AFTER triggers may immediately change
  // or recreate it, and must see its existing preimage/absence marker already recorded.
  // This adapter requires an explicit, non-null key known to BEFORE INSERT; rowid
  // autoallocation and non-unique keys need a different adapter. The checked activation
  // statement requires DB-enforced non-null primary keys; nullable schemas are refused.
  return `
CREATE TRIGGER ${identifier(`tenant_backup_${schema.table}_insert`)} BEFORE INSERT ON ${table}
BEGIN ${guard} ${captureConflicts} ${capture('NEW', false)} END;
CREATE TRIGGER ${identifier(`tenant_backup_${schema.table}_update`)} BEFORE UPDATE ON ${table}
BEGIN ${guard} ${capture('OLD', true)} ${captureConflicts} ${capture('NEW', false)} END;
CREATE TRIGGER ${identifier(`tenant_backup_${schema.table}_delete`)} BEFORE DELETE ON ${table}
BEGIN ${capture('OLD', true)} END;
`;
}

/**
 * Bind snapshotId, tenantId, afterKey, limit. Validate existence/state before execution.
 * Reads are gated here as well, so an expired/mismatched snapshot cannot expose current rows.
 * A sealed snapshot cannot be read from the mutable source; it needs its materialized artifact.
 */
export function sqliteSnapshotPageQuery(schema: CaptureSchema): string {
  validateSchema(schema);
  return `WITH selected_snapshot AS (
    SELECT id, tenant_id FROM tenant_backup_snapshots
    WHERE id = ? AND tenant_id = ? AND state = 'capturing'
  ), snapshot_rows AS (
    SELECT ${recordKey(schema, 'live')} AS record_key, ${rowJson(schema, 'live')} AS row_json
    FROM ${identifier(schema.table)} AS live
    JOIN selected_snapshot AS snapshot ON ${ownedAtBoundary(schema, 'live', 'snapshot')}
    WHERE NOT EXISTS (
      SELECT 1 FROM tenant_backup_preimages AS previous
      WHERE previous.snapshot_id = snapshot.id AND previous.source_table = '${schema.table}'
        AND previous.record_key = ${recordKey(schema, 'live')}
    )
    UNION ALL
    SELECT previous.record_key, previous.row_json
    FROM tenant_backup_preimages AS previous
    JOIN selected_snapshot AS snapshot ON snapshot.id = previous.snapshot_id
    WHERE previous.source_table = '${schema.table}' AND previous.present = 1
  ) SELECT record_key, row_json FROM snapshot_rows WHERE record_key > ?
    ORDER BY record_key LIMIT ?`;
}
