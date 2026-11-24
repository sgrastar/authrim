import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { D1PluginRunnerStateRepository, type ClaimedRunnerShard } from '../registry-state';
import { rows } from './helpers/dynamic-plugin-seed';
import { createD1, openRunnerDatabase, type D1Options } from './helpers/sqlite-d1';

let database: DatabaseSync;
function repository(options: D1Options = {}) {
  const d1 = createD1(database, options);
  return { repository: new D1PluginRunnerStateRepository(d1.db), calls: d1.calls };
}
const shard = (index: number, over: Record<string, unknown> = {}) => ({
  shardId: `shard-${String(index).padStart(4, '0')}`,
  bindingRef: `TEST_TDB_USERS_${String(index).padStart(4, '0')}_CORE`,
  dataRole: 'tenant_core/users' as const,
  residencyPartition: 'jp',
  routeGeneration: 3,
  ...over,
});
const registry = (generation: number, count: number) =>
  ({ generation, shards: Array.from({ length: count }, (_, i) => shard(i)) }) as never;
const state = () =>
  database.prepare('SELECT * FROM plugin_runner_registry_state').get() as Record<string, unknown>;
const shardRows = () =>
  rows<Record<string, unknown>>(
    database,
    'SELECT * FROM plugin_runner_registry_shards ORDER BY tenant_shard_id'
  );
const cursorRows = () =>
  rows<Record<string, unknown>>(
    database,
    'SELECT * FROM plugin_runner_shard_cursors ORDER BY tenant_shard_id'
  );

beforeEach(() => {
  database = openRunnerDatabase();
});

describe('advanceSweep', () => {
  const advance = (reg: unknown, now = 1_000, options: D1Options = {}) =>
    repository(options).repository.advanceSweep(reg as never, now);
  it.each([0, -1, 1.5, Number.NaN])('refuses a clock value of %s', async (now) => {
    await expect(advance(registry(1, 1), now)).rejects.toThrow(
      /^plugin_runner_registry_now_invalid$/u
    );
  });
  it('needs the sessions API and a state row', async () => {
    await expect(advance(registry(1, 1), 1_000, { withoutSession: true })).rejects.toThrow(
      /^plugin_runner_state_d1_session_required$/u
    );
    database.exec('DELETE FROM plugin_runner_registry_state');
    await expect(advance(registry(1, 1))).rejects.toThrow(
      /^plugin_runner_registry_state_missing$/u
    );
  });
  it('records a first generation in one pass, with a cursor for every shard', async () => {
    await expect(advance(registry(1, 3))).resolves.toMatchObject({
      generation: 1,
      startIndex: 0,
      nextIndex: 3,
      complete: true,
      overdue: false,
    });
    expect(state()).toMatchObject({
      active_generation: 1,
      pending_generation: null,
      pending_cursor: 0,
      pending_shard_count: 0,
      sweep_completed_at: 1_000,
      sweep_overdue: 0,
      last_error_code: null,
      updated_at: 1_000,
    });
    expect(shardRows()).toEqual(
      [0, 1, 2].map((i) => ({
        tenant_shard_id: `shard-000${i}`,
        binding_ref: `TEST_TDB_USERS_000${i}_CORE`,
        data_role: 'tenant_core/users',
        residency_partition: 'jp',
        route_generation: 3,
        registry_generation: 1,
        active: 1,
        updated_at: 1_000,
      }))
    );
    expect(cursorRows()).toMatchObject(
      [0, 1, 2].map((i) => ({
        tenant_shard_id: `shard-000${i}`,
        next_due_at: null,
        last_scan_at: null,
        last_generation: 3,
        cursor_json: '{}',
        consecutive_error_count: 0,
        fencing_token: 0,
        updated_at: 1_000,
      }))
    );
  });
  it('returns the shards of the page it handled', async () => {
    const result = await advance(registry(1, 2));
    expect(result?.shards.map((s) => s.shardId)).toEqual(['shard-0000', 'shard-0001']);
  });
  it('works through a large registry in pages of 200 and chunks its statements by 90', async () => {
    const reg = registry(1, 450);
    const first = repository();
    await expect(first.repository.advanceSweep(reg, 1_000)).resolves.toMatchObject({
      startIndex: 0,
      nextIndex: 200,
      complete: false,
    });
    const batch = first.calls.filter((c) => c.kind === 'batch').at(-1);
    expect(
      batch?.sql.split('\n;\n').filter((sql) => sql.includes('INTO plugin_runner_shard_cursors'))
    ).toHaveLength(3);
    expect(state()).toMatchObject({
      active_generation: 0,
      pending_generation: 1,
      pending_cursor: 200,
      pending_shard_count: 450,
      sweep_started_at: 1_000,
      sweep_completed_at: null,
    });
    await expect(advance(reg, 1_010)).resolves.toMatchObject({
      startIndex: 200,
      nextIndex: 400,
      complete: false,
    });
    await expect(advance(reg, 1_020)).resolves.toMatchObject({
      startIndex: 400,
      nextIndex: 450,
      complete: true,
    });
    expect(state()).toMatchObject({
      active_generation: 1,
      pending_generation: null,
      sweep_completed_at: 1_020,
    });
    expect(shardRows()).toHaveLength(450);
    expect(cursorRows()).toHaveLength(450);
  });
  it('flags a sweep that took longer than five minutes as overdue', async () => {
    const reg = registry(1, 250);
    await advance(reg, 1_000);
    await expect(advance(reg, 1_300)).resolves.toMatchObject({ overdue: false, complete: true });
    database.exec(
      'UPDATE plugin_runner_registry_state SET active_generation = 0, pending_generation = 1, pending_cursor = 200, pending_shard_count = 250, sweep_started_at = 1_000, sweep_completed_at = NULL'
    );
    await expect(advance(reg, 1_301)).resolves.toMatchObject({ overdue: true, complete: true });
    expect(state()).toMatchObject({
      sweep_overdue: 1,
      last_error_code: 'plugin_runner_full_sweep_overdue',
    });
  });
  it('only marks the sweep overdue while it is still running when it is', async () => {
    const reg = registry(1, 250);
    await advance(reg, 1_000);
    await expect(advance(reg, 1_400)).resolves.toMatchObject({ overdue: true, complete: true });
  });
  it('deactivates the shards of the previous generation when a new generation starts', async () => {
    await advance(registry(1, 3));
    await advance({ generation: 2, shards: [shard(1), shard(5)] }, 2_000);
    expect(
      shardRows().map((row) => [row.tenant_shard_id, row.active, row.registry_generation])
    ).toEqual([
      ['shard-0000', 0, 1],
      ['shard-0001', 1, 2],
      ['shard-0002', 0, 1],
      ['shard-0005', 1, 2],
    ]);
    expect(state()).toMatchObject({ active_generation: 2 });
  });
  it('refuses a generation older than the active or the pending one', async () => {
    await advance(registry(2, 1));
    await expect(advance(registry(1, 1), 2_000)).rejects.toThrow(
      /^plugin_runner_registry_generation_rollback$/u
    );
    database.exec(
      'UPDATE plugin_runner_registry_state SET pending_generation = 4, pending_cursor = 0, pending_shard_count = 450, sweep_started_at = 1'
    );
    await expect(advance(registry(3, 450), 2_000)).rejects.toThrow(
      /^plugin_runner_registry_generation_rollback$/u
    );
  });
  it('does nothing between sweeps and starts a periodic re-sweep five minutes after the last one', async () => {
    await advance(registry(1, 2));
    await expect(advance(registry(1, 2), 1_299)).resolves.toBeNull();
    await expect(advance(registry(1, 2), 1_300)).resolves.toMatchObject({
      generation: 1,
      complete: true,
      startIndex: 0,
    });
    expect(state()).toMatchObject({ sweep_completed_at: 1_300 });
  });
  it('supersedes a sweep of an older pending generation', async () => {
    await advance(registry(1, 450), 1_000);
    await expect(advance(registry(2, 3), 1_100)).resolves.toMatchObject({
      generation: 2,
      startIndex: 0,
      nextIndex: 3,
      complete: true,
    });
    expect(state()).toMatchObject({ active_generation: 2, pending_generation: null });
    expect(shardRows().filter((row) => row.active === 1)).toHaveLength(3);
  });
  it('refuses a pending sweep that disagrees with the registry', async () => {
    await advance(registry(1, 450), 1_000);
    await expect(advance(registry(1, 449), 1_010)).rejects.toThrow(
      /^plugin_runner_registry_sweep_state_mismatch$/u
    );
    database.exec('UPDATE plugin_runner_registry_state SET pending_cursor = 451');
    await expect(advance(registry(1, 450), 1_010)).rejects.toThrow(
      /^plugin_runner_registry_sweep_state_mismatch$/u
    );
  });
  it.each([
    ['active_generation', 'x', 'plugin_runner_registry_active_generation_invalid'],
    ['pending_cursor', 'x', 'plugin_runner_registry_cursor_invalid'],
    ['pending_shard_count', 'x', 'plugin_runner_registry_shard_count_invalid'],
    ['pending_generation', 0, 'plugin_runner_registry_pending_generation_invalid'],
    ['sweep_started_at', 0, 'plugin_runner_registry_started_at_invalid'],
    ['sweep_completed_at', 0, 'plugin_runner_registry_completed_at_invalid'],
  ])('refuses an unreadable %s', async (column, value, code) => {
    await advance(registry(1, 2));
    await expect(
      advance(registry(1, 2), 2_000, {
        rewrite: (call, v) =>
          call.kind === 'first' && call.sql.includes('FROM plugin_runner_registry_state') && v
            ? { ...v, [column]: value }
            : v,
      })
    ).rejects.toThrow(new RegExp(`^${code}$`, 'u'));
  });
  it('reports a sweep start that did not apply', async () => {
    const none = { success: true, results: [], meta: { changes: 0 } };
    await expect(
      advance(registry(1, 1), 1_000, {
        rewrite: (call, v) =>
          call.kind === 'batch' && call.sql.includes('pending_generation IS NULL')
            ? [{ ...none, meta: { changes: 1 } }, none]
            : v,
      })
    ).rejects.toThrow(/^plugin_runner_registry_sweep_start_stale$/u);
  });
  it('reports a sweep start whose statements failed', async () => {
    await expect(
      advance(registry(1, 1), 1_000, {
        intercept: (call) =>
          call.kind === 'batch'
            ? { value: [{ success: false, results: [], meta: {} }] }
            : undefined,
      })
    ).rejects.toThrow(/^plugin_runner_registry_sweep_start_failed$/u);
  });
});

describe('claimDueShards', () => {
  const claim = (input: Record<string, unknown> = {}, options: D1Options = {}) =>
    repository(options).repository.claimDueShards({
      ownerId: 'runner-a',
      now: 1_000,
      limit: 10,
      ...input,
    });
  beforeEach(async () => {
    await repository().repository.advanceSweep(registry(1, 3), 500);
  });
  it.each([
    ['an unsafe owner', { ownerId: '-x' }],
    ['a zero clock', { now: 0 }],
    ['a zero limit', { limit: 0 }],
    ['a limit above 200', { limit: 201 }],
    ['a fractional limit', { limit: 1.5 }],
    ['an unsafe shard id', { shardIds: ['-x'] }],
    ['too many shard ids', { shardIds: Array.from({ length: 201 }, (_, i) => `s${i}`) }],
  ])('rejects %s', async (_label, input) => {
    await expect(claim(input)).rejects.toThrow(/^plugin_runner_shard_claim_input_invalid$/u);
  });
  it('claims due shards in id order, fencing each with a new token and a 45 second lease', async () => {
    await expect(claim()).resolves.toEqual(
      [0, 1, 2].map((i) => ({
        shardId: `shard-000${i}`,
        bindingRef: `TEST_TDB_USERS_000${i}_CORE`,
        dataRole: 'tenant_core/users',
        residencyPartition: 'jp',
        routeGeneration: 3,
        ownerId: 'runner-a',
        fencingToken: 1,
      }))
    );
    expect(cursorRows()).toMatchObject(
      [0, 1, 2].map(() => ({
        lease_owner: 'runner-a',
        lease_expires_at: 1_045,
        fencing_token: 1,
        updated_at: 1_000,
      }))
    );
  });
  it('honours the limit and does not claim a leased shard until its lease ends', async () => {
    await expect(claim({ limit: 2 })).resolves.toHaveLength(2);
    await expect(claim({ ownerId: 'runner-b' })).resolves.toMatchObject([
      { shardId: 'shard-0002' },
    ]);
    await expect(claim({ ownerId: 'runner-c', now: 1_044 })).resolves.toEqual([]);
    await expect(claim({ ownerId: 'runner-c', now: 1_045 })).resolves.toHaveLength(3);
    expect(cursorRows().map((row) => row.fencing_token)).toEqual([2, 2, 2]);
  });
  it('skips shards that are not due yet and those of an inactive generation', async () => {
    database.exec(
      "UPDATE plugin_runner_shard_cursors SET next_due_at = 2000 WHERE tenant_shard_id = 'shard-0000'"
    );
    database.exec(
      "UPDATE plugin_runner_registry_shards SET active = 0 WHERE tenant_shard_id = 'shard-0001'"
    );
    await expect(claim()).resolves.toMatchObject([{ shardId: 'shard-0002' }]);
    await expect(claim({ ownerId: 'runner-b', now: 2_000, limit: 2 })).resolves.toMatchObject([
      { shardId: 'shard-0002' },
      { shardId: 'shard-0000' },
    ]);
  });
  it('orders by due time before id', async () => {
    database.exec(
      "UPDATE plugin_runner_shard_cursors SET next_due_at = 900 WHERE tenant_shard_id = 'shard-0002'"
    );
    database.exec(
      "UPDATE plugin_runner_shard_cursors SET next_due_at = 800 WHERE tenant_shard_id = 'shard-0001'"
    );
    await expect(claim({ limit: 3 })).resolves.toMatchObject([
      { shardId: 'shard-0000' },
      { shardId: 'shard-0001' },
      { shardId: 'shard-0002' },
    ]);
  });
  it('claims exactly the requested shards regardless of their due time', async () => {
    database.exec('UPDATE plugin_runner_shard_cursors SET next_due_at = 9000');
    await expect(
      claim({ shardIds: ['shard-0002', 'shard-0000'], limit: 5 })
    ).resolves.toMatchObject([{ shardId: 'shard-0000' }, { shardId: 'shard-0002' }]);
    await expect(
      claim({ ownerId: 'runner-b', shardIds: ['shard-0000'], limit: 5 })
    ).resolves.toEqual([]);
  });
  it('applies the limit across the requested shards in id order', async () => {
    await expect(
      claim({ shardIds: ['shard-0002', 'shard-0001', 'shard-0000'], limit: 2 })
    ).resolves.toMatchObject([{ shardId: 'shard-0000' }, { shardId: 'shard-0001' }]);
  });
  it('treats an empty list of requested shards as no restriction', async () => {
    await expect(claim({ shardIds: [] })).resolves.toHaveLength(3);
  });
  it('reads requested shards in chunks of ninety', async () => {
    const repo = repository();
    await repo.repository.advanceSweep(registry(2, 200), 600);
    const ids = Array.from({ length: 200 }, (_, i) => `shard-${String(i).padStart(4, '0')}`);
    const result = await repo.repository.claimDueShards({
      ownerId: 'runner-a',
      now: 1_000,
      limit: 150,
      shardIds: ids,
    });
    expect(result).toHaveLength(150);
    expect(result.map((c) => c.shardId)).toEqual(ids.slice(0, 150));
  });
  it('returns nothing when no shard is due', async () => {
    database.exec('UPDATE plugin_runner_shard_cursors SET next_due_at = 5000');
    await expect(claim()).resolves.toEqual([]);
  });
  it.each([
    ['an unsafe id', { tenant_shard_id: 'bad id' }],
    ['a malformed binding', { binding_ref: 'plain' }],
    ['an unknown data role', { data_role: 'other' }],
    ['an unreadable fencing token', { fencing_token: 'x' }],
  ])('refuses a candidate with %s', async (_label, patch) => {
    await expect(
      claim(
        {},
        {
          rewrite: (call, v) =>
            call.kind === 'all' && call.sql.includes('registry.tenant_shard_id')
              ? {
                  ...(v as { results: object[] }),
                  results: (v as { results: object[] }).results.map((row) => ({
                    ...row,
                    ...patch,
                  })),
                }
              : v,
        }
      )
    ).rejects.toThrow(/^plugin_runner_shard_(candidate_invalid|fencing_token_invalid)$/u);
  });
  it('drops candidates whose lease another worker won', async () => {
    await expect(
      claim(
        {},
        {
          intercept: (call) =>
            call.kind === 'batch'
              ? { value: [{ success: true, results: [], meta: { changes: 0 } }] }
              : undefined,
        }
      )
    ).resolves.toEqual([]);
    await expect(
      claim(
        {},
        {
          rewrite: (call, v) =>
            call.kind === 'all' && call.sql.includes('lease_owner = ?')
              ? { ...(v as object), results: [] }
              : v,
        }
      )
    ).resolves.toEqual([]);
  });
  it('refuses unreadable route generations and reflected fencing tokens', async () => {
    await expect(
      claim(
        {},
        {
          rewrite: (call, v) =>
            call.kind === 'all' && call.sql.includes('registry.tenant_shard_id')
              ? {
                  ...(v as { results: object[] }),
                  results: (v as { results: object[] }).results.map((row) => ({
                    ...row,
                    route_generation: 0,
                  })),
                }
              : v,
        }
      )
    ).rejects.toThrow(/^plugin_runner_shard_route_generation_invalid$/u);
    await expect(
      claim(
        { ownerId: 'runner-b', now: 5_000 },
        {
          rewrite: (call, v) =>
            call.kind === 'all' && call.sql.includes('lease_owner = ?')
              ? {
                  ...(v as { results: object[] }),
                  results: (v as { results: object[] }).results.map((row) => ({
                    ...row,
                    fencing_token: 0,
                  })),
                }
              : v,
        }
      )
    ).rejects.toThrow(/^plugin_runner_shard_fencing_token_invalid$/u);
  });
});

describe('finishShard', () => {
  const finish = (
    claim: ClaimedRunnerShard,
    input: Record<string, unknown> = {},
    options: D1Options = {}
  ) =>
    repository(options).repository.finishShard({
      claim,
      now: 2_000,
      nextDueAt: 2_100,
      ...input,
    });
  async function claimed(): Promise<ClaimedRunnerShard> {
    await repository().repository.advanceSweep(registry(1, 1), 500);
    const [claim] = await repository().repository.claimDueShards({
      ownerId: 'runner-a',
      now: 1_000,
      limit: 1,
    });
    if (!claim) throw new Error('no claim');
    return claim;
  }
  it.each([
    ['a zero clock', { now: 0 }],
    ['a next due time in the past', { nextDueAt: 1_999 }],
    ['a fractional next due time', { nextDueAt: 2_000.5 }],
    ['an unsafe error code', { errorCode: 'Bad Code' }],
    ['an error code starting with a digit', { errorCode: '1x' }],
    ['an over-long error code', { errorCode: `a${'b'.repeat(128)}` }],
  ])('rejects %s', async (_label, input) => {
    await expect(finish(await claimed(), input)).rejects.toThrow(
      /^plugin_runner_shard_finish_input_invalid$/u
    );
  });
  it('releases the lease and records the scan', async () => {
    const claim = await claimed();
    await finish(claim);
    expect(cursorRows()).toMatchObject([
      {
        next_due_at: 2_100,
        last_scan_at: 2_000,
        last_generation: 3,
        scheduler_error_code: null,
        consecutive_error_count: 0,
        lease_owner: null,
        lease_expires_at: null,
        updated_at: 2_000,
      },
    ]);
  });
  it('accepts a next due time equal to the clock and a missing one', async () => {
    const claim = await claimed();
    await finish(claim, { nextDueAt: 2_000 });
    expect(cursorRows()[0]).toMatchObject({ next_due_at: 2_000 });
    const second = await repository().repository.claimDueShards({
      ownerId: 'runner-b',
      now: 2_000,
      limit: 1,
    });
    await finish(second[0], { nextDueAt: null, now: 2_001 });
    expect(cursorRows()[0]).toMatchObject({ next_due_at: null });
  });
  it('counts consecutive failures and resets them on success', async () => {
    let claim = await claimed();
    await finish(claim, { errorCode: 'plugin_runner_shard_scan_failed' });
    expect(cursorRows()[0]).toMatchObject({
      scheduler_error_code: 'plugin_runner_shard_scan_failed',
      consecutive_error_count: 1,
    });
    claim = must(
      await repository().repository.claimDueShards({ ownerId: 'runner-a', now: 2_100, limit: 1 })
    )[0];
    await finish(claim, {
      errorCode: 'plugin_runner_shard_scan_failed',
      now: 2_100,
      nextDueAt: 2_200,
    });
    expect(cursorRows()[0]).toMatchObject({ consecutive_error_count: 2 });
    claim = must(
      await repository().repository.claimDueShards({ ownerId: 'runner-a', now: 2_200, limit: 1 })
    )[0];
    await finish(claim, { now: 2_200, nextDueAt: 2_300 });
    expect(cursorRows()[0]).toMatchObject({
      consecutive_error_count: 0,
      scheduler_error_code: null,
    });
  });
  it('refuses to finish with a stale fencing token or another owner', async () => {
    const claim = await claimed();
    await expect(finish({ ...claim, fencingToken: claim.fencingToken + 1 })).rejects.toThrow(
      /^plugin_runner_shard_finish_stale$/u
    );
    await expect(finish({ ...claim, ownerId: 'runner-z' })).rejects.toThrow(
      /^plugin_runner_shard_finish_stale$/u
    );
    expect(cursorRows()[0]).toMatchObject({ lease_owner: 'runner-a' });
  });
  it('adopts a finish that already happened with the same outcome, but not a different one', async () => {
    const claim = await claimed();
    await finish(claim);
    await expect(finish(claim)).resolves.toBeUndefined();
    await expect(finish(claim, { nextDueAt: 2_101 })).rejects.toThrow(
      /^plugin_runner_shard_finish_stale$/u
    );
    await expect(finish(claim, { errorCode: 'plugin_runner_shard_scan_failed' })).rejects.toThrow(
      /^plugin_runner_shard_finish_stale$/u
    );
    await expect(finish(claim, { now: 2_001, nextDueAt: 2_100 })).rejects.toThrow(
      /^plugin_runner_shard_finish_stale$/u
    );
    await expect(finish({ ...claim, fencingToken: claim.fencingToken + 1 })).rejects.toThrow(
      /^plugin_runner_shard_finish_stale$/u
    );
  });
  it('adopts a finished shard that has no next due time only for a null request', async () => {
    const claim = await claimed();
    await finish(claim, { nextDueAt: null });
    await expect(finish(claim, { nextDueAt: null })).resolves.toBeUndefined();
    await expect(finish(claim, { nextDueAt: 2_100 })).rejects.toThrow(
      /^plugin_runner_shard_finish_stale$/u
    );
  });
  it('refuses a finish for a shard that vanished', async () => {
    const claim = await claimed();
    database.exec('DELETE FROM plugin_runner_shard_cursors');
    await expect(finish(claim)).rejects.toThrow(/^plugin_runner_shard_finish_stale$/u);
  });
});

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing value');
  return value;
}
