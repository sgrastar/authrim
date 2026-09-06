import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createDefaultConfig, type AuthrimConfig } from '../core/config';
import type { AuthrimLock } from '../core/lock';
import { ensureInitialNotificationProviderConfiguration } from '../core/notification-provider-bootstrap';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function config(provider: 'none' | 'cloudflare' | 'resend' | 'sendgrid'): AuthrimConfig {
  const value = createDefaultConfig('test');
  return {
    ...value,
    tenant: { ...value.tenant, name: 'tenant-a' },
    features: {
      ...value.features,
      email: {
        ...value.features.email,
        provider,
        configured: provider !== 'none',
        ...(provider === 'none' ? {} : { fromAddress: 'noreply@example.test' }),
      },
    },
  };
}

function lock(): AuthrimLock {
  return {
    d1: { PLUGIN_RUNNER_DB: { name: 'test-plugin-runner', id: 'database-a' } },
    kv: {
      AUTHRIM_CONFIG: { name: 'test-authrim-config', id: 'config-kv-a' },
      SETTINGS: { name: 'test-settings', id: 'settings-kv-a' },
    },
  } as unknown as AuthrimLock;
}

function reflectedQuery(executedSql: string[]) {
  return vi.fn(async (_databaseName: string, sql: string) => {
    const source = executedSql.at(-1);
    if (!source) throw new Error('missing_bootstrap_sql');
    const namespaceId = sql.match(/route\.tenant_id = '([^']+)'/u)?.[1];
    if (namespaceId) {
      const operation = source.match(/notification-order-bootstrap-v1-[0-9a-f]{64}/u)?.[0];
      if (!operation) throw new Error('missing_bootstrap_operation');
      const operationOffset = source.indexOf(operation);
      const fingerprint = source
        .slice(operationOffset + operation.length)
        .match(/[0-9a-f]{64}/u)?.[0];
      if (!fingerprint) throw new Error('missing_bootstrap_fingerprint');
      const installationId = source.match(/notification-installation-v1-[0-9a-f]{64}/u)?.[0];
      return [
        {
          tenant_id: namespaceId,
          channel: 'email',
          config_version: 1,
          state: installationId ? 'enabled' : 'disabled',
          last_operation_id: operation,
          order_fingerprint: fingerprint,
          installation_ids_json: JSON.stringify(installationId ? [installationId] : []),
        },
      ];
    }
    const installationId = sql.match(/installation\.installation_id = '([^']+)'/u)?.[1];
    if (!installationId) throw new Error('unexpected_bootstrap_query');
    const tenantId = source.includes("'authrim-platform'") ? 'authrim-platform' : 'tenant-a';
    const isResend = source.includes("'notifier-resend'");
    return [
      {
        installation_id: installationId,
        tenant_id: tenantId,
        plugin_id: isResend ? 'notifier-resend' : 'notifier-cloudflare',
        backend_kind: 'in_process',
        script_name: null,
        state: 'enabled',
        config_version: isResend ? 2 : 1,
        credential_count: isResend ? 1 : 0,
      },
    ];
  });
}

describe('initial notification provider bootstrap', () => {
  it('materializes explicit disabled platform and tenant routes', async () => {
    const executedSql: string[] = [];
    const execute = vi.fn(async (_databaseName: string, sql: string) => {
      executedSql.push(sql);
      return { stdout: '', stderr: '' };
    });
    const query = reflectedQuery(executedSql);
    const putKv = vi.fn(async () => undefined);
    await expect(
      ensureInitialNotificationProviderConfiguration({
        environmentId: 'test',
        config: config('none'),
        lock: lock(),
        keysDir: '/not-used',
        now: 1_000,
        execute: execute as never,
        query: query as never,
        putKv,
      })
    ).resolves.toEqual({
      providerId: null,
      namespaces: ['authrim-platform', 'tenant-a'],
    });
    expect(executedSql).toHaveLength(2);
    expect(
      execute.mock.calls.every(([databaseIdentifier]) => databaseIdentifier === 'database-a')
    ).toBe(true);
    expect(
      query.mock.calls.every(([databaseIdentifier]) => databaseIdentifier === 'database-a')
    ).toBe(true);
    expect(executedSql.every((sql) => sql.includes("'disabled'"))).toBe(true);
    expect(putKv).toHaveBeenCalledWith(
      'config-kv-a',
      'settings:tenant:tenant-a:email-settings',
      JSON.stringify({ strategy: 'priority_failover', providerOrder: [] })
    );
  });

  it('fails closed before mutation when the plugin-runner lock has no immutable ID', async () => {
    const missingId = lock();
    delete (missingId.d1.PLUGIN_RUNNER_DB as { id?: string }).id;
    const execute = vi.fn();
    const query = vi.fn();
    const putKv = vi.fn();

    await expect(
      ensureInitialNotificationProviderConfiguration({
        environmentId: 'test',
        config: config('none'),
        lock: missingId,
        keysDir: '/not-used',
        now: 1_000,
        execute: execute as never,
        query: query as never,
        putKv: putKv as never,
      })
    ).rejects.toThrow('notification_provider_bootstrap_database_id_missing');
    expect(execute).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(putKv).not.toHaveBeenCalled();
  });

  it('encrypts Resend credentials before D1 and KV projection', async () => {
    const keysDir = await mkdtemp(join(tmpdir(), 'authrim-notification-bootstrap-'));
    temporaryDirectories.push(keysDir);
    await Promise.all([
      writeFile(join(keysDir, 'resend_api_key.txt'), 're_secret_bootstrap'),
      writeFile(join(keysDir, 'plugin_encryption_key.txt'), 'e'.repeat(64)),
      writeFile(join(keysDir, 'plugin_mutation_hmac_key.txt'), 'm'.repeat(64)),
    ]);
    const database = new DatabaseSync(':memory:');
    for (const migration of ['migrations/plugin-runner/001_pre_1_0_plugin_runner_baseline.sql']) {
      database.exec(await readFile(resolve(process.cwd(), '../..', migration), 'utf8'));
    }
    const executedSql: string[] = [];
    const execute = vi.fn(async (_databaseName: string, sql: string) => {
      executedSql.push(sql);
      database.exec(sql);
      return { stdout: '', stderr: '' };
    });
    const writes = new Map<string, string>();
    const putKv = vi.fn(async (_namespaceId: string, key: string, value: string) => {
      writes.set(key, value);
    });

    const bootstrapInput = {
      environmentId: 'test',
      config: config('resend'),
      lock: lock(),
      keysDir,
      now: 1_000,
      execute: execute as never,
      query: (async (_databaseName: string, sql: string) => database.prepare(sql).all()) as never,
      putKv,
    };
    await expect(
      ensureInitialNotificationProviderConfiguration(bootstrapInput)
    ).resolves.toMatchObject({ providerId: 'notifier-resend' });
    await expect(
      ensureInitialNotificationProviderConfiguration(bootstrapInput)
    ).resolves.toMatchObject({ providerId: 'notifier-resend' });
    expect(executedSql.join('\n')).not.toContain('re_secret_bootstrap');
    expect(executedSql.join('\n')).toContain('enc:v1:');
    const storedConfig = JSON.parse(writes.get('plugins:config:notifier-resend') ?? '{}') as {
      _encrypted?: string[];
      apiKey?: string;
    };
    expect(storedConfig._encrypted).toEqual(['apiKey']);
    expect(storedConfig.apiKey).toMatch(/^enc:v1:/u);
    expect(storedConfig.apiKey).not.toContain('re_secret_bootstrap');
    expect(writes.get('settings:tenant:tenant-a:email-settings')).toBe(
      JSON.stringify({ strategy: 'priority_failover', providerOrder: ['notifier-resend'] })
    );
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM plugin_runner_encrypted_configs
            WHERE encrypted_value LIKE 'enc:v1:%'`
        )
        .get()
    ).toEqual({ count: 2 });
    database.close();
  });

  it('fails closed for providers without a Runner backend', async () => {
    await expect(
      ensureInitialNotificationProviderConfiguration({
        environmentId: 'test',
        config: config('sendgrid'),
        lock: lock(),
        keysDir: '/not-used',
      })
    ).rejects.toThrow('notification_provider_bootstrap_provider_unsupported');
  });
});
