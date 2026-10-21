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
  /**
   * Trusted name of a non-partial index whose key is exactly the tenant column followed by the
   * complete primary key, all ascending BINARY. Export pages read one tenant's rows from it in
   * primary key order instead of walking every tenant's rows in the primary key index.
   */
  tenantOrderIndex?: string;
}

/** Same-database parent ownership; reference values must use the parent's key storage types. */
export interface ParentSnapshotTableSchema extends Omit<
  SnapshotTableSchema,
  'tenantColumn' | 'tenantOrderIndex'
> {
  parent: {
    schema: SnapshotTableSchema;
    /** Child columns in the exact order of the parent's complete primary key. */
    childColumns: readonly string[];
  };
}

export type CaptureSchema = SnapshotTableSchema | ParentSnapshotTableSchema;

/** Widest primary key the preimage native-order index covers. */
const NATIVE_KEY_TERMS = 8;

/**
 * Decode one tagged record_key term back to its stored SQL value. Pages follow SQLite's native
 * primary key order: live rows read it from their primary key index, preimages from the
 * expression index below. The JSON text order of record_key is a different order.
 * Malformed keys decode to NULL so that maintaining the index can never fail a write.
 */
function nativeKeyTerm(recordKeyExpression: string, index: number): string {
  const tag = `CASE WHEN json_valid(${recordKeyExpression}) THEN json_extract(${recordKeyExpression}, '$[${index}][0]') END`;
  const value = `json_extract(${recordKeyExpression}, '$[${index}][1]')`;
  return `CASE ${tag} WHEN 'integer' THEN CAST(${value} AS INTEGER) WHEN 'real' THEN CAST(${value} AS REAL) WHEN 'text' THEN ${value} WHEN 'blob' THEN unhex(${value}) END`;
}

/** Query expressions must stay identical to these index terms for SQLite to use the index. */
export const SQLITE_SNAPSHOT_NATIVE_ORDER_INDEX = `CREATE INDEX IF NOT EXISTS tenant_backup_preimages_native_order
  ON tenant_backup_preimages(snapshot_id, source_table, present,
    ${Array.from({ length: NATIVE_KEY_TERMS }, (_, index) => nativeKeyTerm('record_key', index)).join(',\n    ')});`;

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
${SQLITE_SNAPSHOT_NATIVE_ORDER_INDEX}
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
    if ('tenantOrderIndex' in schema) throw new Error('snapshot_invalid_tenant_order_index');
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
    if (schema.tenantOrderIndex !== undefined) {
      if (
        typeof schema.tenantOrderIndex !== 'string' ||
        schema.primaryKey[0] === schema.tenantColumn
      )
        throw new Error('snapshot_invalid_tenant_order_index');
      identifier(schema.tenantOrderIndex);
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

/**
 * `scan` keeps the tenant filter off secondary indexes (unary `+`) so a paged export walks the
 * primary key index in order. A tenant-leading primary key keeps the indexable equality.
 */
function directlyOwned(
  schema: SnapshotTableSchema,
  alias: string,
  snapshot: string,
  scan = false
): string {
  const identity = schema.tenantIdentity === 'tenantKey' ? 'tenant_key' : 'tenant_id';
  const filter = scan ? '+' : '';
  // A scan may use the tenant equality only through an index ordered by the primary key after it.
  const tenantFilter =
    scan && (schema.primaryKey[0] === schema.tenantColumn || schema.tenantOrderIndex) ? '' : filter;
  const tenant = `${tenantFilter}${alias}.${identifier(schema.tenantColumn)} = ${snapshot}.${identity}`;
  return schema.scopeTypeColumn
    ? `(${tenant} AND ${filter}${alias}.${identifier(schema.scopeTypeColumn)} = 'tenant')`
    : tenant;
}

/** Resolve parent membership against its original row, including deletion and tenant moves. */
function ownedAtBoundary(
  schema: CaptureSchema,
  alias: string,
  snapshot: string,
  scan = false
): string {
  if (!('parent' in schema)) {
    return directlyOwned(schema, alias, snapshot, scan);
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
 * Bind snapshotId, tenantId, afterKey, limit, plus scanLimit when options.scanLimit is set.
 * Validate existence/state before execution.
 * afterKey is '' or the last emitted record_key. Rows follow native primary key order, not
 * record_key text order; consumers must order by page_order.
 * row_json is a packed BLOB or legacy JSON TEXT; use the dataset source for portable JSON.
 * Reads are gated here as well, so an expired/mismatched snapshot cannot expose current rows.
 * A sealed snapshot cannot be read from the mutable source; it needs its materialized artifact.
 */
export function sqliteSnapshotPageQuery(
  schema: CaptureSchema,
  representation: 'json' | 'packed' = 'packed',
  partitions?: readonly string[],
  options: { scanLimit?: boolean } = {}
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
  const width = schema.primaryKey.length;
  if (width > NATIVE_KEY_TERMS) throw new Error('snapshot_primary_key_too_wide');
  const keys = schema.primaryKey.map((_, index) => `k${index}`);
  const liveKey = schema.primaryKey.map((column) => `live.${identifier(column)}`);
  const preimageKey = keys.map((_, index) => nativeKeyTerm('previous.record_key', index));
  const vector = (terms: readonly string[]) =>
    terms.length === 1 ? terms[0] : `(${terms.join(', ')})`;
  const afterKey = (from: number) => `(SELECT ${keys.slice(from).join(', ')} FROM after_bound)`;
  // Owned rows of a tenant-leading key all share k0, so the range continues on the rest of the
  // key behind the indexable tenant equality instead of scanning other tenants' rows.
  const tenantLeading =
    !('parent' in schema) && width > 1 && schema.primaryKey[0] === schema.tenantColumn;
  const liveAfter = tenantLeading
    ? `${vector(liveKey.slice(1))} > ${afterKey(1)}`
    : `${vector(liveKey)} > ${afterKey(0)}`;
  // The same holds inside a (tenant, primary key...) index. INDEXED BY pins it: with statistics
  // the planner may otherwise prefer another tenant-first index and sort the tenant on each page.
  const tenantIndex =
    !('parent' in schema) && !tenantLeading && schema.tenantOrderIndex
      ? ` INDEXED BY ${identifier(schema.tenantOrderIndex)}`
      : '';
  const firstPage = "(SELECT after_key FROM params) = ''";
  // A direct unique-key lookup keeps the snapshot a one-row loop, so ORDER BY + LIMIT stops on the
  // index instead of sorting every remaining row of the table.
  const snapshotRow = `snapshot.id = (SELECT snapshot_id FROM params)
      AND +snapshot.tenant_id = (SELECT tenant_id FROM params) AND +snapshot.state = 'capturing'`;
  const limit = 'LIMIT (SELECT page_limit FROM params)';
  const scanLimit = 'LIMIT (SELECT max(page_limit, coalesce(scan_limit, page_limit)) FROM params)';
  // Only a tenant-leading key or a (tenant, primary key) index bounds the walk to the tenant's rows.
  // Every other selection test is a flag, not a filter, so the LIMIT bounds the index walk itself: filtering first would walk
  // other tenants' rows, rows of unselected partitions and replaced rows behind the cursor again
  // on every page.
  const tenantRange =
    !('parent' in schema) &&
    (schema.primaryKey[0] === schema.tenantColumn || schema.tenantOrderIndex)
      ? ` AND ${directlyOwned({ ...schema, scopeTypeColumn: undefined }, 'live', 'snapshot', true)}`
      : '';
  const selected = [
    ownedAtBoundary(schema, 'live', 'snapshot', true),
    ...(selectedPartitions
      ? [`+live.${identifier(partitionColumn ?? '')} IN (${selectedPartitions})`]
      : []),
  ].join(' AND ');
  // Scans return keys only. Encoded keys, the replaced test and row bodies are written once below,
  // which keeps the statement under D1's SQL length limit for wide tables and long keys.
  const liveRows = (bound: string) => `SELECT ${liveKey
    .map((term, index) => `${term} AS k${index}`)
    .join(', ')}, (${selected}) AS selected
    FROM tenant_backup_snapshots AS snapshot CROSS JOIN ${identifier(schema.table)} AS live${tenantIndex}
    WHERE ${snapshotRow} AND ${bound}${tenantRange}
    ORDER BY ${liveKey.join(', ')} ${scanLimit}`;
  // `fixed` leading terms are equality-bound; ordering by them would add a sort of the range.
  const preimageRows = (bound: string, fixed = 0) => `SELECT previous.record_key
    FROM tenant_backup_snapshots AS snapshot CROSS JOIN tenant_backup_preimages AS previous
    WHERE ${snapshotRow} AND ${bound} AND previous.snapshot_id = snapshot.id
      AND previous.source_table = '${schema.table}' AND previous.present = 1${selectedPartitions ? ` AND previous.row_partition IN (${selectedPartitions})` : ''}
    ORDER BY ${preimageKey.slice(fixed).join(', ')} ${scanLimit}`;
  // SQLite cannot range-scan a row value over expression index terms. Split "key > after" into
  // disjoint ranges, each an equality prefix plus one scalar range on the index.
  const preimageAfter = preimageKey.map((term, index) =>
    [
      ...preimageKey
        .slice(0, index)
        .map((prefix, prefixIndex) => `${prefix} = (SELECT k${prefixIndex} FROM after_bound)`),
      `${term} > (SELECT k${index} FROM after_bound)`,
    ].join(' AND ')
  );
  const order = keys.join(', ');
  const lastOf = (source: string) =>
    `SELECT ${order}, record_key FROM ${source} ORDER BY ${order}
    LIMIT 1 OFFSET (SELECT max(page_limit, coalesce(scan_limit, page_limit)) FROM params) - 1`;
  // A full source may continue past its last scanned key, so only keys up to both sources' last
  // scanned keys are complete. Beyond that a row of the other source could still sort earlier.
  const withinScan = (source: string) =>
    `(NOT EXISTS (SELECT 1 FROM ${source}) OR ${vector(keys)} <= (SELECT ${order} FROM ${source}))`;
  // Same statement, so the body read by key is the row the scan saw.
  const liveBody = `(SELECT ${representation === 'packed' ? sqlitePackedRowExpression(schema.columns, 'live') : rowJson(schema, 'live')}
      FROM ${identifier(schema.table)} AS live
      WHERE ${schema.primaryKey.map((column, index) => `live.${identifier(column)} = page.k${index}`).join(' AND ')})`;
  const preimageBody = `(SELECT previous.row_json FROM tenant_backup_preimages AS previous
      WHERE previous.snapshot_id = (SELECT snapshot_id FROM params)
        AND previous.source_table = '${schema.table}' AND previous.record_key = page.record_key)`;
  // Each source scans at most scan_limit keys in the shared native order; their merge, cut to
  // page_limit rows, is the page. When no scanned live row is selected and no preimage sorts
  // before the scan ends, the page is one row_json NULL progress row at the last scanned live key:
  // the reader moves its cursor there and reads on. An empty page has no preimage left to merge
  // (a full preimage scan always contributes rows), so that position is safe even when the live
  // scan ended early.
  // scanLimit adds a fifth bind: how many keys each source may scan. It defaults to page_limit.
  return `WITH params(snapshot_id, tenant_id, after_key, page_limit, scan_limit) AS (
    SELECT ?, ?, ?, ?, ${options.scanLimit ? '?' : 'NULL'}
  ),
  after_bound AS (
    SELECT ${keys.map((key, index) => `${nativeKeyTerm('after_key', index)} AS ${key}`).join(', ')}
    FROM params WHERE after_key <> ''
  ),
  live_first AS (${liveRows(firstPage)}),
  live_after AS (${liveRows(liveAfter)}),
  live_keys AS (
    SELECT scanned.*, ${recordKey({ primaryKey: keys }, 'scanned')} AS record_key
    FROM (SELECT * FROM live_first UNION ALL SELECT * FROM live_after) AS scanned
  ),
  live_scan AS MATERIALIZED (
    SELECT live_keys.*, CASE WHEN selected THEN EXISTS (
        SELECT 1 FROM tenant_backup_preimages AS previous
        WHERE previous.snapshot_id = (SELECT snapshot_id FROM params)
          AND previous.source_table = '${schema.table}' AND previous.record_key = live_keys.record_key
      ) ELSE 0 END AS replaced
    FROM live_keys
  ),
  preimage_first AS (${preimageRows(firstPage)}),
  ${preimageAfter.map((bound, index) => `preimage_after_${index} AS (${preimageRows(bound, index)})`).join(',\n  ')},
  preimage_scan AS MATERIALIZED (
    SELECT ${keys.map((key, index) => `${nativeKeyTerm('scanned.record_key', index)} AS ${key}`).join(', ')},
      scanned.record_key
    FROM (SELECT * FROM preimage_first
      ${preimageAfter.map((_, index) => `UNION ALL SELECT * FROM preimage_after_${index}`).join('\n      ')}
    ) AS scanned
    ORDER BY ${order} ${scanLimit}
  ),
  live_last AS (${lastOf('live_scan')}),
  preimage_last AS (${lastOf('preimage_scan')}),
  page AS (
    SELECT * FROM (
      SELECT ${order}, record_key, 1 AS live_source FROM live_scan WHERE selected AND NOT replaced
      UNION ALL SELECT ${order}, record_key, 0 FROM preimage_scan
    )
    WHERE ${withinScan('live_last')} AND ${withinScan('preimage_last')}
    ORDER BY ${order} ${limit}
  ) SELECT record_key, CASE WHEN live_source THEN ${liveBody} ELSE ${preimageBody} END AS row_json,
    row_number() OVER (ORDER BY ${order}) AS page_order FROM page
  UNION ALL SELECT (
      SELECT record_key FROM live_scan ORDER BY ${keys.map((key) => `${key} DESC`).join(', ')} LIMIT 1
    ), NULL, 1
  WHERE NOT EXISTS (SELECT 1 FROM page) AND EXISTS (SELECT 1 FROM live_scan)
  ORDER BY page_order`;
}

/**
 * Bind snapshotId, tenantId, recordKey. Returns the one snapshot row stored under that key, or
 * nothing. Large rows are read in fragments by key, because the rows a page skips can change
 * between its read and a later fragment read.
 */
export function sqliteSnapshotRowQuery(
  schema: CaptureSchema,
  representation: 'json' | 'packed' = 'packed',
  partitions?: readonly string[]
): string {
  // Validates the schema, the partitions and the key width with the page query rules.
  sqliteSnapshotPageQuery(schema, representation, partitions);
  const selectedPartitions = partitions ? rowPartitionValues(partitions) : null;
  const partitionColumn = schema.rowPartition?.column;
  const snapshotRow = `snapshot.id = (SELECT snapshot_id FROM params)
      AND +snapshot.tenant_id = (SELECT tenant_id FROM params) AND +snapshot.state = 'capturing'`;
  const liveKey = schema.primaryKey
    .map(
      (column, index) =>
        `live.${identifier(column)} = (SELECT ${nativeKeyTerm('record_key', index)} FROM params)`
    )
    .join(' AND ');
  return `WITH params(snapshot_id, tenant_id, record_key) AS (SELECT ?, ?, ?)
  SELECT ${recordKey(schema, 'live')} AS record_key, ${representation === 'packed' ? sqlitePackedRowExpression(schema.columns, 'live') : rowJson(schema, 'live')} AS row_json
  FROM tenant_backup_snapshots AS snapshot CROSS JOIN ${identifier(schema.table)} AS live
  WHERE ${snapshotRow} AND ${liveKey}
    AND ${recordKey(schema, 'live')} = (SELECT record_key FROM params)
    AND ${ownedAtBoundary(schema, 'live', 'snapshot')}
    ${selectedPartitions ? `AND live.${identifier(partitionColumn ?? '')} IN (${selectedPartitions})` : ''}
    AND NOT EXISTS (
      SELECT 1 FROM tenant_backup_preimages AS previous
      WHERE previous.snapshot_id = snapshot.id AND previous.source_table = '${schema.table}'
        AND previous.record_key = ${recordKey(schema, 'live')}
    )
  UNION ALL
  SELECT previous.record_key, previous.row_json
  FROM tenant_backup_snapshots AS snapshot CROSS JOIN tenant_backup_preimages AS previous
  WHERE ${snapshotRow} AND previous.snapshot_id = snapshot.id
    AND previous.source_table = '${schema.table}'
    AND previous.record_key = (SELECT record_key FROM params) AND previous.present = 1${selectedPartitions ? ` AND previous.row_partition IN (${selectedPartitions})` : ''}`;
}

/**
 * Bind snapshotId, tenantId and a JSON array of text values. Returns the live rows whose `column`
 * holds one of the values, are owned at the boundary and carry no marker of this snapshot, as
 * `record_key`, `row_type` and `row_hex` (packed body). Rows replaced after the boundary come
 * from sqliteSnapshotPreimagePageQuery instead; read that AFTER this statement, so a row replaced
 * between the two reads is returned by both with the same boundary value.
 */
export function sqliteSnapshotLiveLookupQuery(
  schema: CaptureSchema,
  column: string,
  partitions?: readonly string[]
): string {
  sqliteSnapshotPageQuery(schema, 'packed', partitions);
  if (!schema.columns.includes(column)) throw new Error('snapshot_unknown_lookup_column');
  const selectedPartitions = partitions ? rowPartitionValues(partitions) : null;
  const partitionColumn = schema.rowPartition?.column;
  const body = sqlitePackedRowExpression(schema.columns, 'live');
  return `WITH params(snapshot_id, tenant_id, lookup) AS (SELECT ?, ?, ?)
  SELECT ${recordKey(schema, 'live')} AS record_key, typeof(${body}) AS row_type,
    hex(${body}) AS row_hex
  FROM tenant_backup_snapshots AS snapshot CROSS JOIN ${identifier(schema.table)} AS live
  WHERE snapshot.id = (SELECT snapshot_id FROM params)
    AND +snapshot.tenant_id = (SELECT tenant_id FROM params) AND +snapshot.state = 'capturing'
    AND live.${identifier(column)} IN (SELECT value FROM json_each((SELECT lookup FROM params)))
    AND ${ownedAtBoundary(schema, 'live', 'snapshot')}
    ${selectedPartitions ? `AND live.${identifier(partitionColumn ?? '')} IN (${selectedPartitions})` : ''}
    AND NOT EXISTS (
      SELECT 1 FROM tenant_backup_preimages AS previous
      WHERE previous.snapshot_id = snapshot.id AND previous.source_table = '${schema.table}'
        AND previous.record_key = ${recordKey(schema, 'live')}
    )`;
}

/**
 * Bind snapshotId, tenantId, a JSON array of `column` values, then one value per `filters`
 * entry. Groups the same live rows as sqliteSnapshotLiveLookupQuery that also equal every filter
 * by `groupColumns`, returning those columns as g0..gN plus `row_count`, `min_value` and
 * `max_value` of `rangeColumn`. Combine with the table's preimages read afterwards; the number of
 * present preimages before and after tells whether a row changed in between.
 */
export function sqliteSnapshotLiveAggregateQuery(
  schema: CaptureSchema,
  column: string,
  groupColumns: readonly string[],
  filters: readonly string[],
  rangeColumn: string,
  partitions?: readonly string[]
): string {
  sqliteSnapshotPageQuery(schema, 'packed', partitions);
  for (const name of [column, ...groupColumns, ...filters, rangeColumn])
    if (!schema.columns.includes(name)) throw new Error('snapshot_unknown_lookup_column');
  if (!groupColumns.length || new Set(groupColumns).size !== groupColumns.length)
    throw new Error('snapshot_invalid_lookup_group');
  const selectedPartitions = partitions ? rowPartitionValues(partitions) : null;
  const partitionColumn = schema.rowPartition?.column;
  const groups = groupColumns.map((name) => `live.${identifier(name)}`);
  return `WITH params(snapshot_id, tenant_id, lookup) AS (SELECT ?, ?, ?)
  SELECT ${groups.map((term, index) => `${term} AS g${index}`).join(', ')}, count(*) AS row_count,
    min(live.${identifier(rangeColumn)}) AS min_value, max(live.${identifier(rangeColumn)}) AS max_value
  FROM tenant_backup_snapshots AS snapshot CROSS JOIN ${identifier(schema.table)} AS live
  WHERE snapshot.id = (SELECT snapshot_id FROM params)
    AND +snapshot.tenant_id = (SELECT tenant_id FROM params) AND +snapshot.state = 'capturing'
    AND live.${identifier(column)} IN (SELECT value FROM json_each((SELECT lookup FROM params)))
    ${filters.map((name) => `AND live.${identifier(name)} = ?`).join('\n    ')}
    AND ${ownedAtBoundary(schema, 'live', 'snapshot')}
    ${selectedPartitions ? `AND live.${identifier(partitionColumn ?? '')} IN (${selectedPartitions})` : ''}
    AND NOT EXISTS (
      SELECT 1 FROM tenant_backup_preimages AS previous
      WHERE previous.snapshot_id = snapshot.id AND previous.source_table = '${schema.table}'
        AND previous.record_key = ${recordKey(schema, 'live')}
    )
  GROUP BY ${groups.join(', ')}`;
}

/** Bind snapshotId, tenantId. Number of present preimages of one table in a capturing snapshot. */
export function sqliteSnapshotPreimageCountQuery(schema: CaptureSchema): string {
  validateSchema(schema);
  return `SELECT count(*) AS preimages FROM tenant_backup_snapshots AS snapshot
  CROSS JOIN tenant_backup_preimages AS previous
  WHERE snapshot.id = ? AND +snapshot.tenant_id = ? AND +snapshot.state = 'capturing'
    AND previous.snapshot_id = snapshot.id AND previous.source_table = '${schema.table}'
    AND previous.present = 1`;
}

/**
 * Bind snapshotId, tenantId, afterKey ('' for the first page) and a limit. Returns the boundary
 * values of one table's rows that changed after the boundary, in record_key text order, as
 * `record_key`, `row_type` ('blob' packed or legacy 'text' JSON) and `row_hex`. Preimages are
 * written only for rows the snapshot's tenant owned, so no ownership test is repeated here.
 */
export function sqliteSnapshotPreimagePageQuery(
  schema: CaptureSchema,
  partitions?: readonly string[]
): string {
  sqliteSnapshotPageQuery(schema, 'packed', partitions);
  const selectedPartitions = partitions ? rowPartitionValues(partitions) : null;
  return `WITH params(snapshot_id, tenant_id, after_key, page_limit) AS (SELECT ?, ?, ?, ?)
  SELECT previous.record_key, typeof(previous.row_json) AS row_type,
    hex(CAST(previous.row_json AS BLOB)) AS row_hex
  FROM tenant_backup_snapshots AS snapshot CROSS JOIN tenant_backup_preimages AS previous
  WHERE snapshot.id = (SELECT snapshot_id FROM params)
    AND +snapshot.tenant_id = (SELECT tenant_id FROM params) AND +snapshot.state = 'capturing'
    AND previous.snapshot_id = snapshot.id AND previous.source_table = '${schema.table}'
    AND previous.present = 1 AND previous.record_key > (SELECT after_key FROM params)
    ${selectedPartitions ? `AND previous.row_partition IN (${selectedPartitions})` : ''}
  ORDER BY previous.record_key LIMIT (SELECT page_limit FROM params)`;
}

/** Cheap T0 existence probe used to materialize execution work without encoding row bodies. */
export function sqliteSnapshotExistenceQuery(
  schema: CaptureSchema,
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
    SELECT 1 AS present
    FROM ${identifier(schema.table)} AS live
    JOIN selected_snapshot AS snapshot ON ${ownedAtBoundary(schema, 'live', 'snapshot')}
    WHERE ${selectedPartitions ? `live.${identifier(partitionColumn ?? '')} IN (${selectedPartitions}) AND ` : ''}NOT EXISTS (
      SELECT 1 FROM tenant_backup_preimages AS previous
      WHERE previous.snapshot_id = snapshot.id AND previous.source_table = '${schema.table}'
        AND previous.record_key = ${recordKey(schema, 'live')}
    )
    UNION ALL
    SELECT 1
    FROM tenant_backup_preimages AS previous
    JOIN selected_snapshot AS snapshot ON snapshot.id = previous.snapshot_id
    WHERE previous.source_table = '${schema.table}' AND previous.present = 1${selectedPartitions ? ` AND previous.row_partition IN (${selectedPartitions})` : ''}
  ) SELECT 1 FROM snapshot_rows LIMIT 1`;
}
