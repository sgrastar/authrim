import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import { buildLogIcebergRecord } from '../log-iceberg-record';
import type { LogIcebergConfig } from '../log-iceberg-config';
import { SqlLogIcebergRecordStore, type LogIcebergStagedHead } from '../log-iceberg-store';

const now = 1_800_000_000_000;
const config: LogIcebergConfig = {
  mode: 'scheduled',
  generation: 'new-generation',
  schemaVersion: 1,
  activatedAt: now,
  accountId: 'a'.repeat(32),
  bucket: 'logs',
  warehouse: `${'a'.repeat(32)}_logs`,
  catalogUri: `https://catalog.cloudflarestorage.com/${'a'.repeat(32)}/logs`,
  namespace: 'authrim',
  table: 'logs_v1',
  tableUuid: 'f644e0fa-a8d7-4976-bcd7-1520bc0f8d9b',
  physicalFingerprint: 'f'.repeat(64),
  dbRetentionDays: 7,
  exportIntervalMinutes: 10,
};
const keys = { rootKeyHex: 'ab'.repeat(32), keyVersion: 1, contentHmacKeyHex: 'cd'.repeat(32) };
const scope = { tenantId: 'tenant-a', tenantKey: 'key-a', sourceDataset: 'core.audit_log', now };
const makeRecord = (
  id = 'event-1',
  body: Record<string, unknown> = { id, email: 'private@example.invalid' }
) =>
  buildLogIcebergRecord(
    config,
    {
      eventId: id,
      tenantKey: scope.tenantKey,
      sourceDataset: scope.sourceDataset,
      logType: 'audit',
      eventAt: now - 1000,
      ingestedAt: now,
      expiresAt: now + 1000,
      body,
    },
    keys
  );

describe('new-generation encrypted DB staging (real SQL)', () => {
  let fixture: ReturnType<typeof sqliteAdapter>;
  let store: SqlLogIcebergRecordStore;
  beforeEach(() => {
    fixture = sqliteAdapter();
    fixture.db.exec('PRAGMA foreign_keys=ON');
    fixture.db.exec(
      readFileSync(
        new URL('../../../../../migrations/admin/d1/052_log_iceberg_storage.sql', import.meta.url),
        'utf8'
      )
    );
    store = new SqlLogIcebergRecordStore(fixture.adapter);
  });
  afterEach(() => {
    fixture.db.close();
  });

  it('stores a large encrypted envelope in bounded parts without plaintext or a legacy log INSERT', async () => {
    const record = await makeRecord('large', { value: '日本語'.repeat(220_000) });
    expect(record.detail_ciphertext.length).toBeGreaterThan(2_000_000);
    await store.put(scope.tenantId, record);
    const part = fixture.db
      .prepare(
        'SELECT MAX(length(CAST(body AS BLOB))) AS bytes,COUNT(*) AS count FROM log_iceberg_record_parts'
      )
      .get();
    expect(Number(part?.bytes)).toBeLessThanOrEqual(65536);
    expect(Number(part?.count)).toBeGreaterThan(30);
    expect(await store.readTenant(scope)).toEqual([record]);
    expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get()?.n).toBe(0);
    const header = fixture.db.prepare('SELECT header_json FROM log_iceberg_records').get();
    expect(header?.header_json).not.toContain('日本語');
    expect(header?.header_json).not.toContain('private@example.invalid');
  });

  it('retains the first immutable envelope on an identical retry with another nonce', async () => {
    const first = await makeRecord();
    const retry = await makeRecord();
    expect(first.detail_ciphertext).not.toBe(retry.detail_ciphertext);
    await store.put(scope.tenantId, first);
    await store.put(scope.tenantId, retry);
    expect(await store.readTenant(scope)).toEqual([first]);
    expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_records').get()?.n).toBe(1);
  });

  it('rejects the same logical event with different content without overwriting the first one', async () => {
    const first = await makeRecord();
    await store.put(scope.tenantId, first);
    await expect(
      store.put(scope.tenantId, await makeRecord('event-1', { changed: true }))
    ).rejects.toThrow('log_iceberg_event_id_collision');
    expect(await store.readTenant(scope)).toEqual([first]);
  });

  it('rolls the header back when any part fails to persist', async () => {
    fixture.db.exec(`CREATE TRIGGER reject_second_part BEFORE INSERT ON log_iceberg_record_parts
      WHEN NEW.part_index=1 BEGIN SELECT RAISE(ABORT,'part write failed'); END`);
    await expect(
      store.put(scope.tenantId, await makeRecord('parts', { value: 'x'.repeat(100_000) }))
    ).rejects.toThrow('part write failed');
    expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_records').get()?.n).toBe(0);
    expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_record_parts').get()?.n).toBe(
      0
    );
  });

  it('enforces tenant, dataset, original expiry and event-time windows', async () => {
    const first = await makeRecord();
    await store.put(scope.tenantId, first);
    await store.put(
      scope.tenantId,
      await buildLogIcebergRecord(
        config,
        {
          eventId: 'no-expiry',
          tenantKey: scope.tenantKey,
          sourceDataset: scope.sourceDataset,
          logType: 'audit',
          eventAt: now - 1_000_000,
          ingestedAt: now,
          expiresAt: null,
          body: { id: 'no-expiry' },
        },
        keys
      )
    );
    expect(await store.readTenant({ ...scope, tenantId: 'tenant-b' })).toEqual([]);
    expect(await store.readTenant({ ...scope, tenantKey: 'key-b' })).toEqual([]);
    expect(await store.readTenant({ ...scope, sourceDataset: 'admin.admin_audit_log' })).toEqual(
      []
    );
    expect((await store.readTenant({ ...scope, now: now + 1000 })).map((r) => r.event_id)).toEqual([
      'no-expiry',
    ]);
    expect(
      (await store.readTenant({ ...scope, fromMs: now - 2000 })).map((r) => r.event_id)
    ).toEqual(['event-1']);
    expect((await store.readTenant({ ...scope, toMs: now - 5000 })).map((r) => r.event_id)).toEqual(
      ['no-expiry']
    );
  });

  it('fails when a body is incomplete while its source still exists', async () => {
    await store.put(scope.tenantId, await makeRecord());
    fixture.db.exec('DELETE FROM log_iceberg_record_parts');
    await expect(store.readTenant(scope)).rejects.toThrow('log_iceberg_staging_parts_missing');
  });

  it('defers a concurrently committed source to the subsequent cold read instead of returning an incomplete body', async () => {
    await store.put(scope.tenantId, await makeRecord());
    const heads = await fixture.adapter.query<LogIcebergStagedHead>(
      'SELECT * FROM log_iceberg_records'
    );
    fixture.db.exec('DELETE FROM log_iceberg_records');
    expect(await store.read(heads)).toEqual([]);
  });

  it('rejects an oversized result from small heads before loading headers or encrypted bodies', async () => {
    await store.put(scope.tenantId, await makeRecord('a'));
    await store.put(scope.tenantId, await makeRecord('b'));
    fixture.db.exec('UPDATE log_iceberg_records SET body_bytes=3000000');
    const queries = vi.spyOn(fixture.adapter, 'query');
    await expect(store.readTenant(scope)).rejects.toThrow('log_iceberg_staging_budget_exceeded');
    expect(queries.mock.calls).toHaveLength(1);
    expect(queries.mock.calls[0][0]).not.toContain('SELECT *');
    expect(queries.mock.calls[0][0]).not.toContain('log_iceberg_record_parts');
  });
});
