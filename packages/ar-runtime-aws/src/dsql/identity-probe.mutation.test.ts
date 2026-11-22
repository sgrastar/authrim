/* eslint-disable @typescript-eslint/no-unsafe-assignment -- fakes and deliberately malformed inputs are intentionally untyped */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DsqlProbeDatabase } from './probe';
import { createDsqlIdentityFixture } from './identity-fixture';
import { createDsqlIdentitySchemaPlan, initializeDsqlIdentitySchema } from './identity-schema';
import {
  createDsqlIdentityImportJournal,
  DsqlIdentityImportValidationError,
  DsqlIdentityVerificationMismatch,
  restoreDsqlIdentitySlice,
  verifyDsqlIdentitySubset,
} from './identity-import';
import { runDsqlIdentityProbe } from './identity-probe';
import { POSTGRES_RESTORE_TABLE_CONTRACTS } from '../import/postgres-restore-table-contract';

vi.mock('./identity-fixture', () => ({ createDsqlIdentityFixture: vi.fn() }));
vi.mock('./identity-schema', async (original) => ({
  ...(await original<typeof import('./identity-schema')>()),
  initializeDsqlIdentitySchema: vi.fn(),
}));
vi.mock('./identity-import', async (original) => ({
  ...(await original<typeof import('./identity-import')>()),
  createDsqlIdentityImportJournal: vi.fn(),
  restoreDsqlIdentitySlice: vi.fn(),
  verifyDsqlIdentitySubset: vi.fn(),
}));

const rows = { 'core.users_core': 201, 'pii.users_pii': 201, 'core.passkeys': 201 };
let changed: boolean;
let step: number;
let dbType: string;
let currentDatabase: string;
let chunkRow: Record<string, unknown> | undefined;
const execute = vi.fn<DsqlProbeDatabase['execute']>();
const transaction = vi.fn();
const queryOne = vi.fn();
const close = vi.fn();
const reopen = vi.fn();
const db = {
  getType: () => dbType,
  queryOne,
  execute,
  transaction,
} as unknown as DsqlProbeDatabase;
const omitted = () =>
  POSTGRES_RESTORE_TABLE_CONTRACTS.filter((spec) => !Object.hasOwn(rows, spec.datasetId))
    .map((spec) => spec.datasetId)
    .sort();
const run = (options: { writeProbe: true; userCount?: number } = { writeProbe: true }) => {
  step = 0;
  changed = false;
  return runDsqlIdentityProbe(db, options);
};
const drops = () => execute.mock.calls.map(([sql]) => sql).filter((sql) => sql.startsWith('DROP'));
const tableEvents = (name: string) => [
  { kind: 'table', name, status: 'attempted' } as const,
  { kind: 'table', name, status: 'created' } as const,
];

beforeEach(() => {
  vi.clearAllMocks();
  changed = false;
  step = 0;
  dbType = 'aurora-dsql';
  currentDatabase = 'postgres';
  chunkRow = { count: '9', max_rows: 100, total_rows: '603' };
  close.mockResolvedValue(undefined);
  reopen.mockResolvedValue({ close });
  queryOne.mockImplementation(async (sql: string) =>
    sql.includes('current_database') ? { name: currentDatabase } : chunkRow
  );
  vi.mocked(createDsqlIdentityFixture).mockResolvedValue({
    backup: { close } as unknown as Awaited<ReturnType<typeof createDsqlIdentityFixture>>['backup'],
    trustedReceiptDigest: 'a'.repeat(64),
    tenantId: 'synthetic-tenant',
    expectedRows: { ...rows, 'core.tenants': 0 },
    reopen,
    close,
  });
  vi.mocked(initializeDsqlIdentitySchema).mockImplementation(async (_db, schema, options) => {
    options?.onProgress?.({ kind: 'schema', name: schema, status: 'attempted' });
    options?.onProgress?.({ kind: 'schema', name: schema, status: 'created' });
    for (const name of ['users_core', 'users_pii', 'passkeys']) {
      for (const event of tableEvents(name)) options?.onProgress?.(event);
    }
    return createDsqlIdentitySchemaPlan(schema);
  });
  vi.mocked(createDsqlIdentityImportJournal).mockImplementation(async (_db, _schema, options) => {
    for (const name of ['authrim_identity_import_operation', 'authrim_identity_import_chunks']) {
      for (const event of tableEvents(name)) options?.onProgress?.(event);
    }
  });
  vi.mocked(restoreDsqlIdentitySlice).mockImplementation(async (input) => {
    if (input.tenantId !== 'synthetic-tenant' || input.trustedReceiptSha256 !== 'a'.repeat(64)) {
      throw new DsqlIdentityImportValidationError();
    }
    return {
      status: step++ === 0 ? 'loading' : 'sealed',
      fullRuntimeReady: false,
      datasetIndex: 0,
      rowOffset: 100,
      revision: step,
    };
  });
  vi.mocked(verifyDsqlIdentitySubset).mockImplementation(async () => {
    if (changed) throw new DsqlIdentityVerificationMismatch();
    return {
      status: 'native_subset_verified',
      fullRuntimeReady: false,
      tables: Object.entries(rows).map(([datasetId, rowCount]) => ({
        datasetId,
        rowCount,
        sourceSha256: 'a'.repeat(64),
        targetSha256: 'b'.repeat(64),
      })),
      omittedDatasets: omitted(),
    } as Awaited<ReturnType<typeof verifyDsqlIdentitySubset>>;
  });
  execute.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.startsWith('UPDATE'))
      changed = sql.includes('users_pii') ? params?.[0] !== '9007199254740993' : true;
    return { success: true, rowsAffected: 1, durationMs: 0 };
  });
  transaction.mockRejectedValue(Object.assign(new Error('redacted'), { code: '23505' }));
});

const lastCheck = (r: Awaited<ReturnType<typeof run>>) => r.checks.at(-1);

describe('identity probe (mutation hardening)', () => {
  it('reports the full passing envelope and check order', async () => {
    const r = await run();
    expect(r.schema).toMatch(/^authrim_dsql_identity_[0-9a-f]{32}$/u);
    expect(r).toMatchObject({
      formatVersion: 1,
      mode: 'synthetic-native-identity',
      fullRuntimeReady: false,
      passed: true,
      cleanup: 'complete',
      chunks: 9,
      maxChunkRows: 100,
      restoredRows: rows,
      omittedDatasets: omitted(),
    });
    expect(r.checks).toEqual(
      [
        'database',
        'native-schema-and-indexes',
        'encrypted-synthetic-backup',
        'partial-import',
        'changed-source-and-tenant-rejected',
        'resume-after-reopening-backup',
        'native-readback-and-reference-verification',
        'native-uniqueness-enforced',
        'precise-json-number-change-rejected',
        'changed-native-row-rejected',
      ].map((name) => ({ name, passed: true }))
    );
    expect(queryOne.mock.calls[1][0]).toContain(`"${r.schema}"."authrim_identity_import_chunks"`);
  });

  it('validates preconditions and bounds before any work', async () => {
    dbType = 'postgres';
    await expect(run()).rejects.toThrow('dsql_identity_probe_explicit_write_required');
    dbType = 'aurora-dsql';
    for (const userCount of [0, -1, 2001, 1.5, Number.NaN])
      await expect(run({ writeProbe: true, userCount })).rejects.toThrow(
        'dsql_identity_probe_explicit_write_required'
      );
    await expect(run({ writeProbe: false } as never)).rejects.toThrow(
      'dsql_identity_probe_explicit_write_required'
    );
    expect(queryOne).not.toHaveBeenCalled();
    for (const userCount of [1, 2000]) {
      vi.mocked(createDsqlIdentityFixture).mockClear();
      expect((await run({ writeProbe: true, userCount })).passed).toBe(true);
      expect(createDsqlIdentityFixture).toHaveBeenCalledWith({ userCount });
      step = 0;
    }
  });

  it('fails the database check without cleanup when the database is wrong', async () => {
    currentDatabase = 'other';
    const r = await run();
    expect(r.passed).toBe(false);
    expect(r.checks).toEqual([{ name: 'database', passed: false }]);
    expect(r.cleanup).toBe('not-needed');
    expect(initializeDsqlIdentitySchema).not.toHaveBeenCalled();
  });

  it.each([
    'dsql_identity_schema_create_failed',
    'dsql_identity_table_create_failed',
    'dsql_identity_index_job_missing',
    'dsql_identity_index_job_invalid',
    'dsql_identity_index_build_failed',
    'dsql_identity_index_catalog_invalid',
    'dsql_identity_index_status_invalid',
    'dsql_identity_index_wait_exhausted',
    'dsql_identity_schema_initialization_failed',
  ])('exposes the allow-listed failure code %s', async (code) => {
    vi.mocked(initializeDsqlIdentitySchema).mockRejectedValue(new Error(code));
    const r = await run();
    expect(r.checks.at(-1)).toEqual({
      name: 'native-schema-and-indexes',
      passed: false,
      failureCode: code,
    });
  });

  it('withholds unknown messages, non-Error values and malformed SQLSTATEs', async () => {
    const expectFailure = async (thrown: unknown, extra: Record<string, string>) => {
      vi.mocked(initializeDsqlIdentitySchema).mockRejectedValue(thrown);
      expect(lastCheck(await run())).toEqual({
        name: 'native-schema-and-indexes',
        passed: false,
        ...extra,
      });
    };
    await expectFailure(new Error('private detail'), {});
    await expectFailure({ message: 'dsql_identity_schema_create_failed' }, {});
    await expectFailure(null, {});
    await expectFailure('text', {});
    await expectFailure(Object.assign(new Error('x'), { code: '42P01' }), { sqlState: '42P01' });
    await expectFailure(Object.assign(new Error('x'), { code: 'XX000' }), { sqlState: 'XX000' });
    await expectFailure(Object.assign(new Error('x'), { code: 'abcde' }), {});
    await expectFailure(Object.assign(new Error('x'), { code: '1234' }), {});
    await expectFailure(Object.assign(new Error('x'), { code: 'ABCDE1' }), {});
    await expectFailure(Object.assign(new Error('x'), { code: '-ABCDE' }), {});
    await expectFailure(Object.assign(new Error('x'), { code: 12345 }), {});
    await expectFailure(
      Object.assign(new Error('dsql_identity_table_create_failed'), { code: '23505' }),
      { failureCode: 'dsql_identity_table_create_failed', sqlState: '23505' }
    );
  });

  it('tracks progress precisely when deciding whether cleanup is safe', async () => {
    const scenario = async (
      events: Array<{ kind: 'schema' | 'table' | 'index'; name: string; status: never }>
    ) => {
      execute.mockClear();
      vi.mocked(initializeDsqlIdentitySchema).mockImplementation(async (_db, _s, options) => {
        for (const event of events) options?.onProgress?.(event);
        throw new Error('stop');
      });
      return run();
    };
    const e = (kind: 'schema' | 'table' | 'index', name: string, status: string) =>
      ({ kind, name, status }) as never;
    // no schema creation was confirmed: nothing is dropped
    let r = await scenario([]);
    expect(r).toMatchObject({ cleanup: 'not-needed', passed: false });
    expect(execute).not.toHaveBeenCalled();
    r = await scenario([e('table', 't', 'created')]);
    expect(r.cleanup).toBe('not-needed');
    expect(execute).not.toHaveBeenCalled();
    r = await scenario([e('schema', 's', 'ready'), e('index', 'i', 'ready')]);
    expect(r.cleanup).toBe('not-needed');
    expect(execute).not.toHaveBeenCalled();
    // an attempted CREATE leaves the outcome unconfirmed
    r = await scenario([e('schema', 's', 'attempted')]);
    expect(r.cleanup).toBe('creation-unconfirmed');
    // confirmed schema, nothing pending: only the schema is dropped
    r = await scenario([e('schema', 's', 'attempted'), e('schema', 's', 'created')]);
    expect(r.cleanup).toBe('complete');
    expect(drops()).toEqual([`DROP SCHEMA "${r.schema}"`]);
    // confirmed table is dropped before the schema, without CASCADE
    r = await scenario([
      e('schema', 's', 'created'),
      e('table', 'a_table', 'attempted'),
      e('table', 'a_table', 'created'),
    ]);
    expect(r.cleanup).toBe('complete');
    expect(drops()).toEqual([`DROP TABLE "${r.schema}"."a_table"`, `DROP SCHEMA "${r.schema}"`]);
    // pending table creation blocks cleanup until it is confirmed
    r = await scenario([
      e('schema', 's', 'created'),
      e('table', 'a_table', 'attempted'),
      e('table', 'a_table', 'ready'),
    ]);
    expect(r.cleanup).toBe('creation-unconfirmed');
    expect(execute).not.toHaveBeenCalled();
    // pending index creation is resolved only by a ready index
    r = await scenario([
      e('schema', 's', 'created'),
      e('index', 'i', 'attempted'),
      e('index', 'i', 'created'),
    ]);
    expect(r.cleanup).toBe('creation-unconfirmed');
    expect(execute).not.toHaveBeenCalled();
    r = await scenario([
      e('schema', 's', 'created'),
      e('index', 'i', 'attempted'),
      e('index', 'i', 'ready'),
    ]);
    expect(r.cleanup).toBe('complete');
    expect(drops()).toEqual([`DROP SCHEMA "${r.schema}"`]);
    r = await scenario([
      e('schema', 's', 'created'),
      e('table', 't', 'attempted'),
      e('index', 'i', 'ready'),
    ]);
    expect(r.cleanup).toBe('complete');
    // schema events cannot clear a pending table
    r = await scenario([e('table', 't', 'attempted'), e('schema', 's', 'created')]);
    expect(r.cleanup).toBe('complete');
  });

  it('drops confirmed tables in reverse creation order and the schema last', async () => {
    const r = await run();
    expect(drops()).toEqual([
      `DROP TABLE "${r.schema}"."authrim_identity_import_chunks"`,
      `DROP TABLE "${r.schema}"."authrim_identity_import_operation"`,
      `DROP TABLE "${r.schema}"."passkeys"`,
      `DROP TABLE "${r.schema}"."users_pii"`,
      `DROP TABLE "${r.schema}"."users_core"`,
      `DROP SCHEMA "${r.schema}"`,
    ]);
  });

  it('marks cleanup failed when a drop fails or a table name is unsafe', async () => {
    execute.mockImplementation(async (sql: string) => {
      if (sql.startsWith('DROP SCHEMA')) throw new Error('denied');
      return { success: true, rowsAffected: 1, durationMs: 0 };
    });
    let r = await run();
    expect(r).toMatchObject({ passed: false, cleanup: 'failed' });
    for (const bad of ['Xusers', 'users1', 'Bad-Name', 'a b', '']) {
      execute.mockReset();
      execute.mockResolvedValue({ success: true, rowsAffected: 1, durationMs: 0 });
      vi.mocked(initializeDsqlIdentitySchema).mockImplementation(async (_db, schema, options) => {
        options?.onProgress?.({ kind: 'schema', name: schema, status: 'created' });
        options?.onProgress?.({ kind: 'table', name: bad, status: 'created' });
        throw new Error('stop');
      });
      r = await run();
      expect(r.cleanup, bad).toBe('failed');
      expect(r.passed).toBe(false);
      expect(drops()).toEqual([]);
    }
  });

  it('passes the right inputs to the importer and rejects changed inputs', async () => {
    const r = await run();
    expect(r.passed).toBe(true);
    const calls = vi.mocked(restoreDsqlIdentitySlice).mock.calls.map(([i]) => i);
    expect(calls[0]).toMatchObject({
      db,
      schema: r.schema,
      tenantId: 'synthetic-tenant',
      trustedReceiptSha256: 'a'.repeat(64),
      maxRowsPerChunk: 100,
    });
    expect(calls[1]).toMatchObject({ tenantId: 'synthetic-other-tenant' });
    expect(calls[2]).toMatchObject({
      tenantId: 'synthetic-tenant',
      trustedReceiptSha256: 'f'.repeat(64),
    });
    expect(close).toHaveBeenCalled();
    expect(reopen).toHaveBeenCalledTimes(1);
  });

  it('fails partial-import unless the first step is still loading', async () => {
    vi.mocked(restoreDsqlIdentitySlice).mockResolvedValue({
      status: 'sealed',
      fullRuntimeReady: false,
    } as never);
    const r = await run();
    expect(lastCheck(r)).toEqual({ name: 'partial-import', passed: false });
  });

  it('fails when a changed tenant or receipt is not rejected as a validation error', async () => {
    vi.mocked(restoreDsqlIdentitySlice).mockResolvedValue({ status: 'loading' } as never);
    expect(lastCheck(await run())).toEqual({
      name: 'changed-source-and-tenant-rejected',
      passed: false,
    });
    vi.mocked(restoreDsqlIdentitySlice).mockReset();
    vi.mocked(restoreDsqlIdentitySlice)
      .mockResolvedValueOnce({ status: 'loading' } as never)
      .mockRejectedValueOnce(new DsqlIdentityImportValidationError())
      .mockRejectedValueOnce(new Error('transport'));
    expect(lastCheck(await run())).toEqual({
      name: 'changed-source-and-tenant-rejected',
      passed: false,
    });
  });

  it('bounds the resume loop to 1000 steps and stops at either terminal status', async () => {
    vi.mocked(restoreDsqlIdentitySlice).mockReset();
    vi.mocked(restoreDsqlIdentitySlice)
      .mockResolvedValueOnce({ status: 'loading' } as never)
      .mockRejectedValueOnce(new DsqlIdentityImportValidationError())
      .mockRejectedValueOnce(new DsqlIdentityImportValidationError())
      .mockResolvedValue({ status: 'loading' } as never);
    let r = await run();
    expect(lastCheck(r)).toEqual({ name: 'resume-after-reopening-backup', passed: false });
    expect(restoreDsqlIdentitySlice).toHaveBeenCalledTimes(3 + 1000);

    for (const terminal of ['sealed', 'native_subset_verified']) {
      vi.mocked(restoreDsqlIdentitySlice).mockReset();
      vi.mocked(restoreDsqlIdentitySlice)
        .mockResolvedValueOnce({ status: 'loading' } as never)
        .mockRejectedValueOnce(new DsqlIdentityImportValidationError())
        .mockRejectedValueOnce(new DsqlIdentityImportValidationError())
        .mockResolvedValueOnce({ status: 'loading' } as never)
        .mockResolvedValueOnce({ status: 'loading' } as never)
        .mockResolvedValueOnce({ status: terminal } as never)
        .mockResolvedValue({ status: 'loading' } as never);
      r = await run();
      expect(r.passed).toBe(true);
      expect(restoreDsqlIdentitySlice).toHaveBeenCalledTimes(6);
    }
  });

  it('requires a verified, non-runtime-ready receipt', async () => {
    const base = await verifyDsqlIdentitySubset({} as never);
    for (const patch of [
      { fullRuntimeReady: true },
      { status: 'sealed' },
      { status: 'sealed', fullRuntimeReady: true },
    ]) {
      vi.mocked(verifyDsqlIdentitySubset).mockResolvedValue({ ...base, ...patch } as never);
      step = 0;
      expect(lastCheck(await run())).toEqual({
        name: 'native-readback-and-reference-verification',
        passed: false,
      });
    }
  });

  it('compares restored row counts with the fixture and the omitted list size', async () => {
    const base = await verifyDsqlIdentitySubset({} as never);
    vi.mocked(createDsqlIdentityFixture).mockResolvedValue({
      ...(await createDsqlIdentityFixture()),
      expectedRows: { ...rows, 'core.users_core': 999 },
    });
    expect(lastCheck(await run())).toEqual({
      name: 'native-readback-and-reference-verification',
      passed: false,
    });
    vi.mocked(createDsqlIdentityFixture).mockResolvedValue({
      ...(await createDsqlIdentityFixture()),
      expectedRows: { ...rows, 'core.tenants': 5 },
    });
    step = 0;
    expect(lastCheck(await run())).toEqual({
      name: 'native-readback-and-reference-verification',
      passed: false,
    });
    for (const omittedDatasets of [omitted().slice(1), [...omitted(), 'extra.dataset']]) {
      vi.mocked(createDsqlIdentityFixture).mockResolvedValue({
        ...(await createDsqlIdentityFixture()),
        expectedRows: { ...rows },
      });
      vi.mocked(verifyDsqlIdentitySubset).mockResolvedValue({ ...base, omittedDatasets });
      step = 0;
      expect(lastCheck(await run())).toEqual({
        name: 'native-readback-and-reference-verification',
        passed: false,
      });
    }
  });

  it.each([
    ['too few chunks', { count: '8', max_rows: 100, total_rows: '603' }],
    ['unparseable count', { max_rows: 100, total_rows: '603' }],
    ['non-integer count', { count: '1.5', max_rows: 100, total_rows: '603' }],
    ['oversized chunk', { count: '9', max_rows: 101, total_rows: '603' }],
    ['non-numeric chunk size', { count: '9', max_rows: '100', total_rows: '603' }],
    ['missing chunk size', { count: '9', total_rows: '603' }],
    ['row total mismatch', { count: '9', max_rows: 100, total_rows: '602' }],
    ['row total missing', { count: '9', max_rows: 100 }],
  ])('rejects chunk statistics: %s', async (_name, row) => {
    chunkRow = row;
    expect(lastCheck(await run())).toEqual({
      name: 'native-readback-and-reference-verification',
      passed: false,
    });
  });

  it('accepts more chunks than the minimum and smaller chunks', async () => {
    chunkRow = { count: '40', max_rows: 1, total_rows: '603' };
    expect((await run()).passed).toBe(true);
  });

  it('runs the duplicate insert inside the rejected transaction with a unique id', async () => {
    const tx = { execute: vi.fn().mockResolvedValue(undefined) };
    transaction.mockImplementation(async (callback: (t: typeof tx) => Promise<void>) => {
      await callback(tx);
      throw Object.assign(new Error('dup'), { code: '23505' });
    });
    const r = await run();
    expect(r.passed).toBe(true);
    expect(tx.execute).toHaveBeenCalledTimes(1);
    const [sql, params] = tx.execute.mock.calls[0];
    expect(sql).toContain(`INSERT INTO "${r.schema}"."passkeys"`);
    expect(sql).toContain(`FROM "${r.schema}"."passkeys" ORDER BY id LIMIT 1`);
    expect(params).toEqual([expect.stringMatching(/^duplicate-[0-9a-f-]{36}$/u)]);
  });

  it('fails when the duplicate is accepted or rejected with another code', async () => {
    transaction.mockResolvedValue(undefined);
    expect(lastCheck(await run())).toEqual({ name: 'native-uniqueness-enforced', passed: false });
    transaction.mockRejectedValue(null);
    step = 0;
    expect(lastCheck(await run())).toEqual({ name: 'native-uniqueness-enforced', passed: false });
    transaction.mockRejectedValue({ code: '23503' });
    step = 0;
    expect(lastCheck(await run())).toEqual({
      name: 'native-uniqueness-enforced',
      passed: false,
    });
  });

  it('requires each tampering step to affect exactly one row and be rejected', async () => {
    execute.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('UPDATE'))
        changed = sql.includes('users_pii') ? params?.[0] !== '9007199254740993' : true;
      return { success: true, rowsAffected: sql.startsWith('UPDATE') ? 0 : 1, durationMs: 0 };
    });
    expect(lastCheck(await run())).toEqual({
      name: 'precise-json-number-change-rejected',
      passed: false,
    });
    execute.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('UPDATE'))
        changed = sql.includes('users_pii') ? params?.[0] !== '9007199254740993' : true;
      return {
        success: true,
        rowsAffected: sql.includes('SET counter') ? 0 : 1,
        durationMs: 0,
      };
    });
    expect(lastCheck(await run())).toEqual({ name: 'changed-native-row-rejected', passed: false });
  });

  it('passes the precise integer values to the JSON update and detects the first mismatch', async () => {
    await run();
    const updates = execute.mock.calls.filter(([sql]) => sql.startsWith('UPDATE'));
    expect(updates.map(([, params]) => params)).toEqual([
      ['9007199254740992'],
      ['9007199254740993'],
      undefined,
    ]);
    expect(updates[0][0]).toContain('"users_pii"');
    expect(updates[2][0]).toContain('SET counter = counter + 1');
  });

  it('fails when the changed JSON number or native row is not detected', async () => {
    vi.mocked(verifyDsqlIdentitySubset).mockImplementation(
      async () =>
        ({
          status: 'native_subset_verified',
          fullRuntimeReady: false,
          tables: Object.entries(rows).map(([datasetId, rowCount]) => ({
            datasetId,
            rowCount,
            sourceSha256: 'a',
            targetSha256: 'b',
          })),
          omittedDatasets: omitted(),
        }) as never
    );
    expect(lastCheck(await run())).toEqual({
      name: 'precise-json-number-change-rejected',
      passed: false,
    });
  });

  it('marks local fixture cleanup failures and still reports remote cleanup', async () => {
    close.mockRejectedValue(new Error('cannot remove'));
    const r = await run();
    expect(r.passed).toBe(false);
    expect(lastCheck(r)).toEqual({ name: 'local-fixture-cleanup', passed: false });
    expect(r.cleanup).toBe('complete');
    expect(r.checks.filter((c) => c.name === 'local-fixture-cleanup')).toHaveLength(1);
  });

  it('closes both the reader and the fixture exactly once on success', async () => {
    const fixture = await createDsqlIdentityFixture();
    const readerClose = vi.fn().mockResolvedValue(undefined);
    const fixtureClose = vi.fn().mockResolvedValue(undefined);
    reopen.mockResolvedValue({ close: readerClose });
    fixture.close = fixtureClose;
    const r = await run();
    expect(r.passed).toBe(true);
    expect(r.checks.some((c) => c.name === 'local-fixture-cleanup')).toBe(false);
    expect(readerClose).toHaveBeenCalledTimes(1);
    expect(fixtureClose).toHaveBeenCalledTimes(1);
  });
});
