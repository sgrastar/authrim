import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PluginResourceBindingReconciler,
  pluginResourceHostBindingRef,
} from '../plugin-resource-binding-reconciler';
import { d1 } from './support/plugin-dynamic-fixtures';
import {
  FINGERPRINTS,
  OPERATION_ID,
  bindingDatabase,
  controlEnv,
  hostRef,
  mapJson,
  planBindings,
  seedTarget,
  smokeMock,
} from './support/plugin-binding-fixtures';

function resourceEntry(index: number, overrides: Record<string, unknown> = {}) {
  const kind = (['d1', 'kv_namespace', 'r2_bucket'] as const)[index];
  if (!kind) throw new Error('bad_index');
  const names = [
    ['state', 'PLUGIN_STATE', 'read_write'],
    ['cache', 'PLUGIN_CACHE', 'read_only'],
    ['objects', 'PLUGIN_OBJECTS', 'read_write'],
  ] as const;
  const [logical, binding, access] = names[index] ?? names[0];
  return {
    logicalResourceId: logical,
    binding,
    hostBindingRef: hostRef(kind),
    kind,
    access,
    ownershipFingerprint: FINGERPRINTS[kind],
    ...overrides,
  };
}

function mapWith(resources: unknown[]): string {
  return mapJson({ resources });
}

describe('plugin resource binding plan parsing', () => {
  let database: DatabaseSync;
  const api = {
    listWorkerDeployments: vi.fn(),
    getWorkerSettings: vi.fn(),
    patchWorkerSettings: vi.fn(),
  };

  beforeEach(() => {
    database = bindingDatabase();
    for (const mock of Object.values(api)) mock.mockReset();
  });
  afterEach(() => database.close());

  async function reconcile(smoke: ReturnType<typeof smokeMock> | null = smokeMock()) {
    return new PluginResourceBindingReconciler(
      d1(database),
      api,
      controlEnv(d1(database), smoke),
      () => 100
    ).reconcile();
  }

  async function expectBlocked(code: string, state = 'pending') {
    expect(await reconcile()).toEqual({ attempted: 1, succeeded: 0, deferred: 0, blocked: 1 });
    expect(
      database
        .prepare(
          'SELECT state, last_error_code, updated_at FROM control_plugin_resource_binding_reconciliations'
        )
        .get()
    ).toEqual({ state, last_error_code: code, updated_at: 100 });
    expect(
      database
        .prepare(
          'SELECT status, next_attempt_at, last_error_code, last_error_redacted, updated_at FROM control_operations'
        )
        .get()
    ).toEqual({
      status: 'blocked',
      next_attempt_at: null,
      last_error_code: code,
      last_error_redacted: code,
      updated_at: 100,
    });
    expect(api.listWorkerDeployments).not.toHaveBeenCalled();
  }

  const mapCases: [string, string][] = [
    ['an array', '[]'],
    ['null', 'null'],
    ['a string', '"x"'],
    ['an extra top-level key', mapJson({ extra: 1 })],
    ['a wrong schema version', mapJson({ schemaVersion: 2 })],
    ['an unsafe plugin id', mapJson({ pluginId: 'Plugin A' })],
    ['a numeric plugin id', mapJson({ pluginId: 5 })],
    ['a short digest', mapJson({ capabilityManifestDigest: 'abc' })],
    ['a numeric digest', mapJson({ capabilityManifestDigest: 7 })],
    ['a non-array resource list', mapJson({ resources: {} })],
    ['an empty resource list', mapWith([])],
    ['seventeen resources', mapWith(Array.from({ length: 17 }, () => null))],
    ['a null resource', mapWith([null])],
    ['an array resource', mapWith([[]])],
    ['a resource with an extra key', mapWith([resourceEntry(0, { extra: true })])],
    ['an unsafe logical id', mapWith([resourceEntry(0, { logicalResourceId: 'State' })])],
    ['a numeric logical id', mapWith([resourceEntry(0, { logicalResourceId: 1 })])],
    ['a lowercase binding', mapWith([resourceEntry(0, { binding: 'plugin_state' })])],
    ['a numeric binding', mapWith([resourceEntry(0, { binding: 1 })])],
    ['an unsafe host binding', mapWith([resourceEntry(0, { hostBindingRef: 'PLUGIN_STATE' })])],
    ['a numeric host binding', mapWith([resourceEntry(0, { hostBindingRef: 1 })])],
    ['an unknown kind', mapWith([resourceEntry(0, { kind: 'queue' })])],
    ['an unknown access', mapWith([resourceEntry(0, { access: 'admin' })])],
    ['a short fingerprint', mapWith([resourceEntry(0, { ownershipFingerprint: 'abc' })])],
    ['a numeric fingerprint', mapWith([resourceEntry(0, { ownershipFingerprint: 1 })])],
    [
      'a host binding derived from another fingerprint',
      mapWith([resourceEntry(0, { hostBindingRef: hostRef('kv_namespace').replace('KV', 'D1') })]),
    ],
    [
      'duplicate logical ids',
      mapWith([resourceEntry(0), resourceEntry(1, { logicalResourceId: 'state' })]),
    ],
    [
      'duplicate bindings',
      mapWith([resourceEntry(0), resourceEntry(1, { binding: 'PLUGIN_STATE' })]),
    ],
    [
      'duplicate host bindings',
      mapWith([
        resourceEntry(0),
        resourceEntry(0, { logicalResourceId: 'other', binding: 'PLUGIN_OTHER' }),
      ]),
    ],
  ];

  it.each(mapCases)('blocks a resource map with %s', async (_label, map) => {
    seedTarget(database, { map });
    await expectBlocked('plugin_resource_binding_map_invalid');
  });

  it('blocks a resource map larger than one mebibyte', async () => {
    const oversized = JSON.stringify({ pad: 'x'.repeat(1024 * 1024) });
    seedTarget(database, { map: oversized });
    await expectBlocked('plugin_resource_binding_map_invalid');
  });

  it('accepts a resource map of exactly one mebibyte before shape validation', async () => {
    const pad = 'x'.repeat(1024 * 1024 - '{"pad":""}'.length);
    seedTarget(database, { map: JSON.stringify({ pad }) });
    // Still invalid by shape, which proves the size gate did not reject it first.
    await expectBlocked('plugin_resource_binding_map_invalid');
  });

  const planCases: [string, string][] = [
    ['an object', '{}'],
    ['a null', 'null'],
    ['an empty list', '[]'],
    ['seventeen entries', JSON.stringify(Array.from({ length: 17 }, () => ({})))],
    ['a null entry', JSON.stringify([null])],
    ['an array entry', JSON.stringify([[]])],
    ['a numeric name', JSON.stringify([{ name: 1, type: 'd1', database_id: 'x' }])],
    ['an unsafe name', JSON.stringify([{ name: 'PLUGIN_STATE', type: 'd1', database_id: 'x' }])],
    ['an unknown type', JSON.stringify([{ name: hostRef('d1'), type: 'queue' }])],
    ['a d1 without database id', JSON.stringify([{ name: hostRef('d1'), type: 'd1' }])],
    [
      'a kv without namespace id',
      JSON.stringify([{ name: hostRef('kv_namespace'), type: 'kv_namespace' }]),
    ],
    ['an r2 without bucket', JSON.stringify([{ name: hostRef('r2_bucket'), type: 'r2_bucket' }])],
    [
      'a duplicate name',
      JSON.stringify([
        { name: hostRef('d1'), type: 'd1', database_id: 'a' },
        { name: hostRef('d1'), type: 'd1', database_id: 'b' },
      ]),
    ],
  ];

  it.each(planCases)('blocks a binding plan with %s', async (_label, bindings) => {
    seedTarget(database, { bindings });
    await expectBlocked('plugin_resource_binding_plan_invalid');
  });

  it('accepts a binding plan of sixteen entries before the map cross-check', async () => {
    const entries = Array.from({ length: 16 }, (_, index) => ({
      name: `PRES_D1_${index.toString(16).padStart(24, '0').toUpperCase()}`,
      type: 'd1',
      database_id: `db-${index}`,
    }));
    seedTarget(database, { bindings: JSON.stringify(entries) });
    await expectBlocked('plugin_resource_binding_plan_mismatch');
  });

  it('blocks a plan whose size differs from the resource map', async () => {
    seedTarget(database, { bindings: JSON.stringify(planBindings().slice(0, 2)) });
    await expectBlocked('plugin_resource_binding_plan_mismatch');
  });

  it('blocks a plan naming a binding absent from the resource map', async () => {
    const plan = planBindings();
    plan[0] = { name: `PRES_D1_${'0'.repeat(24)}`, type: 'd1', database_id: 'x' };
    seedTarget(database, { bindings: JSON.stringify(plan) });
    await expectBlocked('plugin_resource_binding_plan_mismatch');
  });

  it('defers without blocking while the smoke service binding is absent', async () => {
    seedTarget(database);
    expect(await reconcile(null)).toEqual({ attempted: 1, succeeded: 0, deferred: 1, blocked: 0 });
    expect(
      database
        .prepare(
          'SELECT status, next_attempt_at, last_error_code, last_error_redacted FROM control_operations'
        )
        .get()
    ).toEqual({
      status: 'waiting_retry',
      next_attempt_at: 115,
      last_error_code: 'plugin_resource_binding_smoke_unavailable',
      last_error_redacted: 'plugin_resource_binding_smoke_unavailable',
    });
    expect(
      database
        .prepare(
          'SELECT state, last_error_code FROM control_plugin_resource_binding_reconciliations'
        )
        .get()
    ).toEqual({ state: 'pending', last_error_code: 'plugin_resource_binding_smoke_unavailable' });
    expect(api.listWorkerDeployments).not.toHaveBeenCalled();
  });

  it('defers when the smoke binding lacks the resource method', async () => {
    seedTarget(database);
    const env = controlEnv(d1(database), null);
    env.SMOKE_AR_PLUGIN_RUNNER = { smokeTenantBinding: vi.fn() };
    const result = await new PluginResourceBindingReconciler(
      d1(database),
      api,
      env,
      () => 100
    ).reconcile();
    expect(result).toEqual({ attempted: 1, succeeded: 0, deferred: 1, blocked: 0 });
    expect(database.prepare('SELECT last_error_code FROM control_operations').get()).toEqual({
      last_error_code: 'plugin_resource_binding_smoke_unavailable',
    });
  });

  it('marks a target that already holds patch evidence as blocked', async () => {
    seedTarget(database, { state: 'settings_patched', map: '[]' });
    await expectBlocked('plugin_resource_binding_map_invalid', 'blocked');
  });

  it('keeps an unpatched target pending because its row cannot hold the blocked state', async () => {
    seedTarget(database, { map: '[]' });
    await reconcile();
    expect(
      database.prepare('SELECT state FROM control_plugin_resource_binding_reconciliations').get()
    ).toEqual({ state: 'pending' });
    // The blocked operation is no longer due, so the unpatched target is not retried.
    expect(await reconcile()).toMatchObject({ attempted: 0 });
  });

  it('blocks an operation that is waiting for a retry', async () => {
    seedTarget(database, { map: '[]' });
    database
      .prepare(
        `UPDATE control_operations SET status = 'waiting_retry', next_attempt_at = 50 WHERE operation_id = ?`
      )
      .run(OPERATION_ID);
    expect(await reconcile()).toMatchObject({ blocked: 1 });
    expect(
      database.prepare('SELECT status, last_error_code FROM control_operations').get()
    ).toEqual({ status: 'blocked', last_error_code: 'plugin_resource_binding_map_invalid' });
  });

  it('rejects host binding names with a prefix or suffix around a valid reference', async () => {
    for (const name of [`x${hostRef('d1')}`, `${hostRef('d1')}X`, hostRef('d1').toLowerCase()]) {
      seedTarget(database, {
        bindings: JSON.stringify([{ name, type: 'd1', database_id: 'x' }]),
      });
      await expectBlocked('plugin_resource_binding_plan_invalid');
      database.exec('DELETE FROM control_plugin_resource_binding_reconciliations');
      database.exec("UPDATE control_operations SET status = 'running', last_error_code = NULL");
    }
  });

  it('rejects fingerprints with a prefix or suffix around a valid digest', async () => {
    for (const fingerprint of [`z${'a'.repeat(64)}`, `${'a'.repeat(64)}z`, 'A'.repeat(64)]) {
      seedTarget(database, {
        map: mapWith([resourceEntry(0, { ownershipFingerprint: fingerprint })]),
      });
      await expectBlocked('plugin_resource_binding_map_invalid');
      database.exec('DELETE FROM control_plugin_resource_binding_reconciliations');
      database.exec("UPDATE control_operations SET status = 'running', last_error_code = NULL");
    }
    seedTarget(database, { map: mapJson({ capabilityManifestDigest: `z${'9'.repeat(64)}` }) });
    await expectBlocked('plugin_resource_binding_map_invalid');
  });

  function kvResources(count: number) {
    return Array.from({ length: count }, (_, index) => {
      const fingerprint = (index + 1).toString(16).padStart(2, '0').repeat(32);
      const hostBindingRef = pluginResourceHostBindingRef('kv_namespace', fingerprint);
      return {
        entry: {
          logicalResourceId: `kv-${index}`,
          binding: `KV_${index}`,
          hostBindingRef,
          kind: 'kv_namespace',
          access: 'read_only',
          ownershipFingerprint: fingerprint,
        },
        binding: { name: hostBindingRef, type: 'kv_namespace', namespace_id: `ns-${index}` },
      };
    });
  }

  it.each([1, 16])('accepts a plan and map of exactly %s resources', async (count) => {
    const resources = kvResources(count);
    seedTarget(database, {
      map: mapWith(resources.map((item) => item.entry)),
      bindings: JSON.stringify(resources.map((item) => item.binding)),
    });
    api.listWorkerDeployments.mockRejectedValue(new Error('stop_here'));
    expect(await reconcile()).toEqual({ attempted: 1, succeeded: 0, deferred: 1, blocked: 0 });
    expect(api.listWorkerDeployments).toHaveBeenCalledTimes(1);
    expect(database.prepare('SELECT status FROM control_operations').get()).toEqual({
      status: 'waiting_retry',
    });
  });

  it('rejects a map of seventeen well-formed resources', async () => {
    const resources = kvResources(17);
    seedTarget(database, {
      map: mapWith(resources.map((item) => item.entry)),
      bindings: JSON.stringify(resources.slice(0, 16).map((item) => item.binding)),
    });
    await expectBlocked('plugin_resource_binding_map_invalid');
  });

  it('rejects identifiers with junk before or after an otherwise valid value', async () => {
    const variants: [string, Record<string, unknown>][] = [
      ['plugin id prefix', { pluginId: '!plugin-a' }],
      ['plugin id suffix', { pluginId: 'plugin-a!' }],
    ];
    for (const [, patch] of variants) {
      seedTarget(database, { map: mapJson(patch) });
      await expectBlocked('plugin_resource_binding_map_invalid');
      database.exec('DELETE FROM control_plugin_resource_binding_reconciliations');
      database.exec("UPDATE control_operations SET status = 'running', last_error_code = NULL");
    }
    for (const patch of [
      { logicalResourceId: '!state' },
      { logicalResourceId: 'state!' },
      { binding: '!PLUGIN_STATE' },
      { binding: 'PLUGIN_STATE!' },
    ]) {
      seedTarget(database, { map: mapWith([resourceEntry(0, patch)]) });
      await expectBlocked('plugin_resource_binding_map_invalid');
      database.exec('DELETE FROM control_plugin_resource_binding_reconciliations');
      database.exec("UPDATE control_operations SET status = 'running', last_error_code = NULL");
    }
  });
});
