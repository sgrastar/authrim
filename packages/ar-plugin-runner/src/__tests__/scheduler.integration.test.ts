import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { exportJWK, generateKeyPair } from 'jose';
import { createNotificationDeliveryIntent } from '@authrim/ar-lib-core';
import {
  buildPluginRunnerRegistryGenerationKey,
  buildPluginRunnerRegistrySnapshotKey,
  signPluginRunnerRegistry,
} from '@authrim/ar-lib-core/control-plane';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginRunnerScheduler } from '../scheduler';
import { ImmediateNotificationDeliveryService } from '../notification-delivery-service';
import type { PluginRunnerEnv } from '../types';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[] = []
  ) {}

  bind(...values: unknown[]) {
    return new BoundStatement(
      this.statement,
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
    );
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async all<T>() {
    return {
      success: true,
      results: this.statement.all(...this.values) as T[],
      meta: {},
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
    return new BoundStatement(this.database.prepare(sql));
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
    batch: (statements: BoundStatement[]) => session.batch(statements),
  } as unknown as D1Database;
}

function pluginOutboxSchema(): string {
  const migration = readFileSync(
    resolve(REPO_ROOT, 'migrations/032_tenant_directory_and_plugin_outboxes.sql'),
    'utf8'
  );
  const start = migration.indexOf('CREATE TABLE IF NOT EXISTS plugin_hook_outbox');
  const end = migration.indexOf('CREATE TABLE IF NOT EXISTS identifier_change_notification_outbox');
  if (start < 0 || end <= start) throw new Error('plugin_outbox_test_schema_missing');
  return migration.slice(start, end);
}

async function dynamicWorkerFixture(database: DatabaseSync) {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      pluginId: 'plugin-a',
      compatibilityDate: '2026-07-31',
      compatibilityFlags: [],
      mainModule: 'index.js',
      modules: {
        'index.js': 'export default { fetch() { return new Response(null, { status: 204 }); } };',
      },
    })
  );
  const codeSha256 = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('');
  const codeObjectKey = `plugins/plugin-a/${codeSha256}.json`;
  const versionDigest = 'c'.repeat(64);
  database
    .prepare(
      `INSERT INTO plugin_runner_dynamic_worker_releases (
         plugin_id, version_digest, code_sha256, code_object_key, source_manifest_hash,
         capability_manifest_digest, policy_json, state, published_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, '{"hostInterfaces":[],"resources":[]}', 'published', 1, 1)`
    )
    .run('plugin-a', versionDigest, codeSha256, codeObjectKey, 'a'.repeat(64), 'b'.repeat(64));
  database
    .prepare(
      `INSERT INTO plugin_runner_dynamic_worker_manifests (
         plugin_id, active_version_digest, state, updated_at
       ) VALUES ('plugin-a', ?, 'active', 1)`
    )
    .run(versionDigest);
  database
    .prepare(
      `INSERT INTO plugin_runner_dynamic_worker_hook_policies (
         plugin_id, version_digest, capability, timeout_ms, failure_policy, max_attempts,
         async_retry_budget_seconds, circuit_breaker_threshold,
         circuit_breaker_cooldown_seconds, updated_at
       ) VALUES ('plugin-a', ?, 'notifier.send', 1000, 'retry_async', 5, 86400, 3, 60, 1)`
    )
    .run(versionDigest);
  database
    .prepare(
      `INSERT INTO plugin_runner_dynamic_worker_artifacts (
         artifact_id, installation_id, plugin_id, version_digest,
         state, activated_at, updated_at
       ) VALUES (?, ?, ?, ?, 'active', 1, 1)`
    )
    .run(`artifact-${codeSha256.slice(0, 16)}`, 'installation-a', 'plugin-a', versionDigest);
  return {
    codeObjectKey,
    codeSha256,
    bucket: {
      get: vi.fn(async (key: string) =>
        key === codeObjectKey
          ? {
              size: bytes.byteLength,
              arrayBuffer: async () => bytes.slice().buffer,
            }
          : null
      ),
    },
  };
}

describe('PluginRunnerScheduler integration', () => {
  let runnerDatabase: DatabaseSync;
  let tenantDatabase: DatabaseSync;

  beforeEach(() => {
    runnerDatabase = new DatabaseSync(':memory:');
    tenantDatabase = new DatabaseSync(':memory:');
    runnerDatabase.exec('PRAGMA foreign_keys = ON');
    for (const migration of [
      '001_plugin_runner.sql',
      '002_registry_installations_and_config.sql',
      '003_sync_circuit_breaker_probe.sql',
      '006_dynamic_worker_loader_artifacts.sql',
      '007_replace_dynamic_rollout_partial_index.sql',
      '008_dynamic_worker_resource_bindings.sql',
    ]) {
      runnerDatabase.exec(
        readFileSync(resolve(REPO_ROOT, 'migrations/plugin-runner', migration), 'utf8')
      );
    }
    tenantDatabase.exec(pluginOutboxSchema());
    tenantDatabase.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/035_notification_delivery_intents.sql'), 'utf8')
    );
    runnerDatabase.exec(
      `INSERT INTO plugin_runner_installations (
         installation_id, tenant_id, plugin_id, backend_kind, script_name,
         state, config_version, platform_concurrency_cap, platform_rate_per_minute,
         created_at, updated_at
       ) VALUES (
         'installation-a', 'tenant-a', 'plugin-a', 'dynamic_worker', 'plugin-a',
         'enabled', 1, 2, 30, 1, 1
       );
       ;`
    );
    tenantDatabase.exec(
      `INSERT INTO plugin_hook_outbox (
         outbox_id, tenant_id, plugin_installation_id, capability, event_type,
         event_version, idempotency_key, payload_json, payload_class,
         status, attempt_no, created_at, updated_at
       ) VALUES (
         'outbox-due', 'tenant-a', 'installation-a', 'notifier.send', 'account.created',
         1, 'account/a#created',
         '{"tenantId":"tenant-a","accountId":"account-a","eventType":"account.created","eventVersion":1}',
         'reference_v1', 'queued', 0, 699000, 699000
       );
       INSERT INTO plugin_hook_outbox (
         outbox_id, tenant_id, plugin_installation_id, capability, event_type,
         event_version, idempotency_key, payload_json, payload_class,
         status, attempt_no, created_at, updated_at
       ) VALUES (
         'outbox-expired', 'tenant-a', 'installation-a', 'notifier.send', 'account.created',
         1, 'account/old#created',
         '{"tenantId":"tenant-a","accountId":"account-old","eventType":"account.created","eventVersion":1}',
         'reference_v1', 'queued', 0, 50, 50
       );
       UPDATE plugin_hook_outbox
          SET status = 'locked', attempt_no = 1, claim_owner = 'fixture',
              claim_token = 'fixture-claim', lease_until = 91, updated_at = 90
        WHERE outbox_id = 'outbox-expired';
       UPDATE plugin_hook_outbox
          SET status = 'succeeded', claim_owner = NULL, claim_token = NULL,
              lease_until = NULL, succeeded_at = 100, delete_after = 604900,
              updated_at = 100
       WHERE outbox_id = 'outbox-expired';`
    );
    tenantDatabase.exec(
      `INSERT INTO notification_delivery_intents (
         intent_id, tenant_id, plugin_installation_id, provider_order_version,
         provider_installation_ids_json, active_provider_index, provider_started_at,
         channel, notification_kind,
         payload_version, payload_key_id, payload_envelope_json, idempotency_key,
         request_fingerprint, fingerprint_key_id, state, expires_at, delete_after,
         created_at, updated_at
       ) VALUES (
         'intent-expired', 'tenant-a', 'installation-a', 1,
         '["installation-a"]', 0, 699000, 'email', 'auth.email_otp',
         1, 'notification-key-a', '{}', 'notification/expired',
         '${'a'.repeat(64)}', 'notification-hmac-a', 'pending', 699999, 699999,
         699000, 699000
       );
       INSERT INTO notification_delivery_intents (
         intent_id, tenant_id, plugin_installation_id, provider_order_version,
         provider_installation_ids_json, active_provider_index, provider_started_at,
         channel, notification_kind,
         payload_version, payload_key_id, payload_envelope_json, idempotency_key,
         request_fingerprint, fingerprint_key_id, state, expires_at, delete_after,
         created_at, updated_at
       ) VALUES (
         'intent-future', 'tenant-a', 'installation-a', 1,
         '["installation-a"]', 0, 699000, 'email', 'auth.email_otp',
         1, 'notification-key-a', '{}', 'notification/future',
         '${'b'.repeat(64)}', 'notification-hmac-a', 'pending', 700100, 700100,
         699000, 699000
       );`
    );
  });

  afterEach(() => {
    runnerDatabase.close();
    tenantDatabase.close();
  });

  it('loads only the signed registry, resumes the shard, dispatches, and runs retention', async () => {
    const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const privateJwk = {
      ...(await exportJWK(pair.privateKey)),
      kid: 'runner-key-a',
      alg: 'EdDSA',
    };
    const publicJwk = {
      ...(await exportJWK(pair.publicKey)),
      kid: 'runner-key-a',
      alg: 'EdDSA',
    };
    const notificationPair = await crypto.subtle.generateKey(
      {
        name: 'RSA-OAEP',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['encrypt', 'decrypt']
    );
    if (!('privateKey' in notificationPair)) {
      throw new Error('notification_test_key_generation_failed');
    }
    const notificationPrivateJwk = {
      ...(await crypto.subtle.exportKey('jwk', notificationPair.privateKey)),
      kid: 'notification-key-a',
      use: 'enc',
      alg: 'RSA-OAEP-256',
      key_ops: ['decrypt'],
    };
    const token = await signPluginRunnerRegistry({
      privateJwk,
      registry: {
        environmentId: 'test',
        generation: 1,
        issuedAt: 699_000,
        expiresAt: 701_000,
        shards: [
          {
            shardId: 'shard-a',
            bindingRef: 'TEST_TDB_DEFAULT_JP_0001_CORE',
            dataRole: 'tenant_core/default',
            residencyPartition: 'jp',
            routeGeneration: 1,
          },
        ],
      },
    });
    const registry = new Map([
      [buildPluginRunnerRegistrySnapshotKey('test'), token],
      [buildPluginRunnerRegistryGenerationKey('test'), '1'],
    ]);
    const artifact = await dynamicWorkerFixture(runnerDatabase);
    const pluginFetch = vi.fn(async () => new Response(null, { status: 204 }));
    const codeLoads: Promise<unknown>[] = [];
    const loaderGet = vi.fn((_workerId: string, load: () => Promise<unknown>) => {
      codeLoads.push(load());
      return { getEntrypoint: () => ({ fetch: pluginFetch }) };
    });
    const outbound = vi.fn(() => ({ fetch: vi.fn() }));
    const env = {
      PLUGIN_RUNNER_DB: d1(runnerDatabase),
      TENANT_RUNTIME_REGISTRY: { get: async (key: string) => registry.get(key) ?? null },
      TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
      PLUGIN_LOADER: { get: loaderGet },
      PLUGIN_BUNDLES: artifact.bucket,
      PLUGIN_ENCRYPTION_KEY: 'scheduler-test-plugin-encryption-key',
      NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_A: JSON.stringify(notificationPrivateJwk),
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      TEST_TDB_DEFAULT_JP_0001_CORE: d1(tenantDatabase),
    } as unknown as PluginRunnerEnv;

    await new PluginRunnerScheduler(env, () => 700_000, outbound as never).run();
    await Promise.all(codeLoads);

    expect(loaderGet).toHaveBeenCalledTimes(1);
    expect(pluginFetch).toHaveBeenCalledTimes(1);
    expect(loaderGet.mock.calls[0]?.[0]).toMatch(/^[a-f0-9]{64}$/u);
    expect(outbound).toHaveBeenCalledWith({
      contractVersion: 1,
      tenantId: 'tenant-a',
      pluginInstallationId: 'installation-a',
      capability: 'notifier.send',
      requestId: `scope:${loaderGet.mock.calls[0]?.[0]}`,
      executionScope: {
        accountId: 'account-a',
        bindingRef: 'TEST_TDB_DEFAULT_JP_0001_CORE',
        dataRole: 'tenant_core/default',
        residencyPartition: 'jp',
      },
    });
    expect(artifact.bucket.get).toHaveBeenCalledWith(artifact.codeObjectKey);
    expect(
      tenantDatabase
        .prepare(`SELECT status, attempt_no FROM plugin_hook_outbox WHERE outbox_id = 'outbox-due'`)
        .get()
    ).toEqual({ status: 'succeeded', attempt_no: 1 });
    expect(
      tenantDatabase
        .prepare(
          `SELECT COUNT(*) AS count FROM plugin_hook_outbox WHERE outbox_id = 'outbox-expired'`
        )
        .get()
    ).toEqual({ count: 0 });
    expect(
      tenantDatabase
        .prepare(
          `SELECT COUNT(*) AS count FROM notification_delivery_intents
            WHERE intent_id = 'intent-future'`
        )
        .get()
    ).toEqual({ count: 1 });
    expect(
      tenantDatabase
        .prepare(
          `SELECT COUNT(*) AS count FROM notification_delivery_intents
            WHERE intent_id = 'intent-expired'`
        )
        .get()
    ).toEqual({ count: 0 });
    expect(
      runnerDatabase
        .prepare(
          `SELECT next_due_at, last_scan_at, scheduler_error_code
             FROM plugin_runner_shard_cursors WHERE tenant_shard_id = 'shard-a'`
        )
        .get()
    ).toEqual({ next_due_at: 700100, last_scan_at: 700000, scheduler_error_code: null });
    expect(
      runnerDatabase
        .prepare(
          `SELECT used_count FROM plugin_runner_rate_limit_buckets
            WHERE installation_id = 'installation-a' AND tenant_id = 'tenant-a'
              AND capability = 'notifier.send' AND destination_host = ''`
        )
        .get()
    ).toEqual({ used_count: 1 });
    expect(
      runnerDatabase.prepare(`SELECT COUNT(*) AS count FROM plugin_runner_dispatch_leases`).get()
    ).toEqual({ count: 0 });
  });

  it('delivers an exact encrypted notification reference immediately through the signed shard', async () => {
    const registryPair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const registryPrivateJwk = {
      ...(await exportJWK(registryPair.privateKey)),
      kid: 'runner-key-a',
      alg: 'EdDSA',
    };
    const registryPublicJwk = {
      ...(await exportJWK(registryPair.publicKey)),
      kid: 'runner-key-a',
      alg: 'EdDSA',
    };
    const notificationPair = await crypto.subtle.generateKey(
      {
        name: 'RSA-OAEP',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['encrypt', 'decrypt']
    );
    if (!('privateKey' in notificationPair)) {
      throw new Error('notification_test_key_generation_failed');
    }
    const notificationPublicJwk = {
      ...(await crypto.subtle.exportKey('jwk', notificationPair.publicKey)),
      kid: 'notification-key-a',
      use: 'enc',
      alg: 'RSA-OAEP-256',
      key_ops: ['encrypt'],
    };
    const notificationPrivateJwk = {
      ...(await crypto.subtle.exportKey('jwk', notificationPair.privateKey)),
      kid: 'notification-key-a',
      use: 'enc',
      alg: 'RSA-OAEP-256',
      key_ops: ['decrypt'],
    };
    await createNotificationDeliveryIntent({
      db: d1(tenantDatabase),
      environmentId: 'test',
      publicJwks: JSON.stringify({ keys: [notificationPublicJwk] }),
      activeKeyId: 'notification-key-a',
      idempotencyHmacKey: 'notification-test-hmac-key-at-least-32-bytes',
      tenantId: 'tenant-a',
      intentId: 'intent-immediate',
      outboxId: 'outbox-immediate',
      providerOrder: { configVersion: 1, installationIds: ['installation-a'] },
      notificationKind: 'auth.email_otp',
      idempotencyKey: 'challenge-a/email',
      expiresAt: 700_100,
      payload: {
        channel: 'email',
        to: 'person@example.test',
        subject: 'Sign-in code',
        body: '<p>Code: 123456</p>',
      },
      now: 699_999,
    });
    const token = await signPluginRunnerRegistry({
      privateJwk: registryPrivateJwk,
      registry: {
        environmentId: 'test',
        generation: 1,
        issuedAt: 699_000,
        expiresAt: 701_000,
        shards: [
          {
            shardId: 'shard-a',
            bindingRef: 'TEST_TDB_DEFAULT_JP_0001_CORE',
            dataRole: 'tenant_core/default',
            residencyPartition: 'jp',
            routeGeneration: 1,
          },
        ],
      },
    });
    const registry = new Map([
      [buildPluginRunnerRegistrySnapshotKey('test'), token],
      [buildPluginRunnerRegistryGenerationKey('test'), '1'],
    ]);
    const artifact = await dynamicWorkerFixture(runnerDatabase);
    let receivedContract: string | null = null;
    let receivedPayload: unknown;
    const pluginFetch = vi.fn(
      async (request: string | URL | Request, init?: ConstructorParameters<typeof Request>[1]) => {
        const resolved = request instanceof Request ? request : new Request(request, init);
        receivedContract = resolved.headers.get('X-Authrim-Plugin-Contract');
        receivedPayload = await resolved.json();
        return new Response(null, { status: 204 });
      }
    );
    const codeLoads: Promise<unknown>[] = [];
    const loaderGet = vi.fn((_workerId: string, load: () => Promise<unknown>) => {
      codeLoads.push(load());
      return { getEntrypoint: () => ({ fetch: pluginFetch }) };
    });
    const outbound = vi.fn(() => ({ fetch: vi.fn() }));
    const env = {
      PLUGIN_RUNNER_DB: d1(runnerDatabase),
      TENANT_RUNTIME_REGISTRY: { get: async (key: string) => registry.get(key) ?? null },
      TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({
        keys: [registryPublicJwk],
      }),
      PLUGIN_LOADER: { get: loaderGet },
      PLUGIN_BUNDLES: artifact.bucket,
      PLUGIN_ENCRYPTION_KEY: 'scheduler-test-plugin-encryption-key',
      NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_A: JSON.stringify(notificationPrivateJwk),
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      TEST_TDB_DEFAULT_JP_0001_CORE: d1(tenantDatabase),
    } as unknown as PluginRunnerEnv;

    const deliveryResult = await new ImmediateNotificationDeliveryService(
      env,
      () => 700_000,
      outbound as never
    ).deliver({
      tenantId: 'tenant-a',
      intentId: 'intent-immediate',
      outboxId: 'outbox-immediate',
      pluginInstallationId: 'installation-a',
      bindingRef: 'TEST_TDB_DEFAULT_JP_0001_CORE',
    });
    await Promise.all(codeLoads);
    expect({
      deliveryResult,
      calls: pluginFetch.mock.calls.length,
      outbox: tenantDatabase
        .prepare(
          `SELECT status, attempt_no, last_error_code FROM plugin_hook_outbox WHERE outbox_id = 'outbox-immediate'`
        )
        .get(),
      intent: tenantDatabase
        .prepare(
          `SELECT state FROM notification_delivery_intents WHERE intent_id = 'intent-immediate'`
        )
        .get(),
    }).toEqual({
      deliveryResult: 'delivered',
      calls: 1,
      outbox: { status: 'succeeded', attempt_no: 1, last_error_code: null },
      intent: { state: 'delivered' },
    });
    expect(pluginFetch).toHaveBeenCalledTimes(1);
    expect(loaderGet).toHaveBeenCalledTimes(1);
    expect(artifact.bucket.get).toHaveBeenCalledWith(artifact.codeObjectKey);
    expect(receivedContract).toBe('notification-delivery-v1');
    expect(receivedPayload).toMatchObject({
      tenantId: 'tenant-a',
      pluginInstallationId: 'installation-a',
      payload: {
        tenantId: 'tenant-a',
        intentId: 'intent-immediate',
        notificationKind: 'auth.email_otp',
        delivery: {
          channel: 'email',
          to: 'person@example.test',
          subject: 'Sign-in code',
          body: '<p>Code: 123456</p>',
        },
      },
    });
    expect(
      tenantDatabase
        .prepare(
          `SELECT state, payload_key_id, payload_envelope_json
             FROM notification_delivery_intents WHERE intent_id = 'intent-immediate'`
        )
        .get()
    ).toEqual({ state: 'delivered', payload_key_id: null, payload_envelope_json: null });
    expect(
      tenantDatabase
        .prepare(
          `SELECT status, attempt_no FROM plugin_hook_outbox WHERE outbox_id = 'outbox-immediate'`
        )
        .get()
    ).toEqual({ status: 'succeeded', attempt_no: 1 });
  });
});
