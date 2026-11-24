import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptValue, encryptValue } from '@authrim/ar-lib-plugin';
import { D1PluginConfigStore } from '../config-store';
import { D1PluginConfigReencryptor } from '../config-reencryption';
import { D1DynamicPluginInstallationStore } from '../dynamic-worker-installations';
import { seedPlugin } from './helpers/dynamic-plugin-seed';
import { createD1, openRunnerDatabase } from './helpers/sqlite-d1';

vi.mock('@authrim/ar-lib-plugin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-plugin')>();
  return {
    ...actual,
    encryptValue: vi.fn(actual.encryptValue),
    decryptValue: vi.fn(actual.decryptValue),
  };
});

const OLD_SECRET = 'old-plugin-encryption-secret-value-0123456789';
const NEW_SECRET = 'new-plugin-encryption-secret-value-0123456789';
const KEYRING = {
  active: { id: 'v2', secret: NEW_SECRET },
  previous: { id: 'v1', secret: OLD_SECRET },
};
let database: DatabaseSync;

async function arrange() {
  database = openRunnerDatabase();
  seedPlugin(database, { slots: [{ configKey: 'apiKey', required: true }] });
  const d1 = createD1(database);
  const created = await new D1DynamicPluginInstallationStore(d1.db, 'test', () => 5).configure({
    tenantId: 'tenant-a',
    pluginId: 'plugin-a',
    enabled: false,
  });
  await new D1PluginConfigStore(
    d1.db,
    OLD_SECRET,
    'plugin-runner-mutation-hmac-key-value',
    () => 6
  ).replaceCredentials({
    operationId: 'credential-a',
    tenantId: 'tenant-a',
    installationId: created.installationId,
    expectedConfigVersion: 1,
    credentials: [
      {
        configKey: 'apiKey',
        destinationHost: 'api.example.com',
        injectionKind: 'bearer',
        injectionName: 'Authorization',
        value: 'secret-a',
      },
    ],
  });
  const rotation = new D1PluginConfigReencryptor(createD1(database).db, KEYRING, () => 2_000);
  await rotation.start('op-1');
  vi.mocked(encryptValue).mockClear();
  vi.mocked(decryptValue).mockClear();
  return rotation;
}
const stored = () =>
  database.prepare('SELECT encryption_key_id FROM plugin_runner_encrypted_configs').all();

beforeEach(() => {
  vi.mocked(encryptValue).mockReset();
  vi.mocked(decryptValue).mockReset();
});

describe('re-encryption safety checks', () => {
  it('refuses to store a ciphertext that does not decrypt back to the plaintext', async () => {
    const actual =
      await vi.importActual<typeof import('@authrim/ar-lib-plugin')>('@authrim/ar-lib-plugin');
    vi.mocked(encryptValue).mockImplementation(actual.encryptValue);
    vi.mocked(decryptValue).mockImplementation(actual.decryptValue);
    const rotation = await arrange();
    vi.mocked(decryptValue)
      .mockResolvedValueOnce('secret-a')
      .mockResolvedValueOnce('something else');
    await expect(rotation.advanceActive()).rejects.toThrow(
      /^plugin_config_reencryption_verification_failed$/u
    );
    expect(stored()).toEqual([{ encryption_key_id: 'v1' }]);
  });
  it.each([
    ['too few parts', 'enc:v1:abc'],
    ['too many parts', 'enc:v1:abc:def:ghi'],
    ['an empty nonce', 'enc:v1::cipher'],
  ])('refuses an envelope with %s', async (_label, envelope) => {
    const actual =
      await vi.importActual<typeof import('@authrim/ar-lib-plugin')>('@authrim/ar-lib-plugin');
    vi.mocked(encryptValue).mockImplementation(actual.encryptValue);
    vi.mocked(decryptValue).mockImplementation(actual.decryptValue);
    const rotation = await arrange();
    vi.mocked(encryptValue).mockResolvedValueOnce(envelope);
    vi.mocked(decryptValue).mockResolvedValueOnce('secret-a').mockResolvedValueOnce('secret-a');
    await expect(rotation.advanceActive()).rejects.toThrow(
      /^plugin_config_reencryption_envelope_invalid$/u
    );
    expect(stored()).toEqual([{ encryption_key_id: 'v1' }]);
  });
});
