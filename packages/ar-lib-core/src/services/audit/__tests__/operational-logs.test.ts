import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@authrim/ar-lib-logging/iceberg/capabilities', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-logging/iceberg/capabilities')>()),
  LOG_ARCHIVE_IMPLEMENTED_MODES: ['scheduled', 'pipeline'],
}));
import { storeOperationalLog } from '../operational-logs';
import { logProducerFixture } from '../../__tests__/log-iceberg-producer-fixture';
import { decryptLogIcebergRecord } from '../../log-iceberg-record';
import { decryptProtectedLogIcebergDetail } from '../../log-iceberg-row-codec';
import type { LogArchiveRecord } from '@authrim/ar-lib-logging/iceberg/schema';

describe.each(['scheduled', 'pipeline'] as const)('operational reasons (%s)', (mode) => {
  let f: Awaited<ReturnType<typeof logProducerFixture>>;
  beforeEach(async () => {
    f = await logProducerFixture(mode);
  });
  afterEach(() => f.db.close());
  const input = () => ({
    tenantId: 'tenant-a',
    subjectType: 'user' as const,
    subjectId: 'user-1',
    actorId: 'admin-1',
    action: 'user.suspend',
    reasonDetail: 'Sensitive private investigation reason',
    requestId: 'request-1',
  });

  it('writes one new log with a nested reason, the original second-based row TTL and no old copies', async () => {
    const id = await storeOperationalLog(f.env, input());
    const rows = await f.rows('core.operational_logs');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id,
      reason_detail_encrypted: null,
      encryption_key_version: 0,

      subject_id: 'user-1',
    });
    expect(rows[0].detail_object_catalog_id).toMatch(/^ilgd_/);
    expect(Number(rows[0].expires_at) - Number(rows[0].created_at)).toBe(90 * 86400);
    expect(JSON.stringify(rows)).not.toContain(input().reasonDetail);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM operational_logs').get()?.n).toBe(0);
    const records: LogArchiveRecord[] =
      mode === 'scheduled'
        ? await f.staging.readTenant({
            tenantId: 'tenant-a',
            tenantKey: 'key-a',
            sourceDataset: 'core.operational_logs',
            now: f.now,
          })
        : [...f.objects.values()].map((value) => JSON.parse(value.text) as LogArchiveRecord);
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record.expires_at).toBe(Number(rows[0].expires_at) * 1000);
    const body = await decryptLogIcebergRecord(
      record,
      { tenantKey: 'key-a', sourceDataset: 'core.operational_logs' },
      async () => f.keys
    );
    expect(JSON.stringify(body.row)).not.toContain(input().reasonDetail);
    expect(
      await decryptProtectedLogIcebergDetail({ record, body, resolveKeys: async () => f.keys })
    ).toEqual({ reason_detail: input().reasonDetail });
    expect(f.queueMessages.length).toBe(mode === 'pipeline' ? 1 : 0);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_records').get()?.n).toBe(
      mode === 'scheduled' ? 1 : 0
    );
  });

  it('preserves an explicit tenant retention and skips an empty reason', async () => {
    await storeOperationalLog(f.env, { ...input(), retentionDays: 7 });
    const rows = await f.rows('core.operational_logs');
    expect(Number(rows[0].expires_at) - Number(rows[0].created_at)).toBe(7 * 86400);
    expect(await storeOperationalLog(f.env, { ...input(), reasonDetail: '' })).toBe('');
    expect(await f.rows('core.operational_logs')).toHaveLength(1);
  });

  it('rejects a missing storage mode and invalid retention without an inline or legacy fallback', async () => {
    await expect(
      storeOperationalLog({ ...f.env, AUTHRIM_LOG_ARCHIVE_MODE: undefined }, input())
    ).rejects.toThrow();
    await expect(storeOperationalLog(f.env, { ...input(), retentionDays: -1 })).rejects.toThrow(
      'operational_log_retention_invalid'
    );
    expect(await f.rows('core.operational_logs')).toEqual([]);
  });
});
