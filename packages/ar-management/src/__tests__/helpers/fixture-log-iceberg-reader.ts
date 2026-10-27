import { ensureDatabaseAdapter, type Env } from '@authrim/ar-lib-core';
import type {
  LogIcebergReadScope,
  LogIcebergDatasetReadResult,
} from '@authrim/ar-lib-core/services/log-iceberg-read';
import type { LogIcebergSqlRow } from '@authrim/ar-lib-core/services/log-iceberg-row-codec';

/** Existing identity/report fixtures store their input rows in SQLite. This is an injected test
 * read port only; production must never query these former log tables or use this helper. */
export async function fixtureLogIcebergReader(
  env: Env,
  input: LogIcebergReadScope
): Promise<LogIcebergDatasetReadResult> {
  if (!/^(core|admin)\.[a-z_]+$/.test(input.sourceDataset)) throw new Error('fixture dataset');
  const table = input.sourceDataset.split('.')[1];
  const adapter = ensureDatabaseAdapter(env.DB);
  const rows = await adapter.query<LogIcebergSqlRow>(`SELECT * FROM ${table} WHERE tenant_id=?`, [
    input.tenantId,
  ]);
  const factor = [
    'core.audit_log',
    'core.operational_logs',
    'core.permission_check_audit',
  ].includes(input.sourceDataset)
    ? 1000
    : 1;
  const column =
    input.sourceDataset === 'core.permission_check_audit' ? 'checked_at' : 'created_at';
  return {
    rows: rows.filter((row) => {
      const at = Number(row[column]) * factor;
      return (
        (!input.eventId || row.id === input.eventId) &&
        (input.fromMs === undefined || at >= input.fromMs) &&
        (input.toMs === undefined || at <= input.toMs)
      );
    }),
    hasArchive: false,
    consistency: 'snapshot',
    pendingDeliveries: 0,
  };
}
