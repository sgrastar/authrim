import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTHRIM_MIGRATION_HISTORY_SQL } from '../migration-history-contract.js';
import {
  DB,
  FakeD1,
  PIN,
  checksum,
  errorOf,
  file,
  makeEngine,
  release,
} from './migration-engine-fixtures.js';

const mappingStatements = vi.hoisted(() => vi.fn());
vi.mock('../../mapping-graph-migration', () => ({
  mappingGraphMigrationStatements: mappingStatements,
}));

beforeEach(() => {
  mappingStatements.mockReset();
});

const run = (d1: FakeD1, files = [file('001_a.sql', 1)]) =>
  makeEngine(release(files), d1).apply({ databaseId: DB, pin: PIN });

describe('apply: lost responses on a migration batch', () => {
  it.each(['throw', 'unsuccess', 'short'] as const)(
    'recovers when the %s outcome hid a committed write',
    async (outcome) => {
      const d1 = new FakeD1();
      d1.faults = [{ kind: 'migration', outcome, apply: true }];
      const result = await run(d1);
      expect(result).toMatchObject({ appliedFiles: 1, skippedFiles: 0, responseLossRecoveries: 1 });
      expect(d1.batches).toHaveLength(2);
      expect(d1.queries.filter((q) => q.sql === AUTHRIM_MIGRATION_HISTORY_SQL)).toHaveLength(2);
    }
  );

  it('rethrows the original failure when the write did not commit', async () => {
    const d1 = new FakeD1();
    d1.faults = [{ kind: 'migration', outcome: 'throw', apply: false }];
    expect(await errorOf(run(d1))).toBe('d1_transport_error');
    expect(d1.sentinel).toBeUndefined();
    expect(d1.batches).toHaveLength(1);
  });

  it('reports a checksum mismatch when the committed row differs', async () => {
    const d1 = new FakeD1();
    d1.faults = [{ kind: 'migration', outcome: 'throw', apply: false }];
    let historyCalls = 0;
    d1.queryFault = (sql) => {
      if (sql !== AUTHRIM_MIGRATION_HISTORY_SQL) return undefined;
      historyCalls += 1;
      return historyCalls === 1
        ? undefined
        : [
            {
              success: true,
              results: [{ filename: '001_a.sql', checksum: checksum(8), applied_at: 1 }],
            },
          ];
    };
    expect(await errorOf(run(d1))).toBe('migration_history_checksum_mismatch');
  });

  it.each([
    ['verification query fails', [{ success: false, results: [] }]],
    ['verification rows invalid', [{ success: true, results: [{ filename: '', applied_at: 1 }] }]],
  ])('reports an unknown commit state when %s', async (_name, result) => {
    const d1 = new FakeD1();
    d1.faults = [{ kind: 'migration', outcome: 'throw', apply: true }];
    let historyCalls = 0;
    d1.queryFault = (sql) => {
      if (sql !== AUTHRIM_MIGRATION_HISTORY_SQL) return undefined;
      historyCalls += 1;
      return historyCalls === 1 ? undefined : result;
    };
    expect(await errorOf(run(d1))).toBe('migration_commit_state_unknown');
  });

  it('counts recoveries across several files', async () => {
    const d1 = new FakeD1();
    d1.faults = [
      { kind: 'migration', occurrence: 0, outcome: 'throw', apply: true },
      { kind: 'migration', occurrence: 1, outcome: 'unsuccess', apply: true },
    ];
    const result = await run(d1, [
      file('001_a.sql', 1),
      file('002_b.sql', 2),
      file('003_c.sql', 3),
    ]);
    expect(result).toMatchObject({ appliedFiles: 3, responseLossRecoveries: 2 });
  });
});

describe('apply: sentinel commit', () => {
  it('recovers a lost sentinel response when the sentinel matches', async () => {
    const d1 = new FakeD1();
    d1.faults = [{ kind: 'sentinel', outcome: 'throw', apply: true }];
    const result = await run(d1);
    expect(result).toMatchObject({ appliedFiles: 1, responseLossRecoveries: 1 });
    const sentinelReads = d1.queries.filter((q) => q.sql.includes('WHERE stream_id = ?'));
    expect(sentinelReads).toHaveLength(1);
  });

  it('rethrows when the sentinel was not committed', async () => {
    const d1 = new FakeD1();
    d1.faults = [{ kind: 'sentinel', outcome: 'unsuccess', apply: false }];
    expect(await errorOf(run(d1))).toBe('migration_d1_batch_failed');
  });

  it('rethrows the original error when a different sentinel is stored', async () => {
    const d1 = new FakeD1();
    d1.faults = [{ kind: 'sentinel', outcome: 'throw', apply: false }];
    d1.setSentinel({ release_id: '0.0.1', applied_file_count: 1, last_filename: '001_a.sql' });
    expect(await errorOf(run(d1))).toBe('d1_transport_error');
  });

  it('reports an unknown commit state when the sentinel cannot be read back', async () => {
    const d1 = new FakeD1();
    d1.faults = [{ kind: 'sentinel', outcome: 'throw', apply: true }];
    d1.queryFault = (sql) =>
      sql.includes('WHERE stream_id = ?') ? [{ success: false, results: [] }] : undefined;
    expect(await errorOf(run(d1))).toBe('migration_commit_state_unknown');
  });

  it('fails verification when the stored sentinel does not match after a clean write', async () => {
    const d1 = new FakeD1();
    d1.queryFault = (sql) =>
      sql.includes('WHERE stream_id = ?')
        ? [
            {
              success: true,
              results: [
                {
                  stream_id: 'core-d1',
                  release_id: '1.2.3',
                  manifest_digest: PIN.manifestDigest,
                  applied_file_count: 99,
                  state: 'ready',
                  last_filename: '001_a.sql',
                },
              ],
            },
          ]
        : undefined;
    expect(await errorOf(run(d1))).toBe('migration_sentinel_verification_failed');
  });

  it('fails verification when no sentinel row exists after a clean write', async () => {
    const d1 = new FakeD1();
    d1.queryFault = (sql) =>
      sql.includes('WHERE stream_id = ?') ? [{ success: true, results: [] }] : undefined;
    expect(await errorOf(run(d1))).toBe('migration_sentinel_verification_failed');
  });

  it('propagates an invalid sentinel query result in the final verification', async () => {
    const d1 = new FakeD1();
    d1.queryFault = (sql) =>
      sql.includes('WHERE stream_id = ?') ? [{ success: false, results: [] }] : undefined;
    expect(await errorOf(run(d1))).toBe('migration_d1_query_result_invalid');
  });

  it('rejects an invalid sentinel read in the already-applied shortcut', async () => {
    const d1 = new FakeD1();
    d1.addHistory('001_a.sql', 1);
    d1.queryFault = (sql) =>
      sql.includes('WHERE stream_id = ?') ? [{ success: false, results: [] }] : undefined;
    expect(await errorOf(run(d1))).toBe('migration_d1_query_result_invalid');
    expect(d1.batches).toEqual([]);
  });
});

describe('apply: superseded history adoption', () => {
  const a = { path: '001_a.sql', checksum: checksum(1) };
  const b = { path: '002_b.sql', checksum: checksum(2) };

  function loaded(extra: Array<ReturnType<typeof file>> = []) {
    const merged = file('003_merged.sql', 3, 'SELECT 3;', [a, b]);
    return release([merged, ...extra], {
      knownHistory: [
        a,
        b,
        ...[merged, ...extra].map(({ path, checksum: c }) => ({ path, checksum: c })),
      ],
    });
  }

  it('adopts a merged file without running its sql when every source was applied', async () => {
    const d1 = new FakeD1();
    d1.addHistory('001_a.sql', 1);
    d1.addHistory('002_b.sql', 2);
    const result = await makeEngine(loaded(), d1).apply({ databaseId: DB, pin: PIN });
    expect(result).toMatchObject({ appliedFiles: 0, skippedFiles: 1, totalFiles: 1 });
    expect(d1.batches).toHaveLength(2);
    expect(d1.batches[0]?.batch).toHaveLength(1);
    expect(d1.batches[0]?.batch[0]?.sql).toContain('INSERT INTO authrim_migrations');
    expect(d1.batches[0]?.batch[0]?.params?.slice(0, 2)).toEqual(['003_merged.sql', checksum(3)]);
  });

  it('refuses a partially applied supersedes set', async () => {
    const d1 = new FakeD1();
    d1.addHistory('001_a.sql', 1);
    expect(await errorOf(makeEngine(loaded(), d1).apply({ databaseId: DB, pin: PIN }))).toBe(
      'migration_history_partial_supersedes'
    );
    expect(d1.batches).toEqual([]);
  });

  it('runs the merged file normally when none of its sources were applied', async () => {
    const d1 = new FakeD1();
    const result = await makeEngine(loaded(), d1).apply({ databaseId: DB, pin: PIN });
    expect(result).toMatchObject({ appliedFiles: 1, skippedFiles: 0 });
    expect(d1.batches[0]?.batch[0]).toEqual({ sql: 'SELECT 3;' });
  });

  it('runs the file normally when its supersedes list is empty', async () => {
    const d1 = new FakeD1();
    const empty = file('003_merged.sql', 3, 'SELECT 3;', []);
    const result = await makeEngine(release([empty]), d1).apply({ databaseId: DB, pin: PIN });
    expect(result).toMatchObject({ appliedFiles: 1, skippedFiles: 0 });
  });

  it('ignores supersedes of a file that is already recorded', async () => {
    const d1 = new FakeD1();
    d1.addHistory('001_a.sql', 1);
    d1.addHistory('003_merged.sql', 3);
    const result = await makeEngine(loaded(), d1).apply({ databaseId: DB, pin: PIN });
    expect(result).toMatchObject({ appliedFiles: 0, skippedFiles: 1 });
  });

  it('counts adopted and executed files separately', async () => {
    const d1 = new FakeD1();
    d1.addHistory('001_a.sql', 1);
    d1.addHistory('002_b.sql', 2);
    const next = file('004_next.sql', 4);
    const result = await makeEngine(loaded([next]), d1).apply({ databaseId: DB, pin: PIN });
    expect(result).toMatchObject({
      appliedFiles: 1,
      skippedFiles: 1,
      lastFilename: '004_next.sql',
    });
  });

  it('does not run the mapping graph hook for an adopted 023 file', async () => {
    const d1 = new FakeD1();
    d1.addHistory('001_a.sql', 1);
    d1.addHistory('002_b.sql', 2);
    const merged = file('023_mapping_rule_graph.sql', 3, 'SELECT 3;', [a, b]);
    const loadedRelease = release([merged], {
      pin: { ...PIN, streamId: 'admin-d1' },
      knownHistory: [a, b, { path: merged.path, checksum: merged.checksum }],
    });
    await makeEngine(loadedRelease, d1).apply({
      databaseId: DB,
      pin: { ...PIN, streamId: 'admin-d1' },
    });
    expect(mappingStatements).not.toHaveBeenCalled();
  });
});

describe('apply: mapping graph migration (admin-d1 023)', () => {
  const adminPin = { ...PIN, streamId: 'admin-d1' };

  it('appends recompilation statements before the history record', async () => {
    const d1 = new FakeD1();
    mappingStatements.mockImplementation(
      async (_sql: string, query: (sql: string) => Promise<unknown>) => {
        expect(await query('SELECT guard')).toEqual([]);
        return ['CREATE TABLE t (a);', 'UPDATE t SET a = 1; DELETE FROM t;'];
      }
    );
    const f = file('023_mapping_rule_graph.sql', 23, 'SELECT base;');
    const result = await makeEngine(release([f], { pin: adminPin }), d1).apply({
      databaseId: DB,
      pin: adminPin,
    });
    expect(result).toMatchObject({ streamId: 'admin-d1', appliedFiles: 1 });
    expect(mappingStatements).toHaveBeenCalledTimes(1);
    expect(mappingStatements.mock.calls[0]?.[0]).toBe('SELECT base;');
    expect(d1.queries.some((q) => q.sql === 'SELECT guard' && q.databaseId === DB)).toBe(true);
    expect(d1.batches[0]?.batch.slice(0, -1)).toEqual([
      { sql: 'SELECT base;' },
      { sql: 'CREATE TABLE t (a);' },
      { sql: 'UPDATE t SET a = 1;' },
      { sql: 'DELETE FROM t;' },
    ]);
    expect(d1.batches[0]?.batch.at(-1)?.sql).toContain('INSERT INTO authrim_migrations');
  });

  it('feeds guard query failures back through the row validation', async () => {
    const d1 = new FakeD1();
    d1.queryFault = (sql) => (sql === 'SELECT guard' ? [{ success: false }] : undefined);
    mappingStatements.mockImplementation(
      async (_sql: string, query: (sql: string) => Promise<unknown>) => {
        await query('SELECT guard');
        return [];
      }
    );
    const f = file('023_mapping_rule_graph.sql', 23);
    expect(
      await errorOf(
        makeEngine(release([f], { pin: adminPin }), d1).apply({ databaseId: DB, pin: adminPin })
      )
    ).toBe('migration_d1_query_result_invalid');
    expect(d1.batches).toEqual([]);
  });

  it.each([
    ['another stream', 'core-d1', '023_mapping_rule_graph.sql'],
    ['another file', 'admin-d1', '024_other.sql'],
  ])('does not run the hook for %s', async (_name, streamId, path) => {
    const d1 = new FakeD1();
    const pin = { ...PIN, streamId };
    await makeEngine(release([file(path, 5)], { pin }), d1).apply({ databaseId: DB, pin });
    expect(mappingStatements).not.toHaveBeenCalled();
  });
});

describe('apply: draft append history prefix', () => {
  const baseline = file('001_1_2_3_core_baseline.sql', 1);
  const f2 = file('002_a.sql', 2);
  const f3 = file('003_b.sql', 3);
  const f4 = file('004_c.sql', 4);
  const base = [baseline, f2, f3, f4].map(({ path, checksum: c }) => ({ path, checksum: c }));
  const draft = (executable: Array<ReturnType<typeof file>>) =>
    release(executable, { draftAppendBase: base, knownHistory: base });
  const applyTo = (d1: FakeD1, executable: Array<ReturnType<typeof file>>) =>
    makeEngine(draft(executable), d1).apply({ databaseId: DB, pin: PIN });

  it('extends a database that holds an unbroken prefix reaching the first executable file', async () => {
    const d1 = new FakeD1();
    d1.addHistory(baseline.path, 1);
    d1.addHistory(f2.path, 2);
    const result = await applyTo(d1, [f3, f4]);
    expect(result).toMatchObject({ appliedFiles: 2, skippedFiles: 0 });
    expect(d1.batches[0]?.batch.at(-1)?.params?.[0]).toBe('003_b.sql');
  });

  it('accepts a prefix that already extends past the first executable file', async () => {
    const d1 = new FakeD1();
    d1.addHistory(baseline.path, 1);
    d1.addHistory(f2.path, 2);
    d1.addHistory(f3.path, 3);
    const result = await applyTo(d1, [f3, f4]);
    expect(result).toMatchObject({ appliedFiles: 1, skippedFiles: 1 });
  });

  it('judges the first executable file by its lowest base position', async () => {
    const d1 = new FakeD1();
    d1.addHistory(baseline.path, 1);
    d1.addHistory(f2.path, 2);
    expect(await applyTo(d1, [f4, f3])).toMatchObject({ appliedFiles: 2 });
  });

  it('refuses an empty history', async () => {
    const d1 = new FakeD1();
    expect(await errorOf(applyTo(d1, [f3]))).toBe('migration_history_prefix_missing');
    expect(d1.batches).toEqual([]);
  });

  it('refuses recorded files outside the draft base', async () => {
    const d1 = new FakeD1();
    d1.addHistory(baseline.path, 1);
    d1.addHistory('009_x.sql', 9);
    const loaded = release([f3], {
      draftAppendBase: base,
      knownHistory: [...base, { path: '009_x.sql', checksum: checksum(9) }],
    });
    expect(await errorOf(makeEngine(loaded, d1).apply({ databaseId: DB, pin: PIN }))).toBe(
      'migration_history_unexpected_file'
    );
  });

  it('refuses recorded checksums that differ from the draft base', async () => {
    const d1 = new FakeD1();
    d1.addHistory(baseline.path, 1);
    d1.addHistory(f2.path, 7);
    const loaded = release([f3], {
      draftAppendBase: base,
      knownHistory: [
        { path: baseline.path, checksum: checksum(1) },
        { path: f2.path, checksum: checksum(7) },
        { path: f3.path, checksum: checksum(3) },
      ],
    });
    expect(await errorOf(makeEngine(loaded, d1).apply({ databaseId: DB, pin: PIN }))).toBe(
      'migration_history_checksum_mismatch'
    );
  });

  it('refuses a baseline among the executable files', async () => {
    const d1 = new FakeD1();
    d1.addHistory(f2.path, 2);
    expect(await errorOf(applyTo(d1, [baseline, f3]))).toBe(
      'migration_release_draft_append_baseline_forbidden'
    );
  });

  it('requires every baseline of the base to be recorded', async () => {
    const d1 = new FakeD1();
    d1.addHistory(f2.path, 2);
    expect(await errorOf(applyTo(d1, [f3]))).toBe('migration_history_prefix_missing');
  });

  it('refuses a gap in the recorded prefix', async () => {
    const d1 = new FakeD1();
    d1.addHistory(baseline.path, 1);
    d1.addHistory(f3.path, 3);
    expect(await errorOf(applyTo(d1, [f4]))).toBe('migration_history_prefix_gap');
  });

  it('refuses a prefix that stops before the first executable file', async () => {
    const d1 = new FakeD1();
    d1.addHistory(baseline.path, 1);
    expect(await errorOf(applyTo(d1, [f3, f4]))).toBe('migration_history_prefix_missing');
  });

  it('refuses executable files that are not part of the base', async () => {
    const d1 = new FakeD1();
    d1.addHistory(baseline.path, 1);
    const stray = file('005_stray.sql', 5);
    const loaded = release([stray], {
      draftAppendBase: base,
      knownHistory: [...base, { path: stray.path, checksum: stray.checksum }],
    });
    expect(await errorOf(makeEngine(loaded, d1).apply({ databaseId: DB, pin: PIN }))).toBe(
      'migration_history_prefix_missing'
    );
  });
});
