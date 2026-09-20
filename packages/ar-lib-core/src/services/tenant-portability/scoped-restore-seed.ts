import type { DatabaseAdapter } from '../../db/adapter';
import { backupOwnershipPredicate, type BackupRowOwnership } from './row-ownership';
import type { SqliteDatasetInspectionPolicy } from './sqlite-dataset-inspector';
import { sqliteDatasetInspectionPolicyDescriptor } from './sqlite-dataset-inspector';
import type { CaptureSchema } from './sqlite-snapshot';
import { sqlitePackedRowExpression } from './sqlite-packed-row';

type Database = Pick<DatabaseAdapter, 'query'>;
// Packed-row expressions can consume hundreds of SQLite compound terms for wide tables. Two
// datasets per statement is the D1-safe bound; four concurrent pages still collapse the latency of
// the many small/empty datasets without exceeding the Worker connection budget.
const MAX_QUERY_TERMS = 2;
const MAX_QUERY_SQL_BYTES = 48 * 1024;
const QUERY_PAGE_CONCURRENCY = 4;
const MAX_SEED_ROWS = 8192;
const fail = () => new Error('backup_scoped_restore_seed_unavailable');
const identifier = (value: string) => {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw fail();
  return `"${value}"`;
};
const digest = async (value: string) => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
};
function ownership(schema: CaptureSchema): BackupRowOwnership {
  if ('parent' in schema)
    return {
      kind: 'parent',
      table: schema.parent.schema.table,
      keys: schema.parent.schema.primaryKey.map((parent, index) => ({
        parent,
        child: schema.parent.childColumns[index],
      })),
      ownership: ownership(schema.parent.schema),
    };
  return schema.scopeTypeColumn
    ? { kind: 'scope', typeColumn: schema.scopeTypeColumn, idColumn: schema.tenantColumn }
    : {
        kind: 'tenant',
        column: schema.tenantColumn,
        identity: schema.tenantIdentity ?? 'tenantId',
      };
}

/**
 * Pin only one tenant's installed target slice in a shared SQLite database. Log rows are excluded
 * because the import request and approval themselves append audit evidence before staging starts;
 * conflicting restored log IDs are still rejected by the normal exact-row writer.
 */
export async function readScopedSqliteRestoreSeedFingerprint(input: {
  database: Database;
  policies: readonly SqliteDatasetInspectionPolicy[];
  tenantId: string;
  tenantKey: string;
  assertAdmission: () => Promise<void>;
}): Promise<string> {
  if (
    !input.tenantId ||
    !input.tenantKey ||
    !input.policies.length ||
    input.policies.length > 4096 ||
    new Set(input.policies.map(({ dataset }) => dataset.id)).size !== input.policies.length
  )
    throw fail();
  const sorted = [...input.policies].sort((left, right) =>
    left.dataset.id.localeCompare(right.dataset.id)
  );
  const descriptors = new Map(
    sorted.map((policy) => [policy.dataset.id, sqliteDatasetInspectionPolicyDescriptor(policy)])
  );
  const hashesByDataset = new Map<string, string[]>();
  const queryable: {
    datasetId: string;
    sql: string;
    params: unknown[];
  }[] = [];
  let totalRows = 0;
  for (const policy of sorted) {
    hashesByDataset.set(policy.dataset.id, []);
    if (
      ['audit', 'history', 'sensitive_logs', 'delivery_state', 'log_dependencies'].includes(
        policy.dataset.kind
      ) ||
      policy.restoreDisposition === 'reference_only'
    )
      continue;
    const schema = policy.schema;
    const predicate = backupOwnershipPredicate(ownership(schema), {
      tenantId: input.tenantId,
      tenantKey: policy.restoreTenantKey ?? policy.tenantKey ?? input.tenantKey,
    });
    const packed = sqlitePackedRowExpression(schema.columns, 'backup_row');
    const partition = schema.rowPartition
      ? ` AND ${identifier('backup_row')}.${identifier(schema.rowPartition.column)} IN (${(
          policy.partitions ?? schema.rowPartition.values
        )
          .map(() => '?')
          .join(',')})`
      : '';
    const params = [
      ...predicate.params,
      ...(schema.rowPartition ? [...(policy.partitions ?? schema.rowPartition.values)] : []),
    ];
    queryable.push({
      datasetId: policy.dataset.id,
      sql: `SELECT ? AS dataset_id,hex(${packed}) AS encoded
            FROM ${identifier(schema.table)} AS backup_row
            WHERE ${predicate.sql}${partition}`,
      params: [policy.dataset.id, ...params],
    });
  }

  const pages: (typeof queryable)[] = [];
  let page: typeof queryable = [];
  let pageSqlBytes = 0;
  for (const query of queryable) {
    const queryBytes = new TextEncoder().encode(query.sql).byteLength;
    if (
      page.length &&
      (page.length >= MAX_QUERY_TERMS || pageSqlBytes + queryBytes > MAX_QUERY_SQL_BYTES)
    ) {
      pages.push(page);
      page = [];
      pageSqlBytes = 0;
    }
    page.push(query);
    pageSqlBytes += queryBytes;
  }
  if (page.length) pages.push(page);

  // The caller's admission check revalidates the lease, restore plan, routing, and unpublished
  // target. Repeating that full cross-database check for every mostly-empty page made plan creation
  // scale with the registered dataset count. Pin admission once around this bounded read; the outer
  // restore-plan guard checks it again before persisting the fingerprint.
  await input.assertAdmission();
  for (let offset = 0; offset < pages.length; offset += QUERY_PAGE_CONCURRENCY) {
    const group = pages.slice(offset, offset + QUERY_PAGE_CONCURRENCY);
    const results = await Promise.all(
      group.map((entries) =>
        input.database.query<{ dataset_id: string; encoded: string }>(
          `SELECT dataset_id,encoded FROM (${entries.map(({ sql }) => sql).join(' UNION ALL ')}) LIMIT ?`,
          [...entries.flatMap(({ params }) => params), MAX_SEED_ROWS + 1]
        )
      )
    );
    for (const rows of results) {
      totalRows += rows.length;
      if (totalRows > MAX_SEED_ROWS) throw fail();
      for (const row of rows) {
        const hashes = hashesByDataset.get(row.dataset_id);
        if (!hashes || typeof row.encoded !== 'string' || !/^[A-F0-9]+$/.test(row.encoded))
          throw fail();
        hashes.push(await digest(row.encoded));
      }
    }
  }
  await input.assertAdmission();

  const datasets: Array<{ descriptor: unknown; rows: number; digest: string }> = [];
  for (const policy of sorted) {
    const descriptor = descriptors.get(policy.dataset.id);
    const hashes = hashesByDataset.get(policy.dataset.id);
    if (!descriptor || !hashes) throw fail();
    hashes.sort();
    datasets.push({
      descriptor,
      rows: hashes.length,
      digest: await digest(JSON.stringify(hashes)),
    });
  }
  return digest(JSON.stringify({ version: 1, tenantId: input.tenantId, datasets }));
}
