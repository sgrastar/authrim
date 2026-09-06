import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { derivePluginInstallationId } from '@authrim/ar-lib-core';
import { D1PluginInstallationResolver } from '../installations';
import {
  PluginD1ResourceAccess,
  PluginKvResourceAccess,
  PluginR2ResourceAccess,
  PluginResourceControlService,
  type PluginResourceBindingDescriptor,
  type PluginResourceBindingProps,
} from '../resource-bindings';
import type { PluginRunnerEnv } from '../types';

type SqlValue = string | number | null | Uint8Array;

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const VERSION_DIGEST = '1'.repeat(64);
const CODE_SHA256 = '2'.repeat(64);
const FINGERPRINT_D1 = 'a'.repeat(64);
const FINGERPRINT_KV = 'b'.repeat(64);
const FINGERPRINT_R2 = 'c'.repeat(64);
const HOST_D1 = `PRES_D1_${'A'.repeat(24)}`;
const HOST_KV = `PRES_KV_${'B'.repeat(24)}`;
const HOST_R2 = `PRES_R2_${'C'.repeat(24)}`;
const POLICY = {
  hostInterfaces: [],
  resources: [
    { logicalResourceId: 'state', binding: 'PLUGIN_STATE', kind: 'd1', access: 'read_write' },
    {
      logicalResourceId: 'cache',
      binding: 'PLUGIN_CACHE',
      kind: 'kv_namespace',
      access: 'read_only',
    },
    {
      logicalResourceId: 'objects',
      binding: 'PLUGIN_OBJECTS',
      kind: 'r2_bucket',
      access: 'read_write',
    },
  ],
};

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[]
  ) {}

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ success: true; results: T[]; meta: { changes: number } }> {
    return {
      success: true,
      results: this.statement.all(...this.values) as T[],
      meta: { changes: 0 },
    };
  }

  async run() {
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class Session {
  constructor(private readonly database: DatabaseSync) {}

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
      first: <T>() => new BoundStatement(statement, []).first<T>(),
    };
  }

  async batch(statements: BoundStatement[]) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function d1(database: DatabaseSync): D1Database {
  const session = new Session(database);
  return {
    prepare: (sql: string) => session.prepare(sql),
    withSession: () => session,
  } as unknown as D1Database;
}

function access<T>(
  Entrypoint: new (...args: never[]) => T,
  env: PluginRunnerEnv,
  props: PluginResourceBindingProps
): T {
  const Constructor = Entrypoint as unknown as new (context: unknown, env: PluginRunnerEnv) => T;
  return new Constructor({ props }, env);
}

describe('Plugin Dynamic Worker resource bindings', () => {
  let runner: DatabaseSync;
  let resource: DatabaseSync;
  let installationId: string;
  let env: PluginRunnerEnv;
  let kvValues: Map<string, string>;
  let r2Values: Map<string, Uint8Array>;

  beforeEach(async () => {
    runner = new DatabaseSync(':memory:');
    resource = new DatabaseSync(':memory:');
    runner.exec('PRAGMA foreign_keys = ON');
    for (const migration of ['001_0_4_0_plugin_runner_baseline.sql']) {
      runner.exec(
        readFileSync(resolve(REPO_ROOT, 'migrations/plugin-runner/d1', migration), 'utf8')
      );
    }
    resource.exec('CREATE TABLE plugin_state (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    installationId = await derivePluginInstallationId({
      environmentId: 'test',
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      purpose: 'dynamic-plugin',
    });
    runner
      .prepare(
        `INSERT INTO plugin_runner_dynamic_worker_releases (
           plugin_id, version_digest, code_sha256, code_object_key, source_manifest_hash,
           capability_manifest_digest, policy_json, state, published_at, updated_at
         ) VALUES ('plugin-a', ?, ?, ?, ?, ?, ?, 'published', 1, 1)`
      )
      .run(
        VERSION_DIGEST,
        CODE_SHA256,
        `plugins/plugin-a/${CODE_SHA256}.json`,
        '3'.repeat(64),
        '4'.repeat(64),
        JSON.stringify(POLICY)
      );
    runner
      .prepare(
        `INSERT INTO plugin_runner_dynamic_worker_manifests (
           plugin_id, active_version_digest, state, updated_at
         ) VALUES ('plugin-a', ?, 'active', 1)`
      )
      .run(VERSION_DIGEST);

    kvValues = new Map();
    r2Values = new Map();
    const kv = {
      get: async (key: string) => kvValues.get(key) ?? null,
      put: async (key: string, value: string) => void kvValues.set(key, value),
      delete: async (key: string) => void kvValues.delete(key),
      list: async () => ({
        keys: [...kvValues.keys()].map((name) => ({ name })),
        list_complete: true,
        cacheStatus: null,
      }),
    };
    const r2 = {
      head: async (key: string) => {
        const value = r2Values.get(key);
        return value
          ? { key, size: value.byteLength, etag: `etag-${key}`, uploaded: new Date(0) }
          : null;
      },
      get: async (key: string) => {
        const value = r2Values.get(key);
        return value
          ? {
              key,
              size: value.byteLength,
              etag: `etag-${key}`,
              uploaded: new Date(0),
              body: { cancel: async () => undefined },
              arrayBuffer: async () => value.slice().buffer,
            }
          : null;
      },
      put: async (key: string, value: string | Uint8Array) => {
        r2Values.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : value);
        return { key, etag: `etag-${key}` };
      },
      delete: async (key: string) => void r2Values.delete(key),
      list: async () => ({
        objects: [...r2Values.entries()].map(([key, value]) => ({
          key,
          size: value.byteLength,
          etag: `etag-${key}`,
          uploaded: new Date(0),
        })),
        truncated: false,
      }),
    };
    env = {
      PLUGIN_RUNNER_DB: d1(runner),
      TENANT_RUNTIME_REGISTRY: {} as KVNamespace,
      TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: '{}',
      PLUGIN_ENCRYPTION_KEY: 'test-encryption-key',
      PLUGIN_MUTATION_HMAC_KEY: 'test-mutation-key',
      NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_A: '{}',
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      AUTHRIM_WORKER_SCRIPT_NAME: 'test-ar-plugin-runner',
      CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS: '{}',
      CONTROL_SMOKE_VERSION: {
        id: 'version-1',
        tag: 'test',
        timestamp: '2026-08-01T00:00:00.000Z',
      },
      [HOST_D1]: d1(resource),
      [HOST_KV]: kv,
      [HOST_R2]: r2,
    };
  });

  function descriptors(): PluginResourceBindingDescriptor[] {
    return [
      {
        logicalResourceId: 'state',
        binding: 'PLUGIN_STATE',
        hostBindingRef: HOST_D1,
        kind: 'd1',
        access: 'read_write',
        ownershipFingerprint: FINGERPRINT_D1,
      },
      {
        logicalResourceId: 'cache',
        binding: 'PLUGIN_CACHE',
        hostBindingRef: HOST_KV,
        kind: 'kv_namespace',
        access: 'read_only',
        ownershipFingerprint: FINGERPRINT_KV,
      },
      {
        logicalResourceId: 'objects',
        binding: 'PLUGIN_OBJECTS',
        hostBindingRef: HOST_R2,
        kind: 'r2_bucket',
        access: 'read_write',
        ownershipFingerprint: FINGERPRINT_R2,
      },
    ];
  }

  function props(resource: PluginResourceBindingDescriptor): PluginResourceBindingProps {
    return {
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      installationId,
      ...resource,
    };
  }

  async function reflect(resources = descriptors(), operationId = 'operation-a') {
    return new PluginResourceControlService(
      env,
      {
        caller: 'ar-control',
        audience: 'authrim-runtime-smoke-v1',
        environmentId: 'test',
        targetWorker: 'test-ar-plugin-runner',
      },
      () => 100
    ).reflectAndSmoke({
      operationId,
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      installationId,
      expectedVersionId: 'version-1',
      resources,
    });
  }

  it('reflects and exposes only the exact D1, KV, and R2 resource map', async () => {
    await expect(reflect()).resolves.toEqual({
      operationId: 'operation-a',
      installationId,
      observedVersionId: 'version-1',
      resourceCount: 3,
    });
    const [d1Resource, kvResource, r2Resource] = descriptors();
    const d1Access = access(PluginD1ResourceAccess, env, props(d1Resource));
    await expect(
      d1Access.run('INSERT INTO plugin_state (id, value) VALUES (?, ?)', ['a', 'value-a'])
    ).resolves.toEqual({ changes: 1 });
    await expect(
      d1Access.all('SELECT id, value FROM plugin_state WHERE id = ?', ['a'])
    ).resolves.toEqual({ results: [{ id: 'a', value: 'value-a' }] });

    const kvAccess = access(PluginKvResourceAccess, env, props(kvResource));
    kvValues.set('cached', 'value');
    await expect(kvAccess.get('cached')).resolves.toBe('value');
    await expect(kvAccess.put('cached', 'changed')).rejects.toThrow(
      'plugin_dynamic_resource_write_denied'
    );

    const r2Access = access(PluginR2ResourceAccess, env, props(r2Resource));
    await expect(r2Access.put('object-a', 'payload')).resolves.toEqual({ etag: 'etag-object-a' });
    await expect(r2Access.get('object-a')).resolves.toEqual(new TextEncoder().encode('payload'));
  });

  it('fails closed for cross-tenant, stale, wrong-kind, and unsafe SQL access', async () => {
    await reflect();
    const d1Resource = descriptors()[0];
    const crossTenant = access(PluginD1ResourceAccess, env, {
      ...props(d1Resource),
      tenantId: 'tenant-b',
    });
    await expect(crossTenant.all('SELECT 1')).rejects.toThrow(
      'plugin_dynamic_resource_scope_denied'
    );

    const valid = access(PluginD1ResourceAccess, env, props(d1Resource));
    await expect(valid.all('PRAGMA table_list')).rejects.toThrow(
      'plugin_dynamic_resource_sql_denied'
    );
    await expect(valid.run('DROP TABLE plugin_state')).rejects.toThrow(
      'plugin_dynamic_resource_sql_denied'
    );
    runner
      .prepare(
        `UPDATE plugin_runner_dynamic_worker_resources
            SET state = 'disabled', updated_at = 101
          WHERE installation_id = ? AND logical_resource_id = 'state'`
      )
      .run(installationId);
    await expect(valid.all('SELECT 1')).rejects.toThrow('plugin_dynamic_resource_scope_denied');

    await expect(
      reflect([
        {
          ...d1Resource,
          kind: 'kv_namespace',
        },
      ])
    ).rejects.toThrow('plugin_dynamic_resource_input_invalid');
  });

  it('re-owns only a disabled exact resource map for a later provisioning operation', async () => {
    await reflect();
    runner
      .prepare(
        `UPDATE plugin_runner_dynamic_worker_resources
            SET state = 'disabled', updated_at = 101
          WHERE installation_id = ?`
      )
      .run(installationId);

    await expect(reflect(descriptors(), 'operation-b')).resolves.toMatchObject({
      operationId: 'operation-b',
      resourceCount: 3,
    });
    expect(
      runner
        .prepare(
          `SELECT DISTINCT control_operation_id, state
             FROM plugin_runner_dynamic_worker_resources WHERE installation_id = ?`
        )
        .all(installationId)
    ).toEqual([{ control_operation_id: 'operation-b', state: 'active' }]);

    await expect(reflect(descriptors(), 'operation-c')).rejects.toThrow(
      'plugin_dynamic_resource_reflection_conflict'
    );
  });

  it('resolves an enabled installation only when its active map matches the manifest', async () => {
    await reflect();
    runner
      .prepare(
        `INSERT INTO plugin_runner_installations (
           installation_id, tenant_id, plugin_id, backend_kind, script_name,
           state, config_version, platform_concurrency_cap, platform_rate_per_minute,
           created_at, updated_at
         ) VALUES (?, 'tenant-a', 'plugin-a', 'dynamic_worker', 'plugin-a',
                   'enabled', 1, 2, 30, 1, 1)`
      )
      .run(installationId);
    runner
      .prepare(
        `INSERT INTO plugin_runner_dynamic_worker_artifacts (
           artifact_id, installation_id, plugin_id, version_digest,
           state, activated_at, updated_at
         ) VALUES ('artifact-a', ?, 'plugin-a', ?, 'active', 1, 1)`
      )
      .run(installationId, VERSION_DIGEST);
    runner
      .prepare(
        `INSERT INTO plugin_runner_dynamic_worker_hook_policies (
           plugin_id, version_digest, capability, timeout_ms, failure_policy, max_attempts,
           async_retry_budget_seconds, circuit_breaker_threshold,
           circuit_breaker_cooldown_seconds, updated_at
         ) VALUES ('plugin-a', ?, 'flow.evaluate', 1000, 'fail_closed', 1, 60, 5, 60, 1)`
      )
      .run(VERSION_DIGEST);

    const resolver = new D1PluginInstallationResolver(env.PLUGIN_RUNNER_DB);
    await expect(
      resolver.resolve({
        tenantId: 'tenant-a',
        pluginInstallationId: installationId,
        capability: 'flow.evaluate',
      })
    ).resolves.toMatchObject({
      pluginId: 'plugin-a',
      resources: [
        { logicalResourceId: 'cache', binding: 'PLUGIN_CACHE', kind: 'kv_namespace' },
        { logicalResourceId: 'objects', binding: 'PLUGIN_OBJECTS', kind: 'r2_bucket' },
        { logicalResourceId: 'state', binding: 'PLUGIN_STATE', kind: 'd1' },
      ],
    });

    runner
      .prepare(
        `UPDATE plugin_runner_dynamic_worker_resources
            SET state = 'disabled', updated_at = 102
          WHERE installation_id = ? AND logical_resource_id = 'cache'`
      )
      .run(installationId);
    await expect(
      resolver.resolve({
        tenantId: 'tenant-a',
        pluginInstallationId: installationId,
        capability: 'flow.evaluate',
      })
    ).rejects.toThrow('plugin_installation_resource_invalid');
  });
});
