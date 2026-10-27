import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { filterUnErasedLogIcebergRecords } from '../log-iceberg-erasure-filter';
import { exportLogIcebergBatch } from '../log-iceberg-export';
import { createLogIcebergReadPort } from '../log-iceberg-read';
import { icebergFixture } from './log-iceberg-test-fixture';

describe('PII anonymous-subject replay barrier', () => {
  let f: Awaited<ReturnType<typeof icebergFixture>>;
  beforeEach(async () => {
    f = await icebergFixture();
  });
  afterEach(() => f.db.close());
  const erase = () =>
    f.db
      .prepare(
        `INSERT INTO log_iceberg_subject_erasures(id,tenant_id,tenant_key,source_dataset,subject_id,state,created_at,updated_at)VALUES(?,?,?,?,?,'pending',?,?)`
      )
      .run(
        'erasure-a',
        'tenant-a',
        'key-a',
        'pii.pii_log',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        f.now,
        f.now
      );
  it('does not write staging bodies when an erase request races a prepared atomic batch', async () => {
    const record = await f.record('pii-1', { sourceDataset: 'pii.pii_log' });
    const prepared = await f.staging.preparePut('tenant-a', record);
    erase();
    await f.adapter.batch(prepared.statements);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_records').get()?.n).toBe(0);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_record_parts').get()?.n).toBe(0);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_event_receipts').get()?.n).toBe(0);
    await expect(f.staging.put('tenant-a', record)).resolves.toBeUndefined();
  });
  it('removes erased PII before decryption but preserves another subject, tenant and normal audit event', async () => {
    const erased = await f.record('pii-1', { sourceDataset: 'pii.pii_log' });
    await f.staging.put('tenant-a', erased);
    await exportLogIcebergBatch(f.config, f.ports);
    erase();
    const allowed = await f.record('pii-2', {
      sourceDataset: 'pii.pii_log',
      subjectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
    const otherTenant = await f.record('pii-3', {
      sourceDataset: 'pii.pii_log',
      tenantId: 'tenant-b',
      tenantKey: 'key-b',
    });
    const audit = await f.record('audit-1');
    expect(
      await filterUnErasedLogIcebergRecords(f.adapter, 'tenant-a', [erased, allowed, audit])
    ).toEqual([allowed, audit]);
    expect(await filterUnErasedLogIcebergRecords(f.adapter, 'tenant-b', [otherTenant])).toEqual([
      otherTenant,
    ]);
    // Invalid current key proves the erased ciphertext never reaches decryption.
    const reader = createLogIcebergReadPort(
      {
        OBJECT_ENCRYPTION_ROOT_KEY: '00'.repeat(32),
        LOG_ARCHIVE_ROOT_KEYRING: JSON.stringify({
          schema_version: 1,
          current_version: 1,
          roots: { 1: '00'.repeat(32) },
        }),
        LOG_ARCHIVE_CONTENT_HMAC_KEY: f.keys.contentHmacKeyHex,
      },
      f.config,
      { ...f.ports, tenantKey: async () => 'key-a' }
    );
    expect(
      (await reader.readDataset({ tenantId: 'tenant-a', sourceDataset: 'pii.pii_log', now: f.now }))
        .rows
    ).toEqual([]);
  });
  it('rejects a PII producer that omits its anonymous subject instead of creating an unerasable record', async () => {
    const record = await f.record('pii-1', { sourceDataset: 'pii.pii_log' });
    await expect(
      filterUnErasedLogIcebergRecords(f.adapter, 'tenant-a', [{ ...record, subject_id: null }])
    ).rejects.toThrow('log_iceberg_pii_subject_invalid');
    await expect(f.staging.preparePut('tenant-a', { ...record, subject_id: null })).rejects.toThrow(
      'log_iceberg_pii_subject_invalid'
    );
  });
});
