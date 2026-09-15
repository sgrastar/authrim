import type { DatabaseAdapter } from '../../db/adapter';
import { backupOwnershipPredicate, type BackupRowOwnership } from './row-ownership';
import type { SqliteDatasetInspectionPolicy } from './sqlite-dataset-inspector';
import { sqliteDatasetInspectionPolicyDescriptor } from './sqlite-dataset-inspector';
import type { CaptureSchema } from './sqlite-snapshot';
import { sqlitePackedRowExpression } from './sqlite-packed-row';

type Database = Pick<DatabaseAdapter, 'query'>;
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
  const datasets: Array<{ descriptor: unknown; rows: number; digest: string }> = [];
  let totalRows = 0;
  for (const policy of [...input.policies].sort((left, right) =>
    left.dataset.id.localeCompare(right.dataset.id)
  )) {
    const descriptor = sqliteDatasetInspectionPolicyDescriptor(policy);
    if (
      ['audit', 'history', 'sensitive_logs', 'delivery_state', 'log_dependencies'].includes(
        policy.dataset.kind
      ) ||
      policy.restoreDisposition === 'reference_only'
    ) {
      datasets.push({ descriptor, rows: 0, digest: await digest('[]') });
      continue;
    }
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
    const hashes: string[] = [];
    for (let offset = 0; ; offset += 32) {
      await input.assertAdmission();
      const rows = await input.database.query<{ encoded: string }>(
        `SELECT hex(${packed}) AS encoded FROM ${identifier(schema.table)} AS backup_row
         WHERE ${predicate.sql}${partition} LIMIT 32 OFFSET ?`,
        [...params, offset]
      );
      if (!rows.length) break;
      for (const row of rows) {
        if (typeof row.encoded !== 'string' || !/^[A-F0-9]+$/.test(row.encoded)) throw fail();
        hashes.push(await digest(row.encoded));
      }
      totalRows += rows.length;
      if (totalRows > 8192) throw fail();
    }
    hashes.sort();
    datasets.push({
      descriptor,
      rows: hashes.length,
      digest: await digest(JSON.stringify(hashes)),
    });
  }
  await input.assertAdmission();
  return digest(JSON.stringify({ version: 1, tenantId: input.tenantId, datasets }));
}
