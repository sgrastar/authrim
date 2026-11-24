import { describe, expect, it } from 'vitest';
import { ApiMigrationEngine, cloudflareMigrationExecutor } from '../migration-engine.js';
import {
  AUTHRIM_MIGRATIONS_TABLE_SQL,
  AUTHRIM_MIGRATION_HISTORY_SQL,
  TENANT_DATABASE_MIGRATION_STATE_TABLE_SQL,
} from '../migration-history-contract.js';
import {
  DB,
  FakeD1,
  MIGRATIONS,
  PIN,
  STATE,
  checksum,
  errorOf,
  file,
  makeEngine,
  release,
} from './migration-engine-fixtures.js';

const INFRA_SQL_FRAGMENT = 'sqlite_master';

describe('apply: basics', () => {
  it('rejects an empty stream before touching D1', async () => {
    const d1 = new FakeD1();
    expect(await errorOf(makeEngine(release([]), d1).apply({ databaseId: DB, pin: PIN }))).toBe(
      'migration_release_stream_empty'
    );
    expect(d1.queries).toEqual([]);
    expect(d1.batches).toEqual([]);
  });

  it('applies every file in order and records history and the sentinel', async () => {
    const d1 = new FakeD1();
    const files = [
      file('001_a.sql', 1, 'CREATE TABLE a (id INTEGER);\nINSERT INTO a VALUES (1);'),
      file('002_b.sql', 2, 'SELECT 2;'),
    ];
    let tick = 1000;
    const result = await makeEngine(release(files), d1, () => tick++).apply({
      databaseId: DB,
      pin: PIN,
    });
    expect(result).toEqual({
      streamId: 'core-d1',
      releaseId: '1.2.3',
      manifestDigest: PIN.manifestDigest,
      totalFiles: 2,
      appliedFiles: 2,
      skippedFiles: 0,
      responseLossRecoveries: 0,
      lastFilename: '002_b.sql',
    });
    expect(d1.batches).toHaveLength(3);
    expect(d1.batches.every((b) => b.databaseId === DB)).toBe(true);
    const [first, second, sentinel] = d1.batches.map((b) => b.batch);
    expect(first?.map((q) => q.sql).slice(0, 2)).toEqual([
      'CREATE TABLE a (id INTEGER);',
      'INSERT INTO a VALUES (1);',
    ]);
    expect(first).toHaveLength(3);
    expect(first?.[2]?.sql).toContain('INSERT INTO authrim_migrations');
    expect(first?.[2]?.sql).toContain('execution_time_ms, setup_version, tool_version');
    expect(first?.[2]?.params).toEqual(['001_a.sql', checksum(1), 1000, '1.2.3']);
    expect(second).toHaveLength(2);
    expect(second?.[0]).toEqual({ sql: 'SELECT 2;' });
    expect(second?.[1]?.params).toEqual(['002_b.sql', checksum(2), 1002, '1.2.3']);
    expect(sentinel).toHaveLength(1);
    expect(sentinel?.[0]?.sql).toContain('INSERT INTO tenant_database_migration_state');
    expect(sentinel?.[0]?.sql).toContain('ON CONFLICT(stream_id) DO UPDATE SET');
    expect(sentinel?.[0]?.params).toEqual([
      'core-d1',
      '1.2.3',
      PIN.manifestDigest,
      2,
      '002_b.sql',
      1004,
    ]);
    expect(d1.sentinel).toMatchObject({ applied_file_count: 2, last_filename: '002_b.sql' });
  });

  it('queries the infrastructure state, history, and verifies the sentinel by stream id', async () => {
    const d1 = new FakeD1();
    await makeEngine(release([file('001_a.sql', 1)]), d1).apply({ databaseId: DB, pin: PIN });
    expect(d1.queries.map((q) => q.databaseId)).toEqual([DB, DB, DB]);
    expect(d1.queries[0]?.sql).toContain(INFRA_SQL_FRAGMENT);
    expect(d1.queries[0]?.sql).toContain(
      "name IN ('authrim_migrations', 'tenant_database_migration_state')"
    );
    expect(d1.queries[0]?.sql).toContain('ORDER BY name');
    expect(d1.queries[0]?.params).toBeUndefined();
    expect(d1.queries[1]?.sql).toBe(AUTHRIM_MIGRATION_HISTORY_SQL);
    expect(d1.queries[2]).toEqual({
      databaseId: DB,
      sql: 'SELECT stream_id, release_id, manifest_digest, applied_file_count, state, last_filename FROM tenant_database_migration_state WHERE stream_id = ?',
      params: ['core-d1'],
    });
  });

  it('skips files already in history and counts only the new ones', async () => {
    const d1 = new FakeD1();
    d1.addHistory('001_a.sql', 1);
    const result = await makeEngine(
      release([file('001_a.sql', 1), file('002_b.sql', 2)]),
      d1
    ).apply({ databaseId: DB, pin: PIN });
    expect(result).toMatchObject({ totalFiles: 2, appliedFiles: 1, skippedFiles: 1 });
    expect(d1.batches).toHaveLength(2);
    expect(d1.batches[0]?.batch[1]?.params?.[0]).toBe('002_b.sql');
  });

  it('cloudflareMigrationExecutor returns the same executor', () => {
    const d1 = new FakeD1();
    expect(cloudflareMigrationExecutor(d1)).toBe(d1);
  });

  it('is exported as a class taking reader, executor and clock', () => {
    expect(ApiMigrationEngine.length).toBe(3);
  });
});

describe('apply: migration infrastructure', () => {
  it('does not create infrastructure when both tables exist', async () => {
    const d1 = new FakeD1();
    await makeEngine(release([file('001_a.sql', 1)]), d1).apply({ databaseId: DB, pin: PIN });
    expect(d1.batches.some((b) => b.batch[0]?.sql.startsWith('CREATE TABLE'))).toBe(false);
  });

  it.each([
    ['none', []],
    ['only ledger', [MIGRATIONS]],
    ['only state', [STATE]],
    ['wrong order', [STATE, MIGRATIONS]],
    ['wrong names', [MIGRATIONS, 'other']],
    ['three tables', [MIGRATIONS, STATE, 'extra']],
    ['wrong first', ['other', STATE]],
  ])('creates the infrastructure when it is incomplete (%s)', async (_name, infra) => {
    const d1 = new FakeD1();
    d1.infra = infra;
    await makeEngine(release([file('001_a.sql', 1)]), d1).apply({ databaseId: DB, pin: PIN });
    expect(d1.batches[0]?.batch).toEqual([
      { sql: AUTHRIM_MIGRATIONS_TABLE_SQL },
      { sql: TENANT_DATABASE_MIGRATION_STATE_TABLE_SQL },
    ]);
    expect(d1.batches[0]?.databaseId).toBe(DB);
    expect(d1.batches).toHaveLength(3);
  });

  it.each([
    ['transport error', 'throw'],
    ['unsuccessful statement', 'unsuccess'],
    ['short result', 'short'],
  ] as const)('fails when the infrastructure batch reports %s', async (_name, outcome) => {
    const d1 = new FakeD1();
    d1.infra = [];
    d1.faults = [{ kind: 'infra', outcome, apply: false }];
    const message = await errorOf(
      makeEngine(release([file('001_a.sql', 1)]), d1).apply({ databaseId: DB, pin: PIN })
    );
    expect(message).toBe(outcome === 'throw' ? 'd1_transport_error' : 'migration_d1_batch_failed');
    expect(d1.batches).toHaveLength(1);
  });

  it.each([
    ['no results', []],
    [
      'two results',
      [
        { success: true, results: [] },
        { success: true, results: [] },
      ],
    ],
    ['unsuccessful', [{ success: false, results: [] }]],
    ['success missing', [{ results: [] }]],
    ['results missing', [{ success: true }]],
    ['results not array', [{ success: true, results: {} }]],
    ['row null', [{ success: true, results: [null] }]],
    ['row array', [{ success: true, results: [[]] }]],
    ['row string', [{ success: true, results: ['x'] }]],
  ])('rejects an invalid infrastructure query result (%s)', async (_name, results) => {
    const d1 = new FakeD1();
    d1.queryFault = (sql) => (sql.includes(INFRA_SQL_FRAGMENT) ? results : undefined);
    expect(
      await errorOf(
        makeEngine(release([file('001_a.sql', 1)]), d1).apply({ databaseId: DB, pin: PIN })
      )
    ).toBe('migration_d1_query_result_invalid');
  });
});

describe('apply: history validation', () => {
  const rows = (results: unknown[]) => [{ success: true, results }];
  const faultHistory = (d1: FakeD1, result: unknown): void => {
    d1.queryFault = (sql) =>
      sql === AUTHRIM_MIGRATION_HISTORY_SQL ? (result as never) : undefined;
  };

  it.each([
    ['unsuccessful query', [{ success: false, results: [] }]],
    ['no results', []],
    ['row not an object', rows(['x'])],
    ['blank filename', rows([{ filename: ' ', checksum: checksum(1), applied_at: 1 }])],
    ['missing checksum', rows([{ filename: '001_a.sql', applied_at: 1 }])],
    ['null checksum', rows([{ filename: '001_a.sql', checksum: null, applied_at: 1 }])],
    ['bad checksum', rows([{ filename: '001_a.sql', checksum: 'xyz', applied_at: 1 }])],
    ['missing applied_at', rows([{ filename: '001_a.sql', checksum: checksum(1) }])],
    ['null applied_at', rows([{ filename: '001_a.sql', checksum: checksum(1), applied_at: null }])],
    [
      'duplicate',
      rows([
        { filename: '001_a.sql', checksum: checksum(1), applied_at: 1 },
        { filename: '001_a.sql', checksum: checksum(1), applied_at: 2 },
      ]),
    ],
  ])('maps %s to migration_history_invalid', async (_name, result) => {
    const d1 = new FakeD1();
    faultHistory(d1, result);
    expect(
      await errorOf(
        makeEngine(release([file('001_a.sql', 1)]), d1).apply({ databaseId: DB, pin: PIN })
      )
    ).toBe('migration_history_invalid');
    expect(d1.batches).toEqual([]);
  });

  it('trims history filenames so padded rows still match', async () => {
    const d1 = new FakeD1();
    d1.history.push({ filename: ' 001_a.sql ', checksum: checksum(1), applied_at: 1 });
    const result = await makeEngine(release([file('001_a.sql', 1)]), d1).apply({
      databaseId: DB,
      pin: PIN,
    });
    expect(result).toMatchObject({ appliedFiles: 0, skippedFiles: 1 });
  });

  it('rejects release files that are not part of the known history contract', async () => {
    const d1 = new FakeD1();
    const loaded = release([file('001_a.sql', 1)], { knownHistory: [] });
    expect(await errorOf(makeEngine(loaded, d1).apply({ databaseId: DB, pin: PIN }))).toBe(
      'migration_release_history_contract_invalid'
    );
    const wrong = release([file('001_a.sql', 1)], {
      knownHistory: [{ path: '001_a.sql', checksum: checksum(2) }],
    });
    expect(await errorOf(makeEngine(wrong, d1).apply({ databaseId: DB, pin: PIN }))).toBe(
      'migration_release_history_contract_invalid'
    );
    expect(d1.batches).toEqual([]);
  });

  it('rejects recorded files unknown to the release and checksum drift', async () => {
    const unexpected = new FakeD1();
    unexpected.addHistory('999_zzz.sql', 9);
    expect(
      await errorOf(
        makeEngine(release([file('001_a.sql', 1)]), unexpected).apply({ databaseId: DB, pin: PIN })
      )
    ).toBe('migration_history_unexpected_file');

    const drift = new FakeD1();
    drift.addHistory('001_a.sql', 7);
    expect(
      await errorOf(
        makeEngine(release([file('001_a.sql', 1)]), drift).apply({ databaseId: DB, pin: PIN })
      )
    ).toBe('migration_history_checksum_mismatch');
    expect(drift.batches).toEqual([]);
  });
});

describe('apply: already applied releases', () => {
  const files = [file('001_a.sql', 1), file('002_b.sql', 2)];
  function applied(): FakeD1 {
    const d1 = new FakeD1();
    d1.addHistory('001_a.sql', 1);
    d1.addHistory('002_b.sql', 2);
    return d1;
  }

  it('short-circuits when the sentinel already matches', async () => {
    const d1 = applied();
    d1.setSentinel({ applied_file_count: 2, last_filename: '002_b.sql' });
    const result = await makeEngine(release(files), d1).apply({ databaseId: DB, pin: PIN });
    expect(result).toEqual({
      streamId: 'core-d1',
      releaseId: '1.2.3',
      manifestDigest: PIN.manifestDigest,
      totalFiles: 2,
      appliedFiles: 0,
      skippedFiles: 2,
      responseLossRecoveries: 0,
      lastFilename: '002_b.sql',
    });
    expect(d1.batches).toEqual([]);
    expect(d1.queries).toHaveLength(3);
  });

  it.each([
    ['stream_id', { stream_id: 'other-d1' }],
    ['release_id', { release_id: '9.9.9' }],
    ['manifest_digest', { manifest_digest: 'e'.repeat(64) }],
    ['applied_file_count', { applied_file_count: 1 }],
    ['state', { state: 'failed' }],
    ['last_filename', { last_filename: '001_a.sql' }],
  ])('rewrites the sentinel when %s differs', async (_name, override) => {
    const d1 = applied();
    d1.setSentinel({ applied_file_count: 2, last_filename: '002_b.sql', ...override });
    const result = await makeEngine(release(files), d1).apply({ databaseId: DB, pin: PIN });
    expect(result).toMatchObject({ appliedFiles: 0, skippedFiles: 2, responseLossRecoveries: 0 });
    expect(d1.batches).toHaveLength(1);
    expect(d1.batches[0]?.batch[0]?.params?.slice(0, 5)).toEqual([
      'core-d1',
      '1.2.3',
      PIN.manifestDigest,
      2,
      '002_b.sql',
    ]);
  });

  it('writes the sentinel when none exists', async () => {
    const d1 = applied();
    const result = await makeEngine(release(files), d1).apply({ databaseId: DB, pin: PIN });
    expect(result.skippedFiles).toBe(2);
    expect(d1.batches).toHaveLength(1);
    expect(d1.sentinel).toMatchObject({ last_filename: '002_b.sql' });
  });

  it('does not take the shortcut while any file is still pending', async () => {
    const d1 = new FakeD1();
    d1.addHistory('001_a.sql', 1);
    d1.setSentinel({ applied_file_count: 2, last_filename: '002_b.sql' });
    const result = await makeEngine(release(files), d1).apply({ databaseId: DB, pin: PIN });
    expect(result).toMatchObject({ appliedFiles: 1, skippedFiles: 1 });
    expect(d1.batches).toHaveLength(2);
  });
});
