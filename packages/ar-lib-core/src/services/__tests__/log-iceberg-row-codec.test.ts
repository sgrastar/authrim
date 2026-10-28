import { describe, expect, it } from 'vitest';
import type { LogIcebergConfig } from '../log-iceberg-config';
import { buildLogIcebergRecord, decryptLogIcebergRecord } from '../log-iceberg-record';
import {
  decodeLogIcebergRow,
  decryptProtectedLogIcebergDetail,
  encodeLogIcebergRow,
  logIcebergDetailReference,
} from '../log-iceberg-row-codec';

const now = Date.UTC(2026, 9, 27);
const config: LogIcebergConfig = {
  mode: 'scheduled',
  generation: 'generation-one',
  schemaVersion: 1,
  activatedAt: now,
  accountId: 'a'.repeat(32),
  bucket: 'archive-logs',
  warehouse: `${'a'.repeat(32)}_archive-logs`,
  catalogUri: `https://catalog.cloudflarestorage.com/${'a'.repeat(32)}/archive-logs`,
  namespace: 'authrim',
  table: 'logs_v1',
  tableUuid: 'f644e0fa-a8d7-4976-bcd7-1520bc0f8d9b',
  physicalFingerprint: 'f'.repeat(64),
  dbRetentionDays: 7,
  exportIntervalMinutes: 10,
};
const keys = { rootKeyHex: 'ab'.repeat(32), keyVersion: 1, contentHmacKeyHex: 'cd'.repeat(32) };
const context = {
  tenantKey: 'tenant-key',
  sourceDataset: 'admin.admin_audit_log',
  eventId: 'event-1',
  generation: config.generation,
  schemaVersion: 1,
};
const row = {
  id: 'event-1',
  tenant_id: 'tenant-a',
  action: 'user.update',
  before_json: '{"email":"before@example.invalid"}',
  after_json: '{"email":"after@example.invalid"}',
};
const input = {
  ...context,
  logType: 'admin_audit',
  eventAt: now,
  ingestedAt: now,
  expiresAt: null,
};
const makeBody = () => encodeLogIcebergRow({ context, row, keys });

describe('separately authorized Iceberg details', () => {
  it('keeps arbitrary metadata under a reserved key protected and accepts only a separate trusted scalar projection', async () => {
    const metadata_json = JSON.stringify({
      admin_ui_bff_forwarded_host: { private_note: 'SENSITIVE' },
      arbitrary_note: 'HIDDEN',
    });
    const body = await encodeLogIcebergRow({ context, row: { ...row, metadata_json }, keys });
    const basic = decodeLogIcebergRow(body, 'tenant-a', 'event-1');
    expect(basic.metadata_json).toBeNull();
    expect(JSON.stringify(basic)).not.toContain('SENSITIVE');
    const trusted = await encodeLogIcebergRow({
      context,
      row: { ...row, metadata_json },
      keys,
      adminInlineMetadata: {
        admin_actor_type: 'admin_user',
        admin_ui_bff_forwarded_host: 'admin.example.invalid',
      },
    });
    expect(
      JSON.parse(String(decodeLogIcebergRow(trusted, 'tenant-a', 'event-1').metadata_json))
    ).toEqual({
      admin_actor_type: 'admin_user',
      admin_ui_bff_forwarded_host: 'admin.example.invalid',
    });
    await expect(
      encodeLogIcebergRow({
        context,
        row,
        keys,
        adminInlineMetadata: { admin_ui_bff_forwarded_host: { private_note: 'SENSITIVE' } },
      })
    ).rejects.toThrow('log_iceberg_row_body_invalid');
    const record = await buildLogIcebergRecord(config, { ...input, body: trusted }, keys);
    expect(
      (
        await decryptProtectedLogIcebergDetail({
          record,
          body: trusted,
          resolveKeys: async () => keys,
        })
      )?.metadata_json
    ).toBe(metadata_json);
  });
  it('keeps before/after encrypted after the general row is decrypted', async () => {
    const body = await makeBody();
    const record = await buildLogIcebergRecord(config, { ...input, body }, keys);
    const decoded = await decryptLogIcebergRecord(record, context, async () => keys);
    expect(JSON.stringify(decoded)).not.toContain('before@example.invalid');
    expect(JSON.stringify(decoded)).not.toContain('after@example.invalid');
    const basic = decodeLogIcebergRow(decoded, 'tenant-a', 'event-1');
    expect(basic).toMatchObject({ action: 'user.update', before_json: null, after_json: null });
    expect(basic.detail_object_catalog_id).toBe(await logIcebergDetailReference(context));
    // The detail loader is a separate operation that an endpoint invokes only after its extra ACL.
    expect(
      await decryptProtectedLogIcebergDetail({
        record,
        body: decoded,
        resolveKeys: async () => keys,
      })
    ).toEqual({ before_json: row.before_json, after_json: row.after_json, metadata_json: null });
  });

  it('preserves logical identity across both encryption nonces and key/generation rotations', async () => {
    const a = await buildLogIcebergRecord(config, { ...input, body: await makeBody() }, keys);
    const b = await buildLogIcebergRecord(config, { ...input, body: await makeBody() }, keys);
    expect(a.payload_hmac).toBe(b.payload_hmac);
    expect(a.detail_ciphertext).not.toBe(b.detail_ciphertext);
    const rotatedKeys = { ...keys, rootKeyHex: 'ef'.repeat(32), keyVersion: 2 };
    const rotatedContext = { ...context, generation: 'generation-two' };
    const body = await encodeLogIcebergRow({ context: rotatedContext, row, keys: rotatedKeys });
    const c = await buildLogIcebergRecord(
      { ...config, generation: rotatedContext.generation },
      { ...input, body },
      rotatedKeys
    );
    expect(c.payload_hmac).toBe(a.payload_hmac);
    const decoded = await decryptLogIcebergRecord(c, context, async (version) =>
      version === 2 ? rotatedKeys : keys
    );
    expect(
      await decryptProtectedLogIcebergDetail({
        record: c,
        body: decoded,
        resolveKeys: async (version) => (version === 2 ? rotatedKeys : keys),
      })
    ).toEqual({ before_json: row.before_json, after_json: row.after_json, metadata_json: null });
    expect(await logIcebergDetailReference(rotatedContext)).toBe(
      await logIcebergDetailReference(context)
    );
  });

  it('detects changed detail content even when basic columns are identical', async () => {
    const a = await buildLogIcebergRecord(config, { ...input, body: await makeBody() }, keys);
    const body = await encodeLogIcebergRow({
      context,
      row: { ...row, after_json: '{"changed":true}' },
      keys,
    });
    const b = await buildLogIcebergRecord(config, { ...input, body }, keys);
    expect(a.payload_hmac).not.toBe(b.payload_hmac);
  });

  it('binds the nested envelope to tenant, event, generation and protected-detail class', async () => {
    const body = await makeBody();
    const record = await buildLogIcebergRecord(config, { ...input, body }, keys);
    for (const patch of [
      { tenant_key: 'other' },
      { event_id: 'other' },
      { storage_generation: 'other-generation' },
      { source_dataset: 'core.operational_logs' },
    ]) {
      await expect(
        decryptProtectedLogIcebergDetail({
          record: { ...record, ...patch },
          body,
          resolveKeys: async () => keys,
        })
      ).rejects.toThrow();
    }
    await expect(
      decryptProtectedLogIcebergDetail({
        record,
        body,
        resolveKeys: async () => ({ ...keys, rootKeyHex: 'ef'.repeat(32) }),
      })
    ).rejects.toThrow();
    for (const patch of [
      { payload_hmac: '0'.repeat(64) },
      { key_version: 2 },
      { envelope: null },
    ]) {
      const original = body.protected_detail as Record<string, unknown>;
      await expect(
        decryptProtectedLogIcebergDetail({
          record,
          body: { ...body, protected_detail: { ...original, ...patch } },
          resolveKeys: async () => keys,
        })
      ).rejects.toThrow();
    }
  });

  it.each(['core.operational_logs', 'pii.pii_log'])(
    'stores %s sensitive values only in the protected envelope',
    async (sourceDataset) => {
      const scope = { ...context, sourceDataset };
      const body = await encodeLogIcebergRow({
        context: scope,
        row: {
          id: 'event-1',
          tenant_id: 'tenant-a',
          reason_detail_encrypted: 'old-value',
          encryption_key_version: 7,
          values_encrypted: 'old-value',
        },
        keys,
        protectedDetail: {
          reason: 'sensitive reason',
          values: { email: 'private@example.invalid' },
        },
      });
      const record = await buildLogIcebergRecord(config, { ...input, sourceDataset, body }, keys);
      expect(JSON.stringify(body)).not.toContain('private@example.invalid');
      expect(JSON.stringify(body)).not.toContain('sensitive reason');
      const basic = decodeLogIcebergRow(body, 'tenant-a', 'event-1');
      if (sourceDataset === 'pii.pii_log') expect(basic.values_encrypted).toBeNull();
      else expect(basic.reason_detail_encrypted).toBeNull();
      expect(
        await decryptProtectedLogIcebergDetail({ record, body, resolveKeys: async () => keys })
      ).toEqual({ reason: 'sensitive reason', values: { email: 'private@example.invalid' } });
    }
  );

  it('rejects non-scalar query columns and a row from another tenant or event', async () => {
    const body = await makeBody();
    for (const [tenantId, eventId] of [
      ['tenant-b', 'event-1'],
      ['tenant-a', 'event-2'],
    ])
      expect(() => decodeLogIcebergRow(body, tenantId, eventId)).toThrow();
    expect(() =>
      decodeLogIcebergRow(
        { ...body, row: { ...row, metadata_json: { nested: true } } },
        'tenant-a',
        'event-1'
      )
    ).toThrow();
  });

  it('keeps a near-limit protected detail within the 4 MiB encrypted record budget', async () => {
    const detail = { before_json: 'x'.repeat(2 * 1024 * 1024 - 200), after_json: null };
    const body = await encodeLogIcebergRow({ context, row: { ...row, ...detail }, keys });
    const record = await buildLogIcebergRecord(config, { ...input, body }, keys);
    expect(new TextEncoder().encode(JSON.stringify(record)).byteLength).toBeLessThan(
      4 * 1024 * 1024
    );
    const decrypted = await decryptProtectedLogIcebergDetail({
      record,
      body,
      resolveKeys: async () => keys,
    });
    expect(decrypted?.before_json === detail.before_json).toBe(true);
    expect(decrypted?.after_json).toBeNull();
    expect(decrypted?.metadata_json).toBeNull();
    await expect(
      encodeLogIcebergRow({
        context,
        row: { ...row, before_json: 'x'.repeat(2 * 1024 * 1024) },
        keys,
      })
    ).rejects.toThrow('log_iceberg_detail_too_large');
  });
});
