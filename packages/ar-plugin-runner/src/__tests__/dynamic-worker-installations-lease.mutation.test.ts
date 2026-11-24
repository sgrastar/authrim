import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { D1DynamicPluginInstallationStore } from '../dynamic-worker-installations';
import {
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

async function enabledTenant(tenantId: string, version = VERSION_1): Promise<string> {
  const id = await seedInstallation(database, { tenantId, state: 'enabled' });
  seedArtifact(database, id, version);
  return id;
}

beforeEach(() => {
  database = openRunnerDatabase();
  seedPlugin(database);
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
  describe('operation identity and lease', () => {
    it('refuses to reuse an operation id for another plugin', async () => {
      await store().store.rolloutBatch(batch());
      seedPlugin(database, { pluginId: 'plugin-b' });
      await expect(store().store.rolloutBatch(batch({ pluginId: 'plugin-b' }))).rejects.toThrow(
        /^plugin_dynamic_rollout_idempotency_conflict$/u
      );
    });
    it.each(['completed', 'completed_with_errors', 'blocked'])(
      'replays a %s operation without touching it',
      async (state) => {
        await store().store.rolloutBatch(batch());
        database.exec(
          `UPDATE plugin_runner_dynamic_worker_rollouts SET state = '${state}', succeeded_count = 4, failed_count = 1, blocked_count = 2, cursor_installation_id = 'c1', last_error_code = 'plugin_dynamic_rollout_failed'`
        );
        const { store: s, calls } = store();
        await expect(s.rolloutBatch(batch())).resolves.toEqual({
          operationId: 'op-1',
          pluginId: 'plugin-a',
          targetVersionDigest: VERSION_1,
          state,
          cursorInstallationId: 'c1',
          processedThisBatch: 0,
          succeededCount: 4,
          blockedCount: 2,
          failedCount: 1,
          hasMore: false,
          lastErrorCode: 'plugin_dynamic_rollout_failed',
        });
        expect(calls.filter((c) => c.kind === 'run' || c.kind === 'batch')).toEqual([]);
      }
    );
    it('reports a concurrent insert failure as in progress', async () => {
      await expect(
        store({
          intercept: (call) => {
            if (call.kind === 'run' && call.sql.includes('INSERT OR IGNORE'))
              throw new Error('busy');
            return undefined;
          },
        }).store.rolloutBatch(batch())
      ).rejects.toThrow(/^plugin_dynamic_rollout_in_progress$/u);
    });
    it('reports a vanished operation as in progress', async () => {
      await expect(
        store({
          intercept: (call) =>
            call.kind === 'run' && call.sql.includes('INSERT OR IGNORE')
              ? { value: ok }
              : undefined,
        }).store.rolloutBatch(batch())
      ).rejects.toThrow(/^plugin_dynamic_rollout_in_progress$/u);
    });
    it('records the target digest and a running state on creation', async () => {
      const { store: s, calls } = store({
        intercept: (call) => {
          if (
            call.kind === 'run' &&
            call.sql.includes('UPDATE plugin_runner_dynamic_worker_rollouts')
          ) {
            throw new Error('stop');
          }
          return undefined;
        },
      });
      await expect(s.rolloutBatch(batch())).rejects.toThrow('stop');
      const insert = calls.find((c) => c.sql.includes('INSERT OR IGNORE'));
      expect(insert?.values).toEqual(['op-1', 'plugin-a', VERSION_1, NOW, NOW]);
    });
    it('takes a random lease for 120 seconds and bumps the fence', async () => {
      const { store: s, calls } = store();
      await s.rolloutBatch(batch());
      const lease = must(calls.find((c) => c.sql.includes('SET lease_owner = ?')));
      expect(lease.values[0]).toMatch(/^rollout-[0-9a-f-]{36}$/u);
      expect(lease.values.slice(1)).toEqual([NOW + 120, NOW, 'op-1', NOW]);
      const second = store();
      await second.store.rolloutBatch(batch({ operationId: 'op-2' }));
      const other = must(second.calls.find((c) => c.sql.includes('SET lease_owner = ?')));
      expect(other.values[0]).not.toBe(lease.values[0]);
    });
    it('refuses while another worker holds a live lease', async () => {
      await store().store.rolloutBatch(batch());
      database.exec(
        `UPDATE plugin_runner_dynamic_worker_rollouts SET state = 'running', lease_owner = 'other', lease_until = ${NOW + 1}`
      );
      await expect(store().store.rolloutBatch(batch())).rejects.toThrow(
        /^plugin_dynamic_rollout_in_progress$/u
      );
      expect(operation()).toMatchObject({ lease_owner: 'other', lease_until: NOW + 1 });
    });
    it('takes over a lease that expires exactly now', async () => {
      await store().store.rolloutBatch(batch());
      database.exec(
        `UPDATE plugin_runner_dynamic_worker_rollouts SET state = 'running', lease_owner = 'other', lease_until = ${NOW}`
      );
      await expect(store().store.rolloutBatch(batch())).resolves.toMatchObject({
        state: 'completed',
      });
    });
    it('does not unblock a live lease when the target changed', async () => {
      await store().store.rolloutBatch(batch());
      seedPlugin(database, { version: VERSION_2 });
      database.exec(
        `UPDATE plugin_runner_dynamic_worker_rollouts SET state = 'running', lease_owner = 'other', lease_until = ${NOW + 5}`
      );
      await expect(store().store.rolloutBatch(batch())).rejects.toThrow(
        /^plugin_dynamic_rollout_target_changed$/u
      );
      expect(operation()).toMatchObject({ state: 'running', lease_owner: 'other' });
    });
    it('blocks a leaseless operation whose target moved', async () => {
      await store().store.rolloutBatch(batch());
      database.exec("UPDATE plugin_runner_dynamic_worker_rollouts SET state = 'running'");
      seedPlugin(database, { version: VERSION_2 });
      await expect(store().store.rolloutBatch(batch())).rejects.toThrow(
        /^plugin_dynamic_rollout_target_changed$/u
      );
      expect(operation()).toMatchObject({
        state: 'blocked',
        last_error_code: 'plugin_dynamic_rollout_target_changed',
        updated_at: NOW,
      });
    });
    it('blocks a running operation whose release is no longer published', async () => {
      await store().store.rolloutBatch(batch());
      database.exec("UPDATE plugin_runner_dynamic_worker_rollouts SET state = 'running'");
      database.exec("UPDATE plugin_runner_dynamic_worker_releases SET state = 'revoked'");
      await expect(store().store.rolloutBatch(batch())).rejects.toThrow(
        /^plugin_dynamic_rollout_target_changed$/u
      );
      expect(operation()).toMatchObject({ state: 'blocked' });
    });
    it('blocks a running operation whose manifest was withdrawn', async () => {
      await store().store.rolloutBatch(batch());
      database.exec("UPDATE plugin_runner_dynamic_worker_rollouts SET state = 'running'");
      database.exec("UPDATE plugin_runner_dynamic_worker_manifests SET state = 'revoked'");
      await expect(store().store.rolloutBatch(batch())).rejects.toThrow(
        /^plugin_dynamic_rollout_target_changed$/u
      );
    });
    it('detects a lease lost to another owner right after taking it', async () => {
      let lookups = 0;
      const { store: s, calls } = store({
        intercept: (call) => {
          if (
            call.kind === 'first' &&
            call.sql.includes('FROM plugin_runner_dynamic_worker_rollouts')
          ) {
            lookups += 1;
            if (lookups === 3) {
              return {
                value: { ...must(operation()), lease_owner: 'someone-else' },
              };
            }
          }
          return undefined;
        },
      });
      await expect(s.rolloutBatch(batch())).rejects.toThrow(/^plugin_dynamic_rollout_lease_lost$/u);
      expect(calls.some((c) => c.kind === 'all')).toBe(false);
      expect(operation()).toMatchObject({ last_error_code: null });
    });
    it.each([0, -1, 1.5, 'x'])('rejects a lease fence of %j', async (fence) => {
      let owner = '';
      let lookups = 0;
      const { store: s, calls } = store({
        intercept: (call) => {
          if (call.kind === 'run' && call.sql.includes('SET lease_owner = ?')) {
            owner = String(call.values[0]);
          }
          if (
            call.kind === 'first' &&
            call.sql.includes('FROM plugin_runner_dynamic_worker_rollouts')
          ) {
            lookups += 1;
            if (lookups === 3) {
              return { value: { ...must(operation()), lease_owner: owner, lease_fence: fence } };
            }
          }
          return undefined;
        },
      });
      await expect(s.rolloutBatch(batch())).rejects.toThrow(/^plugin_dynamic_rollout_lease_lost$/u);
      expect(calls.some((c) => c.kind === 'all')).toBe(false);
      expect(operation()).toMatchObject({ last_error_code: null });
    });
    it('detects a lease that is gone when the batch finishes', async () => {
      await enabledTenant('t1');
      let owner = '';
      let lookups = 0;
      const { store: s } = store({
        intercept: (call) => {
          if (call.kind === 'run' && call.sql.includes('SET lease_owner = ?')) {
            owner = String(call.values[0]);
          }
          if (
            call.kind === 'first' &&
            call.sql.includes('FROM plugin_runner_dynamic_worker_rollouts')
          ) {
            lookups += 1;
            if (lookups === 4)
              return { value: { ...must(operation()), lease_owner: `${owner}-x` } };
          }
          return undefined;
        },
      });
      await expect(s.rolloutBatch(batch())).rejects.toThrow(/^plugin_dynamic_rollout_lease_lost$/u);
    });
    it('detects a lease that cannot be released', async () => {
      const { store: s } = store({
        intercept: (call) =>
          call.kind === 'run' && call.sql.includes('SET state = ?, lease_owner = NULL')
            ? { value: { success: true, results: [], meta: { changes: 0 } } }
            : undefined,
      });
      await expect(s.rolloutBatch(batch())).rejects.toThrow(/^plugin_dynamic_rollout_lease_lost$/u);
    });
    it('rejects a finished operation that cannot be re-read', async () => {
      let lookups = 0;
      const { store: s } = store({
        intercept: (call) => {
          if (
            call.kind === 'first' &&
            call.sql.includes('FROM plugin_runner_dynamic_worker_rollouts')
          ) {
            lookups += 1;
            if (lookups === 5) return { value: null };
          }
          return undefined;
        },
      });
      await expect(s.rolloutBatch(batch())).rejects.toThrow(
        /^plugin_dynamic_rollout_reflection_invalid$/u
      );
    });
  });

  describe('operation rows read back from storage', () => {
    const replay = async (over: Record<string, unknown>) => {
      await store().store.rolloutBatch(batch());
      const row = must(operation());
      return store({
        intercept: (call) =>
          call.kind === 'first' && call.sql.includes('FROM plugin_runner_dynamic_worker_rollouts')
            ? { value: { ...row, state: 'completed', ...over } }
            : undefined,
      }).store.rolloutBatch(batch());
    };
    const INVALID = /^plugin_dynamic_rollout_reflection_invalid$/u;
    it.each([
      ['an unknown state', { state: 'paused' }],
      ['a negative success count', { succeeded_count: -1 }],
      ['a fractional block count', { blocked_count: 1.5 }],
      ['a textual failure count', { failed_count: 'x' }],
      ['a short target digest', { target_version_digest: 'a'.repeat(63) }],
      ['an uppercase target digest', { target_version_digest: 'A'.repeat(64) }],
      ['a target digest with a suffix', { target_version_digest: `${'a'.repeat(64)}0` }],
      ['an unstable error code', { last_error_code: 'Bad Code' }],
      ['an error code with a prefix', { last_error_code: 'x plugin_dynamic_a' }],
      ['an error code with a suffix', { last_error_code: 'plugin_dynamic_a-b' }],
    ])('rejects %s', async (_label, over) => {
      await expect(replay(over)).rejects.toThrow(INVALID);
    });
    it('accepts zero counts and numeric strings', async () => {
      await expect(
        replay({ succeeded_count: '0', blocked_count: '3', failed_count: 0 })
      ).resolves.toMatchObject({ succeededCount: 0, blockedCount: 3, failedCount: 0 });
    });
  });
});

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing value');
  return value;
}
