import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { D1DynamicPluginInstallationStore } from '../dynamic-worker-installations';
import {
  installationIdFor,
  rows,
  seedArtifact,
  seedInstallation,
  seedPlugin,
  VERSION_1,
} from './helpers/dynamic-plugin-seed';
import { createD1, openRunnerDatabase, throwOpaque, type D1Options } from './helpers/sqlite-d1';

const NOW = 1_000;
let database: DatabaseSync;

function store(options: D1Options = {}, now: () => number = () => NOW) {
  const d1 = createD1(database, options);
  return { store: new D1DynamicPluginInstallationStore(d1.db, 'test', now), calls: d1.calls };
}
const target = { tenantId: 'tenant-a', pluginId: 'plugin-a' };
const installation = () =>
  rows<Record<string, unknown>>(database, 'SELECT * FROM plugin_runner_installations');

beforeEach(() => {
  database = openRunnerDatabase();
  seedPlugin(database);
});

describe('construction and clock', () => {
  it.each(['', '-bad', 'has space', 'a'.repeat(257)])('rejects environment %j', (environment) => {
    expect(() => new D1DynamicPluginInstallationStore(createD1(database).db, environment)).toThrow(
      /^plugin_dynamic_installation_environment_invalid$/u
    );
  });
  it('accepts a 256-character environment id', () => {
    expect(
      () => new D1DynamicPluginInstallationStore(createD1(database).db, 'a'.repeat(256))
    ).not.toThrow();
  });
  it.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'refuses a clock value of %s before writing',
    async (value) => {
      const { store: s } = store({}, () => value);
      await expect(s.configure({ ...target, enabled: false })).rejects.toThrow(
        /^plugin_dynamic_installation_now_invalid$/u
      );
      expect(installation()).toEqual([]);
    }
  );
  it('accepts a clock value of exactly one', async () => {
    const { store: s } = store({}, () => 1);
    await expect(s.configure({ ...target, enabled: false })).resolves.toMatchObject({
      state: 'disabled',
    });
  });
  it('needs the D1 sessions API and asks for the primary', async () => {
    const without = store({ withoutSession: true });
    await expect(without.store.configure({ ...target, enabled: false })).rejects.toThrow(
      /^plugin_dynamic_installation_d1_session_required$/u
    );
    await expect(without.store.listApproved()).rejects.toThrow(
      /^plugin_dynamic_installation_d1_session_required$/u
    );
    const withSession = store();
    await withSession.store.configure({ ...target, enabled: false });
    expect(withSession.calls.filter((c) => c.kind === 'session')).toEqual([
      { kind: 'session', sql: 'first-primary', values: [] },
    ]);
  });
});

describe('configure input', () => {
  const run = (input: unknown) => store().store.configure(input);
  it.each([
    ['null', null],
    ['array', []],
    ['string', 'x'],
    ['extra key', { ...target, enabled: false, extra: 1 }],
    ['missing enabled', target],
    ['request id on disable', { ...target, enabled: false, activationRequestId: 'r1' }],
    ['non-boolean enabled', { ...target, enabled: 'true' }],
    ['numeric tenant', { ...target, tenantId: 5, enabled: false }],
    ['empty tenant', { ...target, tenantId: '', enabled: false }],
    ['tenant leading dash', { ...target, tenantId: '-a', enabled: false }],
    ['tenant too long', { ...target, tenantId: 'a'.repeat(257), enabled: false }],
    ['uppercase plugin', { ...target, pluginId: 'Plugin', enabled: false }],
    ['plugin leading dot', { ...target, pluginId: '.p', enabled: false }],
    ['plugin with colon', { ...target, pluginId: 'p:a', enabled: false }],
    ['plugin too long', { ...target, pluginId: 'a'.repeat(129), enabled: false }],
    ['numeric plugin', { ...target, pluginId: 7, enabled: false }],
    ['bad request id', { ...target, enabled: true, activationRequestId: '-x' }],
    ['request id with space', { ...target, enabled: true, activationRequestId: 'a b' }],
  ])('rejects %s', async (_label, input) => {
    await expect(run(input)).rejects.toThrow(/^plugin_dynamic_installation_input_invalid$/u);
    expect(installation()).toEqual([]);
  });
  it('accepts boundary identifiers', async () => {
    seedPlugin(database, { pluginId: 'a'.repeat(128), version: VERSION_1 });
    await expect(
      run({ tenantId: 'T'.repeat(256), pluginId: 'a'.repeat(128), enabled: false })
    ).resolves.toMatchObject({ state: 'disabled' });
    seedPlugin(database, { pluginId: '0.a_b-c', version: VERSION_1 });
    await expect(
      run({ tenantId: 'a.b:c-d_e', pluginId: '0.a_b-c', enabled: false })
    ).resolves.toMatchObject({ state: 'disabled' });
  });
});

describe('stageActivation', () => {
  const stage = { ...target, activationRequestId: 'activation-1' };
  it.each([
    ['null', null],
    ['array', []],
    ['missing request', target],
    ['extra key', { ...stage, enabled: true }],
    ['bad tenant', { ...stage, tenantId: '' }],
    ['bad plugin', { ...stage, pluginId: 'P' }],
    ['numeric request', { ...stage, activationRequestId: 1 }],
    ['bad request', { ...stage, activationRequestId: '-r' }],
    ['numeric tenant', { ...stage, tenantId: 1 }],
    ['numeric plugin', { ...stage, pluginId: 1 }],
  ])('rejects %s', async (_label, input) => {
    await expect(store().store.stageActivation(input)).rejects.toThrow(
      /^plugin_dynamic_activation_stage_input_invalid$/u
    );
    expect(installation()).toEqual([]);
  });

  it('stages a disabled installation holding the request and returns the fence', async () => {
    const { store: s } = store();
    const installationId = await installationIdFor('tenant-a');
    await expect(s.stageActivation(stage)).resolves.toEqual({
      installationId,
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      activationRequestId: 'activation-1',
      state: 'pending',
    });
    expect(installation()).toMatchObject([
      {
        installation_id: installationId,
        tenant_id: 'tenant-a',
        plugin_id: 'plugin-a',
        backend_kind: 'dynamic_worker',
        script_name: 'plugin-a',
        state: 'disabled',
        config_version: 1,
        platform_concurrency_cap: 4,
        platform_rate_per_minute: 60,
        pending_activation_request_id: 'activation-1',
        created_at: NOW,
        updated_at: NOW,
      },
    ]);
  });

  it('is idempotent for the same request and refreshes only the update time', async () => {
    await store().store.stageActivation(stage);
    await store({}, () => 2_000).store.stageActivation(stage);
    expect(installation()).toMatchObject([
      { pending_activation_request_id: 'activation-1', created_at: NOW, updated_at: 2_000 },
    ]);
  });

  it('refuses a second request while another is pending, leaving the first fence', async () => {
    await store().store.stageActivation(stage);
    await expect(
      store().store.stageActivation({ ...stage, activationRequestId: 'activation-2' })
    ).rejects.toThrow(/^plugin_dynamic_activation_stage_conflict$/u);
    expect(installation()).toMatchObject([{ pending_activation_request_id: 'activation-1' }]);
  });

  it('refuses to stage over an enabled installation that already holds the same request', async () => {
    await seedInstallation(database, { state: 'enabled', pending: 'activation-1' });
    await expect(store().store.stageActivation(stage)).rejects.toThrow(
      /^plugin_dynamic_activation_stage_conflict$/u
    );
  });

  it('refuses to stage over an enabled installation', async () => {
    await seedInstallation(database, { state: 'enabled' });
    await expect(store().store.stageActivation(stage)).rejects.toThrow(
      /^plugin_dynamic_activation_stage_conflict$/u
    );
    expect(installation()).toMatchObject([
      { state: 'enabled', pending_activation_request_id: null },
    ]);
  });

  it('surfaces the uniqueness violation when another identity already holds the tenant and plugin', async () => {
    await seedInstallation(database, { installationId: 'someone-else' });
    await expect(store().store.stageActivation(stage)).rejects.toThrow(/UNIQUE constraint failed/u);
    expect(installation()).toMatchObject([
      { installation_id: 'someone-else', pending_activation_request_id: null },
    ]);
  });

  it.each([
    ['no manifest', () => database.exec('DELETE FROM plugin_runner_dynamic_worker_manifests')],
    [
      'staging manifest',
      () => database.exec("UPDATE plugin_runner_dynamic_worker_manifests SET state = 'staging'"),
    ],
    [
      'revoked manifest',
      () => database.exec("UPDATE plugin_runner_dynamic_worker_manifests SET state = 'revoked'"),
    ],
    [
      'revoked release',
      () => database.exec("UPDATE plugin_runner_dynamic_worker_releases SET state = 'revoked'"),
    ],
  ])('refuses with %s', async (_label, mutate) => {
    mutate();
    await expect(store().store.stageActivation(stage)).rejects.toThrow(
      /^plugin_dynamic_installation_version_unavailable$/u
    );
    expect(installation()).toEqual([]);
  });

  it('surfaces the storage error when the write fails and nothing was staged', async () => {
    const { store: s } = store({
      intercept: (call) => {
        if (call.kind === 'run' && call.sql.includes('INSERT INTO plugin_runner_installations')) {
          throw new Error('d1_unavailable');
        }
        return undefined;
      },
    });
    await expect(s.stageActivation(stage)).rejects.toThrow(/^d1_unavailable$/u);
  });

  it('reports a conflict when a non-Error is thrown and nothing was staged', async () => {
    const { store: s } = store({
      intercept: (call) => {
        if (call.kind === 'run') throwOpaque('opaque');
        return undefined;
      },
    });
    await expect(s.stageActivation(stage)).rejects.toThrow(
      /^plugin_dynamic_activation_stage_conflict$/u
    );
  });

  it('adopts a stage that committed although the response was lost', async () => {
    await seedInstallation(database, { pending: 'activation-1' });
    const { store: s } = store({
      intercept: (call) => {
        if (call.kind === 'run') throw new Error('response_lost');
        return undefined;
      },
    });
    await expect(s.stageActivation(stage)).resolves.toMatchObject({ state: 'pending' });
  });

  it('binds installation, tenant, plugin, script, request and both timestamps in order', async () => {
    const { store: s, calls } = store();
    await s.stageActivation(stage);
    const insert = calls.find((c) => c.sql.includes('INSERT INTO plugin_runner_installations'));
    expect(insert?.values).toEqual([
      await installationIdFor('tenant-a'),
      'tenant-a',
      'plugin-a',
      'plugin-a',
      'activation-1',
      NOW,
      NOW,
    ]);
  });
});

describe('configure disabled', () => {
  it('creates a disabled installation without a pin', async () => {
    const installationId = await installationIdFor('tenant-a');
    await expect(store().store.configure({ ...target, enabled: false })).resolves.toEqual({
      installationId,
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      state: 'disabled',
      configVersion: 1,
      pinnedVersionDigest: null,
    });
    expect(installation()).toMatchObject([
      {
        installation_id: installationId,
        backend_kind: 'dynamic_worker',
        script_name: 'plugin-a',
        state: 'disabled',
        config_version: 1,
        platform_concurrency_cap: 4,
        platform_rate_per_minute: 60,
        pending_activation_request_id: null,
        created_at: NOW,
        updated_at: NOW,
      },
    ]);
  });

  it('refuses to create without an active published manifest', async () => {
    database.exec("UPDATE plugin_runner_dynamic_worker_releases SET state = 'revoked'");
    await expect(store().store.configure({ ...target, enabled: false })).rejects.toThrow(
      /^plugin_dynamic_installation_version_unavailable$/u
    );
    database.exec("UPDATE plugin_runner_dynamic_worker_releases SET state = 'published'");
    database.exec("UPDATE plugin_runner_dynamic_worker_manifests SET state = 'staging'");
    await expect(store().store.configure({ ...target, enabled: false })).rejects.toThrow(
      /^plugin_dynamic_installation_version_unavailable$/u
    );
    database.exec('DELETE FROM plugin_runner_dynamic_worker_manifests');
    await expect(store().store.configure({ ...target, enabled: false })).rejects.toThrow(
      /^plugin_dynamic_installation_version_unavailable$/u
    );
    expect(installation()).toEqual([]);
  });

  it('disables an enabled installation, clears its fence and keeps the pin', async () => {
    const installationId = await seedInstallation(database, { state: 'enabled' });
    seedArtifact(database, installationId, VERSION_1);
    await expect(
      store({}, () => 2_000).store.configure({ ...target, enabled: false })
    ).resolves.toEqual({
      installationId,
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      state: 'disabled',
      configVersion: 1,
      pinnedVersionDigest: VERSION_1,
    });
    expect(installation()).toMatchObject([
      { state: 'disabled', pending_activation_request_id: null, updated_at: 2_000, created_at: 1 },
    ]);
  });

  it('clears a staged activation fence when disabling', async () => {
    await seedInstallation(database, { pending: 'activation-1' });
    await store().store.configure({ ...target, enabled: false });
    expect(installation()).toMatchObject([
      { state: 'disabled', pending_activation_request_id: null },
    ]);
  });

  it('disables active resource projections of exactly this installation', async () => {
    const installationId = await seedInstallation(database, { state: 'enabled' });
    seedArtifact(database, installationId, VERSION_1);
    const other = await seedInstallation(database, { tenantId: 'tenant-b', state: 'enabled' });
    const insertResource = (id: string, tenant: string, logical: string, state: string) =>
      database
        .prepare(
          `INSERT INTO plugin_runner_dynamic_worker_resources (
             installation_id, tenant_id, plugin_id, logical_resource_id, logical_binding_name,
             host_binding_ref, resource_kind, access_mode, ownership_fingerprint,
             control_operation_id, state, updated_at
           ) VALUES (?, ?, 'plugin-a', ?, ?, ?, 'kv_namespace', 'read_only', ?, 'op-1', ?, 1)`
        )
        .run(
          id,
          tenant,
          logical,
          logical.toUpperCase(),
          `PRES_KV_${{ one: 'A', two: 'B', three: 'C' }[logical] ?? 'D'}${'0'.repeat(23)}`,
          'a'.repeat(64),
          state
        );
    insertResource(installationId, 'tenant-a', 'one', 'active');
    insertResource(installationId, 'tenant-a', 'three', 'disabled');
    insertResource(other, 'tenant-b', 'two', 'active');
    await store({}, () => 3_000).store.configure({ ...target, enabled: false });
    expect(
      rows<{
        installation_id: string;
        logical_resource_id: string;
        state: string;
        updated_at: number;
      }>(
        database,
        'SELECT installation_id, logical_resource_id, state, updated_at FROM plugin_runner_dynamic_worker_resources ORDER BY logical_resource_id'
      )
    ).toEqual([
      {
        installation_id: installationId,
        logical_resource_id: 'one',
        state: 'disabled',
        updated_at: 3_000,
      },
      {
        installation_id: installationId,
        logical_resource_id: 'three',
        state: 'disabled',
        updated_at: 1,
      },
      { installation_id: other, logical_resource_id: 'two', state: 'active', updated_at: 1 },
    ]);
  });

  it.each([
    ['one active resource left', { value: { count: 1 } }],
    ['a string count', { value: { count: '2' } }],
    ['no answer', { value: null }],
    ['an unreadable count', { value: { count: 'x' } }],
  ])('fails closed on %s after disabling', async (_label, override) => {
    await seedInstallation(database, { state: 'enabled' });
    const { store: s } = store({
      intercept: (call) => (call.sql.includes('COUNT(*) AS count') ? override : undefined),
    });
    await expect(s.configure({ ...target, enabled: false })).rejects.toThrow(
      /^plugin_dynamic_installation_resource_disable_failed$/u
    );
  });

  it('accepts a zero count delivered as a string', async () => {
    await seedInstallation(database, { state: 'enabled' });
    const { store: s } = store({
      intercept: (call) =>
        call.sql.includes('COUNT(*) AS count') ? { value: { count: '0' } } : undefined,
    });
    await expect(s.configure({ ...target, enabled: false })).resolves.toMatchObject({
      state: 'disabled',
    });
  });

  it.each([
    ['another installation id', { installationId: 'someone-else' }],
    ['an in-process backend', { backendKind: 'in_process' as const }],
    ['another script', { scriptName: 'other-script' }],
  ])('refuses an existing row with %s', async (_label, seed) => {
    await seedInstallation(database, seed);
    await expect(store().store.configure({ ...target, enabled: false })).rejects.toThrow(
      /^plugin_dynamic_installation_identity_conflict$/u
    );
    expect(installation()).toHaveLength(1);
  });
});
