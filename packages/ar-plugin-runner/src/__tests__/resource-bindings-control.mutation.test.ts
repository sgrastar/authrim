import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parsePluginManifestResources,
  PluginResourceControlService,
  SAML_DR_WRITER_SURFACES,
} from '../resource-bindings';
import {
  BINDING,
  createResourceWorld,
  FINGERPRINT,
  HOST,
  installationId,
  LOGICAL,
  publishResourcePolicy,
  RESOURCE_POLICY,
  fakeKv,
} from './helpers/resource-fixture';
import { must } from './helpers/mock-kit';

vi.mock('@authrim/ar-lib-core/services/tenant-portability/saml-dr-writer', () => ({
  runSamlDrCoveredOperation: (
    env: unknown,
    ctx: unknown,
    op: (env: unknown, ctx: unknown) => unknown
  ) => op(env, ctx),
}));

const CONTROL = {
  caller: 'ar-control',
  audience: 'authrim-runtime-smoke-v1',
  environmentId: 'test',
  targetWorker: 'ar-plugin-runner',
};
const descriptor = (kind: 'd1' | 'kv_namespace' | 'r2_bucket', access: string) => ({
  logicalResourceId: LOGICAL[kind],
  binding: BINDING[kind],
  hostBindingRef: HOST[kind],
  kind,
  access,
  ownershipFingerprint: FINGERPRINT[kind],
});
const RESOURCES = [
  descriptor('r2_bucket', 'read_write'),
  descriptor('d1', 'read_write'),
  descriptor('kv_namespace', 'read_only'),
];

let world: ReturnType<typeof createResourceWorld>;
let input: Record<string, unknown>;
const service = (props: unknown = CONTROL, now = () => 777) =>
  new PluginResourceControlService(world.env, props as never, now);
const reflect = (over: Record<string, unknown> = {}, props: unknown = CONTROL) =>
  service(props).reflectAndSmoke({ ...input, ...over });
const rowsOf = () =>
  world.runner
    .prepare(
      'SELECT logical_resource_id, control_operation_id, state, updated_at FROM plugin_runner_dynamic_worker_resources ORDER BY logical_resource_id'
    )
    .all();

beforeEach(async () => {
  world = createResourceWorld();
  publishResourcePolicy(world.runner);
  (world.env as unknown as Record<string, unknown>).CONTROL_SMOKE_VERSION = { id: 'version-1' };
  input = {
    operationId: 'operation-1',
    tenantId: 'tenant-a',
    pluginId: 'plugin-a',
    installationId: await installationId(),
    expectedVersionId: 'version-1',
    resources: RESOURCES,
  };
});

describe('control caller authorization', () => {
  const DENIED = /^plugin_dynamic_resource_caller_unauthorized$/u;
  it.each([
    ['no props', null],
    ['another caller', { ...CONTROL, caller: 'ar-auth' }],
    ['another audience', { ...CONTROL, audience: 'authrim-plugin-runner-v1' }],
    ['another environment', { ...CONTROL, environmentId: 'prod' }],
    ['an unsafe environment id', { ...CONTROL, environmentId: '-x' }],
    ['no target worker', { ...CONTROL, targetWorker: undefined }],
    ['an empty target worker', { ...CONTROL, targetWorker: '' }],
    ['an unsafe target worker', { ...CONTROL, targetWorker: '-x' }],
    ['another target worker', { ...CONTROL, targetWorker: 'ar-other' }],
  ])('rejects %s before reading the input', async (_label, props) => {
    await expect(reflect({}, props)).rejects.toThrow(DENIED);
    expect(world.calls).toEqual([]);
  });
  it('rejects when the environment name differs from the script name binding', async () => {
    (world.env as unknown as Record<string, unknown>).AUTHRIM_ENVIRONMENT_NAME = 'prod';
    await expect(reflect()).rejects.toThrow(DENIED);
    (world.env as unknown as Record<string, unknown>).AUTHRIM_ENVIRONMENT_NAME = 'test';
    (world.env as unknown as Record<string, unknown>).AUTHRIM_WORKER_SCRIPT_NAME = 'other';
    await expect(reflect()).rejects.toThrow(DENIED);
  });
});

describe('control input', () => {
  const INVALID = /^plugin_dynamic_resource_control_input_invalid$/u;
  it.each([
    ['null', null],
    ['array', []],
    ['missing key', { operationId: 'operation-1' }],
  ])('rejects %s', async (_label, value) => {
    await expect(service().reflectAndSmoke(value)).rejects.toThrow(INVALID);
  });
  it.each([
    ['an extra key', { extra: 1 }],
    ['a bad operation id', { operationId: '' }],
    ['a numeric operation id', { operationId: 1 }],
    ['a bad tenant', { tenantId: '-a' }],
    ['a bad plugin', { pluginId: 'Plugin' }],
    ['a bad installation id', { installationId: '' }],
    ['a bad expected version', { expectedVersionId: '' }],
    ['non-array resources', { resources: {} }],
    ['no resources', { resources: [] }],
    ['seventeen resources', { resources: Array.from({ length: 17 }, () => RESOURCES[0]) }],
    ['a foreign installation id', { installationId: 'installation-z' }],
  ])('rejects %s', async (_label, over) => {
    await expect(reflect(over)).rejects.toThrow(INVALID);
    expect(world.calls.filter((call) => call.kind !== 'session')).toEqual([]);
  });
  const distinct = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      logicalResourceId: `res${String(i).padStart(2, '0')}`,
      binding: `BIND${String(i).padStart(2, '0')}`,
      hostBindingRef: `PRES_KV_${String(i).padStart(24, 'B')}`,
      kind: 'kv_namespace',
      access: 'read_only',
      ownershipFingerprint: 'b'.repeat(64),
    }));
  it('accepts sixteen distinct resources up to the manifest comparison and refuses seventeen', async () => {
    await expect(reflect({ resources: distinct(16) })).rejects.toThrow(
      /^plugin_dynamic_resource_manifest_mismatch$/u
    );
    await expect(reflect({ resources: distinct(17) })).rejects.toThrow(INVALID);
  });
  it.each([
    ['d1', 'PRES_R2_'],
    ['d1', 'PRES_KV_'],
    ['kv_namespace', 'PRES_D1_'],
    ['kv_namespace', 'PRES_R2_'],
    ['r2_bucket', 'PRES_D1_'],
    ['r2_bucket', 'PRES_KV_'],
  ])('rejects a %s descriptor whose host reference starts with %s', async (kind, prefix) => {
    const bad = {
      ...descriptor(kind as 'd1', 'read_write'),
      hostBindingRef: `${prefix}${'A'.repeat(24)}`,
    };
    await expect(reflect({ resources: [bad] })).rejects.toThrow(
      /^plugin_dynamic_resource_input_invalid$/u
    );
  });
  it('rejects duplicate logical ids, bindings and host references', async () => {
    const [, d1, kv] = RESOURCES as [
      (typeof RESOURCES)[number],
      (typeof RESOURCES)[number],
      (typeof RESOURCES)[number],
    ];
    await expect(
      reflect({ resources: [d1, { ...kv, logicalResourceId: d1.logicalResourceId }] })
    ).rejects.toThrow(INVALID);
    await expect(reflect({ resources: [d1, { ...kv, binding: d1.binding }] })).rejects.toThrow(
      INVALID
    );
    const otherKv = { ...kv, logicalResourceId: 'other', binding: 'OTHER' };
    await expect(reflect({ resources: [kv, otherKv] })).rejects.toThrow(INVALID);
  });
  it('rejects a malformed descriptor with the resource code', async () => {
    await expect(reflect({ resources: [{ ...RESOURCES[1], kind: 'queue' }] })).rejects.toThrow(
      /^plugin_dynamic_resource_input_invalid$/u
    );
    await expect(reflect({ resources: [{ ...RESOURCES[1], extra: 1 }] })).rejects.toThrow(
      /^plugin_dynamic_resource_input_invalid$/u
    );
  });
  it('refuses when the runtime is not the version the caller expected', async () => {
    const mismatch = /^plugin_dynamic_resource_version_mismatch$/u;
    await expect(reflect({ expectedVersionId: 'version-2' })).rejects.toThrow(mismatch);
    (world.env as unknown as Record<string, unknown>).CONTROL_SMOKE_VERSION = undefined;
    await expect(reflect()).rejects.toThrow(mismatch);
  });
});

describe('manifest agreement', () => {
  const MISMATCH = /^plugin_dynamic_resource_manifest_mismatch$/u;
  const [r2Resource, d1Resource, kvResource] = RESOURCES as [
    (typeof RESOURCES)[number],
    (typeof RESOURCES)[number],
    (typeof RESOURCES)[number],
  ];
  it('refuses a plugin without an approved release', async () => {
    world.runner.exec('DELETE FROM plugin_runner_dynamic_worker_manifests');
    await expect(reflect()).rejects.toThrow(/^plugin_dynamic_resource_manifest_unavailable$/u);
  });
  it.each([
    ['a staging manifest', "UPDATE plugin_runner_dynamic_worker_manifests SET state = 'staging'"],
    ['a revoked release', "UPDATE plugin_runner_dynamic_worker_releases SET state = 'revoked'"],
  ])('refuses %s', async (_label, sql) => {
    world.runner.exec(sql);
    await expect(reflect()).rejects.toThrow(/^plugin_dynamic_resource_manifest_unavailable$/u);
  });
  it.each([
    ['too few resources', () => ({ resources: [d1Resource, kvResource] })],
    [
      'an unknown logical id',
      () => ({
        resources: [d1Resource, kvResource, { ...r2Resource, logicalResourceId: 'unknown' }],
      }),
    ],
    [
      'another binding name',
      () => ({ resources: [d1Resource, kvResource, { ...r2Resource, binding: 'OTHER' }] }),
    ],
    [
      'another kind',
      () => ({
        resources: [
          d1Resource,
          kvResource,
          {
            ...r2Resource,
            kind: 'kv_namespace',
            hostBindingRef: HOST.kv_namespace.replace('B', 'D'),
          },
        ],
      }),
    ],
    [
      'another access',
      () => ({ resources: [d1Resource, { ...kvResource, access: 'read_write' }, r2Resource] }),
    ],
  ])('refuses %s', async (_label, over) => {
    await expect(reflect(over())).rejects.toThrow(MISMATCH);
    expect(rowsOf()).toEqual([]);
  });
  it('refuses a manifest that declares a resource the caller did not pass', async () => {
    await expect(reflect({ resources: [d1Resource, kvResource] })).rejects.toThrow(MISMATCH);
  });
  it('refuses a manifest whose policy cannot be read', async () => {
    world.runner.exec("UPDATE plugin_runner_dynamic_worker_releases SET policy_json = '[]'");
    await expect(reflect()).rejects.toThrow(/^plugin_dynamic_resource_manifest_invalid$/u);
  });
});

describe('smoke and reflection', () => {
  it('smokes each binding in logical-id order and records the exact rows', async () => {
    const order: string[] = [];
    world.kv.get.mockImplementation(async (key: string) => (order.push(`kv:${key}`), null));
    world.r2.head.mockImplementation(async (key: string) => (order.push(`r2:${key}`), null));
    await expect(reflect()).resolves.toEqual({
      operationId: 'operation-1',
      installationId: await installationId(),
      observedVersionId: 'version-1',
      resourceCount: 3,
    });
    expect(order).toEqual([
      `kv:__authrim_resource_smoke__/${FINGERPRINT.kv_namespace}`,
      `r2:__authrim_resource_smoke__/${FINGERPRINT.r2_bucket}`,
    ]);
    expect(world.kv.get).toHaveBeenCalledWith(
      `__authrim_resource_smoke__/${FINGERPRINT.kv_namespace}`,
      'text'
    );
    expect(rowsOf()).toEqual([
      {
        logical_resource_id: 'cache',
        control_operation_id: 'operation-1',
        state: 'active',
        updated_at: 777,
      },
      {
        logical_resource_id: 'objects',
        control_operation_id: 'operation-1',
        state: 'active',
        updated_at: 777,
      },
      {
        logical_resource_id: 'state',
        control_operation_id: 'operation-1',
        state: 'active',
        updated_at: 777,
      },
    ]);
  });
  it('binds every column of the reflection batch in declared order', async () => {
    await reflect();
    const batch = must(world.calls.find((call) => call.kind === 'batch'));
    const id = await installationId();
    expect(batch.values.slice(0, 11)).toEqual([
      id,
      'tenant-a',
      'plugin-a',
      'cache',
      'PLUGIN_CACHE',
      HOST.kv_namespace,
      'kv_namespace',
      'read_only',
      FINGERPRINT.kv_namespace,
      'operation-1',
      777,
    ]);
    expect(batch.values).toHaveLength(33);
  });
  it('reads the clock only after the smoke checks passed', async () => {
    const now = vi.fn(() => 5);
    world.kv.get.mockRejectedValueOnce(new Error('kv down'));
    await expect(
      new PluginResourceControlService(world.env, CONTROL as never, now).reflectAndSmoke(input)
    ).rejects.toThrow('kv down');
    expect(now).not.toHaveBeenCalled();
    expect(rowsOf()).toEqual([]);
  });
  it('defaults the clock to the current time in seconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_321_999);
    try {
      await new PluginResourceControlService(world.env, CONTROL as never).reflectAndSmoke(input);
      expect(must((rowsOf() as Array<{ updated_at: number }>)[0]).updated_at).toBe(1_700_000_321);
    } finally {
      vi.useRealTimers();
    }
  });
  it('is idempotent for the same operation', async () => {
    await reflect();
    await expect(reflect()).resolves.toMatchObject({ resourceCount: 3 });
  });
  it('refuses a different operation while the resources are active', async () => {
    await reflect();
    await expect(reflect({ operationId: 'operation-2' })).rejects.toThrow(
      /^plugin_dynamic_resource_reflection_conflict$/u
    );
    expect(rowsOf()).toMatchObject([{ control_operation_id: 'operation-1' }, {}, {}]);
  });
  it('re-owns disabled resources for a later operation', async () => {
    await reflect();
    world.runner.exec("UPDATE plugin_runner_dynamic_worker_resources SET state = 'disabled'");
    await reflect({ operationId: 'operation-2' });
    expect(rowsOf()).toEqual([
      {
        logical_resource_id: 'cache',
        control_operation_id: 'operation-2',
        state: 'active',
        updated_at: 777,
      },
      {
        logical_resource_id: 'objects',
        control_operation_id: 'operation-2',
        state: 'active',
        updated_at: 777,
      },
      {
        logical_resource_id: 'state',
        control_operation_id: 'operation-2',
        state: 'active',
        updated_at: 777,
      },
    ]);
  });
  it('refuses to adopt a resource with another fingerprint', async () => {
    await reflect();
    world.runner.exec("UPDATE plugin_runner_dynamic_worker_resources SET state = 'disabled'");
    const altered = { ...RESOURCES[1], ownershipFingerprint: 'f'.repeat(64) };
    await expect(
      reflect({ operationId: 'operation-2', resources: [altered, RESOURCES[0], RESOURCES[2]] })
    ).rejects.toThrow(/^plugin_dynamic_resource_reflection_conflict$/u);
  });
  it.each([
    ['a short batch', [{ success: true, meta: { changes: 1 } }]],
    ['a failed statement', [1, 2, 3].map((_, i) => ({ success: i !== 1, meta: { changes: 1 } }))],
    [
      'an unchanged row',
      [1, 2, 3].map((_, i) => ({ success: true, meta: { changes: i === 2 ? 0 : 1 } })),
    ],
    [
      'a doubly changed row',
      [1, 2, 3].map((_, i) => ({ success: true, meta: { changes: i === 0 ? 2 : 1 } })),
    ],
  ])('rejects %s', async (_label, results) => {
    world = createResourceWorld({
      intercept: (call) => (call.kind === 'batch' ? { value: results } : undefined),
    });
    publishResourcePolicy(world.runner);
    (world.env as unknown as Record<string, unknown>).CONTROL_SMOKE_VERSION = { id: 'version-1' };
    await expect(reflect()).rejects.toThrow(/^plugin_dynamic_resource_reflection_conflict$/u);
  });
  it('treats a missing change count as a conflict', async () => {
    world = createResourceWorld({
      intercept: (call) =>
        call.kind === 'batch'
          ? { value: [1, 2, 3].map(() => ({ success: true, meta: {} })) }
          : undefined,
    });
    publishResourcePolicy(world.runner);
    (world.env as unknown as Record<string, unknown>).CONTROL_SMOKE_VERSION = { id: 'version-1' };
    await expect(reflect()).rejects.toThrow(/^plugin_dynamic_resource_reflection_conflict$/u);
  });
  it('detects resources that are active beyond the reflected map', async () => {
    world.runner.exec(
      `INSERT INTO plugin_runner_dynamic_worker_resources (installation_id, tenant_id, plugin_id, logical_resource_id, logical_binding_name, host_binding_ref, resource_kind, access_mode, ownership_fingerprint, control_operation_id, state, updated_at) VALUES ('${await installationId()}', 'tenant-a', 'plugin-a', 'zzz', 'ZZZ', 'PRES_KV_${'D'.repeat(24)}', 'kv_namespace', 'read_only', '${'d'.repeat(64)}', 'old', 'active', 1)`
    );
    await expect(reflect()).rejects.toThrow(/^plugin_dynamic_resource_reflection_mismatch$/u);
  });
  it('reads the reflection back for this tenant and installation, at most 17 rows', async () => {
    await reflect();
    const read = must(world.calls.filter((call) => call.kind === 'all').at(-1));
    expect(read.sql).toContain('LIMIT 17');
    expect(read.values).toEqual([await installationId(), 'tenant-a']);
  });
  it.each([
    ['plugin', { plugin_id: 'other' }],
    ['logical id', { logical_resource_id: 'other' }],
    ['binding', { logical_binding_name: 'OTHER' }],
    ['host reference', { host_binding_ref: 'x' }],
    ['kind', { resource_kind: 'd1' }],
    ['access', { access_mode: 'read_only' }],
    ['fingerprint', { ownership_fingerprint: 'x' }],
    ['operation', { control_operation_id: 'x' }],
  ])('rejects a reflection whose %s differs', async (_label, over) => {
    const holder: { current?: ReturnType<typeof createResourceWorld> } = {};
    holder.current = createResourceWorld({
      intercept: (call) => {
        if (call.kind !== 'all' || !call.sql.includes('LIMIT 17')) return undefined;
        const rows = (holder.current?.runner
          .prepare(
            'SELECT * FROM plugin_runner_dynamic_worker_resources ORDER BY logical_resource_id'
          )
          .all() ?? []) as Array<Record<string, unknown>>;
        rows[1] = { ...must(rows[1]), ...over };
        return { value: { success: true, results: rows, meta: {} } };
      },
    });
    world = holder.current;
    publishResourcePolicy(world.runner);
    (world.env as unknown as Record<string, unknown>).CONTROL_SMOKE_VERSION = { id: 'version-1' };
    await expect(reflect()).rejects.toThrow(/^plugin_dynamic_resource_reflection_mismatch$/u);
  });
  it('rejects a reflection that lists fewer resources than were reflected', async () => {
    const holder: { current?: ReturnType<typeof createResourceWorld> } = {};
    holder.current = createResourceWorld({
      intercept: (call) => {
        if (call.kind !== 'all' || !call.sql.includes('LIMIT 17')) return undefined;
        const rows = (holder.current?.runner
          .prepare(
            'SELECT * FROM plugin_runner_dynamic_worker_resources ORDER BY logical_resource_id'
          )
          .all() ?? []) as Array<Record<string, unknown>>;
        return { value: { success: true, results: rows.slice(0, 2), meta: {} } };
      },
    });
    world = holder.current;
    publishResourcePolicy(world.runner);
    (world.env as unknown as Record<string, unknown>).CONTROL_SMOKE_VERSION = { id: 'version-1' };
    await expect(reflect()).rejects.toThrow(/^plugin_dynamic_resource_reflection_mismatch$/u);
  });
  describe('binding smoke', () => {
    const smokeWorld = (d1Answer: unknown) => {
      (world.env as unknown as Record<string, unknown>)[HOST.d1] = {
        prepare: () => undefined,
        withSession: () => ({ prepare: () => ({ first: async () => d1Answer }) }),
      };
    };
    it('accepts a numeric string 1 from the database probe', async () => {
      smokeWorld({ ok: '1' });
      await expect(reflect()).resolves.toMatchObject({ resourceCount: 3 });
    });
    it.each([
      ['no row', null],
      ['another value', { ok: 2 }],
      ['no value', {}],
    ])('fails the smoke on %s', async (_label, answer) => {
      smokeWorld(answer);
      await expect(reflect()).rejects.toThrow(/^plugin_dynamic_resource_smoke_failed$/u);
      expect(rowsOf()).toEqual([]);
    });
    it('refuses a missing binding of any kind', async () => {
      for (const kind of ['d1', 'kv_namespace', 'r2_bucket'] as const) {
        const fresh = createResourceWorld();
        publishResourcePolicy(fresh.runner);
        (fresh.env as unknown as Record<string, unknown>).CONTROL_SMOKE_VERSION = {
          id: 'version-1',
        };
        delete (fresh.env as unknown as Record<string, unknown>)[HOST[kind]];
        await expect(
          new PluginResourceControlService(fresh.env, CONTROL as never, () => 1).reflectAndSmoke(
            input
          )
        ).rejects.toThrow(/^plugin_dynamic_resource_binding_unavailable$/u);
      }
      world.kv = fakeKv();
    });
  });
});

describe('parsePluginManifestResources', () => {
  const INVALID = /^plugin_dynamic_resource_manifest_invalid$/u;
  const entry = (over: Record<string, unknown> = {}) => ({
    logicalResourceId: 'state',
    binding: 'STATE',
    kind: 'd1',
    access: 'read_write',
    ...over,
  });
  const parse = (resources: unknown) => parsePluginManifestResources(JSON.stringify({ resources }));
  it('maps declared resources by logical id, dropping provisioning detail', () => {
    const parsed = parse([
      entry({ provisioning: { defaultMode: 'managed' } }),
      entry({
        logicalResourceId: 'cache',
        binding: 'CACHE',
        kind: 'kv_namespace',
        access: 'read_only',
      }),
    ]);
    expect([...parsed.entries()]).toEqual([
      ['state', { logicalResourceId: 'state', binding: 'STATE', kind: 'd1', access: 'read_write' }],
      [
        'cache',
        { logicalResourceId: 'cache', binding: 'CACHE', kind: 'kv_namespace', access: 'read_only' },
      ],
    ]);
  });
  it('accepts an empty list and sixteen entries, rejecting seventeen', () => {
    expect(parse([]).size).toBe(0);
    const many = (count: number) =>
      Array.from({ length: count }, (_, i) =>
        entry({ logicalResourceId: `r${i}`, binding: `B${i}` })
      );
    expect(parse(many(16)).size).toBe(16);
    expect(() => parse(many(17))).toThrow(INVALID);
  });
  it.each([
    ['text that is not JSON', '{nope'],
    ['a JSON array', '[]'],
    ['a JSON string', '"x"'],
    ['null', 'null'],
    ['no resources', '{}'],
    ['non-array resources', '{"resources":{}}'],
  ])('rejects %s', (_label, text) => {
    expect(() => parsePluginManifestResources(text)).toThrow(INVALID);
  });
  it.each([
    ['a null entry', null],
    ['an array entry', []],
    ['a bad logical id', entry({ logicalResourceId: 'State' })],
    ['a numeric logical id', entry({ logicalResourceId: 1 })],
    ['a missing binding', entry({ binding: undefined })],
    ['a lowercase binding', entry({ binding: 'state' })],
    ['an unknown kind', entry({ kind: 'queue' })],
    ['an unknown access', entry({ access: 'admin' })],
  ])('rejects %s', (_label, value) => {
    expect(() => parse([value])).toThrow(INVALID);
  });
  it('rejects duplicate logical ids and duplicate bindings', () => {
    expect(() => parse([entry(), entry({ binding: 'OTHER' })])).toThrow(INVALID);
    expect(() => parse([entry(), entry({ logicalResourceId: 'other' })])).toThrow(INVALID);
  });
  it('parses the shared fixture policy', () => {
    expect(parsePluginManifestResources(JSON.stringify(RESOURCE_POLICY)).size).toBe(3);
  });
});

describe('writer surfaces', () => {
  it('lists the five mutating entrypoints', () => {
    expect([...SAML_DR_WRITER_SURFACES]).toEqual([
      'rpc:PluginD1ResourceAccess.run',
      'rpc:PluginKvResourceAccess.put',
      'rpc:PluginKvResourceAccess.delete',
      'rpc:PluginR2ResourceAccess.put',
      'rpc:PluginR2ResourceAccess.delete',
    ]);
  });
});
