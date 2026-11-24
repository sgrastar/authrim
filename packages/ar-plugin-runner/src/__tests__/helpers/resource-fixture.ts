import { DatabaseSync } from 'node:sqlite';
import { vi } from 'vitest';
import { derivePluginInstallationId } from '@authrim/ar-lib-core';
import type { PluginResourceBindingProps, PluginResourceKind } from '../../resource-bindings';
import type { PluginRunnerEnv } from '../../types';
import { createD1, openRunnerDatabase, type D1Options } from './sqlite-d1';

export const HOST = {
  d1: `PRES_D1_${'A'.repeat(24)}`,
  kv_namespace: `PRES_KV_${'B'.repeat(24)}`,
  r2_bucket: `PRES_R2_${'C'.repeat(24)}`,
} as const;
export const FINGERPRINT = {
  d1: 'a'.repeat(64),
  kv_namespace: 'b'.repeat(64),
  r2_bucket: 'c'.repeat(64),
} as const;
export const LOGICAL = { d1: 'state', kv_namespace: 'cache', r2_bucket: 'objects' } as const;
export const BINDING = {
  d1: 'PLUGIN_STATE',
  kv_namespace: 'PLUGIN_CACHE',
  r2_bucket: 'PLUGIN_OBJECTS',
} as const;
export const VERSION_DIGEST = '1'.repeat(64);

export const RESOURCE_POLICY = {
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

export async function installationId(
  tenantId = 'tenant-a',
  pluginId = 'plugin-a'
): Promise<string> {
  return derivePluginInstallationId({
    environmentId: 'test',
    tenantId,
    pluginId,
    purpose: 'dynamic-plugin',
  });
}

export async function propsFor(
  kind: PluginResourceKind,
  access: 'read_only' | 'read_write' = 'read_write',
  over: Partial<PluginResourceBindingProps> = {}
): Promise<PluginResourceBindingProps> {
  return {
    tenantId: 'tenant-a',
    pluginId: 'plugin-a',
    installationId: await installationId(),
    logicalResourceId: LOGICAL[kind],
    binding: BINDING[kind],
    hostBindingRef: HOST[kind],
    kind,
    access,
    ownershipFingerprint: FINGERPRINT[kind],
    ...over,
  };
}

export function insertResource(
  runner: DatabaseSync,
  props: PluginResourceBindingProps,
  state: 'active' | 'disabled' = 'active',
  operationId = 'operation-1'
): void {
  runner
    .prepare(
      `INSERT INTO plugin_runner_dynamic_worker_resources (
         installation_id, tenant_id, plugin_id, logical_resource_id, logical_binding_name,
         host_binding_ref, resource_kind, access_mode, ownership_fingerprint,
         control_operation_id, state, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    )
    .run(
      props.installationId,
      props.tenantId,
      props.pluginId,
      props.logicalResourceId,
      props.binding,
      props.hostBindingRef,
      props.kind,
      props.access,
      props.ownershipFingerprint,
      operationId,
      state
    );
}

export function publishResourcePolicy(
  runner: DatabaseSync,
  policy: unknown = RESOURCE_POLICY
): void {
  runner
    .prepare(
      `INSERT INTO plugin_runner_dynamic_worker_releases (
         plugin_id, version_digest, code_sha256, code_object_key, source_manifest_hash,
         capability_manifest_digest, policy_json, state, published_at, updated_at
       ) VALUES ('plugin-a', ?, ?, ?, ?, ?, ?, 'published', 1, 1)`
    )
    .run(
      VERSION_DIGEST,
      '2'.repeat(64),
      `plugins/plugin-a/${'2'.repeat(64)}.json`,
      '3'.repeat(64),
      '4'.repeat(64),
      typeof policy === 'string' ? policy : JSON.stringify(policy)
    );
  runner
    .prepare(
      `INSERT INTO plugin_runner_dynamic_worker_manifests (
         plugin_id, active_version_digest, state, updated_at
       ) VALUES ('plugin-a', ?, 'active', 1)`
    )
    .run(VERSION_DIGEST);
}

export function fakeKv(values = new Map<string, string>()) {
  return {
    values,
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => void values.set(key, value)),
    delete: vi.fn(async (key: string) => void values.delete(key)),
    list: vi.fn(
      async (
        _options?: unknown
      ): Promise<{
        keys: Array<{ name: string; expiration?: number }>;
        list_complete: boolean;
        cursor?: string;
      }> => ({
        keys: [...values.keys()].map((name) => ({ name })),
        list_complete: true,
      })
    ),
  };
}

export function fakeR2(values = new Map<string, Uint8Array>()) {
  const cancel = vi.fn(async () => undefined);
  return {
    values,
    cancel,
    head: vi.fn(async (key: string) => {
      const value = values.get(key);
      return value
        ? { key, size: value.byteLength, etag: `etag-${key}`, uploaded: new Date(86_400_000) }
        : null;
    }),
    get: vi.fn(async (key: string) => {
      const value = values.get(key);
      return value
        ? {
            key,
            size: value.byteLength,
            body: { cancel },
            arrayBuffer: async () =>
              value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
          }
        : null;
    }),
    put: vi.fn(
      async (key: string, value: string | Uint8Array): Promise<{ etag: string } | null> => {
        values.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : value);
        return { etag: `etag-${key}` };
      }
    ),
    delete: vi.fn(async (key: string) => void values.delete(key)),
    list: vi.fn(async (_options?: unknown) => ({
      objects: [...values.entries()].map(([key, value]) => ({
        key,
        size: value.byteLength,
        etag: `etag-${key}`,
        uploaded: new Date(86_400_000),
      })),
      truncated: false as boolean,
      cursor: undefined as string | undefined,
    })),
  };
}

export function createResourceWorld(options: D1Options = {}) {
  const runner = openRunnerDatabase();
  const resourceDatabase = createD1(openResourceDatabase());
  const runnerD1 = createD1(runner, options);
  const kv = fakeKv();
  const r2 = fakeR2();
  const env = {
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    AUTHRIM_WORKER_SCRIPT_NAME: 'ar-plugin-runner',
    PLUGIN_RUNNER_DB: runnerD1.db,
    [HOST.d1]: resourceDatabase.db,
    [HOST.kv_namespace]: kv,
    [HOST.r2_bucket]: r2,
  } as unknown as PluginRunnerEnv;
  return {
    runner,
    env,
    kv,
    r2,
    calls: runnerD1.calls,
    resourceCalls: resourceDatabase.calls,
  };
}

function openResourceDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE plugin_state (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  return database;
}

export function entrypoint<T>(
  Entrypoint: new (...args: never[]) => T,
  env: PluginRunnerEnv,
  props: unknown
): T {
  const Constructor = Entrypoint as unknown as new (context: unknown, env: PluginRunnerEnv) => T;
  return new Constructor({ props }, env);
}
