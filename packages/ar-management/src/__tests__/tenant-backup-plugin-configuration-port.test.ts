import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { decodePortablePluginConfiguration } from '@authrim/ar-lib-core/services/tenant-portability/phase5-record-datasets';
import {
  decryptSecretFields,
  encryptSecretFields,
  getPluginEncryptionKey,
  type EncryptedConfig,
} from '@authrim/ar-lib-plugin';
import type { AdapterContext } from '../tenant-backup-export-dispatcher';

const mocks = vi.hoisted(() => ({ createSnapshot: vi.fn((input: unknown) => input) }));

vi.mock('../tenant-backup-record-snapshot-port', () => ({
  createEncryptedTenantBackupRecordSnapshotPort: mocks.createSnapshot,
}));

import { createTenantBackupPluginConfigurationPorts } from '../tenant-backup-plugin-configuration-port';

function memoryKv(initial: Record<string, string>): KVNamespace {
  const values = new Map(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  } as unknown as KVNamespace;
}

function environment(settings: KVNamespace, key: string): Env {
  return {
    SETTINGS: settings,
    PLUGIN_ENCRYPTION_KEY: key,
  } as Env;
}

function context(): AdapterContext {
  return {
    context: {
      lease: { tenantId: 'tenant-a', operationId: 'operation-a' },
      signal: new AbortController().signal,
    },
  } as unknown as AdapterContext;
}

const registry = JSON.stringify({
  'example-plugin': {
    id: 'example-plugin',
    version: '1.2.3',
    backendKind: 'in_process',
  },
});

describe('tenant backup plugin configuration production port', () => {
  beforeEach(() => mocks.createSnapshot.mockClear());

  it('roundtrips tenant KV settings and re-encrypts secrets with the target key', async () => {
    const sourceEnv = environment(
      memoryKv({ 'plugins:registry': registry }),
      'source-plugin-encryption-key-32-bytes-minimum'
    );
    const sourceKey = await getPluginEncryptionKey(sourceEnv);
    const sourceSettings = sourceEnv.SETTINGS as KVNamespace;
    const sourceStored = await encryptSecretFields(
      { endpoint: 'https://example.test', apiKey: 'source-secret' },
      ['apiKey'],
      sourceKey
    );
    await sourceSettings.put(
      'plugins:config:example-plugin:tenant:tenant-a',
      JSON.stringify(sourceStored)
    );
    await sourceSettings.put('plugins:enabled:example-plugin:tenant:tenant-a', 'true');

    createTenantBackupPluginConfigurationPorts(sourceEnv);
    const snapshot = mocks.createSnapshot.mock.calls[0][0] as {
      capture(context: AdapterContext): AsyncIterable<Uint8Array>;
    };
    const rows: Uint8Array[] = [];
    for await (const row of snapshot.capture(context())) rows.push(row);
    expect(rows).toHaveLength(1);
    const configuration = decodePortablePluginConfiguration(
      new TextDecoder().decode(rows[0]).trimEnd(),
      'tenant-a'
    );
    expect(configuration.config).toMatchObject({
      backend: 'kv',
      enabled: true,
      secretFields: ['apiKey'],
      value: { apiKey: 'source-secret' },
    });

    const targetKv = memoryKv({ 'plugins:registry': registry });
    const targetEnv = environment(targetKv, 'target-plugin-encryption-key-32-bytes-minimum');
    const target = createTenantBackupPluginConfigurationPorts(targetEnv);
    const signal = new AbortController().signal;
    await target.importPlugin({ signal }, configuration);
    await expect(target.verifyPlugin({ signal }, configuration)).resolves.toBe(true);
    const raw = await targetKv.get('plugins:config:example-plugin:tenant:tenant-a');
    expect(raw).not.toContain('source-secret');
    const decrypted = await decryptSecretFields(
      JSON.parse(raw ?? '{}') as EncryptedConfig,
      await getPluginEncryptionKey(targetEnv)
    );
    expect(decrypted).toMatchObject({
      endpoint: 'https://example.test',
      apiKey: 'source-secret',
    });
  });

  it('does not overwrite conflicting target configuration', async () => {
    const sourceEnv = environment(
      memoryKv({
        'plugins:registry': registry,
        'plugins:config:example-plugin:tenant:tenant-a': JSON.stringify({ region: 'source' }),
        'plugins:enabled:example-plugin:tenant:tenant-a': 'false',
      }),
      'source-plugin-encryption-key-32-bytes-minimum'
    );
    createTenantBackupPluginConfigurationPorts(sourceEnv);
    const snapshot = mocks.createSnapshot.mock.calls[0][0] as {
      capture(context: AdapterContext): AsyncIterable<Uint8Array>;
    };
    const rows: Uint8Array[] = [];
    for await (const row of snapshot.capture(context())) rows.push(row);
    const configuration = decodePortablePluginConfiguration(
      new TextDecoder().decode(rows[0]).trimEnd(),
      'tenant-a'
    );
    const target = createTenantBackupPluginConfigurationPorts(
      environment(
        memoryKv({
          'plugins:registry': registry,
          'plugins:config:example-plugin:tenant:tenant-a': JSON.stringify({ region: 'target' }),
          'plugins:enabled:example-plugin:tenant:tenant-a': 'false',
        }),
        'target-plugin-encryption-key-32-bytes-minimum'
      )
    );
    await expect(
      target.importPlugin({ signal: new AbortController().signal }, configuration)
    ).rejects.toThrow('backup_plugin_configuration_invalid');
  });

  it('fails closed when a dynamic installation exists without a portable runner adapter', async () => {
    const runner = {
      listApprovedDynamicPlugins: vi.fn(async () => [
        {
          pluginId: 'dynamic',
          activeVersionDigest: 'd'.repeat(64),
        },
      ]),
    };
    const env = {
      ...environment(
        memoryKv({
          'plugins:registry': JSON.stringify({
            dynamic: {
              id: 'dynamic',
              version: '1',
              backendKind: 'dynamic_worker',
            },
          }),
        }),
        'source-plugin-encryption-key-32-bytes-minimum'
      ),
      PLUGIN_RUNNER: runner,
    } as unknown as Env;
    createTenantBackupPluginConfigurationPorts(env);
    const snapshot = mocks.createSnapshot.mock.calls[0][0] as {
      assertSource(context: AdapterContext): Promise<void>;
    };
    await expect(snapshot.assertSource(context())).rejects.toThrow(
      'backup_plugin_configuration_invalid'
    );
  });

  it('roundtrips dynamic configuration through the Plugin Runner service binding', async () => {
    const portable = {
      tenantId: 'tenant-a',
      sourceInstallationId: 'source-installation',
      pluginId: 'dynamic',
      versionDigest: 'd'.repeat(64),
      contractVersion: 1 as const,
      enabled: true,
      credentials: { apiKey: 'secret' },
      resources: [],
      mutationScopes: [],
    };
    const runner = {
      listApprovedDynamicPlugins: vi.fn(async () => [
        {
          pluginId: 'dynamic',
          activeVersionDigest: portable.versionDigest,
        },
      ]),
      exportDynamicPluginBackup: vi.fn(async () => portable),
      restoreDynamicPluginBackup: vi.fn(async () => ({
        installationId: 'target-installation',
        state: 'enabled',
        configVersion: 2,
      })),
      verifyDynamicPluginBackup: vi.fn(async () => true),
    };
    const env = {
      ...environment(memoryKv({}), 'plugin-encryption-key-32-bytes-minimum'),
      PLUGIN_RUNNER: runner,
    } as unknown as Env;
    const ports = createTenantBackupPluginConfigurationPorts(env);
    const snapshot = mocks.createSnapshot.mock.calls[0][0] as {
      capture(context: AdapterContext): AsyncIterable<Uint8Array>;
    };
    const rows: Uint8Array[] = [];
    for await (const row of snapshot.capture(context())) rows.push(row);
    expect(rows).toHaveLength(1);
    const configuration = decodePortablePluginConfiguration(
      new TextDecoder().decode(rows[0]).trimEnd(),
      'tenant-a'
    );
    await ports.assertPluginSupported(configuration);
    await ports.importPlugin({ signal: new AbortController().signal }, configuration);
    await expect(
      ports.verifyPlugin({ signal: new AbortController().signal }, configuration)
    ).resolves.toBe(true);
    expect(runner.restoreDynamicPluginBackup).toHaveBeenCalledWith({
      operationId: 'backup-tenant-a-dynamic',
      configuration: portable,
    });
  });
});
