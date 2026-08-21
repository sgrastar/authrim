import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { derivePluginInstallationId } from '@authrim/ar-lib-core';
import { D1PluginConfigStore } from '../config-store';
import { D1DynamicPluginInstallationStore } from '../dynamic-worker-installations';
import { D1PluginInstallationResolver } from '../installations';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const RELEASE_A = 'a'.repeat(64);
const RELEASE_B = 'b'.repeat(64);
const VERSION_A = '1'.repeat(64);
const VERSION_B = '2'.repeat(64);
const POLICY_JSON = JSON.stringify({
  backend: 'dynamic_worker',
  resourceScope: 'tenant',
  visibility: 'tenant',
  capabilities: [{ name: 'flow.evaluate' }],
  credentials: [{ configKey: 'apiKey', required: true }],
  egressAllowedHosts: [{ kind: 'exact', host: 'api.example.com' }],
  hostInterfaces: [],
  resources: [],
});

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
  constructor(
    private readonly database: DatabaseSync,
    private readonly afterBatch?: () => void
  ) {}

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
      this.afterBatch?.();
      return results;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function d1(database: DatabaseSync, afterBatch?: () => void): D1Database {
  const session = new Session(database, afterBatch);
  return {
    prepare: (sql: string) => session.prepare(sql),
    withSession: () => session,
  } as unknown as D1Database;
}

function publish(
  database: DatabaseSync,
  digest: string,
  destinationHost = 'api.example.com'
): void {
  const versionDigest = digest === RELEASE_A ? VERSION_A : VERSION_B;
  const key = `plugins/plugin-a/${digest}.json`;
  database
    .prepare(
      `INSERT INTO plugin_runner_dynamic_worker_releases (
         plugin_id, version_digest, code_sha256, code_object_key, source_manifest_hash,
         capability_manifest_digest, policy_json, state, published_at, updated_at
       ) VALUES ('plugin-a', ?, ?, ?, ?, ?, ?, 'published', 1, 1)`
    )
    .run(
      versionDigest,
      digest,
      key,
      'c'.repeat(64),
      'd'.repeat(64),
      POLICY_JSON.replaceAll('api.example.com', destinationHost)
    );
  database
    .prepare(
      `INSERT INTO plugin_runner_dynamic_worker_manifests (
         plugin_id, active_version_digest, state, updated_at
       ) VALUES ('plugin-a', ?, 'active', 1)
       ON CONFLICT(plugin_id) DO UPDATE SET
         active_version_digest = excluded.active_version_digest,
         state = 'active', updated_at = excluded.updated_at`
    )
    .run(versionDigest);
  database
    .prepare(
      `INSERT INTO plugin_runner_dynamic_worker_hook_policies (
         plugin_id, version_digest, capability, timeout_ms, failure_policy, max_attempts,
         async_retry_budget_seconds, circuit_breaker_threshold,
         circuit_breaker_cooldown_seconds, updated_at
       ) VALUES ('plugin-a', ?, 'flow.evaluate', 1000, 'fail_closed', 1, 60, 5, 60, 1)`
    )
    .run(versionDigest);
  database
    .prepare(
      `INSERT INTO plugin_runner_dynamic_worker_egress_allowed_hosts (
         plugin_id, version_digest, rule_id, match_kind, host_pattern, created_at
       ) VALUES ('plugin-a', ?, 'manifest-000', 'exact', ?, 1)`
    )
    .run(versionDigest, destinationHost);
  database
    .prepare(
      `INSERT INTO plugin_runner_dynamic_worker_credential_slots (
         plugin_id, version_digest, config_key, required, destination_host,
         injection_kind, injection_name, updated_at
       ) VALUES ('plugin-a', ?, 'apiKey', 1, ?, 'bearer', 'Authorization', 1)`
    )
    .run(versionDigest, destinationHost);
}

describe('D1DynamicPluginInstallationStore', () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec('PRAGMA foreign_keys = ON');
    for (const migration of ['001_pre_1_0_plugin_runner_baseline.sql']) {
      database.exec(
        readFileSync(resolve(REPO_ROOT, 'migrations/plugin-runner', migration), 'utf8')
      );
    }
    publish(database, RELEASE_A);
  });

  async function enableTenant(
    store: D1DynamicPluginInstallationStore,
    tenantId: string
  ): Promise<string> {
    const disabled = await store.configure({ tenantId, pluginId: 'plugin-a', enabled: false });
    await new D1PluginConfigStore(
      d1(database),
      'dynamic-worker-installation-encryption-secret',
      'dynamic-worker-installation-mutation-hmac-secret',
      () => 101
    ).replaceCredentials({
      operationId: `credential-${tenantId}`,
      tenantId,
      installationId: disabled.installationId,
      expectedConfigVersion: 1,
      credentials: [
        {
          configKey: 'apiKey',
          destinationHost: 'api.example.com',
          injectionKind: 'bearer',
          injectionName: 'Authorization',
          value: `secret-${tenantId}`,
        },
      ],
    });
    await store.configure({ tenantId, pluginId: 'plugin-a', enabled: true });
    return disabled.installationId;
  }

  it('inherits only an exact credential slot and requires re-entry for a changed target', async () => {
    const store = new D1DynamicPluginInstallationStore(d1(database), 'test', () => 200);
    const input = { tenantId: 'tenant-rollout', pluginId: 'plugin-a', enabled: false };
    const disabled = await store.configure(input);
    const config = new D1PluginConfigStore(
      d1(database),
      'dynamic-worker-installation-encryption-secret',
      'dynamic-worker-installation-mutation-hmac-secret',
      () => 201
    );
    await config.replaceCredentials({
      operationId: 'credential-rollout-a',
      tenantId: input.tenantId,
      installationId: disabled.installationId,
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
    await store.configure({ ...input, enabled: true });
    publish(database, RELEASE_B, 'api2.example.com');

    await expect(store.rollout({ ...input, enabled: true })).rejects.toThrow(
      'plugin_dynamic_rollout_credentials_required'
    );
    await store.configure(input);
    await expect(
      store.credentialInputs({
        tenantId: input.tenantId,
        pluginId: input.pluginId,
        credentials: { apiKey: 'secret-b' },
      })
    ).resolves.toMatchObject({
      values: [{ configKey: 'apiKey', destinationHost: 'api2.example.com' }],
    });
    await config.replaceCredentials({
      operationId: 'credential-rollout-b',
      tenantId: input.tenantId,
      installationId: disabled.installationId,
      expectedConfigVersion: 2,
      credentials: [
        {
          configKey: 'apiKey',
          destinationHost: 'api2.example.com',
          injectionKind: 'bearer',
          injectionName: 'Authorization',
          value: 'secret-b',
        },
      ],
    });
    await expect(store.rollout({ ...input, enabled: true })).resolves.toMatchObject({
      state: 'enabled',
      pinnedVersionDigest: VERSION_B,
    });
  });

  afterEach(() => database.close());

  it('rejects a delayed activation after a newer disable clears its request fence', async () => {
    const store = new D1DynamicPluginInstallationStore(d1(database), 'test', () => 100);
    const input = { tenantId: 'tenant-fenced', pluginId: 'plugin-a', enabled: false };
    const disabled = await store.configure(input);
    await new D1PluginConfigStore(
      d1(database),
      'dynamic-worker-installation-encryption-secret',
      'dynamic-worker-installation-mutation-hmac-secret',
      () => 101
    ).replaceCredentials({
      operationId: 'credential-fenced-a',
      tenantId: input.tenantId,
      installationId: disabled.installationId,
      expectedConfigVersion: 1,
      credentials: [
        {
          configKey: 'apiKey',
          destinationHost: 'api.example.com',
          injectionKind: 'bearer',
          injectionName: 'Authorization',
          value: 'secret-fenced',
        },
      ],
    });

    await expect(
      store.stageActivation({
        tenantId: input.tenantId,
        pluginId: input.pluginId,
        activationRequestId: 'operation-a',
      })
    ).resolves.toMatchObject({ state: 'pending', activationRequestId: 'operation-a' });
    await store.configure(input);

    await expect(
      store.configure({
        ...input,
        enabled: true,
        activationRequestId: 'operation-a',
      })
    ).rejects.toThrow('plugin_dynamic_activation_request_mismatch');
    expect(
      database
        .prepare(
          `SELECT state, pending_activation_request_id
             FROM plugin_runner_installations WHERE installation_id = ?`
        )
        .get(disabled.installationId)
    ).toEqual({ state: 'disabled', pending_activation_request_id: null });

    await store.stageActivation({
      tenantId: input.tenantId,
      pluginId: input.pluginId,
      activationRequestId: 'operation-b',
    });
    await expect(
      store.configure({
        ...input,
        enabled: true,
        activationRequestId: 'operation-b',
      })
    ).resolves.toMatchObject({ state: 'enabled' });
  });

  it('disables every active resource projection when the installation is disabled', async () => {
    const store = new D1DynamicPluginInstallationStore(d1(database), 'test', () => 100);
    const input = { tenantId: 'tenant-resources', pluginId: 'plugin-a', enabled: false };
    const installation = await store.configure(input);
    database
      .prepare(
        `INSERT INTO plugin_runner_dynamic_worker_resources (
           installation_id, tenant_id, plugin_id, logical_resource_id,
           logical_binding_name, host_binding_ref, resource_kind, access_mode,
           ownership_fingerprint, control_operation_id, state, updated_at
         ) VALUES (?, ?, 'plugin-a', 'state', 'PLUGIN_STATE', ?, 'd1', 'read_write',
                   ?, 'operation-a', 'active', 99)`
      )
      .run(
        installation.installationId,
        input.tenantId,
        `PRES_D1_${'A'.repeat(24)}`,
        'a'.repeat(64)
      );

    await expect(store.configure(input)).resolves.toMatchObject({ state: 'disabled' });
    expect(
      database
        .prepare(
          `SELECT state FROM plugin_runner_dynamic_worker_resources
            WHERE installation_id = ? AND logical_resource_id = 'state'`
        )
        .get(installation.installationId)
    ).toEqual({ state: 'disabled' });
  });

  it('pins on tenant enable, preserves the pin, and advances only on explicit rollout', async () => {
    const store = new D1DynamicPluginInstallationStore(d1(database), 'test', () => 100);
    const input = { tenantId: 'tenant-a', pluginId: 'plugin-a', enabled: false };
    const disabled = await store.configure(input);
    const config = new D1PluginConfigStore(
      d1(database),
      'dynamic-worker-installation-encryption-secret',
      'dynamic-worker-installation-mutation-hmac-secret',
      () => 101
    );
    await config.replaceCredentials({
      operationId: 'credential-operation-a',
      tenantId: input.tenantId,
      installationId: disabled.installationId,
      expectedConfigVersion: 1,
      credentials: [
        {
          configKey: 'apiKey',
          destinationHost: 'api.example.com',
          injectionKind: 'bearer',
          injectionName: 'Authorization',
          value: 'secret-value',
        },
      ],
    });

    await expect(store.configure({ ...input, enabled: true })).resolves.toMatchObject({
      state: 'enabled',
      configVersion: 2,
      pinnedVersionDigest: VERSION_A,
    });
    publish(database, RELEASE_B);
    await expect(store.configure({ ...input, enabled: true })).resolves.toMatchObject({
      pinnedVersionDigest: VERSION_A,
    });
    await expect(store.rollout({ ...input, enabled: true })).resolves.toMatchObject({
      pinnedVersionDigest: VERSION_B,
    });
    expect(
      database
        .prepare(
          `SELECT version_digest, state FROM plugin_runner_dynamic_worker_artifacts
            WHERE installation_id = ? ORDER BY version_digest`
        )
        .all(disabled.installationId)
    ).toEqual([
      { version_digest: VERSION_A, state: 'retired' },
      { version_digest: VERSION_B, state: 'active' },
    ]);
  });

  it('resumes a bounded platform rollout and treats the first small batch as the canary', async () => {
    const store = new D1DynamicPluginInstallationStore(d1(database), 'test', () => 300);
    const installationIds = await Promise.all(
      ['tenant-a', 'tenant-b', 'tenant-c'].map((tenantId) => enableTenant(store, tenantId))
    );
    publish(database, RELEASE_B);

    await expect(
      store.rolloutBatch({ operationId: 'rollout-a', pluginId: 'plugin-a', batchSize: 1 })
    ).resolves.toMatchObject({
      state: 'running',
      processedThisBatch: 1,
      succeededCount: 1,
      blockedCount: 0,
      failedCount: 0,
      hasMore: true,
      targetVersionDigest: VERSION_B,
    });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM plugin_runner_dynamic_worker_artifacts
            WHERE version_digest = ? AND state = 'active'`
        )
        .get(VERSION_B)
    ).toEqual({ count: 1 });

    await expect(
      store.rolloutBatch({ operationId: 'rollout-a', pluginId: 'plugin-a', batchSize: 2 })
    ).resolves.toMatchObject({
      state: 'completed',
      processedThisBatch: 2,
      succeededCount: 3,
      hasMore: false,
    });
    await expect(
      store.rolloutBatch({ operationId: 'rollout-a', pluginId: 'plugin-a', batchSize: 25 })
    ).resolves.toMatchObject({
      state: 'completed',
      processedThisBatch: 0,
      succeededCount: 3,
      hasMore: false,
    });
    database
      .prepare(
        `UPDATE plugin_runner_dynamic_worker_manifests
            SET active_version_digest = ?, updated_at = 301
          WHERE plugin_id = 'plugin-a'`
      )
      .run(VERSION_A);
    await expect(
      store.rolloutBatch({ operationId: 'rollout-a', pluginId: 'plugin-a', batchSize: 25 })
    ).resolves.toMatchObject({
      state: 'completed',
      processedThisBatch: 0,
      targetVersionDigest: VERSION_B,
    });
    expect(
      database
        .prepare(
          `SELECT installation_id, COUNT(*) AS count
             FROM plugin_runner_dynamic_worker_rollout_results
            WHERE operation_id = 'rollout-a'
            GROUP BY installation_id ORDER BY installation_id`
        )
        .all()
    ).toEqual(
      installationIds
        .sort()
        .map((installationId) => ({ installation_id: installationId, count: 1 }))
    );
  });

  it('allows only one running platform rollout per plugin', () => {
    const insert = database.prepare(
      `INSERT INTO plugin_runner_dynamic_worker_rollouts (
         operation_id, plugin_id, target_version_digest, state, created_at, updated_at
       ) VALUES (?, 'plugin-a', ?, ?, 1, 1)`
    );

    insert.run('rollout-running-a', VERSION_A, 'running');
    expect(() => insert.run('rollout-running-b', VERSION_A, 'running')).toThrow(
      'plugin_dynamic_rollout_in_progress'
    );

    insert.run('rollout-blocked', VERSION_A, 'blocked');
    expect(() =>
      database
        .prepare(
          `UPDATE plugin_runner_dynamic_worker_rollouts
              SET state = 'running'
            WHERE operation_id = 'rollout-blocked'`
        )
        .run()
    ).toThrow('plugin_dynamic_rollout_in_progress');

    database
      .prepare(
        `UPDATE plugin_runner_dynamic_worker_rollouts
            SET state = 'completed'
          WHERE operation_id = 'rollout-running-a'`
      )
      .run();
    expect(() =>
      database
        .prepare(
          `UPDATE plugin_runner_dynamic_worker_rollouts
              SET state = 'running'
            WHERE operation_id = 'rollout-blocked'`
        )
        .run()
    ).not.toThrow();
  });

  it('records a credential-policy mismatch as a secret-free blocked tenant result', async () => {
    const store = new D1DynamicPluginInstallationStore(d1(database), 'test', () => 400);
    const installationId = await enableTenant(store, 'tenant-blocked');
    publish(database, RELEASE_B, 'api2.example.com');

    await expect(
      store.rolloutBatch({ operationId: 'rollout-blocked', pluginId: 'plugin-a', batchSize: 25 })
    ).resolves.toMatchObject({
      state: 'completed_with_errors',
      processedThisBatch: 1,
      succeededCount: 0,
      blockedCount: 1,
      failedCount: 0,
      hasMore: false,
    });
    expect(
      database
        .prepare(
          `SELECT installation_id, tenant_id, state, error_code
             FROM plugin_runner_dynamic_worker_rollout_results
            WHERE operation_id = 'rollout-blocked'`
        )
        .get()
    ).toEqual({
      installation_id: installationId,
      tenant_id: 'tenant-blocked',
      state: 'blocked',
      error_code: 'plugin_dynamic_rollout_credentials_required',
    });
  });

  it('blocks a running operation when the platform target changes between batches', async () => {
    const store = new D1DynamicPluginInstallationStore(d1(database), 'test', () => 500);
    await Promise.all(
      ['tenant-change-a', 'tenant-change-b'].map((tenantId) => enableTenant(store, tenantId))
    );
    publish(database, RELEASE_B);
    await store.rolloutBatch({
      operationId: 'rollout-target-change',
      pluginId: 'plugin-a',
      batchSize: 1,
    });
    database
      .prepare(
        `UPDATE plugin_runner_dynamic_worker_manifests
            SET active_version_digest = ?, updated_at = 501
          WHERE plugin_id = 'plugin-a'`
      )
      .run(VERSION_A);

    await expect(
      store.rolloutBatch({
        operationId: 'rollout-target-change',
        pluginId: 'plugin-a',
        batchSize: 1,
      })
    ).rejects.toThrow('plugin_dynamic_rollout_target_changed');
    expect(
      database
        .prepare(
          `SELECT state, last_error_code FROM plugin_runner_dynamic_worker_rollouts
            WHERE operation_id = 'rollout-target-change'`
        )
        .get()
    ).toEqual({
      state: 'blocked',
      last_error_code: 'plugin_dynamic_rollout_target_changed',
    });
  });

  it('adopts a committed tenant rollout after the D1 batch response is lost', async () => {
    const initial = new D1DynamicPluginInstallationStore(d1(database), 'test', () => 600);
    await enableTenant(initial, 'tenant-response-loss');
    publish(database, RELEASE_B);
    let loseNextBatchResponse = true;
    const store = new D1DynamicPluginInstallationStore(
      d1(database, () => {
        if (!loseNextBatchResponse) return;
        loseNextBatchResponse = false;
        throw new Error('d1_response_lost');
      }),
      'test',
      () => 601
    );

    await expect(
      store.rolloutBatch({
        operationId: 'rollout-response-loss',
        pluginId: 'plugin-a',
        batchSize: 1,
      })
    ).resolves.toMatchObject({
      state: 'completed',
      processedThisBatch: 1,
      succeededCount: 1,
      failedCount: 0,
      targetVersionDigest: VERSION_B,
    });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM plugin_runner_dynamic_worker_rollout_results
            WHERE operation_id = 'rollout-response-loss'`
        )
        .get()
    ).toEqual({ count: 1 });
  });

  it('returns a bounded secret-free platform-approved catalog projection', async () => {
    const store = new D1DynamicPluginInstallationStore(d1(database), 'test', () => 100);
    await expect(store.listApproved()).resolves.toEqual([
      {
        pluginId: 'plugin-a',
        capabilityManifestDigest: 'd'.repeat(64),
        activeVersionDigest: VERSION_A,
        visibility: 'tenant',
        capabilities: ['flow.evaluate'],
        credentials: [{ configKey: 'apiKey', required: true }],
        resources: [],
        updatedAt: 1,
      },
    ]);
    expect(JSON.stringify(await store.listApproved())).not.toContain('destinationHost');
  });

  it('fails closed when required credentials are absent or do not match the manifest slot', async () => {
    const store = new D1DynamicPluginInstallationStore(d1(database), 'test', () => 100);
    await expect(
      store.configure({ tenantId: 'tenant-b', pluginId: 'plugin-a', enabled: true })
    ).rejects.toThrow('plugin_dynamic_installation_credentials_missing');

    const disabled = await store.configure({
      tenantId: 'tenant-b',
      pluginId: 'plugin-a',
      enabled: false,
    });
    const config = new D1PluginConfigStore(
      d1(database),
      'dynamic-worker-installation-encryption-secret',
      'dynamic-worker-installation-mutation-hmac-secret'
    );
    await expect(
      config.replaceCredentials({
        operationId: 'credential-operation-b',
        tenantId: 'tenant-b',
        installationId: disabled.installationId,
        expectedConfigVersion: 1,
        credentials: [
          {
            configKey: 'apiKey',
            destinationHost: 'api.example.com',
            injectionKind: 'header',
            injectionName: 'X-Provider-Key',
            value: 'secret-value',
          },
        ],
      })
    ).rejects.toThrow('plugin_config_credential_slot_mismatch');
  });

  it('blocks runtime resolution after platform manifest or pinned release revocation', async () => {
    database.exec(
      `UPDATE plugin_runner_dynamic_worker_credential_slots SET required = 0
        WHERE plugin_id = 'plugin-a'`
    );
    const store = new D1DynamicPluginInstallationStore(d1(database), 'test', () => 100);
    const enabled = await store.configure({
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      enabled: true,
    });
    const resolver = new D1PluginInstallationResolver(d1(database));
    await expect(
      resolver.resolve({
        tenantId: 'tenant-a',
        pluginInstallationId: enabled.installationId,
        capability: 'flow.evaluate',
      })
    ).resolves.toMatchObject({ codeSha256: RELEASE_A });

    database.exec(
      `UPDATE plugin_runner_dynamic_worker_manifests SET state = 'revoked'
        WHERE plugin_id = 'plugin-a'`
    );
    await expect(
      resolver.resolve({
        tenantId: 'tenant-a',
        pluginInstallationId: enabled.installationId,
        capability: 'flow.evaluate',
      })
    ).resolves.toBeNull();
    database.exec(
      `UPDATE plugin_runner_dynamic_worker_manifests SET state = 'active'
        WHERE plugin_id = 'plugin-a';
       UPDATE plugin_runner_dynamic_worker_releases SET state = 'revoked'
        WHERE plugin_id = 'plugin-a' AND code_sha256 = '${RELEASE_A}'`
    );
    await expect(
      resolver.resolve({
        tenantId: 'tenant-a',
        pluginInstallationId: enabled.installationId,
        capability: 'flow.evaluate',
      })
    ).resolves.toBeNull();
  });

  it('derives distinct installation identities across tenant boundaries', async () => {
    await expect(
      Promise.all([
        derivePluginInstallationId({
          environmentId: 'test',
          tenantId: 'tenant-a',
          pluginId: 'plugin-a',
          purpose: 'dynamic-plugin',
        }),
        derivePluginInstallationId({
          environmentId: 'test',
          tenantId: 'tenant-b',
          pluginId: 'plugin-a',
          purpose: 'dynamic-plugin',
        }),
      ])
    ).resolves.toSatisfy(([left, right]) => left !== right);
  });
});
