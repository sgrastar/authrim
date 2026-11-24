import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { D1DynamicPluginInstallationStore } from '../dynamic-worker-installations';
import {
  artifactIdFor,
  digest,
  installationIdFor,
  rows,
  seedArtifact,
  seedConfig,
  seedInstallation,
  seedPlugin,
  VERSION_1,
  VERSION_2,
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
const artifacts = () =>
  rows<Record<string, unknown>>(
    database,
    'SELECT * FROM plugin_runner_dynamic_worker_artifacts ORDER BY artifact_id'
  );

beforeEach(() => {
  database = openRunnerDatabase();
  seedPlugin(database);
});

describe('configure enabled', () => {
  const enable = (extra: Record<string, unknown> = {}) => ({ ...target, enabled: true, ...extra });
  const expectedArtifact = async (version = VERSION_1) =>
    artifactIdFor(await installationIdFor('tenant-a'), version);

  it('creates an enabled installation pinned to the active release', async () => {
    const installationId = await installationIdFor('tenant-a');
    await expect(store().store.configure(enable())).resolves.toEqual({
      installationId,
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      state: 'enabled',
      configVersion: 1,
      pinnedVersionDigest: VERSION_1,
    });
    expect(installation()).toMatchObject([
      {
        state: 'enabled',
        config_version: 1,
        pending_activation_request_id: null,
        platform_concurrency_cap: 4,
        platform_rate_per_minute: 60,
        created_at: NOW,
        updated_at: NOW,
      },
    ]);
    expect(artifacts()).toEqual([
      {
        artifact_id: await expectedArtifact(),
        installation_id: installationId,
        plugin_id: 'plugin-a',
        version_digest: VERSION_1,
        state: 'active',
        activated_at: NOW,
        updated_at: NOW,
      },
    ]);
  });

  it('commits the installation and artifact in one batch of two statements', async () => {
    const { store: s, calls } = store();
    await s.configure(enable());
    const batch = calls.filter((c) => c.kind === 'batch');
    expect(batch).toHaveLength(1);
    expect(batch[0]?.values).toEqual([
      await installationIdFor('tenant-a'),
      'tenant-a',
      'plugin-a',
      'plugin-a',
      NOW,
      NOW,
      null,
      null,
      await expectedArtifact(),
      await installationIdFor('tenant-a'),
      'plugin-a',
      VERSION_1,
      NOW,
      NOW,
    ]);
  });

  it('re-enables a disabled installation on its pinned release without a second artifact', async () => {
    const installationId = await seedInstallation(database, { state: 'disabled' });
    seedArtifact(database, installationId, VERSION_1);
    seedPlugin(database, { version: VERSION_2 });
    const { store: s, calls } = store({}, () => 2_000);
    await expect(s.configure(enable())).resolves.toMatchObject({
      state: 'enabled',
      pinnedVersionDigest: VERSION_1,
    });
    expect(artifacts()).toHaveLength(1);
    expect(calls.find((c) => c.kind === 'batch')?.values).toHaveLength(8);
    expect(installation()).toMatchObject([{ state: 'enabled', created_at: 1, updated_at: 2_000 }]);
  });

  it('activates a staged request and clears its fence', async () => {
    await seedInstallation(database, { pending: 'activation-1' });
    await expect(
      store().store.configure(enable({ activationRequestId: 'activation-1' }))
    ).resolves.toMatchObject({ state: 'enabled', pinnedVersionDigest: VERSION_1 });
    expect(installation()).toMatchObject([
      { state: 'enabled', pending_activation_request_id: null },
    ]);
  });

  it.each([
    ['a request with nothing staged', {}, enable({ activationRequestId: 'activation-1' })],
    [
      'a different staged request',
      { pending: 'activation-2' },
      enable({ activationRequestId: 'activation-1' }),
    ],
    ['a missing request while one is staged', { pending: 'activation-2' }, enable()],
    [
      'a request on an unfenced installation',
      { state: 'disabled' as const },
      enable({ activationRequestId: 'x' }),
    ],
  ])('refuses %s', async (_label, seed, input) => {
    if (Object.keys(seed).length > 0) await seedInstallation(database, seed);
    await expect(store().store.configure(input)).rejects.toThrow(
      /^plugin_dynamic_activation_request_mismatch$/u
    );
    expect(artifacts()).toEqual([]);
  });

  it.each([
    ['no manifest', () => database.exec('DELETE FROM plugin_runner_dynamic_worker_manifests')],
    [
      'staging manifest',
      () => database.exec("UPDATE plugin_runner_dynamic_worker_manifests SET state = 'staging'"),
    ],
    [
      'revoked release',
      () => database.exec("UPDATE plugin_runner_dynamic_worker_releases SET state = 'revoked'"),
    ],
  ])('refuses with %s', async (_label, mutate) => {
    mutate();
    await expect(store().store.configure(enable())).rejects.toThrow(
      /^plugin_dynamic_installation_version_unavailable$/u
    );
  });

  it('refuses when the pinned release was revoked while the manifest is still published', async () => {
    const installationId = await seedInstallation(database, { state: 'disabled' });
    seedArtifact(database, installationId, VERSION_1);
    seedPlugin(database, { version: VERSION_2 });
    database.exec(
      `UPDATE plugin_runner_dynamic_worker_releases SET state = 'revoked' WHERE version_digest = '${VERSION_1}'`
    );
    await expect(store().store.configure(enable())).rejects.toThrow(
      /^plugin_dynamic_installation_pinned_version_revoked$/u
    );
  });

  describe('required credentials', () => {
    beforeEach(() => {
      database = openRunnerDatabase();
      seedPlugin(database, { slots: [{ configKey: 'apiKey', required: true }] });
    });
    it('refuses a new installation when the release needs a credential', async () => {
      await expect(store().store.configure(enable())).rejects.toThrow(
        /^plugin_dynamic_installation_credentials_missing$/u
      );
      expect(installation()).toEqual([]);
    });
    it('refuses an existing installation without the matching stored credential', async () => {
      await seedInstallation(database, { state: 'disabled' });
      await expect(store().store.configure(enable())).rejects.toThrow(
        /^plugin_dynamic_installation_credentials_missing$/u
      );
    });
    it.each([
      ['other host', { host: 'evil.example.com' }],
      ['other kind', { kind: 'header' as const, name: 'X-Key' }],
      ['other key', { key: 'otherKey' }],
      ['other version', { version: 2 }],
    ])('refuses a stored credential with %s', async (_label, options) => {
      const id = await seedInstallation(database, { state: 'disabled', configVersion: 1 });
      const { key, ...rest } = options as { key?: string };
      seedConfig(database, id, key ?? 'apiKey', rest);
      if ('version' in rest)
        database.exec('UPDATE plugin_runner_installations SET config_version = 1');
      await expect(store().store.configure(enable())).rejects.toThrow(
        /^plugin_dynamic_installation_credentials_missing$/u
      );
    });
    it('accepts a matching credential at the current config version, comparing names case-insensitively', async () => {
      const id = await seedInstallation(database, { state: 'disabled', configVersion: 2 });
      seedConfig(database, id, 'apiKey', { version: 2, name: 'AUTHORIZATION' });
      await expect(store().store.configure(enable())).resolves.toMatchObject({
        state: 'enabled',
        configVersion: 2,
      });
    });
    it('checks credentials against the pinned release, not the newest manifest', async () => {
      const id = await seedInstallation(database, { state: 'disabled' });
      seedArtifact(database, id, VERSION_1);
      seedPlugin(database, {
        version: VERSION_2,
        slots: [
          { configKey: 'apiKey', required: true },
          { configKey: 'extra', required: true, destinationHost: 'other.example.com' },
        ],
      });
      seedConfig(database, id, 'apiKey');
      await expect(store().store.configure(enable())).resolves.toMatchObject({
        pinnedVersionDigest: VERSION_1,
      });
    });
    it('ignores optional slots', async () => {
      database = openRunnerDatabase();
      seedPlugin(database, { slots: [{ configKey: 'apiKey', required: false }] });
      await expect(store().store.configure(enable())).resolves.toMatchObject({ state: 'enabled' });
    });
    it('fails closed on an unreadable required-count', async () => {
      const { store: s } = store({
        intercept: (call) =>
          call.sql.includes('AS required_count') ? { value: { required_count: 17 } } : undefined,
      });
      await expect(s.configure(enable())).rejects.toThrow(
        /^plugin_dynamic_installation_credential_policy_invalid$/u
      );
      for (const value of [{ required_count: -1 }, { required_count: 'x' }, null]) {
        const intercepting = store({
          intercept: (call) => (call.sql.includes('AS required_count') ? { value } : undefined),
        });
        await expect(intercepting.store.configure(enable())).rejects.toThrow(
          /^plugin_dynamic_installation_credential_policy_invalid$/u
        );
      }
    });
    it('accepts a required-count of exactly sixteen as present', async () => {
      const { store: s } = store({
        intercept: (call) =>
          call.sql.includes('AS required_count') ? { value: { required_count: '16' } } : undefined,
      });
      await expect(s.configure(enable())).rejects.toThrow(
        /^plugin_dynamic_installation_credentials_missing$/u
      );
    });
    it('treats a missing-count row as a failure and a string zero as complete', async () => {
      await seedInstallation(database, { state: 'disabled' });
      const none = store({
        intercept: (call) => (call.sql.includes('AS missing_count') ? { value: null } : undefined),
      });
      await expect(none.store.configure(enable())).rejects.toThrow(
        /^plugin_dynamic_installation_credentials_missing$/u
      );
      const zero = store({
        intercept: (call) =>
          call.sql.includes('AS missing_count') ? { value: { missing_count: '0' } } : undefined,
      });
      await expect(zero.store.configure(enable())).resolves.toMatchObject({ state: 'enabled' });
    });
  });

  describe('lost or partial batches', () => {
    const ok = { success: true, results: [], meta: { changes: 1 } };
    it('adopts a batch that committed although the response was lost', async () => {
      const { store: s } = store({
        afterBatch: () => {
          throw new Error('response_lost');
        },
      });
      await expect(s.configure(enable())).resolves.toMatchObject({ state: 'enabled' });
      expect(artifacts()).toHaveLength(1);
    });
    it.each([
      ['a short batch', [ok]],
      ['a long batch', [ok, ok, ok]],
      ['a failed statement', [{ ...ok, success: false }, ok]],
      ['a statement error', [{ ...ok, error: 'boom' }, ok]],
      ['no change', [{ ...ok, meta: { changes: 0 } }, ok]],
      ['two changes', [ok, { ...ok, meta: { changes: 2 } }]],
      ['no meta changes', [ok, { ...ok, meta: {} }]],
    ])('reports %s when nothing is reflected', async (_label, results) => {
      const { store: s } = store({
        intercept: (call) => (call.kind === 'batch' ? { value: results } : undefined),
      });
      await expect(s.configure(enable())).rejects.toThrow(
        /^plugin_dynamic_installation_batch_failed$/u
      );
    });
    it('surfaces the storage error of a failed batch when nothing is reflected', async () => {
      const { store: s } = store({
        intercept: (call) => {
          if (call.kind === 'batch') throw new Error('d1_overloaded');
          return undefined;
        },
      });
      await expect(s.configure(enable())).rejects.toThrow(/^d1_overloaded$/u);
    });
    it('reports a generic batch failure for a non-Error throw when nothing is reflected', async () => {
      const { store: s } = store({
        intercept: (call) => {
          if (call.kind === 'batch') throwOpaque('opaque');
          return undefined;
        },
      });
      await expect(s.configure(enable())).rejects.toThrow(
        /^plugin_dynamic_installation_batch_failed$/u
      );
    });
    it('adopts rows that are already reflected even when the batch reports a partial result', async () => {
      const id = await seedInstallation(database, { state: 'enabled' });
      seedArtifact(database, id, VERSION_1);
      const { store: s } = store({
        intercept: (call) => (call.kind === 'batch' ? { value: [ok] } : undefined),
      });
      await expect(s.configure(enable())).resolves.toMatchObject({
        state: 'enabled',
        pinnedVersionDigest: VERSION_1,
      });
    });
    it.each([
      ['a still-fenced installation', { state: 'enabled' as const, pending: 'x' }, true],
      ['a disabled installation', { state: 'disabled' as const }, true],
      ['an enabled installation with no artifact', { state: 'enabled' as const }, false],
    ])('rejects a reflection with %s', async (_label, seed, withArtifact) => {
      const id = await seedInstallation(database, seed);
      if (withArtifact) seedArtifact(database, id, VERSION_1);
      const { store: s } = store({
        intercept: (call) =>
          call.kind === 'batch' ? { value: withArtifact ? [ok] : [ok, ok] } : undefined,
      });
      await expect(
        s.configure(enable('pending' in seed ? { activationRequestId: 'x' } : {}))
      ).rejects.toThrow(/^plugin_dynamic_installation_reflection_invalid$/u);
    });
    it('rejects a reflection whose pinned release was revoked meanwhile', async () => {
      const id = await seedInstallation(database, { state: 'enabled' });
      seedArtifact(database, id, VERSION_1);
      const { store: s } = store({
        intercept: (call) => {
          if (call.kind !== 'batch') return undefined;
          database.exec("UPDATE plugin_runner_dynamic_worker_releases SET state = 'revoked'");
          return { value: [ok] };
        },
      });
      await expect(s.configure(enable())).rejects.toThrow(
        /^plugin_dynamic_installation_reflection_invalid$/u
      );
    });
  });

  it('derives distinct artifact identities per installation and release', async () => {
    expect(artifactIdFor('a', digest('1'))).not.toBe(artifactIdFor('b', digest('1')));
    expect(artifactIdFor('a', digest('1'))).not.toBe(artifactIdFor('a', digest('2')));
  });
});
