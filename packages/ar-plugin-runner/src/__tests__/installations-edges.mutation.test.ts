import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { D1PluginInstallationResolver } from '../installations';
import {
  basePolicy,
  seedArtifact,
  seedInstallation,
  seedPlugin,
  VERSION_1,
} from './helpers/dynamic-plugin-seed';
import { createD1, openRunnerDatabase, type D1Options } from './helpers/sqlite-d1';

let database: DatabaseSync;
function resolver(options: D1Options = {}) {
  const d1 = createD1(database, options);
  return { resolver: new D1PluginInstallationResolver(d1.db), calls: d1.calls };
}
const query = (over: Record<string, unknown> = {}) => ({
  tenantId: 'tenant-a',
  pluginInstallationId: 'dyn-installation',
  capability: 'notifier.send',
  ...over,
});
const resource = (
  logicalResourceId: string,
  binding: string,
  kind = 'd1',
  access = 'read_write'
) => ({
  logicalResourceId,
  binding,
  kind,
  access,
  provisioning: { defaultMode: 'managed', allowExisting: false },
});
const HOST_PREFIX = { d1: 'PRES_D1_', kv_namespace: 'PRES_KV_', r2_bucket: 'PRES_R2_' } as const;

async function dynamicWith(resources: Array<ReturnType<typeof resource>>) {
  seedPlugin(database, { pluginId: 'dyn-plugin', policy: basePolicy({ resources }) });
  database
    .prepare(
      `INSERT INTO plugin_runner_dynamic_worker_hook_policies (plugin_id, version_digest, capability, timeout_ms, failure_policy, max_attempts, async_retry_budget_seconds, circuit_breaker_threshold, circuit_breaker_cooldown_seconds, updated_at) VALUES ('dyn-plugin', ?, 'notifier.send', 900, 'retry_async', 5, 600, 5, 60, 1)`
    )
    .run(VERSION_1);
  const id = await seedInstallation(database, {
    tenantId: 'tenant-a',
    pluginId: 'dyn-plugin',
    installationId: 'dyn-installation',
    state: 'enabled',
  });
  seedArtifact(database, id, VERSION_1, 'active', 'dyn-plugin');
  database.exec(
    "INSERT INTO plugin_runner_tenant_external_gates (tenant_id, allowed, generation, updated_at) VALUES ('tenant-a', 1, 1, 1)"
  );
}
const ref = (kind: keyof typeof HOST_PREFIX, char: string) =>
  `${HOST_PREFIX[kind]}${char.repeat(24)}`;

beforeEach(() => {
  database = openRunnerDatabase();
});

describe('session handling', () => {
  it('needs the sessions API and reads from the primary', async () => {
    await expect(
      resolver({ withoutSession: true }).resolver.resolveBackend(query())
    ).rejects.toThrow(/^plugin_runner_installation_d1_session_required$/u);
    await expect(resolver({ withoutSession: true }).resolver.resolve(query())).rejects.toThrow(
      /^plugin_runner_installation_d1_session_required$/u
    );
    await expect(
      resolver({ withoutSession: true }).resolver.resolveDispatchPolicy(query())
    ).rejects.toThrow(/^plugin_runner_installation_d1_session_required$/u);
    const probe = resolver();
    await probe.resolver.resolveBackend(query());
    expect(probe.calls.find((c) => c.kind === 'session')?.sql).toBe('first-primary');
  });
});

describe('identifier boundaries', () => {
  it.each([
    ['a capability with trailing text', { capability: 'notifier send' }],
    ['a tenant id with trailing text', { tenantId: 'tenant a' }],
    ['an installation id with trailing text', { pluginInstallationId: 'dyn installation' }],
  ])('rejects %s in every lookup', async (_label, over) => {
    await expect(resolver().resolver.resolveBackend(query(over))).rejects.toThrow(
      /^plugin_installation_lookup_invalid$/u
    );
    await expect(resolver().resolver.resolve(query(over))).rejects.toThrow(
      /^plugin_installation_lookup_invalid$/u
    );
    await expect(resolver().resolver.resolveDispatchPolicy(query(over))).rejects.toThrow(
      /^plugin_policy_lookup_invalid$/u
    );
  });
  it('finds nothing for a stored plugin id with trailing text', async () => {
    await dynamicWith([]);
    await expect(
      resolver({
        rewrite: (call, value) =>
          call.kind === 'first' && call.sql.includes('timeout_ms') && value
            ? { ...value, plugin_id: 'plugin bad' }
            : value,
      }).resolver.resolveBackend(query())
    ).resolves.toBeNull();
  });
  it.each([
    ['a plugin id with trailing text', { plugin_id: 'dyn-plugin bad' }],
    ['a script name with trailing text', { script_name: 'dyn-plugin bad' }],
  ])('refuses a stored target with %s', async (_label, patch) => {
    await dynamicWith([]);
    await expect(
      resolver({
        rewrite: (call, value) =>
          call.kind === 'first' && call.sql.includes('code_object_key') && value
            ? { ...value, ...patch }
            : value,
      }).resolver.resolve(query())
    ).rejects.toThrow(/^plugin_installation_script_invalid$/u);
  });
});

describe('resource map edges', () => {
  const INVALID = /^plugin_installation_resource_invalid$/u;
  const rowFor = (
    logical: string,
    binding: string,
    host: string,
    kind = 'd1',
    access = 'read_write',
    fingerprint = 'a'.repeat(64)
  ) => ({
    plugin_id: 'dyn-plugin',
    logical_resource_id: logical,
    logical_binding_name: binding,
    host_binding_ref: host,
    resource_kind: kind,
    access_mode: access,
    ownership_fingerprint: fingerprint,
  });
  const withRows = (results: object[]) =>
    resolver({
      rewrite: (call, value) =>
        call.kind === 'all' && call.sql.includes('plugin_runner_dynamic_worker_resources')
          ? { ...(value as object), results }
          : value,
    }).resolver.resolve(query());
  it('resolves exactly sixteen provisioned resources of every kind', async () => {
    const declared = Array.from({ length: 16 }, (_, i) =>
      resource(
        `res${String(i).padStart(2, '0')}`,
        `BIND${String(i).padStart(2, '0')}`,
        i % 3 === 0 ? 'd1' : i % 3 === 1 ? 'kv_namespace' : 'r2_bucket'
      )
    );
    await dynamicWith(declared);
    const kinds = ['d1', 'kv_namespace', 'r2_bucket'] as const;
    const results = declared.map((entry, i) =>
      rowFor(
        entry.logicalResourceId,
        entry.binding,
        `${HOST_PREFIX[kinds[i % 3]]}${i.toString(16).toUpperCase().padStart(24, '0')}`,
        kinds[i % 3]
      )
    );
    const target = await withRows(results);
    expect(target?.resources).toHaveLength(16);
    expect(target?.resources.map((r) => r.kind)).toEqual(results.map((r) => r.resource_kind));
  });
  it('refuses a stored kind that differs from the declared one even when its host reference matches the stored kind', async () => {
    await dynamicWith([resource('state', 'PLUGIN_STATE', 'd1')]);
    await expect(
      withRows([rowFor('state', 'PLUGIN_STATE', ref('kv_namespace', 'B'), 'kv_namespace')])
    ).rejects.toThrow(INVALID);
    await expect(
      withRows([rowFor('state', 'PLUGIN_STATE', ref('r2_bucket', 'B'), 'r2_bucket')])
    ).rejects.toThrow(INVALID);
  });
  it('requires the host reference prefix to match each kind', async () => {
    await dynamicWith([
      resource('a', 'BIND_A', 'kv_namespace'),
      resource('b', 'BIND_B', 'r2_bucket'),
    ]);
    await expect(
      withRows([
        rowFor('a', 'BIND_A', ref('d1', 'A'), 'kv_namespace'),
        rowFor('b', 'BIND_B', ref('r2_bucket', 'B'), 'r2_bucket'),
      ])
    ).rejects.toThrow(INVALID);
    await expect(
      withRows([
        rowFor('a', 'BIND_A', ref('kv_namespace', 'A'), 'kv_namespace'),
        rowFor('b', 'BIND_B', ref('kv_namespace', 'B'), 'r2_bucket'),
      ])
    ).rejects.toThrow(INVALID);
    await expect(
      withRows([
        rowFor('a', 'BIND_A', ref('kv_namespace', 'A'), 'kv_namespace'),
        rowFor('b', 'BIND_B', ref('r2_bucket', 'B'), 'r2_bucket'),
      ])
    ).resolves.toMatchObject({ resources: [{ kind: 'kv_namespace' }, { kind: 'r2_bucket' }] });
  });
  it('refuses a binding or host reference repeated by two rows', async () => {
    await dynamicWith([resource('a', 'BIND_A'), resource('b', 'BIND_B')]);
    await expect(
      withRows([rowFor('a', 'BIND_A', ref('d1', 'A')), rowFor('a', 'BIND_A', ref('d1', 'C'))])
    ).rejects.toThrow(INVALID);
    await expect(
      withRows([rowFor('a', 'BIND_A', ref('d1', 'A')), rowFor('b', 'BIND_B', ref('d1', 'A'))])
    ).rejects.toThrow(INVALID);
    await expect(
      withRows([rowFor('a', 'BIND_A', ref('d1', 'A')), rowFor('b', 'BIND_B', ref('d1', 'C'))])
    ).resolves.toMatchObject({ resources: [{ binding: 'BIND_A' }, { binding: 'BIND_B' }] });
  });
  it.each([
    ['a host reference with trailing text', { host: `${ref('d1', 'A')}X` }],
    ['a host reference with leading text', { host: `X${ref('d1', 'A')}` }],
    ['a fingerprint with trailing text', { fingerprint: `${'a'.repeat(64)}0` }],
    ['a fingerprint with leading text', { fingerprint: `0${'a'.repeat(64)}` }],
  ])('refuses a stored resource with %s', async (_label, patch) => {
    await dynamicWith([resource('a', 'BIND_A')]);
    const { host = ref('d1', 'A'), fingerprint = 'a'.repeat(64) } = patch as Record<string, string>;
    await expect(
      withRows([rowFor('a', 'BIND_A', host, 'd1', 'read_write', fingerprint)])
    ).rejects.toThrow(INVALID);
  });
});
