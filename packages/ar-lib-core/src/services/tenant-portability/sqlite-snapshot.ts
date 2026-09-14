import { snapshotUniqueTermSql, type SnapshotUniqueTerm } from './sqlite-index-expression';
import { sqlitePackedRowExpression } from './sqlite-packed-row';

/**
 * Per-database copy-on-write capture primitive for SQLite/D1.
 * A coordinator must establish a cross-store boundary before calling the result a tenant snapshot.
 * Install only from trusted, introspected schema metadata, never from an uploaded bundle.
 */
export interface SnapshotTableSchema {
  table: string;
  tenantColumn: string;
  /** Identity pinned on the snapshot, never inferred by column naming. */
  tenantIdentity?: 'tenantId' | 'tenantKey';
  /** Restrict polymorphic scope rows to scope_type = tenant. */
  scopeTypeColumn?: string;
  columns: readonly string[];
  primaryKey: readonly string[];
  /** Every additional unique key; expression/partial indexes require a specialized adapter. */
  uniqueKeys: readonly (readonly string[])[];
  uniqueExpressions?: readonly (readonly SnapshotUniqueTerm[])[];
  /**
   * A trusted, finite row partition used when one table contains independently selectable
   * backup categories. The original value is journaled with every preimage.
   */
  rowPartition?: {
    column: string;
    values: readonly string[];
  };
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
  state TEXT NOT NULL CHECK (state IN ('capturing', 'sealed', 'invalid')),
  tenant_key TEXT CHECK (tenant_key IS NULL OR length(tenant_key) > 0)
);
CREATE TRIGGER IF NOT EXISTS tenant_backup_snapshot_identity_immutable
BEFORE UPDATE OF id, tenant_id, tenant_key ON tenant_backup_snapshots
WHEN NEW.id IS NOT OLD.id OR NEW.tenant_id IS NOT OLD.tenant_id OR NEW.tenant_key IS NOT OLD.tenant_key
BEGIN SELECT RAISE(ABORT, 'snapshot_identity_immutable'); END;
CREATE TRIGGER IF NOT EXISTS tenant_backup_snapshot_state_monotonic
BEFORE UPDATE OF state ON tenant_backup_snapshots
WHEN (OLD.state='invalid' AND NEW.state!='invalid') OR (OLD.state='sealed' AND NEW.state='capturing')
BEGIN SELECT RAISE(ABORT,'snapshot_state_regression'); END;
CREATE INDEX IF NOT EXISTS tenant_backup_snapshots_capture
  ON tenant_backup_snapshots(state, tenant_id, id);
CREATE TABLE IF NOT EXISTS tenant_backup_preimages (
  snapshot_id TEXT NOT NULL REFERENCES tenant_backup_snapshots(id) ON DELETE CASCADE,
  source_table TEXT NOT NULL,
  record_key TEXT NOT NULL,
  present INTEGER NOT NULL CHECK (present IN (0, 1)),
  row_json TEXT, row_partition TEXT
  CHECK (
    row_partition IS NULL OR (
      typeof(row_partition) = 'text'
      AND length(row_partition) BETWEEN 1 AND 64
    )
  ),
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
    if (
      schema.tenantIdentity !== undefined &&
      !['tenantId', 'tenantKey'].includes(schema.tenantIdentity)
    )
      throw new Error('snapshot_invalid_tenant_identity');
    if (!schema.columns.includes(schema.tenantColumn))
      throw new Error('snapshot_missing_tenant_column');
    if (schema.scopeTypeColumn !== undefined) {
      identifier(schema.scopeTypeColumn);
      if (!schema.columns.includes(schema.scopeTypeColumn))
        throw new Error('snapshot_missing_scope_type_column');
    }
  }
  if (
    schema.primaryKey.length === 0 ||
    new Set(schema.primaryKey).size !== schema.primaryKey.length
  ) {
    throw new Error('snapshot_missing_primary_key');
  }
  for (const terms of schema.uniqueExpressions ?? []) {
    if (!Array.isArray(terms) || !terms.length)
      throw new Error('snapshot_invalid_unique_expression');
    for (const term of terms as readonly SnapshotUniqueTerm[])
      snapshotUniqueTermSql(term, 'existing', schema.columns);
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
  if (schema.rowPartition) {
    identifier(schema.rowPartition.column);
    if (
      !schema.columns.includes(schema.rowPartition.column) ||
      schema.rowPartition.values.length < 2 ||
      schema.rowPartition.values.length > 32 ||
      new Set(schema.rowPartition.values).size !== schema.rowPartition.values.length ||
      schema.rowPartition.values.some((value) => !/^[A-Za-z0-9_.:-]{1,64}$/.test(value))
    )
      throw new Error('snapshot_invalid_row_partition');
  }
}

function rowPartition(schema: CaptureSchema, alias: string): string {
  return schema.rowPartition ? `${alias}.${identifier(schema.rowPartition.column)}` : 'NULL';
}

function rowPartitionValues(values: readonly string[]): string {
  if (!values.length || values.some((value) => !/^[A-Za-z0-9_.:-]{1,64}$/.test(value)))
    throw new Error('snapshot_invalid_row_partition');
  return values.map((value) => `'${value}'`).join(', ');
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

function directlyOwned(schema: SnapshotTableSchema, alias: string, snapshot: string): string {
  const identity = schema.tenantIdentity === 'tenantKey' ? 'tenant_key' : 'tenant_id';
  const tenant = `${alias}.${identifier(schema.tenantColumn)} = ${snapshot}.${identity}`;
  return schema.scopeTypeColumn
    ? `(${tenant} AND ${alias}.${identifier(schema.scopeTypeColumn)} = 'tenant')`
    : tenant;
}

/** Resolve parent membership against its original row, including deletion and tenant moves. */
function ownedAtBoundary(schema: CaptureSchema, alias: string, snapshot: string): string {
  if (!('parent' in schema)) {
    return directlyOwned(schema, alias, snapshot);
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
    WHERE ${directlyOwned(parent, 'owner_live', snapshot)}
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

/** Capture the first preimage. JSON mode exists only for legacy-format compatibility checks. */
export function sqliteSnapshotTriggers(
  schema: CaptureSchema,
  representation: 'packed' | 'json' = 'packed'
): string {
  validateSchema(schema);
  const table = identifier(schema.table);
  // DB NOT NULL is mandatory. This additional capture guard prevents OR IGNORE /
  // OR REPLACE from journaling an invalid pre-constraint identity.
  const guard = `
    SELECT RAISE(ABORT, 'snapshot_invalid_row_identity')
    WHERE (${schema.primaryKey.map((column) => `NEW.${identifier(column)} IS NULL`).join(' OR ')})
      AND EXISTS (SELECT 1 FROM tenant_backup_snapshots AS snapshot
        WHERE snapshot.state = 'capturing' AND ${ownedAtBoundary(schema, 'NEW', 'snapshot')});`;
  const partitionGuard = schema.rowPartition
    ? `
    SELECT RAISE(ABORT, 'snapshot_invalid_row_partition')
    WHERE (typeof(NEW.${identifier(schema.rowPartition.column)}) <> 'text'
      OR NEW.${identifier(schema.rowPartition.column)} NOT IN (${rowPartitionValues(schema.rowPartition.values)}))
      AND EXISTS (SELECT 1 FROM tenant_backup_snapshots AS snapshot
        WHERE snapshot.state = 'capturing' AND ${ownedAtBoundary(schema, 'NEW', 'snapshot')});`
    : '';
  const capture = (alias: 'OLD' | 'NEW', present: boolean) => `
    INSERT INTO tenant_backup_preimages
      (snapshot_id, source_table, record_key, present, row_json, row_partition)
    SELECT snapshot.id, '${schema.table}', ${recordKey(schema, alias)}, ${present ? 1 : 0},
      ${present ? (representation === 'packed' ? sqlitePackedRowExpression(schema.columns, alias) : rowJson(schema, alias)) : 'NULL'},
      ${rowPartition(schema, alias)}
    FROM tenant_backup_snapshots AS snapshot
    WHERE snapshot.state = 'capturing' AND ${ownedAtBoundary(schema, alias, 'snapshot')}
    ON CONFLICT (snapshot_id, source_table, record_key) DO NOTHING;`;
  const columnConflicts = [schema.primaryKey, ...schema.uniqueKeys].map(
    (key) =>
      `(${key.map((column) => `existing.${identifier(column)} = NEW.${identifier(column)}`).join(' AND ')})`
  );
  const expressionConflicts = (schema.uniqueExpressions ?? []).map(
    (terms) =>
      `(${terms.map((term) => `${snapshotUniqueTermSql(term, 'existing', schema.columns)} = ${snapshotUniqueTermSql(term, 'NEW', schema.columns)}`).join(' AND ')})`
  );
  const conflicts = [...columnConflicts, ...expressionConflicts].join(' OR ');
  // REPLACE deletes conflicts without DELETE triggers when recursive_triggers is OFF.
  // Capture conflicts before that implicit deletion; UPSERT also safely uses this path.
  const captureConflicts = `
    INSERT INTO tenant_backup_preimages
      (snapshot_id, source_table, record_key, present, row_json, row_partition)
    SELECT snapshot.id, '${schema.table}', ${recordKey(schema, 'existing')}, 1,
      ${representation === 'packed' ? sqlitePackedRowExpression(schema.columns, 'existing') : rowJson(schema, 'existing')},
      ${rowPartition(schema, 'existing')}
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
BEGIN ${guard} ${partitionGuard} ${captureConflicts} ${capture('NEW', false)} END;
CREATE TRIGGER ${identifier(`tenant_backup_${schema.table}_update`)} BEFORE UPDATE ON ${table}
BEGIN ${guard} ${partitionGuard} ${capture('OLD', true)} ${captureConflicts} ${capture('NEW', false)} END;
CREATE TRIGGER ${identifier(`tenant_backup_${schema.table}_delete`)} BEFORE DELETE ON ${table}
BEGIN ${capture('OLD', true)} END;
`;
}

/**
 * Bind snapshotId, tenantId, afterKey, limit. Validate existence/state before execution.
 * row_json is a packed BLOB or legacy JSON TEXT; use the dataset source for portable JSON.
 * Reads are gated here as well, so an expired/mismatched snapshot cannot expose current rows.
 * A sealed snapshot cannot be read from the mutable source; it needs its materialized artifact.
 */
export function sqliteSnapshotPageQuery(
  schema: CaptureSchema,
  representation: 'json' | 'packed' = 'packed',
  partitions?: readonly string[]
): string {
  validateSchema(schema);
  if (schema.rowPartition) {
    if (
      !partitions?.length ||
      new Set(partitions).size !== partitions.length ||
      partitions.some((partition) => !schema.rowPartition?.values.includes(partition))
    )
      throw new Error('snapshot_invalid_row_partition');
  } else if (partitions !== undefined) {
    throw new Error('snapshot_unexpected_row_partition');
  }
  const selectedPartitions = partitions ? rowPartitionValues(partitions) : null;
  const partitionColumn = schema.rowPartition?.column;
  if (selectedPartitions && !partitionColumn) throw new Error('snapshot_invalid_row_partition');
  return `WITH selected_snapshot AS (
    SELECT id, tenant_id, tenant_key FROM tenant_backup_snapshots
    WHERE id = ? AND tenant_id = ? AND state = 'capturing'
  ), snapshot_rows AS (
    SELECT ${recordKey(schema, 'live')} AS record_key, ${representation === 'packed' ? sqlitePackedRowExpression(schema.columns, 'live') : rowJson(schema, 'live')} AS row_json
    FROM ${identifier(schema.table)} AS live
    JOIN selected_snapshot AS snapshot ON ${ownedAtBoundary(schema, 'live', 'snapshot')}
    WHERE ${selectedPartitions ? `live.${identifier(partitionColumn ?? '')} IN (${selectedPartitions}) AND ` : ''}NOT EXISTS (
      SELECT 1 FROM tenant_backup_preimages AS previous
      WHERE previous.snapshot_id = snapshot.id AND previous.source_table = '${schema.table}'
        AND previous.record_key = ${recordKey(schema, 'live')}
    )
    UNION ALL
    SELECT previous.record_key, previous.row_json
    FROM tenant_backup_preimages AS previous
    JOIN selected_snapshot AS snapshot ON snapshot.id = previous.snapshot_id
    WHERE previous.source_table = '${schema.table}' AND previous.present = 1${selectedPartitions ? ` AND previous.row_partition IN (${selectedPartitions})` : ''}
  ) SELECT record_key, row_json FROM snapshot_rows WHERE record_key > ?
    ORDER BY record_key LIMIT ?`;
}
