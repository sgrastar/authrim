import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogArchiveRecord } from '@authrim/ar-lib-logging/iceberg/schema';
import { AuditService } from '../audit-service';
import type { Env } from '../../../types/env';
import { logProducerFixture } from '../../__tests__/log-iceberg-producer-fixture';
import { decryptLogIcebergRecord } from '../../log-iceberg-record';
import { decryptProtectedLogIcebergDetail } from '../../log-iceberg-row-codec';
import { sqliteAdapter } from '../../../repositories/__tests__/sqlite-core-schema';
vi.mock('@authrim/ar-lib-logging/iceberg/capabilities', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-logging/iceberg/capabilities')>()),
  LOG_ARCHIVE_IMPLEMENTED_MODES: ['scheduled', 'pipeline'],
}));
const close: (() => void)[] = [];
afterEach(() => close.splice(0).forEach((fn) => fn()));
async function fixture(mode: 'scheduled' | 'pipeline') {
  const f = await logProducerFixture(mode),
    pii = sqliteAdapter('pii');
  close.push(f.close, () => pii.db.close());
  Object.assign(pii.adapter, {
    getType: () => 'd1',
    close: async () => {},
    isHealthy: async () => ({ healthy: true, latencyMs: 0, type: 'd1' }),
    transaction: async () => {
      throw new Error('use batch');
    },
  });
  pii.db
    .prepare(
      'INSERT INTO user_anonymization_map(id,tenant_id,user_id,anonymized_user_id,created_at) VALUES(?,?,?,?,?)'
    )
    .run('map', 'tenant-a', 'user-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', Date.now());
  const oldPut = vi.fn();
  Object.assign(f.env, { SENSITIVE_DETAILS: { put: oldPut }, AUDIT_ARCHIVE: { put: oldPut } });
  const service = new AuditService({ env: f.env as Env, piiSource: pii.adapter });
  const records = async (dataset: string) =>
    mode === 'scheduled'
      ? f.staging.readTenant({
          tenantId: 'tenant-a',
          tenantKey: 'key-a',
          sourceDataset: dataset,
          now: Date.now(),
        })
      : [...f.objects.values()]
          .map((value) => JSON.parse(value.text) as LogArchiveRecord)
          .filter((record) => record.source_dataset === dataset);
  return { ...f, pii, service, oldPut, records };
}
describe('new logging storage conformance', () => {
  for (const mode of ['scheduled', 'pipeline'] as const) {
    it(`keeps large event detail only in the canonical encrypted ${mode} record`, async () => {
      const f = await fixture(mode);
      await f.service.logEvent('tenant-a', {
        eventType: 'auth.login',
        eventCategory: 'auth',
        result: 'success',
        details: { payload: 'private-'.repeat(600) },
      });
      const rows = await f.rows('core.event_log');
      expect(rows).toHaveLength(1);
      expect(String(rows[0].details_json)).toContain('private-');
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM event_log').get()?.n).toBe(0);
      expect(f.oldPut).not.toHaveBeenCalled();
      expect(
        JSON.stringify(f.db.prepare('SELECT * FROM log_iceberg_record_parts').all())
      ).not.toContain('private-');
      expect([...f.objects.values()].map((value) => value.text).join('')).not.toContain('private-');
      expect([...f.objects.keys()].every((key) => key.startsWith('_authrim_retry/iceberg/'))).toBe(
        true
      );
    });
    it(`protects large PII values in nested detail in ${mode} without legacy PII rows or JSON objects`, async () => {
      const f = await fixture(mode);
      await f.service.logPIIChange('tenant-a', {
        userId: 'user-1',
        anonymizedUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        changeType: 'update',
        affectedFields: ['profile'],
        newValues: { profile: 'private-'.repeat(900) },
        actorType: 'admin',
      });
      const [record] = await f.records('pii.pii_log');
      expect(record.subject_id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      const body = await decryptLogIcebergRecord(
        record,
        { tenantKey: 'key-a', sourceDataset: 'pii.pii_log' },
        async () => f.keys
      );
      expect(JSON.stringify(body)).not.toContain('private-');
      const detail = await decryptProtectedLogIcebergDetail({
        record,
        body,
        resolveKeys: async () => f.keys,
      });
      expect(detail).toMatchObject({ values: { new: { profile: 'private-'.repeat(900) } } });
      expect(f.pii.db.prepare('SELECT COUNT(*) AS n FROM pii_log').get()?.n).toBe(0);
      expect(f.oldPut).not.toHaveBeenCalled();
    });
  }
  it('fails closed on canonical writer failure without another DB or R2 copy', async () => {
    const f = await fixture('scheduled');
    if (!f.env.LOG_ARCHIVE_WRITER) throw new Error('missing writer');
    f.env.LOG_ARCHIVE_WRITER.writeRecords = vi.fn(async () => {
      throw new Error('archive_unavailable');
    });
    await expect(
      f.service.logEvent('tenant-a', {
        eventType: 'auth.login',
        eventCategory: 'auth',
        result: 'success',
        details: { payload: 'x'.repeat(3000) },
      })
    ).rejects.toThrow('archive_unavailable');
    expect(f.oldPut).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM event_log').get()?.n).toBe(0);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_records').get()?.n).toBe(0);
  });
});
