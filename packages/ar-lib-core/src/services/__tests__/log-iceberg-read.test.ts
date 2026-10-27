import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogIcebergReadPort } from '../log-iceberg-read';
import { exportLogIcebergBatch } from '../log-iceberg-export';
import { icebergFixture } from './log-iceberg-test-fixture';

describe('authorized new-format staging/Iceberg reader (real SQL/Parquet)', () => {
  let f: Awaited<ReturnType<typeof icebergFixture>>;
  beforeEach(async () => {
    f = await icebergFixture();
  });
  afterEach(() => f.db.close());
  const scope = () => ({ tenantId: 'tenant-a', sourceDataset: 'core.audit_log', now: f.now });
  const port = (overrides: Partial<Parameters<typeof createLogIcebergReadPort>[2]> = {}) =>
    createLogIcebergReadPort(
      {
        OBJECT_ENCRYPTION_ROOT_KEY: f.keys.rootKeyHex,
        LOG_ARCHIVE_ROOT_KEYRING: JSON.stringify({
          schema_version: 1,
          current_version: 1,
          roots: { 1: f.keys.rootKeyHex },
        }),
        LOG_ARCHIVE_CONTENT_HMAC_KEY: f.keys.contentHmacKeyHex,
      },
      f.config,
      {
        ...f.ports,
        tenantKey: async (tenantId) => (tenantId === 'tenant-a' ? 'key-a' : 'key-b'),
        ...overrides,
      }
    );
  it('reads the same rows before and after verified source deletion without querying old log tables', async () => {
    await f.staging.put('tenant-a', await f.record());
    const before = await port().readDataset(scope());
    expect(before).toMatchObject({
      hasArchive: false,
      consistency: 'snapshot',
      pendingDeliveries: 0,
    });
    expect(before.rows).toHaveLength(1);
    expect(before.rows[0].metadata_json).toContain('private@example.invalid');
    await exportLogIcebergBatch(f.config, f.ports);
    const after = await port().readDataset(scope());
    expect(after.rows).toEqual(before.rows);
    expect(after.hasArchive).toBe(true);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get()?.n).toBe(0);
  });
  it('does not re-stage an already archived logical event with another encryption nonce', async () => {
    const original = await f.record();
    await f.staging.put('tenant-a', original);
    await exportLogIcebergBatch(f.config, f.ports);
    const retry = await f.record();
    expect(retry.payload_hmac).toBe(original.payload_hmac);
    expect(retry.detail_ciphertext).not.toBe(original.detail_ciphertext);
    await f.staging.put('tenant-a', retry);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_records').get()?.n).toBe(0);
    expect((await port().readDataset(scope())).rows).toHaveLength(1);
  });
  it('rejects different content for the same logical event instead of returning a partial result', async () => {
    await f.staging.put('tenant-a', await f.record());
    await exportLogIcebergBatch(f.config, f.ports);
    await expect(
      f.staging.put(
        'tenant-a',
        await f.record('event-1', { row: { metadata_json: '{"changed":true}' } })
      )
    ).rejects.toThrow('log_iceberg_event_id_collision');
    expect((await port().readDataset(scope())).rows[0].metadata_json).toContain(
      'private@example.invalid'
    );
  });
  it('deduplicates a committed batch that is still present in DB after source deletion fails', async () => {
    await f.staging.put('tenant-a', await f.record());
    f.db.exec(
      "CREATE TRIGGER keep_source BEFORE DELETE ON log_iceberg_records BEGIN SELECT RAISE(ABORT,'keep source'); END"
    );
    await expect(exportLogIcebergBatch(f.config, f.ports)).rejects.toThrow('keep source');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_records').get()?.n).toBe(1);
    expect((await port().readDataset(scope())).rows).toHaveLength(1);
  });
  it('covers a source deleted while its encrypted parts are being read', async () => {
    await f.staging.put('tenant-a', await f.record());
    let intercept = true;
    const original = f.adapter.query.bind(f.adapter);
    const admin = {
      ...f.adapter,
      async query<T>(sql: string, params?: unknown[]) {
        if (intercept && sql.includes('SELECT part_index,body')) {
          intercept = false;
          await exportLogIcebergBatch(f.config, f.ports);
        }
        return original<T>(sql, params);
      },
    };
    const result = await port({ admin }).readDataset(scope());
    expect(result.rows).toHaveLength(1);
    expect(result.hasArchive).toBe(true);
  });
  it('fails an outdated Catalog reply after source deletion', async () => {
    const stale = await f.catalog.loadTable();
    await f.staging.put('tenant-a', await f.record());
    await exportLogIcebergBatch(f.config, f.ports);
    await expect(
      port({
        catalog: {
          ...f.catalog,
          loadTable: async () => stale,
          commit: (update) => f.catalog.commit(update),
        },
      }).readDataset(scope())
    ).rejects.toThrow('log_iceberg_read_watermark_lineage_incomplete');
  });
  it('rejects rollback plus a higher sequence that does not descend from the deletion watermark', async () => {
    await f.staging.put('tenant-a', await f.record());
    await exportLogIcebergBatch(f.config, f.ports);
    const committed = f.catalog.metadata.snapshots?.[0];
    if (!committed) throw new Error('missing fixture snapshot');
    f.catalog.metadata.snapshots = [
      { ...committed, 'snapshot-id': 42, 'parent-snapshot-id': undefined, 'sequence-number': 2 },
    ];
    f.catalog.metadata['current-snapshot-id'] = 42;
    f.catalog.metadata['last-sequence-number'] = 2;
    await expect(port().readDataset(scope())).rejects.toThrow(
      'log_iceberg_read_watermark_lineage_incomplete'
    );
  });
  it('excludes expired data and other tenants before decryption/query evaluation', async () => {
    await f.staging.put('tenant-a', await f.record('expired', { expiresAt: f.now - 1 }));
    await exportLogIcebergBatch(f.config, f.ports);
    await f.staging.put('tenant-a', await f.record('live', { ingestedAt: f.now, expiresAt: null }));
    await f.staging.put(
      'tenant-b',
      await f.record('other', { tenantId: 'tenant-b', tenantKey: 'key-b', ingestedAt: f.now })
    );
    expect((await port().readDataset(scope())).rows.map((row) => row.id)).toEqual(['live']);
    expect(
      (await port().readDataset({ ...scope(), tenantId: 'tenant-b' })).rows.map((row) => row.id)
    ).toEqual(['other']);
  });
  it('leaves separately protected details encrypted in normal reads and decrypts only in the explicit detail operation', async () => {
    const dataset = 'admin.admin_audit_log';
    await f.staging.put(
      'tenant-a',
      await f.record('admin-1', {
        sourceDataset: dataset,
        row: { before_json: '{"secret":"before"}', after_json: '{"secret":"after"}' },
      })
    );
    await exportLogIcebergBatch(f.config, f.ports);
    const result = await port().readDataset({ ...scope(), sourceDataset: dataset });
    expect(result.rows[0]).toMatchObject({ before_json: null, after_json: null });
    expect(JSON.stringify(result.rows)).not.toContain('secret');
    expect(
      await port().loadProtectedDetail({ ...scope(), sourceDataset: dataset, eventId: 'admin-1' })
    ).toEqual({
      before_json: '{"secret":"before"}',
      after_json: '{"secret":"after"}',
      metadata_json: '{"email":"private@example.invalid"}',
    });
    expect(
      await port().loadProtectedDetail({ ...scope(), sourceDataset: dataset, eventId: 'absent' })
    ).toBeNull();
  });
  it('reads a pipeline snapshot with no staging-body scan and marks its visibility eventual', async () => {
    await f.staging.put('tenant-a', await f.record());
    await exportLogIcebergBatch(f.config, f.ports);
    // A scheduled physical table cannot silently be relabeled as a Pipeline table.
    const reader = createLogIcebergReadPort(
      {
        OBJECT_ENCRYPTION_ROOT_KEY: f.keys.rootKeyHex,
        LOG_ARCHIVE_ROOT_KEYRING: JSON.stringify({
          schema_version: 1,
          current_version: 1,
          roots: { 1: f.keys.rootKeyHex },
        }),
        LOG_ARCHIVE_CONTENT_HMAC_KEY: f.keys.contentHmacKeyHex,
      },
      { ...f.config, mode: 'pipeline', dbRetentionDays: null, exportIntervalMinutes: null },
      {
        ...f.ports,
        tenantKey: async () => 'key-a',
        admin: {
          ...f.adapter,
          async query() {
            throw new Error('unexpected staging scan');
          },
        },
      }
    );
    await expect(reader.readDataset(scope())).rejects.toThrow('Archive physical mode mismatch');
  });
});
