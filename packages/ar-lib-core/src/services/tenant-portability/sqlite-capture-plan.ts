import { splitMigrationSql } from '../control-plane/migration-sql.js';
import { sqliteSnapshotTriggers, type CaptureSchema } from './sqlite-snapshot.js';

function schemaSignature(schema: CaptureSchema): string {
  return JSON.stringify({
    table: schema.table,
    columns: [...schema.columns].sort(),
    primaryKey: schema.primaryKey,
    uniqueKeys: schema.uniqueKeys
      .map((key) => [...key])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    uniqueExpressions: schema.uniqueExpressions ?? [],
    rowPartition: schema.rowPartition
      ? { column: schema.rowPartition.column, values: [...schema.rowPartition.values].sort() }
      : null,
    ownership:
      'parent' in schema
        ? schema.parent
        : {
            column: schema.tenantColumn,
            scopeTypeColumn: schema.scopeTypeColumn,
            tenantIdentity: schema.tenantIdentity ?? 'tenantId',
          },
  });
}

// Keep expression depth logarithmic when checking hundreds of tables on D1.
function balancedConjunction(conditions: readonly string[]): string {
  if (conditions.length === 0) return '1';
  if (conditions.length === 1) return conditions[0];
  const middle = Math.floor(conditions.length / 2);
  return `(${balancedConjunction(conditions.slice(0, middle))} AND ${balancedConjunction(conditions.slice(middle))})`;
}

/** Close parent dependencies before installing triggers or starting a snapshot. */
export function sqliteCapturePlan(
  schemas: readonly CaptureSchema[],
  representation: 'packed' | 'json' = 'packed'
): {
  schemas: CaptureSchema[];
  triggers: Array<{ name: string; table: string; sql: string }>;
} {
  if (!schemas.length) throw new Error('snapshot_empty_capture_plan');
  const collected = new Map<string, CaptureSchema>();
  function visit(schema: CaptureSchema): void {
    // Validate before walking the graph; nested/cyclic parents are currently unsupported.
    sqliteSnapshotTriggers(schema);
    const previous = collected.get(schema.table);
    if (previous) {
      if (schemaSignature(previous) !== schemaSignature(schema))
        throw new Error('snapshot_conflicting_capture_schema');
      return;
    }
    if ('parent' in schema) visit(schema.parent.schema);
    collected.set(schema.table, schema);
  }
  for (const schema of schemas) visit(schema);
  const ordered = [...collected.values()];
  return {
    schemas: ordered,
    triggers: ordered.flatMap((schema) => {
      const statements = splitMigrationSql(sqliteSnapshotTriggers(schema, representation));
      if (statements.length !== 3) throw new Error('snapshot_invalid_trigger_count');
      return statements.map((sql, index) => ({
        name: `tenant_backup_${schema.table}_${['insert', 'update', 'delete'][index]}`,
        table: schema.table,
        sql: sql.trim().replace(/;+$/, ''),
      }));
    }),
  };
}

/**
 * Check exact installed capture triggers and DB primary-key constraints in one statement, without a
 * read/check/write race. Callers MUST require meta.changes === 1; zero is not success.
 * This is not full readiness: schema/data compatibility and cross-store fencing are
 * coordinator prerequisites. DDL must remain fenced for the entire capture lifetime.
 */
export function sqliteSnapshotStartStatement(
  schemas: readonly CaptureSchema[],
  snapshotId: string,
  tenantId: string,
  tenantKey?: string,
  representation: 'packed' | 'json' = 'packed'
): { sql: string; params: string[] } {
  if (!snapshotId || !tenantId) throw new Error('snapshot_missing_identity');
  const plan = sqliteCapturePlan(schemas, representation);
  if (tenantKey !== undefined && !tenantKey) throw new Error('snapshot_missing_tenant_key');
  if (
    plan.schemas.some((schema) => !('parent' in schema) && schema.tenantIdentity === 'tenantKey') &&
    !tenantKey
  )
    throw new Error('snapshot_missing_tenant_key');
  const partitionChecks = plan.schemas.flatMap((schema) => {
    if (!schema.rowPartition) return [];
    const column = `"${schema.rowPartition.column}"`;
    const table = `"${schema.table}"`;
    const values = schema.rowPartition.values.map((value) => `'${value}'`).join(', ');
    const ownership =
      'parent' in schema
        ? null
        : schema.scopeTypeColumn
          ? `partitioned_row."${schema.tenantColumn}" = snapshot.${schema.tenantIdentity === 'tenantKey' ? 'tenant_key' : 'tenant_id'} AND partitioned_row."${schema.scopeTypeColumn}" = 'tenant'`
          : `partitioned_row."${schema.tenantColumn}" = snapshot.${schema.tenantIdentity === 'tenantKey' ? 'tenant_key' : 'tenant_id'}`;
    // Parent-owned partitioned rows require a specialized start validator because ownership must
    // be resolved at the boundary. Refuse such a plan instead of scanning a wider table.
    if (!ownership) throw new Error('snapshot_parent_row_partition_unsupported');
    return [
      `NOT EXISTS (SELECT 1 FROM ${table} AS partitioned_row
        WHERE ${ownership}
          AND (typeof(partitioned_row.${column}) <> 'text'
            OR partitioned_row.${column} NOT IN (${values})))`,
    ];
  });
  // D1 limits each bound string. Parse bounded arrays independently rather than
  // concatenating them back into one oversized value inside SQLite.
  const chunks: string[] = [];
  let entries: string[] = [];
  let bytes = 2;
  const primaryKeys = new Map(plan.schemas.map((schema) => [schema.table, schema.primaryKey]));
  for (const trigger of plan.triggers) {
    const primaryKey = primaryKeys.get(trigger.table);
    if (!primaryKey) throw new Error('snapshot_missing_capture_schema');
    // Three triggers share one table contract. Check it on the INSERT entry only.
    const entry = JSON.stringify({
      ...trigger,
      ...(trigger.name.endsWith('_insert') ? { primaryKey } : {}),
    });
    const size = new TextEncoder().encode(entry).length;
    if (size + 2 > 256 * 1024) throw new Error('snapshot_trigger_definition_too_large');
    if (bytes + size + 1 > 256 * 1024) {
      chunks.push(`[${entries.join(',')}]`);
      entries = [];
      bytes = 2;
    }
    entries.push(entry);
    bytes += size + 1;
  }
  if (entries.length) chunks.push(`[${entries.join(',')}]`);
  if (chunks.length > 90) throw new Error('snapshot_start_plan_too_large');
  return {
    sql: `WITH requested_snapshot AS (SELECT ? AS id, ? AS tenant_id, ${tenantKey === undefined ? 'NULL' : '?'} AS tenant_key)
      INSERT INTO tenant_backup_snapshots (id, tenant_id, state, tenant_key)
      SELECT snapshot.id, snapshot.tenant_id, 'capturing', snapshot.tenant_key FROM requested_snapshot AS snapshot
      WHERE ${balancedConjunction([
        ...chunks.map(
          () => `NOT EXISTS (
        SELECT 1 FROM json_each(?) AS expected
        WHERE NOT EXISTS (
          SELECT 1 FROM sqlite_schema AS installed
          WHERE installed.type = 'trigger'
            AND installed.name = json_extract(expected.value, '$.name')
            AND installed.tbl_name = json_extract(expected.value, '$.table')
            AND rtrim(trim(installed.sql), ';') = json_extract(expected.value, '$.sql')
        )
        OR (json_extract(expected.value, '$.name') = 'tenant_backup_' || json_extract(expected.value, '$.table') || '_insert'
          AND (json_type(expected.value, '$.primaryKey') IS NOT 'array' OR NOT EXISTS (SELECT 1 FROM pragma_index_list(json_extract(expected.value, '$.table'))
          WHERE origin='pk')
        OR (SELECT count(*) FROM pragma_table_info(json_extract(expected.value, '$.table')) WHERE pk>0)
          != json_array_length(json_extract(expected.value, '$.primaryKey'))
        OR EXISTS (SELECT 1 FROM json_each(expected.value, '$.primaryKey') AS expected_key
          WHERE NOT EXISTS (SELECT 1 FROM pragma_table_info(json_extract(expected.value, '$.table')) AS installed_key
            WHERE installed_key.name=expected_key.value AND installed_key.pk=expected_key.key+1
              AND installed_key."notnull"=1))))
      )`
        ),
        ...partitionChecks,
      ])}`,
    params: [snapshotId, tenantId, ...(tenantKey === undefined ? [] : [tenantKey]), ...chunks],
  };
}

/** Same checked start, with an exact-identity retry that never replaces rows or old preimages. */
export function sqliteSnapshotStartOrResumeStatement(
  schemas: readonly CaptureSchema[],
  snapshotId: string,
  tenantId: string,
  tenantKey?: string,
  representation: 'packed' | 'json' = 'packed'
): { sql: string; params: string[] } {
  const statement = sqliteSnapshotStartStatement(
    schemas,
    snapshotId,
    tenantId,
    tenantKey,
    representation
  );
  return {
    ...statement,
    sql: `${statement.sql}
      ON CONFLICT(id) DO UPDATE SET state=tenant_backup_snapshots.state
      WHERE tenant_backup_snapshots.tenant_id=excluded.tenant_id
        AND tenant_backup_snapshots.tenant_key IS excluded.tenant_key
        AND tenant_backup_snapshots.state='capturing'`,
  };
}
