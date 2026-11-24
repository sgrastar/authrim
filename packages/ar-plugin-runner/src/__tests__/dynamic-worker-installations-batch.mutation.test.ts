import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { D1DynamicPluginInstallationStore } from '../dynamic-worker-installations';
import {
  digest,
  installationIdFor,
  rows,
  seedArtifact,
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
const ok = { success: true, results: [], meta: { changes: 1 } };
const VERSION_3 = digest('3');

async function enabledTenant(tenantId: string, version = VERSION_1): Promise<string> {
  const id = await seedInstallation(database, { tenantId, state: 'enabled' });
  seedArtifact(database, id, version);
  return id;
}

beforeEach(() => {
  database = openRunnerDatabase();
  seedPlugin(database);
});

describe('rolloutBatch input', () => {
  const BATCH = { operationId: 'op-1', pluginId: 'plugin-a', batchSize: 5 };
  const run = (input: unknown) => store().store.rolloutBatch(input);
  it.each([
    ['null', null],
    ['array', []],
    ['extra key', { ...BATCH, extra: 1 }],
    ['missing key', { operationId: 'op-1', pluginId: 'plugin-a' }],
    ['bad operation', { ...BATCH, operationId: '' }],
    ['numeric operation', { ...BATCH, operationId: 1 }],
    ['bad plugin', { ...BATCH, pluginId: 'P' }],
    ['numeric plugin', { ...BATCH, pluginId: 1 }],
    ['zero batch', { ...BATCH, batchSize: 0 }],
    ['negative batch', { ...BATCH, batchSize: -1 }],
    ['too large batch', { ...BATCH, batchSize: 26 }],
    ['fractional batch', { ...BATCH, batchSize: 1.5 }],
    ['string batch', { ...BATCH, batchSize: '5' }],
    ['missing batch value', { ...BATCH, batchSize: undefined }],
  ])('rejects %s', async (_label, input) => {
    await expect(run(input)).rejects.toThrow(/^plugin_dynamic_rollout_batch_input_invalid$/u);
    expect(rows(database, 'SELECT * FROM plugin_runner_dynamic_worker_rollouts')).toEqual([]);
  });
  it.each([1, 25])('accepts a batch size of %i', async (batchSize) => {
    await expect(run({ ...BATCH, batchSize })).resolves.toMatchObject({ state: 'completed' });
  });
});

describe('rolloutBatch', () => {
  const batch = (over: Record<string, unknown> = {}) => ({
    operationId: 'op-1',
    pluginId: 'plugin-a',
    batchSize: 2,
    ...over,
  });
  const operation = () =>
    rows<Record<string, unknown>>(
      database,
      'SELECT * FROM plugin_runner_dynamic_worker_rollouts WHERE operation_id = ?',
      'op-1'
    )[0];
  const results = () =>
    rows<Record<string, unknown>>(
      database,
      'SELECT installation_id, tenant_id, state, error_code, updated_at FROM plugin_runner_dynamic_worker_rollout_results ORDER BY installation_id'
    );
  const ids = async (...tenants: string[]) =>
    (await Promise.all(tenants.map((tenant) => installationIdFor(tenant)))).sort();

  async function fleet(tenants: string[]): Promise<void> {
    for (const tenant of tenants) await enabledTenant(tenant);
    seedPlugin(database, { version: VERSION_2 });
  }

  it('refuses to start without an approved target release', async () => {
    database.exec('DELETE FROM plugin_runner_dynamic_worker_manifests');
    await expect(store().store.rolloutBatch(batch())).rejects.toThrow(
      /^plugin_dynamic_rollout_version_unavailable$/u
    );
    database.exec("UPDATE plugin_runner_dynamic_worker_releases SET state = 'revoked'");
    seedPlugin(database, { pluginId: 'plugin-b', manifestState: 'staging' });
    await expect(store().store.rolloutBatch(batch({ pluginId: 'plugin-b' }))).rejects.toThrow(
      /^plugin_dynamic_rollout_version_unavailable$/u
    );
  });

  it('refuses an unpublished release as the target', async () => {
    database.exec("UPDATE plugin_runner_dynamic_worker_releases SET state = 'revoked'");
    await expect(store().store.rolloutBatch(batch())).rejects.toThrow(
      /^plugin_dynamic_rollout_version_unavailable$/u
    );
  });

  it('completes immediately when nothing needs to move', async () => {
    await enabledTenant('tenant-a');
    await expect(store().store.rolloutBatch(batch())).resolves.toEqual({
      operationId: 'op-1',
      pluginId: 'plugin-a',
      targetVersionDigest: VERSION_1,
      state: 'completed',
      cursorInstallationId: null,
      processedThisBatch: 0,
      succeededCount: 0,
      blockedCount: 0,
      failedCount: 0,
      hasMore: false,
      lastErrorCode: null,
    });
    expect(operation()).toMatchObject({
      state: 'completed',
      lease_owner: null,
      lease_until: null,
      lease_fence: 1,
      created_at: NOW,
      updated_at: NOW,
    });
  });

  it('moves a bounded page of installations and resumes from its cursor', async () => {
    await fleet(['t1', 't2', 't3']);
    const all = await ids('t1', 't2', 't3');
    const first = await store().store.rolloutBatch(batch());
    expect(first).toEqual({
      operationId: 'op-1',
      pluginId: 'plugin-a',
      targetVersionDigest: VERSION_2,
      state: 'running',
      cursorInstallationId: all[1],
      processedThisBatch: 2,
      succeededCount: 2,
      blockedCount: 0,
      failedCount: 0,
      hasMore: true,
      lastErrorCode: null,
    });
    expect(results().map((row) => row.installation_id)).toEqual(all.slice(0, 2));
    expect(operation()).toMatchObject({ lease_owner: null, lease_until: null, lease_fence: 1 });
    const second = await store().store.rolloutBatch(batch());
    expect(second).toMatchObject({
      state: 'completed',
      cursorInstallationId: all[2],
      processedThisBatch: 1,
      succeededCount: 3,
      hasMore: false,
    });
    expect(operation()).toMatchObject({ lease_fence: 2 });
    expect(results()).toEqual(
      all.map((installation_id) => ({
        installation_id,
        tenant_id: expect.stringMatching(/^t[123]$/u) as unknown,
        state: 'succeeded',
        error_code: null,
        updated_at: NOW,
      }))
    );
    const pins = rows<{ version_digest: string }>(
      database,
      "SELECT version_digest FROM plugin_runner_dynamic_worker_artifacts WHERE state = 'active'"
    );
    expect(pins.map((row) => row.version_digest)).toEqual([VERSION_2, VERSION_2, VERSION_2]);
  });

  it('treats a page that exactly exhausts the fleet as complete', async () => {
    await fleet(['t1', 't2']);
    await expect(store().store.rolloutBatch(batch())).resolves.toMatchObject({
      state: 'completed',
      processedThisBatch: 2,
      hasMore: false,
    });
  });

  it('asks for one more candidate than the page size, after the cursor', async () => {
    await fleet(['t1', 't2', 't3']);
    const { store: s, calls } = store();
    await s.rolloutBatch(batch());
    const query = must(calls.find((c) => c.kind === 'all'));
    expect(query.values).toEqual(['plugin-a', VERSION_2, null, null, 3]);
    const cursor = must(operation()).cursor_installation_id;
    await s.rolloutBatch(batch());
    const second = calls.filter((c) => c.kind === 'all')[1];
    expect(second?.values).toEqual(['plugin-a', VERSION_2, cursor, cursor, 3]);
  });

  it('skips installations already on the target, disabled ones and other plugins', async () => {
    await enabledTenant('t1');
    const disabled = await seedInstallation(database, { tenantId: 't-off', state: 'disabled' });
    seedArtifact(database, disabled, VERSION_1);
    seedPlugin(database, { pluginId: 'plugin-b' });
    const other = await seedInstallation(database, {
      tenantId: 't1',
      pluginId: 'plugin-b',
      state: 'enabled',
    });
    seedArtifact(database, other, VERSION_1, 'active', 'plugin-b');
    seedPlugin(database, { version: VERSION_2 });
    await enabledTenant('t-current', VERSION_2);
    await expect(store().store.rolloutBatch(batch())).resolves.toMatchObject({
      processedThisBatch: 1,
      succeededCount: 1,
    });
    expect(results().map((row) => row.tenant_id)).toEqual(['t1']);
  });

  it('records a credential-blocked installation and finishes with errors', async () => {
    await fleet(['t1']);
    seedPlugin(database, { version: VERSION_3, slots: [{ configKey: 'apiKey', required: true }] });
    await expect(store().store.rolloutBatch(batch({ batchSize: 5 }))).resolves.toMatchObject({
      targetVersionDigest: VERSION_3,
      state: 'completed_with_errors',
      processedThisBatch: 1,
      succeededCount: 0,
      blockedCount: 1,
      failedCount: 0,
    });
    expect(results()).toMatchObject([
      {
        state: 'blocked',
        error_code: 'plugin_dynamic_rollout_credentials_required',
        tenant_id: 't1',
      },
    ]);
    expect(operation()).toMatchObject({ blocked_count: 1, succeeded_count: 0, failed_count: 0 });
  });

  it('records other per-installation failures with a stable code', async () => {
    await fleet(['t1']);
    database.exec("UPDATE plugin_runner_installations SET script_name = 'renamed'");
    const out = await store().store.rolloutBatch(batch());
    expect(out).toMatchObject({
      state: 'completed_with_errors',
      failedCount: 1,
      blockedCount: 0,
      succeededCount: 0,
    });
    expect(results()).toMatchObject([
      { state: 'failed', error_code: 'plugin_dynamic_rollout_unavailable' },
    ]);
    expect(operation()).toMatchObject({ failed_count: 1 });
  });

  it('maps a foreign error to plugin_dynamic_rollout_failed', async () => {
    await fleet(['t1']);
    const { store: s } = store({
      intercept: (call) => {
        if (
          call.kind === 'batch' &&
          call.sql.includes('UPDATE plugin_runner_dynamic_worker_artifacts')
        ) {
          throw new Error('disk exploded');
        }
        return undefined;
      },
    });
    await expect(s.rolloutBatch(batch())).resolves.toMatchObject({ failedCount: 1 });
    expect(results()).toMatchObject([
      { state: 'failed', error_code: 'plugin_dynamic_rollout_failed' },
    ]);
  });

  it('blocks the operation when the platform target moves mid-batch', async () => {
    await fleet(['t1', 't2']);
    let swapped = false;
    const { store: s } = store({
      intercept: (call) => {
        if (
          call.kind === 'all' &&
          call.sql.includes('FROM plugin_runner_installations installation')
        ) {
          if (!swapped) {
            swapped = true;
            seedPlugin(database, { version: VERSION_3 });
          }
        }
        return undefined;
      },
    });
    await expect(s.rolloutBatch(batch())).rejects.toThrow(
      /^plugin_dynamic_rollout_target_changed$/u
    );
    expect(operation()).toMatchObject({
      state: 'blocked',
      last_error_code: 'plugin_dynamic_rollout_target_changed',
      lease_owner: null,
      lease_until: null,
    });
    expect(results()).toEqual([]);
  });

  it('blocks the operation when an installation lands on a different release than the target', async () => {
    await fleet(['t1']);
    let manifestReads = 0;
    const { store: s } = store({
      intercept: (call) => {
        if (
          call.kind === 'first' &&
          call.sql.includes('FROM plugin_runner_dynamic_worker_manifests')
        ) {
          manifestReads += 1;
          // 1: start, 2: running check, 3: loop guard, 4: inside rollout.
          if (manifestReads === 4) seedPlugin(database, { version: VERSION_3 });
        }
        return undefined;
      },
    });
    await expect(s.rolloutBatch(batch())).rejects.toThrow(
      /^plugin_dynamic_rollout_target_changed$/u
    );
    expect(operation()).toMatchObject({ state: 'blocked' });
  });

  it.each([
    ['a revoked manifest', "UPDATE plugin_runner_dynamic_worker_manifests SET state = 'revoked'"],
    ['a staging manifest', "UPDATE plugin_runner_dynamic_worker_manifests SET state = 'staging'"],
    [
      'a revoked release',
      "UPDATE plugin_runner_dynamic_worker_releases SET state = 'revoked' WHERE version_digest = '" +
        VERSION_2 +
        "'",
    ],
  ])(
    'stops before moving anything when the target is withdrawn mid-batch (%s)',
    async (_label, sql) => {
      await fleet(['t1']);
      let done = false;
      const { store: s } = store({
        intercept: (call) => {
          if (
            !done &&
            call.kind === 'all' &&
            call.sql.includes('FROM plugin_runner_installations installation')
          ) {
            done = true;
            database.exec(sql);
          }
          return undefined;
        },
      });
      await expect(s.rolloutBatch(batch())).rejects.toThrow(
        /^plugin_dynamic_rollout_target_changed$/u
      );
      expect(operation()).toMatchObject({ state: 'blocked' });
      expect(
        rows<{ version_digest: string }>(
          database,
          "SELECT version_digest FROM plugin_runner_dynamic_worker_artifacts WHERE state = 'active'"
        )
      ).toEqual([{ version_digest: VERSION_1 }]);
      expect(results()).toEqual([]);
    }
  );

  it('does not move an installation when the manifest points at yet another release mid-batch', async () => {
    await fleet(['t1']);
    let done = false;
    const { store: s } = store({
      intercept: (call) => {
        if (
          !done &&
          call.kind === 'all' &&
          call.sql.includes('FROM plugin_runner_installations installation')
        ) {
          done = true;
          seedPlugin(database, { version: VERSION_3 });
        }
        return undefined;
      },
    });
    await expect(s.rolloutBatch(batch())).rejects.toThrow(
      /^plugin_dynamic_rollout_target_changed$/u
    );
    expect(
      rows<{ version_digest: string }>(
        database,
        "SELECT version_digest FROM plugin_runner_dynamic_worker_artifacts WHERE state = 'active'"
      )
    ).toEqual([{ version_digest: VERSION_1 }]);
  });

  it.each([
    ['a prefix', 'boom plugin_dynamic_x'],
    ['a suffix', 'plugin_dynamic_x-y'],
    ['uppercase', 'plugin_dynamic_X'],
  ])(
    'records plugin_dynamic_rollout_failed for an error message with %s',
    async (_label, message) => {
      await fleet(['t1']);
      const { store: s } = store({
        intercept: (call) => {
          if (
            call.kind === 'batch' &&
            call.sql.includes('UPDATE plugin_runner_dynamic_worker_artifacts')
          ) {
            throw new Error(message);
          }
          return undefined;
        },
      });
      await s.rolloutBatch(batch());
      expect(results()).toMatchObject([
        { state: 'failed', error_code: 'plugin_dynamic_rollout_failed' },
      ]);
    }
  );

  it.each([
    ['a prefix', 'boom plugin_dynamic_x'],
    ['a suffix', 'plugin_dynamic_x-y'],
  ])(
    'records plugin_dynamic_rollout_failed on the operation for a stray error with %s',
    async (_label, message) => {
      await fleet(['t1']);
      const { store: s } = store({
        intercept: (call) => {
          if (
            call.kind === 'all' &&
            call.sql.includes('FROM plugin_runner_installations installation')
          ) {
            throw new Error(message);
          }
          return undefined;
        },
      });
      await expect(s.rolloutBatch(batch())).rejects.toThrow(message);
      expect(operation()).toMatchObject({
        state: 'running',
        last_error_code: 'plugin_dynamic_rollout_failed',
      });
    }
  );

  it('records a stable code and releases the lease on other failures', async () => {
    await fleet(['t1']);
    const { store: s } = store({
      intercept: (call) =>
        call.kind === 'batch' && call.sql.includes('rollout_results') ? { value: [ok] } : undefined,
    });
    await expect(s.rolloutBatch(batch())).rejects.toThrow(
      /^plugin_dynamic_installation_batch_failed$/u
    );
    expect(operation()).toMatchObject({
      state: 'running',
      last_error_code: 'plugin_dynamic_installation_batch_failed',
      lease_owner: null,
      lease_until: null,
    });
  });

  it('masks a non-fixed error with plugin_dynamic_rollout_failed in the operation row', async () => {
    await fleet(['t1']);
    const { store: s } = store({
      intercept: (call) => {
        if (call.kind === 'batch' && call.sql.includes('rollout_results'))
          throw new Error('Disk Exploded');
        return undefined;
      },
    });
    await expect(s.rolloutBatch(batch())).rejects.toThrow(/^Disk Exploded$/u);
    expect(operation()).toMatchObject({ last_error_code: 'plugin_dynamic_rollout_failed' });
  });
});

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing value');
  return value;
}
