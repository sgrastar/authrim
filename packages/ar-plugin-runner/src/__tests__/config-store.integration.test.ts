import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { D1PluginConfigStore } from '../config-store';
import { D1PluginConfigReencryptor } from '../config-reencryption';
import { D1NotificationInstallationStore } from '../notification-installations';
import { D1HumanVerificationInstallationStore } from '../human-verification-installations';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SECRET = 'phase-2b-config-store-encryption-secret';
const MUTATION_SECRET = 'phase-2b-config-mutation-hmac-secret';

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[]
  ) {}

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.statement.all(...this.values) as T[] };
  }

  async run() {
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class Session {
  private loseNextBatchResponse: boolean;

  constructor(
    private readonly database: DatabaseSync,
    loseNextBatchResponse: boolean
  ) {
    this.loseNextBatchResponse = loseNextBatchResponse;
  }

  prepare(sql: string) {
    const statement = this.database.prepare(sql);
    return {
      bind: (...values: unknown[]) =>
        new BoundStatement(
          statement,
          values.map((value) => {
            if (
              typeof value === 'string' ||
              typeof value === 'number' ||
              value === null ||
              value instanceof Uint8Array
            ) {
              return value;
            }
            throw new Error('unsupported_test_sqlite_value');
          })
        ),
    };
  }

  async batch(statements: BoundStatement[]) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec('COMMIT');
      if (this.loseNextBatchResponse) {
        this.loseNextBatchResponse = false;
        throw new Error('simulated_response_loss');
      }
      return results;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function d1(database: DatabaseSync, loseNextBatchResponse = false): D1Database {
  const session = new Session(database, loseNextBatchResponse);
  return {
    prepare: (sql: string) => session.prepare(sql),
    withSession: () => session,
  } as unknown as D1Database;
}

const request = {
  operationId: 'config-operation-a',
  tenantId: 'tenant-a',
  installationId: 'installation-a',
  expectedConfigVersion: 1,
  credentials: [
    {
      configKey: 'apiKey',
      destinationHost: 'hooks.example.com',
      injectionKind: 'bearer' as const,
      injectionName: 'Authorization',
      value: 'provider-secret-value',
    },
  ],
};

describe('D1PluginConfigStore', () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec('PRAGMA foreign_keys = ON');
    for (const migration of ['001_0_4_0_plugin_runner_baseline.sql']) {
      database.exec(
        readFileSync(resolve(REPO_ROOT, 'migrations/plugin-runner', migration), 'utf8')
      );
    }
    database.exec(
      `INSERT INTO plugin_runner_installations (
         installation_id, tenant_id, plugin_id, backend_kind, script_name,
         state, config_version, created_at, updated_at
       ) VALUES (
         'installation-a', 'tenant-a', 'plugin-a', 'dynamic_worker',
         'plugin-a', 'enabled', 1, 1, 1
       );
       INSERT INTO plugin_runner_dynamic_worker_releases (
         plugin_id, version_digest, code_sha256, code_object_key, source_manifest_hash,
         capability_manifest_digest, policy_json, state, published_at, updated_at
       ) VALUES (
         'plugin-a', '${'d'.repeat(64)}', '${'a'.repeat(64)}',
         'plugins/plugin-a/${'a'.repeat(64)}.json', '${'b'.repeat(64)}',
         '${'c'.repeat(64)}', '{}', 'published', 1, 1
       );
       INSERT INTO plugin_runner_dynamic_worker_manifests (
         plugin_id, active_version_digest, state, updated_at
       ) VALUES (
         'plugin-a', '${'d'.repeat(64)}', 'active', 1
       );
       INSERT INTO plugin_runner_dynamic_worker_artifacts (
         artifact_id, installation_id, plugin_id, version_digest,
         state, activated_at, updated_at
       ) VALUES (
         'artifact-a', 'installation-a', 'plugin-a', '${'d'.repeat(64)}',
         'active', 1, 1
       );
       INSERT INTO plugin_runner_dynamic_worker_egress_allowed_hosts (
         plugin_id, version_digest, rule_id, match_kind, host_pattern, created_at
       ) VALUES (
         'plugin-a', '${'d'.repeat(64)}', 'host-a', 'exact', 'hooks.example.com', 1
       );
       INSERT INTO plugin_runner_dynamic_worker_credential_slots (
         plugin_id, version_digest, config_key, required, destination_host, injection_kind,
         injection_name, updated_at
       ) VALUES (
         'plugin-a', '${'d'.repeat(64)}', 'apiKey', 1,
         'hooks.example.com', 'bearer', 'Authorization', 1
       );`
    );
  });

  afterEach(() => database.close());

  it('atomically encrypts a complete credential version and never persists plaintext', async () => {
    const store = new D1PluginConfigStore(d1(database), SECRET, MUTATION_SECRET, () => 1_000);

    await expect(store.replaceCredentials(request)).resolves.toEqual({
      operationId: 'config-operation-a',
      installationId: 'installation-a',
      configVersion: 2,
      credentialCount: 1,
    });
    const row = database
      .prepare(
        `SELECT config_version, encryption_key_id, encrypted_value, nonce_fingerprint,
                reencrypt_state
           FROM plugin_runner_encrypted_configs`
      )
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({
      config_version: 2,
      encryption_key_id: 'v1',
      reencrypt_state: 'current',
    });
    expect(String(row.encrypted_value)).toMatch(/^enc:v1:/u);
    expect(String(row.encrypted_value)).not.toContain('provider-secret-value');
    expect(String(row.nonce_fingerprint)).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      database
        .prepare(
          `SELECT config_version FROM plugin_runner_installations
            WHERE installation_id = 'installation-a'`
        )
        .get()
    ).toEqual({ config_version: 2 });
  });

  it('configures a fixed notification policy and Resend egress host idempotently', async () => {
    const store = new D1NotificationInstallationStore(d1(database), () => 1_000);
    const input = {
      installationId: 'notifier-resend-tenant-b',
      tenantId: 'tenant-b',
      pluginId: 'notifier-resend',
      backendKind: 'in_process' as const,
      enabled: true,
    };
    await expect(store.configure(input)).resolves.toMatchObject({
      installationId: input.installationId,
      tenantId: input.tenantId,
      pluginId: input.pluginId,
      state: 'enabled',
      configVersion: 1,
    });
    await expect(store.configure(input)).resolves.toMatchObject({ configVersion: 1 });
    expect(
      database
        .prepare(
          `SELECT timeout_ms, failure_policy, max_attempts, async_retry_budget_seconds
             FROM plugin_runner_hook_policies
            WHERE plugin_id = 'notifier-resend' AND capability = 'notifier.send'`
        )
        .get()
    ).toEqual({
      timeout_ms: 30_000,
      failure_policy: 'retry_async',
      max_attempts: 12,
      async_retry_budget_seconds: 604_800,
    });
    expect(
      database
        .prepare(
          `SELECT match_kind, host_pattern FROM plugin_runner_egress_allowed_hosts
            WHERE plugin_id = 'notifier-resend' AND rule_id = 'resend-api'`
        )
        .get()
    ).toEqual({ match_kind: 'exact', host_pattern: 'api.resend.com' });
  });

  it('projects a version-matched human-verification config without plaintext persistence', async () => {
    const store = new D1HumanVerificationInstallationStore(
      d1(database),
      SECRET,
      MUTATION_SECRET,
      () => 1_000
    );
    const input = {
      operationId: 'human-config-operation-a',
      installationId: 'human-installation-a',
      tenantId: 'tenant-a',
      pluginId: 'human-verification-cloudflare-turnstile',
      enabled: true,
      config: {
        siteKey: 'public-site-key',
        secretKey: 'private-siteverify-secret',
        expectedHostname: 'LOGIN.EXAMPLE.COM',
        widgetMode: 'managed' as const,
      },
    };

    await expect(store.configure(input)).resolves.toEqual({
      installationId: input.installationId,
      tenantId: input.tenantId,
      pluginId: input.pluginId,
      state: 'enabled',
      configVersion: 2,
    });
    await expect(store.configure(input)).resolves.toMatchObject({ configVersion: 2 });
    expect(
      database
        .prepare(
          `SELECT installation.state, installation.config_version,
                  config.expected_hostname, config.widget_mode
             FROM plugin_runner_installations installation
             JOIN plugin_runner_human_verification_configs config
               ON config.installation_id = installation.installation_id
              AND config.config_version = installation.config_version
            WHERE installation.installation_id = ?`
        )
        .get(input.installationId)
    ).toEqual({
      state: 'enabled',
      config_version: 2,
      expected_hostname: 'login.example.com',
      widget_mode: 'managed',
    });
    const credential = database
      .prepare(
        `SELECT injection_kind, injection_name, encrypted_value
           FROM plugin_runner_encrypted_configs
          WHERE installation_id = ? AND config_version = 2`
      )
      .get(input.installationId) as Record<string, unknown>;
    expect(credential).toMatchObject({ injection_kind: 'json_field', injection_name: 'secret' });
    expect(String(credential.encrypted_value)).toMatch(/^enc:v1:/u);
    expect(String(credential.encrypted_value)).not.toContain('private-siteverify-secret');
  });

  it('rejects cross-tenant human-verification installation collisions', async () => {
    const store = new D1HumanVerificationInstallationStore(
      d1(database),
      SECRET,
      MUTATION_SECRET,
      () => 1_000
    );
    const base = {
      operationId: 'human-config-operation-b',
      installationId: 'human-installation-b',
      tenantId: 'tenant-a',
      pluginId: 'human-verification-hcaptcha',
      enabled: true,
      config: { siteKey: 'site-key', secretKey: 'secret-key' },
    };
    await expect(store.configure(base)).resolves.toMatchObject({ state: 'enabled' });
    await expect(
      store.configure({
        ...base,
        operationId: 'human-config-operation-cross-tenant',
        tenantId: 'tenant-b',
      })
    ).rejects.toThrow('plugin_human_verification_reflection_invalid');
    expect(
      database
        .prepare(`SELECT tenant_id FROM plugin_runner_installations WHERE installation_id = ?`)
        .get(base.installationId)
    ).toEqual({ tenant_id: 'tenant-a' });
  });

  it('adopts an exact installation response-loss retry after complete primary reflection', async () => {
    const input = {
      installationId: 'notifier-cloudflare-tenant-b',
      tenantId: 'tenant-b',
      pluginId: 'notifier-cloudflare',
      backendKind: 'in_process' as const,
      enabled: true,
    };

    await expect(
      new D1NotificationInstallationStore(d1(database, true), () => 1_000).configure(input)
    ).resolves.toMatchObject({
      installationId: input.installationId,
      tenantId: input.tenantId,
      pluginId: input.pluginId,
      state: 'enabled',
    });
  });

  it('does not create policy or egress state for a cross-tenant installation collision', async () => {
    const store = new D1NotificationInstallationStore(d1(database), () => 1_000);

    await expect(
      store.configure({
        installationId: 'installation-a',
        tenantId: 'tenant-b',
        pluginId: 'notifier-resend',
        backendKind: 'in_process',
        enabled: true,
      })
    ).rejects.toThrow('plugin_notification_installation_batch_failed');
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM plugin_runner_hook_policies
            WHERE plugin_id = 'notifier-resend'`
        )
        .get()
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM plugin_runner_egress_allowed_hosts
            WHERE plugin_id = 'notifier-resend'`
        )
        .get()
    ).toEqual({ count: 0 });
  });

  it('adopts a committed response-loss retry and rejects operation reuse with changed secret', async () => {
    const losingStore = new D1PluginConfigStore(
      d1(database, true),
      SECRET,
      MUTATION_SECRET,
      () => 1_000
    );
    await expect(losingStore.replaceCredentials(request)).rejects.toThrow(
      'simulated_response_loss'
    );

    const retryStore = new D1PluginConfigStore(d1(database), SECRET, MUTATION_SECRET, () => 1_001);
    await expect(retryStore.replaceCredentials(request)).resolves.toMatchObject({
      configVersion: 2,
    });
    await expect(
      retryStore.replaceCredentials({
        ...request,
        credentials: [{ ...request.credentials[0], value: 'different-secret' }],
      })
    ).rejects.toThrow('plugin_config_idempotency_conflict');
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM plugin_runner_encrypted_configs`).get()
    ).toEqual({ count: 1 });
  });

  it('rejects cross-tenant and non-approved destinations before encryption writes', async () => {
    const store = new D1PluginConfigStore(d1(database), SECRET, MUTATION_SECRET, () => 1_000);
    await expect(store.replaceCredentials({ ...request, tenantId: 'tenant-b' })).rejects.toThrow(
      'plugin_config_installation_unavailable'
    );
    await expect(
      store.replaceCredentials({
        ...request,
        operationId: 'config-operation-b',
        credentials: [{ ...request.credentials[0], destinationHost: 'evil.example.net' }],
      })
    ).rejects.toThrow('plugin_config_host_not_approved');
    await expect(
      store.replaceCredentials({
        ...request,
        operationId: 'config-operation-c',
        credentials: [
          {
            ...request.credentials[0],
            injectionKind: 'header',
            injectionName: 'Host',
          },
        ],
      })
    ).rejects.toThrow('plugin_config_input_invalid');
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM plugin_runner_config_mutations`).get()
    ).toEqual({ count: 0 });
  });

  it('resumably re-encrypts every record and completes only after the fixed grace period', async () => {
    const oldKey = 'old-plugin-config-encryption-key-value';
    const newKey = 'new-plugin-config-encryption-key-value';
    await new D1PluginConfigStore(
      d1(database),
      { active: { id: 'key-a', secret: oldKey } },
      MUTATION_SECRET,
      () => 1_000
    ).replaceCredentials(request);
    let now = 2_000;
    const keyring = {
      active: { id: 'key-b', secret: newKey },
      previous: { id: 'key-a', secret: oldKey },
    };
    const losing = new D1PluginConfigReencryptor(d1(database, true), keyring, () => now);
    await expect(losing.start('rotation-a')).resolves.toEqual({
      operationId: 'rotation-a',
      sourceCount: 1,
    });
    await expect(losing.advanceActive()).rejects.toThrow('simulated_response_loss');

    const retry = new D1PluginConfigReencryptor(d1(database), keyring, () => now);
    await expect(retry.advanceActive()).resolves.toBe('grace');
    expect(
      database
        .prepare(
          `SELECT encryption_key_id, reencrypt_state
             FROM plugin_runner_encrypted_configs`
        )
        .get()
    ).toEqual({ encryption_key_id: 'key-b', reencrypt_state: 'verified' });
    await expect(
      new D1PluginConfigStore(d1(database), keyring, MUTATION_SECRET, () => now).replaceCredentials(
        request
      )
    ).resolves.toMatchObject({ configVersion: 2 });
    await expect(retry.advanceActive()).resolves.toBe('grace');
    now += 7 * 24 * 60 * 60;
    await expect(retry.advanceActive()).resolves.toBe('complete');
    expect(
      database
        .prepare(
          `SELECT state, active_operation_key, source_count, reencrypted_count
             FROM plugin_runner_config_key_rotations`
        )
        .get()
    ).toEqual({
      state: 'complete',
      active_operation_key: 'operation:rotation-a',
      source_count: 1,
      reencrypted_count: 1,
    });
    await expect(
      new D1PluginConfigStore(
        d1(database),
        { active: keyring.active },
        MUTATION_SECRET,
        () => now
      ).replaceCredentials(request)
    ).resolves.toMatchObject({ configVersion: 2 });
  });

  it('fails closed when the stable mutation HMAC key is unavailable', () => {
    expect(() => new D1PluginConfigStore(d1(database), SECRET, '')).toThrow(
      'plugin_config_hmac_key_invalid'
    );
  });

  it('automatically starts and adopts the deployed current/previous key rotation', async () => {
    const oldKey = 'old-plugin-config-encryption-key-value';
    const newKey = 'new-plugin-config-encryption-key-value';
    await new D1PluginConfigStore(
      d1(database),
      { active: { id: 'key-a', secret: oldKey } },
      MUTATION_SECRET,
      () => 1_000
    ).replaceCredentials(request);
    const reencryptor = new D1PluginConfigReencryptor(
      d1(database),
      {
        active: { id: 'key-b', secret: newKey },
        previous: { id: 'key-a', secret: oldKey },
      },
      () => 2_000
    );

    await expect(reencryptor.ensureActive()).resolves.toEqual({
      operationId: 'auto:key-a:key-b',
      sourceCount: 1,
    });
    await expect(reencryptor.ensureActive()).resolves.toEqual({
      operationId: 'auto:key-a:key-b',
      sourceCount: 1,
    });
    await expect(reencryptor.advanceActive()).resolves.toBe('reencrypting');
  });
});
