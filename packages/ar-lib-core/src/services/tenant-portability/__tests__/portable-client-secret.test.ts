import { expect, it, vi } from 'vitest';
import { decryptValue, encryptValue } from '../../../utils/pii-encryption';
import {
  encryptPortableOauthClientSecret,
  exportPortableOauthClientSecretRow,
  portableOauthClientSecret,
  restorePortableOauthClientSecret,
  targetOauthClientSecretMatches,
  verifyPortableOauthClientSecret,
} from '../portable-client-secret';

const sourceKey = '11'.repeat(32);
const targetKey = '22'.repeat(32);

function row(secret: readonly [string, string | null]) {
  return JSON.stringify({
    tenant_id: ['text', 'tenant-a'],
    client_id: ['text', 'client-a'],
    logout_webhook_secret_encrypted: secret,
  });
}

it('moves an at-rest client secret through a bundle-only representation and re-encrypts it', async () => {
  const source = await encryptValue('fixture-secret', sourceKey, 'AES-256-GCM', 1);
  const portableRow = await exportPortableOauthClientSecretRow(
    row(['text', source.encrypted]),
    sourceKey
  );
  expect(portableRow).not.toContain(source.encrypted);
  const decoded = portableOauthClientSecret(JSON.parse(portableRow));
  expect(decoded).toEqual({
    tenantId: 'tenant-a',
    clientId: 'client-a',
    plaintext: 'fixture-secret',
  });
  if (!decoded.plaintext) throw new Error('expected_plaintext');
  const target = await encryptPortableOauthClientSecret(decoded.plaintext, targetKey, 2);
  expect(target).not.toBe(source.encrypted);
  expect(await targetOauthClientSecretMatches(target, targetKey, 'fixture-secret')).toBe(true);
  expect(await targetOauthClientSecretMatches(target, sourceKey, 'fixture-secret')).toBe(false);
  expect((await decryptValue(target, targetKey)).keyVersion).toBe(2);
});

it('uses the fenced target sidecar methods for apply and sealed verification', async () => {
  const source = await encryptValue('fixture-secret', sourceKey, 'AES-256-GCM', 1);
  const rowJson = await exportPortableOauthClientSecretRow(
    row(['text', source.encrypted]),
    sourceKey
  );
  let stored = '';
  const target = {
    writeSidecarText: vi.fn(async (...args: unknown[]) => {
      const value = args[4];
      const matches = args[5] as (value: string) => Promise<boolean>;
      if (typeof value !== 'string') throw new Error('expected_ciphertext');
      stored = value;
      expect(await matches(stored)).toBe(true);
    }),
    verifySidecarValue: vi.fn(async (...args: unknown[]) => {
      const matches = args[4] as (value: string | null) => Promise<boolean>;
      expect(await matches(stored)).toBe(true);
    }),
  };
  const policy = {};
  const manifest = {};
  await restorePortableOauthClientSecret({
    target: target as never,
    policy: policy as never,
    manifest: manifest as never,
    rowJson,
    targetEncryptionKey: targetKey,
    targetKeyVersion: 3,
  });
  expect((await decryptValue(stored, targetKey)).decrypted).toBe('fixture-secret');
  await verifyPortableOauthClientSecret({
    target: target as never,
    policy: policy as never,
    manifest: manifest as never,
    rowJson,
    targetEncryptionKey: targetKey,
  });
});

it('preserves null without a source key and rejects plaintext-at-rest or malformed bundle values', async () => {
  const empty = row(['null', null]);
  expect(await exportPortableOauthClientSecretRow(empty, undefined)).toBe(empty);
  expect(portableOauthClientSecret(JSON.parse(empty)).plaintext).toBeNull();
  await expect(
    exportPortableOauthClientSecretRow(row(['text', 'plaintext']), sourceKey)
  ).rejects.toThrow('backup_portable_client_secret_invalid');
  expect(() => portableOauthClientSecret(JSON.parse(row(['text', '{}'])))).toThrow(
    'backup_portable_client_secret_invalid'
  );
});
