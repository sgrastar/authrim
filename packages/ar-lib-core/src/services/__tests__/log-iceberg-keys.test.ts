import { afterEach, describe, expect, it } from 'vitest';
import { createLogIcebergKeyResolver, parseLogIcebergRootKeyring } from '../log-iceberg-keys';
import { createLogIcebergReadPort } from '../log-iceberg-read';
import { exportLogIcebergBatch } from '../log-iceberg-export';
import { buildLogIcebergRecord } from '../log-iceberg-record';
import { encodeLogIcebergRow } from '../log-iceberg-row-codec';
import { icebergFixture } from './log-iceberg-test-fixture';

const oldRoot = 'ab'.repeat(32),
  newRoot = 'ef'.repeat(32),
  hmac = 'cd'.repeat(32);
const ring = (roots: Record<string, string> = { 1: oldRoot, 2: newRoot }, current = 2) =>
  JSON.stringify({ schema_version: 1, current_version: current, roots });
const rotatedEnv = () => ({
  OBJECT_ENCRYPTION_ROOT_KEY: newRoot,
  OBJECT_ENCRYPTION_KEY_VERSION: '2',
  LOG_ARCHIVE_CONTENT_HMAC_KEY: hmac,
  LOG_ARCHIVE_ROOT_KEYRING: ring(),
});

describe('versioned log-only masters', () => {
  let f: Awaited<ReturnType<typeof icebergFixture>> | undefined;
  afterEach(() => {
    f?.db.close();
    f = undefined;
  });

  it('resolves retained masters and the current master without changing the stable digest key', () => {
    const resolve = createLogIcebergKeyResolver(rotatedEnv());
    expect(resolve(1)).toEqual({ rootKeyHex: oldRoot, keyVersion: 1, contentHmacKeyHex: hmac });
    expect(resolve()).toEqual({ rootKeyHex: newRoot, keyVersion: 2, contentHmacKeyHex: hmac });
    expect(() => resolve(3)).toThrow('root_key_version_unavailable');
    expect(() => resolve(0)).toThrow('key_version_invalid');
  });

  it.each([
    { LOG_ARCHIVE_ROOT_KEYRING: undefined },
    { LOG_ARCHIVE_ROOT_KEYRING: ring({ 1: oldRoot }, 1) },
    { LOG_ARCHIVE_ROOT_KEYRING: ring({ 1: oldRoot, 2: oldRoot }) },
    { OBJECT_ENCRYPTION_KEY_VERSION: '3' },
    { LOG_ARCHIVE_CONTENT_HMAC_KEY: undefined },
  ])('rejects missing or conflicting deployment key material', (override) => {
    expect(() => createLogIcebergKeyResolver({ ...rotatedEnv(), ...override })).toThrow();
  });

  it.each([
    '{}',
    'null',
    '{',
    ring({}, 1),
    ring({ 0: oldRoot }, 1),
    ring({ 1: oldRoot, 3: newRoot }, 2),
    ring({ 1: 'wrong' }, 1),
    JSON.stringify({
      schema_version: 1,
      current_version: 1,
      roots: { 1: oldRoot },
      unexpected: true,
    }),
    ring(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [i + 1, oldRoot])), 33),
    ' '.repeat(4097),
    `{"schema_version":1,"current_version":1,"roots":{"1":"${oldRoot}","1":"${newRoot}"}}`,
    `{"schema_version":1,"schema_version":1,"current_version":1,"roots":{"1":"${oldRoot}"}}`,
  ])('rejects malformed or over-budget root registries', (value) => {
    expect(() => parseLogIcebergRootKeyring(value)).toThrow('root_keyring_invalid');
  });

  it('reads old staging, old Parquet and protected detail after actual master replacement', async () => {
    f = await icebergFixture();
    const fixture = f;
    const dataset = 'admin.admin_audit_log';
    const old = await fixture.record('old-event', {
      sourceDataset: dataset,
      row: {
        before_json: '{"private":"before"}',
        after_json: '{"private":"after"}',
      },
    });
    await fixture.staging.put('tenant-a', old);
    const scope = { tenantId: 'tenant-a', sourceDataset: dataset, now: fixture.now };
    const port = (env = rotatedEnv()) =>
      createLogIcebergReadPort(env, fixture.config, {
        ...fixture.ports,
        tenantKey: async () => 'key-a',
      });
    const initial = await port({
      OBJECT_ENCRYPTION_ROOT_KEY: oldRoot,
      OBJECT_ENCRYPTION_KEY_VERSION: '1',
      LOG_ARCHIVE_CONTENT_HMAC_KEY: hmac,
      LOG_ARCHIVE_ROOT_KEYRING: ring({ 1: oldRoot }, 1),
    }).readDataset(scope);
    expect(initial.rows).toHaveLength(1);
    const assertOld = async () => {
      const result = await port().readDataset(scope);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].before_json).toBeNull();
      expect(JSON.stringify(result.rows)).not.toContain('private');
      expect(await port().loadProtectedDetail({ ...scope, eventId: 'old-event' })).toMatchObject({
        before_json: '{"private":"before"}',
        after_json: '{"private":"after"}',
      });
    };
    await assertOld();
    await exportLogIcebergBatch(fixture.config, fixture.ports);
    expect((await port().readDataset(scope)).hasArchive).toBe(true);
    await assertOld();
    for (const override of [
      { LOG_ARCHIVE_ROOT_KEYRING: undefined },
      { LOG_ARCHIVE_ROOT_KEYRING: ring({ 2: newRoot }) },
      { LOG_ARCHIVE_ROOT_KEYRING: ring({ 1: newRoot, 2: newRoot }) },
      { OBJECT_ENCRYPTION_KEY_VERSION: '1' },
    ])
      await expect(port({ ...rotatedEnv(), ...override }).readDataset(scope)).rejects.toThrow();
  });

  it('keeps logical HMAC stable across master and storage-generation rotation', async () => {
    f = await icebergFixture();
    const fixture = f;
    const context = {
      tenantKey: 'key-a',
      sourceDataset: 'admin.admin_audit_log',
      eventId: 'event',
      generation: f.config.generation,
      schemaVersion: 1,
    };
    const row = { id: 'event', tenant_id: 'tenant-a', before_json: '{"secret":true}' };
    const oldKeys = { rootKeyHex: oldRoot, contentHmacKeyHex: hmac, keyVersion: 1 };
    const newKeys = createLogIcebergKeyResolver(rotatedEnv())();
    const make = async (keys: typeof oldKeys, generation: string) =>
      buildLogIcebergRecord(
        { ...fixture.config, generation },
        {
          eventId: context.eventId,
          tenantKey: context.tenantKey,
          sourceDataset: context.sourceDataset,
          logType: 'admin_audit',
          eventAt: fixture.now,
          ingestedAt: fixture.now,
          expiresAt: null,
          body: await encodeLogIcebergRow({ context: { ...context, generation }, row, keys }),
        },
        keys
      );
    const first = await make(oldKeys, 'generation-old'),
      next = await make(newKeys, 'generation-new');
    expect(next.payload_hmac).toBe(first.payload_hmac);
    expect(next.detail_key_version).toBe('2');
    expect(next.detail_ciphertext).not.toBe(first.detail_ciphertext);
  });
});
