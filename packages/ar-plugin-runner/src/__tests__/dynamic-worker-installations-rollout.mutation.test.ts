import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { D1DynamicPluginInstallationStore } from '../dynamic-worker-installations';
import {
  artifactIdFor,
  rows,
  seedArtifact,
  seedConfig,
  seedInstallation,
  seedPlugin,
  VERSION_1,
  VERSION_2,
} from './helpers/dynamic-plugin-seed';
import { createD1, openRunnerDatabase, type D1Options } from './helpers/sqlite-d1';

const NOW = 1_000;
let database: DatabaseSync;
function store(options: D1Options = {}) {
  const d1 = createD1(database, options);
  return { store: new D1DynamicPluginInstallationStore(d1.db, 'test', () => NOW), calls: d1.calls };
}
const target = { tenantId: 'tenant-a', pluginId: 'plugin-a' };
const ok = { success: true, results: [], meta: { changes: 1 } };

async function enabledTenant(tenantId: string, version = VERSION_1): Promise<string> {
  const id = await seedInstallation(database, { tenantId, state: 'enabled' });
  seedArtifact(database, id, version);
  return id;
}

beforeEach(() => {
  database = openRunnerDatabase();
  seedPlugin(database);
});

describe('rollout', () => {
  const run = (input: unknown, options: D1Options = {}) => store(options).store.rollout(input);
  const enable = { ...target, enabled: true };
  const artifactRows = () =>
    rows<Record<string, unknown>>(
      database,
      'SELECT artifact_id, version_digest, state, activated_at, updated_at FROM plugin_runner_dynamic_worker_artifacts ORDER BY version_digest'
    );

  it('validates its input like configure and refuses a disable', async () => {
    await expect(run({ ...target, enabled: 'yes' })).rejects.toThrow(
      /^plugin_dynamic_installation_input_invalid$/u
    );
    await expect(run({ ...target, enabled: false })).rejects.toThrow(
      /^plugin_dynamic_rollout_input_invalid$/u
    );
  });

  it('moves an enabled installation to the new release, retiring the old artifact', async () => {
    const id = await enabledTenant('tenant-a');
    seedPlugin(database, { version: VERSION_2 });
    await expect(run(enable)).resolves.toEqual({
      installationId: id,
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      state: 'enabled',
      configVersion: 1,
      pinnedVersionDigest: VERSION_2,
    });
    expect(artifactRows()).toEqual([
      {
        artifact_id: artifactIdFor(id, VERSION_1),
        version_digest: VERSION_1,
        state: 'retired',
        activated_at: null,
        updated_at: NOW,
      },
      {
        artifact_id: artifactIdFor(id, VERSION_2),
        version_digest: VERSION_2,
        state: 'active',
        activated_at: NOW,
        updated_at: NOW,
      },
    ]);
    expect(rows(database, 'SELECT state, updated_at FROM plugin_runner_installations')).toEqual([
      { state: 'enabled', updated_at: NOW },
    ]);
  });

  it('commits the three statements in one batch with ordered binds', async () => {
    const id = await enabledTenant('tenant-a');
    seedPlugin(database, { version: VERSION_2 });
    const { store: s, calls } = store();
    await s.rollout(enable);
    const batch = calls.filter((c) => c.kind === 'batch');
    expect(batch).toHaveLength(1);
    const guard = [id, 'tenant-a', 'plugin-a', 'enabled'];
    expect(batch[0]?.values).toEqual([
      NOW,
      artifactIdFor(id, VERSION_1),
      id,
      ...guard,
      artifactIdFor(id, VERSION_2),
      id,
      'plugin-a',
      VERSION_2,
      NOW,
      NOW,
      ...guard,
      NOW,
      id,
      'tenant-a',
      'plugin-a',
      'enabled',
    ]);
  });

  it('re-activates a previously retired artifact when the manifest returns to it', async () => {
    await enabledTenant('tenant-a');
    seedPlugin(database, { version: VERSION_2 });
    await run(enable);
    database.exec(
      `UPDATE plugin_runner_dynamic_worker_manifests SET active_version_digest = '${VERSION_1}'`
    );
    await expect(run(enable)).resolves.toMatchObject({ pinnedVersionDigest: VERSION_1 });
    expect(artifactRows().map((row) => [row.version_digest, row.state])).toEqual([
      [VERSION_1, 'active'],
      [VERSION_2, 'retired'],
    ]);
    expect(artifactRows()).toHaveLength(2);
  });

  it('is a no-op that reports the pin when the installation is already current', async () => {
    await enabledTenant('tenant-a');
    const { store: s, calls } = store();
    await expect(s.rollout(enable)).resolves.toMatchObject({ pinnedVersionDigest: VERSION_1 });
    expect(calls.filter((c) => c.kind === 'batch')).toEqual([]);
  });

  it.each([
    ['no installation', async () => undefined],
    [
      'a blocked installation',
      async () => {
        await enabledTenant('tenant-a');
        database.exec("UPDATE plugin_runner_installations SET state = 'blocked'");
      },
    ],
    [
      'another script name',
      async () => {
        await enabledTenant('tenant-a');
        database.exec("UPDATE plugin_runner_installations SET script_name = 'other'");
      },
    ],
    [
      'an installation without a pin',
      async () => void (await seedInstallation(database, { state: 'enabled' })),
    ],
  ])('is unavailable with %s', async (_label, arrange) => {
    await arrange();
    seedPlugin(database, { version: VERSION_2 });
    await expect(run(enable)).rejects.toThrow(/^plugin_dynamic_rollout_unavailable$/u);
  });

  it.each([
    ['a staging manifest', "UPDATE plugin_runner_dynamic_worker_manifests SET state = 'staging'"],
    ['a revoked manifest', "UPDATE plugin_runner_dynamic_worker_manifests SET state = 'revoked'"],
    [
      'a revoked release',
      "UPDATE plugin_runner_dynamic_worker_releases SET state = 'revoked' WHERE version_digest = '" +
        VERSION_2 +
        "'",
    ],
  ])('is unavailable with %s', async (_label, sql) => {
    await enabledTenant('tenant-a');
    seedPlugin(database, { version: VERSION_2 });
    database.exec(sql);
    await expect(run(enable)).rejects.toThrow(/^plugin_dynamic_rollout_unavailable$/u);
  });

  it('is unavailable when the plugin has no manifest', async () => {
    await enabledTenant('tenant-a');
    database.exec('DELETE FROM plugin_runner_dynamic_worker_manifests');
    await expect(run(enable)).rejects.toThrow(/^plugin_dynamic_rollout_unavailable$/u);
  });

  describe('credential compatibility of the target release', () => {
    const publishV2 = () =>
      seedPlugin(database, {
        version: VERSION_2,
        slots: [
          { configKey: 'apiKey', required: true },
          {
            configKey: 'opt',
            required: false,
            destinationHost: 'opt.example.com',
            injectionKind: 'header',
            injectionName: 'X-Opt',
          },
        ],
      });
    const tenant = async () => {
      const id = await enabledTenant('tenant-a');
      publishV2();
      return id;
    };
    const CREDENTIALS = /^plugin_dynamic_rollout_credentials_required$/u;
    it('requires the required credential to be configured', async () => {
      await tenant();
      await expect(run(enable)).rejects.toThrow(CREDENTIALS);
      expect(artifactRows()).toHaveLength(1);
    });
    it.each([
      ['another host', { host: 'evil.example.com' }],
      ['another kind', { kind: 'header' as const, name: 'X-Key' }],
      ['another name', { kind: 'header' as const, name: 'Authorization-2' }],
    ])('rejects a configured credential with %s', async (_label, options) => {
      const id = await tenant();
      seedConfig(database, id, 'apiKey', options);
      await expect(run(enable)).rejects.toThrow(CREDENTIALS);
    });
    it('rejects an optional credential configured against another destination', async () => {
      const id = await tenant();
      seedConfig(database, id, 'apiKey');
      seedConfig(database, id, 'opt', { kind: 'header', name: 'X-Opt', host: 'wrong.example.com' });
      await expect(run(enable)).rejects.toThrow(CREDENTIALS);
    });
    it('ignores credentials stored at an older config version', async () => {
      const id = await tenant();
      database.exec(`UPDATE plugin_runner_installations SET config_version = 2`);
      seedConfig(database, id, 'apiKey', { version: 1 });
      await expect(run(enable)).rejects.toThrow(CREDENTIALS);
    });
    it('accepts matching credentials, comparing the injection name case-insensitively', async () => {
      const id = await tenant();
      seedConfig(database, id, 'apiKey', { name: 'AUTHORIZATION' });
      seedConfig(database, id, 'opt', { kind: 'header', name: 'x-opt', host: 'opt.example.com' });
      await expect(run(enable)).resolves.toMatchObject({ pinnedVersionDigest: VERSION_2 });
    });
    it.each([
      ['a missing answer', null],
      ['an unreadable count', { mismatch_count: 'x' }],
      ['a fractional count', { mismatch_count: 0.5 }],
    ])('fails closed on %s', async (_label, value) => {
      await tenant();
      await expect(
        run(enable, {
          intercept: (call) => (call.sql.includes('AS mismatch_count') ? { value } : undefined),
        })
      ).rejects.toThrow(CREDENTIALS);
    });
    it('reads the mismatch count delivered as a string zero', async () => {
      await tenant();
      await expect(
        run(enable, {
          intercept: (call) =>
            call.sql.includes('AS mismatch_count') ? { value: { mismatch_count: '0' } } : undefined,
        })
      ).resolves.toMatchObject({ pinnedVersionDigest: VERSION_2 });
    });
  });

  describe('lost or partial batches', () => {
    const arrange = async () => {
      const id = await enabledTenant('tenant-a');
      seedPlugin(database, { version: VERSION_2 });
      return id;
    };
    it('adopts a batch whose response was lost after it committed', async () => {
      await arrange();
      await expect(
        run(enable, {
          afterBatch: () => {
            throw new Error('response_lost');
          },
        })
      ).resolves.toMatchObject({ pinnedVersionDigest: VERSION_2 });
    });
    it.each([
      ['a short batch', [ok, ok]],
      ['a failed statement', [ok, { ...ok, success: false }, ok]],
      ['an unchanged row', [ok, ok, { ...ok, meta: { changes: 0 } }]],
    ])('reports %s when the pin did not move', async (_label, results) => {
      await arrange();
      await expect(
        run(enable, {
          intercept: (call) => (call.kind === 'batch' ? { value: results } : undefined),
        })
      ).rejects.toThrow(/^plugin_dynamic_installation_batch_failed$/u);
    });
    it('surfaces the storage error when the pin did not move', async () => {
      await arrange();
      await expect(
        run(enable, {
          intercept: (call) => {
            if (call.kind === 'batch') throw new Error('d1_overloaded');
            return undefined;
          },
        })
      ).rejects.toThrow(/^d1_overloaded$/u);
    });
    it('reports a generic rollout failure for a non-Error throw when the pin did not move', async () => {
      await arrange();
      await expect(
        run(enable, {
          intercept: (call) => {
            if (call.kind === 'batch') throw 'opaque' as unknown as Error;
            return undefined;
          },
        })
      ).rejects.toThrow(/^plugin_dynamic_rollout_batch_failed$/u);
    });
    it('rejects a reflection that does not show the target release', async () => {
      await arrange();
      await expect(
        run(enable, {
          intercept: (call) => (call.kind === 'batch' ? { value: [ok, ok, ok] } : undefined),
        })
      ).rejects.toThrow(/^plugin_dynamic_rollout_reflection_invalid$/u);
    });
  });
});

describe('rollout keeps the tenant choice', () => {
  const enable = { tenantId: 'tenant-a', pluginId: 'plugin-a', enabled: true };
  it('moves the pin of a tenant-disabled installation without enabling it', async () => {
    const id = await seedInstallation(database, { state: 'disabled' });
    seedArtifact(database, id, VERSION_1);
    seedPlugin(database, { version: VERSION_2 });
    await expect(store().store.rollout(enable)).resolves.toEqual({
      installationId: id,
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      state: 'disabled',
      configVersion: 1,
      pinnedVersionDigest: VERSION_2,
    });
    expect(rows(database, 'SELECT state, updated_at FROM plugin_runner_installations')).toEqual([
      { state: 'disabled', updated_at: NOW },
    ]);
  });
  it('reports a disabled installation that is already current as disabled', async () => {
    const id = await seedInstallation(database, { state: 'disabled' });
    seedArtifact(database, id, VERSION_1);
    await expect(store().store.rollout(enable)).resolves.toMatchObject({
      state: 'disabled',
      pinnedVersionDigest: VERSION_1,
    });
  });
  it('keeps an enabled installation enabled', async () => {
    await enabledTenant('tenant-a');
    seedPlugin(database, { version: VERSION_2 });
    await expect(store().store.rollout(enable)).resolves.toMatchObject({ state: 'enabled' });
  });
});

describe('rollout racing a disable', () => {
  const enable = { tenantId: 'tenant-a', pluginId: 'plugin-a', enabled: true };
  it('keeps the old pin when the tenant disables the installation after it was read', async () => {
    const id = await enabledTenant('tenant-a');
    seedPlugin(database, { version: VERSION_2 });
    await expect(
      store({
        intercept: (call) => {
          if (call.kind === 'batch') {
            database.exec("UPDATE plugin_runner_installations SET state = 'disabled'");
          }
          return undefined;
        },
      }).store.rollout(enable)
    ).rejects.toThrow(/^plugin_dynamic_installation_batch_failed$/u);
    expect(
      rows(
        database,
        'SELECT artifact_id, version_digest, state, activated_at FROM plugin_runner_dynamic_worker_artifacts'
      )
    ).toEqual([
      {
        artifact_id: artifactIdFor(id, VERSION_1),
        version_digest: VERSION_1,
        state: 'active',
        activated_at: 1,
      },
    ]);
    expect(rows(database, 'SELECT state FROM plugin_runner_installations')).toEqual([
      { state: 'disabled' },
    ]);
  });
  it('keeps the old pin when a disabled installation is enabled after it was read', async () => {
    const id = await seedInstallation(database, { state: 'disabled' });
    seedArtifact(database, id, VERSION_1);
    seedPlugin(database, { version: VERSION_2 });
    await expect(
      store({
        intercept: (call) => {
          if (call.kind === 'batch') {
            database.exec("UPDATE plugin_runner_installations SET state = 'enabled'");
          }
          return undefined;
        },
      }).store.rollout(enable)
    ).rejects.toThrow();
    expect(
      rows<{ version_digest: string }>(
        database,
        "SELECT version_digest FROM plugin_runner_dynamic_worker_artifacts WHERE state = 'active'"
      )
    ).toEqual([{ version_digest: VERSION_1 }]);
  });
});
