import { describe, expect, it } from 'vitest';
import { resolveLogIcebergConfig } from '../log-iceberg-config';
import { buildLogIcebergRecord, decryptLogIcebergRecord } from '../log-iceberg-record';

const activation = Date.UTC(2026, 9, 27);
const configEnv = {
  AUTHRIM_LOG_ARCHIVE_MODE: 'scheduled',
  AUTHRIM_LOG_ARCHIVE_STORAGE_GENERATION: 'b4f9f6b0-9721-4cce-b103-f614d0ea340b',
  AUTHRIM_LOG_ARCHIVE_SCHEMA_VERSION: '1',
  AUTHRIM_LOG_ARCHIVE_ACTIVATED_AT: new Date(activation).toISOString(),
  AUTHRIM_LOG_ARCHIVE_ACCOUNT_ID: 'a'.repeat(32),
  AUTHRIM_LOG_ARCHIVE_BUCKET: 'archive-logs',
  AUTHRIM_LOG_ARCHIVE_WAREHOUSE: `${'a'.repeat(32)}_archive-logs`,
  AUTHRIM_LOG_ARCHIVE_CATALOG_URI: `https://catalog.cloudflarestorage.com/${'a'.repeat(32)}/archive-logs`,
  AUTHRIM_LOG_ARCHIVE_NAMESPACE: 'authrim',
  AUTHRIM_LOG_ARCHIVE_TABLE: 'logs_v1_b4f9f6b0',
  AUTHRIM_LOG_ARCHIVE_TABLE_UUID: 'f644e0fa-a8d7-4976-bcd7-1520bc0f8d9b',
  AUTHRIM_LOG_ARCHIVE_PHYSICAL_FINGERPRINT: 'f'.repeat(64),
  AUTHRIM_LOG_ARCHIVE_DB_RETENTION_DAYS: '7',
  AUTHRIM_LOG_ARCHIVE_EXPORT_INTERVAL_MINUTES: '10',
};
const config = resolveLogIcebergConfig(configEnv);
const key = { rootKeyHex: 'ab'.repeat(32), keyVersion: 1, contentHmacKeyHex: 'ef'.repeat(32) };
const expected = { tenantKey: 'tenant-key-a', sourceDataset: 'core.audit_log' };
const input = {
  eventId: 'event-1',
  ...expected,
  logType: 'audit',
  eventAt: activation - 60_000,
  ingestedAt: activation,
  expiresAt: activation + 90 * 86_400_000,
  overview: { action: 'user.login', result: 'failure' },
  body: {
    id: 'event-1',
    metadata_json: '{"email":"private@example.invalid"}',
    nested: { b: 2, a: '日本語' },
  },
};

describe('Iceberg deployment boundary', () => {
  it('requires an explicit new storage mode and rejects an empty/unknown mode', () => {
    expect(() => resolveLogIcebergConfig({})).toThrow('log_iceberg_configuration_required');
    for (const mode of ['', 'both', 'disabled'])
      expect(() =>
        resolveLogIcebergConfig({ ...configEnv, AUTHRIM_LOG_ARCHIVE_MODE: mode })
      ).toThrow();
  });
  it('does not put DB retention settings into pipeline mode', () => {
    expect(() =>
      resolveLogIcebergConfig({ ...configEnv, AUTHRIM_LOG_ARCHIVE_MODE: 'pipeline' })
    ).toThrow();
    expect(
      resolveLogIcebergConfig({
        ...configEnv,
        AUTHRIM_LOG_ARCHIVE_MODE: 'pipeline',
        AUTHRIM_LOG_ARCHIVE_DB_RETENTION_DAYS: undefined,
        AUTHRIM_LOG_ARCHIVE_EXPORT_INTERVAL_MINUTES: undefined,
      })?.dbRetentionDays
    ).toBeNull();
  });
  it.each([
    { AUTHRIM_LOG_ARCHIVE_CATALOG_URI: 'https://example.invalid/catalog' },
    { AUTHRIM_LOG_ARCHIVE_WAREHOUSE: 'another-account_archive-logs' },
    { AUTHRIM_LOG_ARCHIVE_TABLE: 'logs;DROP TABLE logs' },
    { AUTHRIM_LOG_ARCHIVE_TABLE_UUID: undefined },
    { AUTHRIM_LOG_ARCHIVE_PHYSICAL_FINGERPRINT: 'bad' },
    { AUTHRIM_LOG_ARCHIVE_SCHEMA_VERSION: '2' },
    { AUTHRIM_LOG_ARCHIVE_ACTIVATED_AT: '2026-02-30T00:00:00.000Z' },
    { AUTHRIM_LOG_ARCHIVE_DB_RETENTION_DAYS: '7.5' },
    { AUTHRIM_LOG_ARCHIVE_EXPORT_INTERVAL_MINUTES: '0' },
  ])('rejects a malformed deployment %j', (override) => {
    expect(() => resolveLogIcebergConfig({ ...configEnv, ...override })).toThrow();
  });
});

describe('Iceberg encrypted records', () => {
  it('encrypts the entire body before delivery and retains only explicitly allowed overview fields', async () => {
    const record = await buildLogIcebergRecord(config, input, key);
    expect(JSON.stringify(record)).not.toContain('private@example.invalid');
    expect(record.action).toBe('user.login');
    expect(record.subject_id).toBeNull();
    expect(record.event_at).toBe(input.eventAt);
    expect(await decryptLogIcebergRecord(record, expected, async () => key)).toEqual(input.body);
  });
  it('uses a stable keyed content digest across object ordering and encryption nonces', async () => {
    const a = await buildLogIcebergRecord(config, input, key);
    const b = await buildLogIcebergRecord(
      config,
      {
        ...input,
        body: {
          nested: { a: '日本語', b: 2 },
          metadata_json: input.body.metadata_json,
          id: 'event-1',
        },
      },
      key
    );
    expect(a.payload_hmac).toBe(b.payload_hmac);
    expect(a.detail_ciphertext).not.toBe(b.detail_ciphertext);
    expect(
      (await buildLogIcebergRecord(config, { ...input, body: { changed: true } }, key)).payload_hmac
    ).not.toBe(a.payload_hmac);
  });
  it('binds every overview field, expiry, identity and generation to authenticated encryption', async () => {
    const record = await buildLogIcebergRecord(config, input, key);
    for (const patch of [
      { event_id: 'other' },
      { action: 'user.delete' },
      { expires_at: null },
      { storage_generation: 'another-generation' },
      { ingested_at: activation + 1 },
      { detail_key_version: '2' },
      { payload_hmac: 'f'.repeat(64) },
    ])
      await expect(
        decryptLogIcebergRecord({ ...record, ...patch }, expected, async () => key)
      ).rejects.toThrow();
  });
  it('rejects the wrong scope before key resolution', async () => {
    const record = await buildLogIcebergRecord(config, input, key);
    let reads = 0;
    for (const scope of [
      { ...expected, tenantKey: 'other' },
      { ...expected, sourceDataset: 'admin.admin_audit_log' },
    ])
      await expect(
        decryptLogIcebergRecord(record, scope, async () => {
          reads++;
          return key;
        })
      ).rejects.toThrow();
    expect(reads).toBe(0);
  });
  it('uses the saved key version when reading after a rotation', async () => {
    const record = await buildLogIcebergRecord(config, input, key);
    const keys = new Map([
      [1, key.rootKeyHex],
      [2, 'cd'.repeat(32)],
    ]);
    const rotated = await buildLogIcebergRecord(config, input, {
      ...key,
      rootKeyHex: keys.get(2)!,
      keyVersion: 2,
    });
    expect(rotated.payload_hmac).toBe(record.payload_hmac);
    expect(rotated.detail_ciphertext).not.toBe(record.detail_ciphertext);
    expect(
      await decryptLogIcebergRecord(rotated, expected, async (v) => ({
        ...key,
        rootKeyHex: keys.get(v)!,
      }))
    ).toEqual(input.body);
    expect(
      await decryptLogIcebergRecord(record, expected, async (v) => ({
        ...key,
        rootKeyHex: keys.get(v)!,
      }))
    ).toEqual(input.body);
    await expect(
      decryptLogIcebergRecord(record, expected, async () => ({ ...key, rootKeyHex: keys.get(2)! }))
    ).rejects.toThrow();
  });

  it('rejects a key version that cannot be represented by the reader', async () => {
    await expect(
      buildLogIcebergRecord(config, input, { ...key, keyVersion: 1_000_000_000 })
    ).rejects.toThrow();
  });
  it('rejects nested sparse arrays instead of producing unreadable JSON', async () => {
    const values = new Array(3);
    values[0] = 1;
    values[2] = 2;
    await expect(
      buildLogIcebergRecord(config, { ...input, body: { nested: { values } } }, key)
    ).rejects.toThrow();
  });
  it('keeps null expiry distinct, permits an old event time on new ingestion, and rejects preactivation writes', async () => {
    expect(
      (await buildLogIcebergRecord(config, { ...input, expiresAt: null }, key)).expires_at
    ).toBeNull();
    await expect(
      buildLogIcebergRecord(config, { ...input, ingestedAt: activation - 1 }, key)
    ).rejects.toThrow();
  });
  it('rejects undeclared overview fields and oversized bodies before delivery', async () => {
    await expect(
      buildLogIcebergRecord(
        config,
        {
          ...input,
          overview: {
            ...input.overview,
            email: 'private@example.invalid',
          } as typeof input.overview,
        },
        key
      )
    ).rejects.toThrow();
    await expect(
      buildLogIcebergRecord(config, { ...input, body: { value: 'x'.repeat(3 * 1024 * 1024) } }, key)
    ).rejects.toThrow('log_iceberg_record_too_large');
  });
});
