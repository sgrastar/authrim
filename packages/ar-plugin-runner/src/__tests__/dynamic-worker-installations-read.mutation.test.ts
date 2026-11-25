import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { D1DynamicPluginInstallationStore } from '../dynamic-worker-installations';
import {
  basePolicy,
  digest,
  installationIdFor,
  seedArtifact,
  seedConfig,
  seedInstallation,
  seedPlugin,
  VERSION_1,
  VERSION_2,
} from './helpers/dynamic-plugin-seed';
import { createD1, openRunnerDatabase, type D1Options } from './helpers/sqlite-d1';

let database: DatabaseSync;
function store(options: D1Options = {}) {
  const d1 = createD1(database, options);
  return { store: new D1DynamicPluginInstallationStore(d1.db, 'test', () => 500), calls: d1.calls };
}
const target = { tenantId: 'tenant-a', pluginId: 'plugin-a' };

beforeEach(() => {
  database = openRunnerDatabase();
});

describe('listApproved', () => {
  const resource = (over: Record<string, unknown> = {}) => ({
    logicalResourceId: 'state',
    binding: 'STATE',
    kind: 'd1',
    access: 'read_write',
    provisioning: { defaultMode: 'managed', allowExisting: true },
    ...over,
  });
  const listWithPolicy = async (policy: unknown) => {
    seedPlugin(database, { policy });
    return store().store.listApproved();
  };
  const INVALID = /^plugin_dynamic_catalog_policy_invalid$/u;

  it('returns nothing when no plugin is approved', async () => {
    await expect(store().store.listApproved()).resolves.toEqual([]);
  });

  it('projects the approved release policy and orders by plugin id', async () => {
    seedPlugin(database, {
      pluginId: 'zeta',
      version: VERSION_2,
      capabilityDigest: digest('e'),
      updatedAt: 9,
      policy: basePolicy({
        visibility: 'platform',
        capabilities: [{ name: 'flow.evaluate' }, { name: 'hook.account.lifecycle' }],
        credentials: [
          { configKey: 'apiKey', required: true },
          { configKey: 'optional', required: false },
        ],
        resources: [
          resource(),
          resource({
            logicalResourceId: 'objects',
            binding: 'OBJECTS',
            kind: 'r2_bucket',
            access: 'read_only',
            provisioning: { defaultMode: 'managed', allowExisting: true },
          }),
          resource({
            logicalResourceId: 'cache',
            binding: 'CACHE',
            kind: 'kv_namespace',
            access: 'read_only',
            provisioning: { defaultMode: 'managed', allowExisting: false },
          }),
        ],
      }),
    });
    seedPlugin(database, { pluginId: 'alpha', updatedAt: 3 });
    await expect(store().store.listApproved()).resolves.toEqual([
      {
        pluginId: 'alpha',
        capabilityManifestDigest: digest('d'),
        activeVersionDigest: VERSION_1,
        visibility: 'tenant',
        capabilities: ['flow.evaluate'],
        credentials: [],
        resources: [],
        updatedAt: 3,
      },
      {
        pluginId: 'zeta',
        capabilityManifestDigest: digest('e'),
        activeVersionDigest: VERSION_2,
        visibility: 'platform',
        capabilities: ['flow.evaluate', 'hook.account.lifecycle'],
        credentials: [
          { configKey: 'apiKey', required: true },
          { configKey: 'optional', required: false },
        ],
        resources: [
          {
            logicalResourceId: 'state',
            binding: 'STATE',
            kind: 'd1',
            access: 'read_write',
            allowExisting: true,
          },
          {
            logicalResourceId: 'objects',
            binding: 'OBJECTS',
            kind: 'r2_bucket',
            access: 'read_only',
            allowExisting: true,
          },
          {
            logicalResourceId: 'cache',
            binding: 'CACHE',
            kind: 'kv_namespace',
            access: 'read_only',
            allowExisting: false,
          },
        ],
        updatedAt: 9,
      },
    ]);
  });

  it('leaves out staging, revoked and unpublished plugins', async () => {
    seedPlugin(database, { pluginId: 'staged', manifestState: 'staging' });
    seedPlugin(database, { pluginId: 'revoked-manifest', manifestState: 'revoked' });
    seedPlugin(database, { pluginId: 'live' });
    seedPlugin(database, { pluginId: 'unpublished', releaseState: 'revoked', manifest: false });
    const names = (await store().store.listApproved()).map((entry) => entry.pluginId);
    expect(names).toEqual(['live']);
  });

  it('requests at most 101 rows and accepts exactly 100', async () => {
    for (let index = 0; index < 100; index++) {
      seedPlugin(database, { pluginId: `p${String(index).padStart(3, '0')}` });
    }
    const { store: s, calls } = store();
    await expect(s.listApproved()).resolves.toHaveLength(100);
    expect(calls.find((c) => c.kind === 'all')?.sql).toContain('LIMIT 101');
    seedPlugin(database, { pluginId: 'p100' });
    await expect(store().store.listApproved()).rejects.toThrow(
      /^plugin_dynamic_catalog_limit_exceeded$/u
    );
  });

  it.each([
    ['null policy', 'null'],
    ['array policy', '[]'],
    ['string policy', '"x"'],
    ['number policy', '5'],
    ['wrong backend', basePolicy({ backend: 'in_process' })],
    ['wrong resource scope', basePolicy({ resourceScope: 'platform' })],
    ['unknown visibility', basePolicy({ visibility: 'public' })],
    ['capabilities not an array', basePolicy({ capabilities: {} })],
    ['credentials not an array', basePolicy({ credentials: {} })],
    ['resources not an array', basePolicy({ resources: {} })],
    ['missing resources', { ...basePolicy(), resources: undefined }],
    [
      'seventeen resources',
      basePolicy({
        resources: Array.from({ length: 17 }, (_, i) =>
          resource({ logicalResourceId: `r${i}`, binding: `B${i}` })
        ),
      }),
    ],
    ['null capability', basePolicy({ capabilities: [null] })],
    ['string capability', basePolicy({ capabilities: ['flow.evaluate'] })],
    ['capability without a name', basePolicy({ capabilities: [{}] })],
    ['numeric capability name', basePolicy({ capabilities: [{ name: 5 }] })],
    ['null credential', basePolicy({ credentials: [null] })],
    ['credential without key', basePolicy({ credentials: [{ required: true }] })],
    [
      'credential with numeric key',
      basePolicy({ credentials: [{ configKey: 1, required: true }] }),
    ],
    [
      'credential with non-boolean required',
      basePolicy({ credentials: [{ configKey: 'a', required: 1 }] }),
    ],
    ['credential without required', basePolicy({ credentials: [{ configKey: 'a' }] })],
    ['null resource', basePolicy({ resources: [null] })],
    ['array resource', basePolicy({ resources: [[]] })],
    ['uppercase logical id', basePolicy({ resources: [resource({ logicalResourceId: 'State' })] })],
    ['numeric logical id', basePolicy({ resources: [resource({ logicalResourceId: 1 })] })],
    [
      'duplicate logical id',
      basePolicy({ resources: [resource(), resource({ binding: 'OTHER' })] }),
    ],
    ['lowercase binding', basePolicy({ resources: [resource({ binding: 'state' })] })],
    ['numeric binding', basePolicy({ resources: [resource({ binding: 1 })] })],
    ['binding with leading digit', basePolicy({ resources: [resource({ binding: '1A' })] })],
    ['binding too long', basePolicy({ resources: [resource({ binding: `A${'B'.repeat(128)}` })] })],
    ['unknown kind', basePolicy({ resources: [resource({ kind: 'queue' })] })],
    ['unknown access', basePolicy({ resources: [resource({ access: 'admin' })] })],
    ['missing provisioning', basePolicy({ resources: [resource({ provisioning: undefined })] })],
    ['string provisioning', basePolicy({ resources: [resource({ provisioning: 'x' })] })],
    ['array provisioning', basePolicy({ resources: [resource({ provisioning: [] })] })],
    [
      'unmanaged provisioning',
      basePolicy({
        resources: [resource({ provisioning: { defaultMode: 'existing', allowExisting: true } })],
      }),
    ],
    [
      'non-boolean allowExisting',
      basePolicy({
        resources: [resource({ provisioning: { defaultMode: 'managed', allowExisting: 1 } })],
      }),
    ],
  ])('rejects %s', async (_label, policy) => {
    await expect(listWithPolicy(policy)).rejects.toThrow(INVALID);
  });

  it('accepts sixteen resources and bounds of logical ids and bindings', async () => {
    const resources = Array.from({ length: 16 }, (_, i) =>
      resource({ logicalResourceId: `r${i}`, binding: i === 0 ? `A${'B'.repeat(127)}` : `B${i}` })
    );
    const [entry] = await listWithPolicy(basePolicy({ resources }));
    expect(entry?.resources).toHaveLength(16);
    expect(entry?.resources[0]?.binding).toBe(`A${'B'.repeat(127)}`);
  });

  describe('rows read from storage', () => {
    const row = (over: Record<string, unknown> = {}) => ({
      plugin_id: 'plugin-a',
      capability_manifest_digest: digest('d'),
      active_version_digest: VERSION_1,
      policy_json: JSON.stringify(basePolicy()),
      updated_at: 7,
      ...over,
    });
    const list = (over: Record<string, unknown>) =>
      store({
        intercept: (call) =>
          call.kind === 'all'
            ? { value: { success: true, results: [row(over)], meta: {} } }
            : undefined,
      }).store.listApproved();
    it('rejects policy text that is not JSON', async () => {
      await expect(list({ policy_json: '{not json' })).rejects.toThrow(
        /^plugin_dynamic_catalog_policy_invalid$/u
      );
    });
    it.each([
      ['plugin id', { plugin_id: 'Bad Id' }],
      ['capability digest length', { capability_manifest_digest: 'a'.repeat(63) }],
      ['capability digest case', { capability_manifest_digest: 'A'.repeat(64) }],
      ['capability digest tail', { capability_manifest_digest: `${'a'.repeat(64)}0` }],
      ['version digest', { active_version_digest: 'g'.repeat(64) }],
      ['version digest prefix', { active_version_digest: `x${'a'.repeat(64)}` }],
      ['version digest suffix', { active_version_digest: `${'a'.repeat(64)}x` }],
      ['updated at zero', { updated_at: 0 }],
      ['updated at fractional', { updated_at: 1.5 }],
      ['updated at text', { updated_at: 'soon' }],
    ])('rejects a bad %s', async (_label, over) => {
      await expect(list(over)).rejects.toThrow(/^plugin_dynamic_catalog_policy_invalid$/u);
    });
    it('reads a numeric string update time and accepts an update time of one', async () => {
      await expect(list({ updated_at: '1' })).resolves.toMatchObject([{ updatedAt: 1 }]);
    });
  });
});

describe('default clock', () => {
  it('stamps new rows with the current time in seconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_222_800);
    try {
      seedPlugin(database);
      const d1 = createD1(database);
      await new D1DynamicPluginInstallationStore(d1.db, 'test').configure({
        tenantId: 'tenant-a',
        pluginId: 'plugin-a',
        enabled: false,
      });
      expect(
        database.prepare('SELECT created_at, updated_at FROM plugin_runner_installations').all()
      ).toEqual([{ created_at: 1_700_000_222, updated_at: 1_700_000_222 }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('status', () => {
  const slots = [
    { configKey: 'apiKey', required: true },
    { configKey: 'optional', required: false, destinationHost: 'other.example.com' },
    { configKey: 'second', required: true, destinationHost: 'third.example.com' },
  ];
  beforeEach(() => {
    seedPlugin(database, { slots });
  });
  const status = (input: unknown, options: D1Options = {}) => store(options).store.status(input);

  it.each([
    ['null', null, 'plugin_dynamic_status_input_invalid'],
    ['array', [], 'plugin_dynamic_status_input_invalid'],
    ['string', 'x', 'plugin_dynamic_status_input_invalid'],
    ['extra key', { ...target, enabled: false }, 'plugin_dynamic_status_input_invalid'],
    ['missing key', { tenantId: 'tenant-a' }, 'plugin_dynamic_status_input_invalid'],
    ['bad tenant', { ...target, tenantId: '' }, 'plugin_dynamic_installation_input_invalid'],
    ['bad plugin', { ...target, pluginId: 'P' }, 'plugin_dynamic_installation_input_invalid'],
    ['numeric plugin', { ...target, pluginId: 1 }, 'plugin_dynamic_installation_input_invalid'],
  ])('rejects %s', async (_label, input, code) => {
    await expect(status(input)).rejects.toThrow(new RegExp(`^${code}$`, 'u'));
  });

  it('reports an absent installation against the active release', async () => {
    await expect(status(target)).resolves.toEqual({
      installationId: await installationIdFor('tenant-a'),
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      state: 'absent',
      configVersion: 1,
      configuredKeys: [],
      missingRequiredFields: ['apiKey', 'second'],
      pinnedVersionDigest: null,
    });
  });

  it('reports no missing fields for an absent plugin without a manifest', async () => {
    await expect(status({ ...target, pluginId: 'unknown' })).resolves.toMatchObject({
      state: 'absent',
      missingRequiredFields: [],
    });
  });

  it('lists the keys configured at the current version only', async () => {
    const id = await seedInstallation(database, { state: 'disabled', configVersion: 2 });
    seedConfig(database, id, 'apiKey', { version: 2 });
    seedConfig(database, id, 'second', { version: 1, host: 'third.example.com' });
    seedConfig(database, id, 'optional', { version: 2, host: 'other.example.com' });
    const { store: s, calls } = store();
    await expect(s.status(target)).resolves.toEqual({
      installationId: id,
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      state: 'disabled',
      configVersion: 2,
      configuredKeys: ['apiKey', 'optional'],
      missingRequiredFields: ['second'],
      pinnedVersionDigest: null,
    });
    expect(calls.find((c) => c.sql.includes('SELECT config_key FROM'))?.values).toEqual([id, 2]);
  });

  it('judges an enabled installation by its pinned release rather than the manifest', async () => {
    const id = await seedInstallation(database, { state: 'enabled' });
    seedArtifact(database, id, VERSION_1);
    seedPlugin(database, {
      version: VERSION_2,
      slots: [{ configKey: 'brandNew', required: true, destinationHost: 'new.example.com' }],
    });
    seedConfig(database, id, 'apiKey');
    seedConfig(database, id, 'second', { host: 'third.example.com' });
    await expect(status(target)).resolves.toMatchObject({
      state: 'enabled',
      missingRequiredFields: [],
      pinnedVersionDigest: VERSION_1,
    });
  });

  it('judges a disabled installation by the manifest even when it holds a pin', async () => {
    const id = await seedInstallation(database, { state: 'disabled' });
    seedArtifact(database, id, VERSION_1);
    seedPlugin(database, {
      version: VERSION_2,
      slots: [{ configKey: 'brandNew', required: true, destinationHost: 'new.example.com' }],
    });
    await expect(status(target)).resolves.toMatchObject({
      state: 'disabled',
      missingRequiredFields: ['brandNew'],
      pinnedVersionDigest: VERSION_1,
    });
  });

  it('reports no missing fields for an enabled installation that has no pin', async () => {
    await seedInstallation(database, { state: 'enabled' });
    await expect(status(target)).resolves.toMatchObject({
      state: 'enabled',
      missingRequiredFields: [],
      pinnedVersionDigest: null,
    });
  });

  it('reports a blocked installation', async () => {
    await seedInstallation(database, { state: 'blocked' });
    await expect(status(target)).resolves.toMatchObject({ state: 'blocked' });
  });

  it('reads a numeric string config version', async () => {
    const id = await seedInstallation(database, { state: 'disabled' });
    const row = database
      .prepare('SELECT * FROM plugin_runner_installations WHERE installation_id = ?')
      .get(id) as Record<string, unknown>;
    await expect(
      status(target, {
        intercept: (call) =>
          call.kind === 'first' && call.sql.includes('FROM plugin_runner_installations')
            ? { value: { ...row, config_version: '3' } }
            : undefined,
      })
    ).resolves.toMatchObject({ configVersion: 3 });
  });

  it.each([
    ['zero', 0],
    ['fractional', 1.5],
    ['text', 'x'],
    ['unsafe', 2 ** 53],
  ])('rejects a %s config version', async (_label, configVersion) => {
    const id = await seedInstallation(database, { state: 'disabled' });
    const row = database
      .prepare('SELECT * FROM plugin_runner_installations WHERE installation_id = ?')
      .get(id) as Record<string, unknown>;
    await expect(
      status(target, {
        intercept: (call) =>
          call.kind === 'first' && call.sql.includes('FROM plugin_runner_installations')
            ? { value: { ...row, config_version: configVersion } }
            : undefined,
      })
    ).rejects.toThrow(/^plugin_dynamic_installation_reflection_invalid$/u);
  });

  it('rejects an installation state the store does not know', async () => {
    const id = await seedInstallation(database, { state: 'disabled' });
    const row = database
      .prepare('SELECT * FROM plugin_runner_installations WHERE installation_id = ?')
      .get(id) as Record<string, unknown>;
    await expect(
      status(target, {
        intercept: (call) =>
          call.kind === 'first' && call.sql.includes('FROM plugin_runner_installations')
            ? { value: { ...row, state: 'retired' } }
            : undefined,
      })
    ).rejects.toThrow(/^plugin_dynamic_status_state_invalid$/u);
  });

  it.each([
    ['another installation id', { installationId: 'someone-else' }],
    ['an in-process backend', { backendKind: 'in_process' as const }],
    ['another script name', { scriptName: 'other' }],
  ])('rejects an installation row with %s', async (_label, seed) => {
    await seedInstallation(database, seed);
    await expect(status(target)).rejects.toThrow(
      /^plugin_dynamic_installation_identity_conflict$/u
    );
  });

  it('accepts exactly sixteen credential slots', async () => {
    seedPlugin(database, {
      pluginId: 'plugin-b',
      slots: Array.from({ length: 16 }, (_, i) => ({
        configKey: `key${String(i).padStart(2, '0')}`,
        required: true,
        destinationHost: `h${i}.example.com`,
      })),
    });
    const result = await status({ tenantId: 'tenant-a', pluginId: 'plugin-b' });
    expect(result.missingRequiredFields).toHaveLength(16);
  });

  it('accepts sixteen configured keys and rejects seventeen', async () => {
    const keys = (count: number) =>
      store({
        intercept: (call) =>
          call.kind === 'all' && call.sql.includes('SELECT config_key FROM')
            ? {
                value: {
                  success: true,
                  results: Array.from({ length: count }, (_, i) => ({ config_key: `k${i}` })),
                  meta: {},
                },
              }
            : undefined,
      }).store.status(target);
    await seedInstallation(database, { state: 'disabled' });
    await expect(keys(16)).resolves.toMatchObject({ configuredKeys: expect.any(Array) as unknown });
    await expect(keys(17)).rejects.toThrow(/^plugin_dynamic_status_config_invalid$/u);
  });

  it('rejects more than sixteen credential slots', async () => {
    await expect(
      status(target, {
        intercept: (call) =>
          call.kind === 'all' && call.sql.includes('credential_slots')
            ? {
                value: {
                  success: true,
                  results: Array.from({ length: 17 }, (_, i) => ({
                    config_key: `k${i}`,
                    required: 1,
                  })),
                  meta: {},
                },
              }
            : undefined,
      })
    ).rejects.toThrow(/^plugin_dynamic_credential_policy_invalid$/u);
  });

  it('treats a slot flagged required as a string one as required', async () => {
    await expect(
      status(target, {
        intercept: (call) =>
          call.kind === 'all' && call.sql.includes('credential_slots')
            ? {
                value: {
                  success: true,
                  results: [
                    { config_key: 'a', required: '1' },
                    { config_key: 'b', required: '0' },
                    { config_key: 'c', required: 2 },
                  ],
                  meta: {},
                },
              }
            : undefined,
      })
    ).resolves.toMatchObject({ missingRequiredFields: ['a'] });
  });
});
