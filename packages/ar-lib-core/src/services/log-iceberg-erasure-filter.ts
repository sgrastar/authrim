import type { LogArchiveRecord } from '@authrim/ar-lib-logging/iceberg/schema';
import type { DatabaseAdapter } from '../db/adapter';

export const LOG_ICEBERG_PII_SUBJECT_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** Every accepted PII subject must also be addressable by the purge API. */
export function assertLogIcebergPiiSubject(dataset: string, subjectId: string | null): void {
  if (dataset === 'pii.pii_log' && (!subjectId || !LOG_ICEBERG_PII_SUBJECT_ID.test(subjectId)))
    throw new Error('log_iceberg_pii_subject_invalid');
}

export async function isErasedLogIcebergSubject(
  admin: DatabaseAdapter,
  tenantId: string,
  sourceDataset: string,
  subjectId: string | null
): Promise<boolean> {
  assertLogIcebergPiiSubject(sourceDataset, subjectId);
  if (sourceDataset !== 'pii.pii_log' || !subjectId) return false;
  return Boolean(
    await admin.queryOne<{ id: string }>(
      'SELECT id FROM log_iceberg_subject_erasures WHERE tenant_id=? AND source_dataset=? AND subject_id=?',
      [tenantId, sourceDataset, subjectId],
      { consistencyClass: 'primary_required' }
    )
  );
}

export async function filterUnErasedLogIcebergRecords(
  admin: DatabaseAdapter,
  tenantId: string,
  records: readonly LogArchiveRecord[]
): Promise<LogArchiveRecord[]> {
  const pii = records.filter((record) => record.source_dataset === 'pii.pii_log');
  for (const record of pii) assertLogIcebergPiiSubject(record.source_dataset, record.subject_id);
  if (!pii.length) return [...records];
  const erased = new Set<string>();
  const subjects = [...new Set(pii.map((record) => record.subject_id))];
  for (let start = 0; start < subjects.length; start += 64) {
    const values = subjects.slice(start, start + 64);
    const rows = await admin.query<{ subject_id: string }>(
      `SELECT subject_id FROM log_iceberg_subject_erasures WHERE tenant_id=? AND source_dataset='pii.pii_log' AND subject_id IN(${values.map(() => '?').join(',')})`,
      [tenantId, ...values],
      { consistencyClass: 'primary_required' }
    );
    for (const row of rows) erased.add(row.subject_id);
  }
  return records.filter(
    (record) => record.source_dataset !== 'pii.pii_log' || !erased.has(record.subject_id ?? '')
  );
}
