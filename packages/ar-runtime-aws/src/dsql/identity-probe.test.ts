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
const execute = vi.fn<DsqlProbeDatabase['execute']>();
const transaction = vi.fn();
const close = vi.fn();
const reopen = vi.fn();
const db = {
  getType: () => 'aurora-dsql',
  queryOne: vi.fn(async (sql: string) =>
    sql.includes('current_database')
      ? { name: 'postgres' }
      : { count: '9', max_rows: 100, total_rows: '603' }
  ),
  execute,
  transaction,
} as unknown as DsqlProbeDatabase;

beforeEach(() => {
  vi.clearAllMocks();
  changed = false;
  step = 0;
  close.mockResolvedValue(undefined);
  reopen.mockResolvedValue({ close });
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
      options?.onProgress?.({ kind: 'table', name, status: 'attempted' });
      options?.onProgress?.({ kind: 'table', name, status: 'created' });
    }
    return createDsqlIdentitySchemaPlan(schema);
  });
  vi.mocked(createDsqlIdentityImportJournal).mockImplementation(async (_db, _schema, options) => {
    for (const name of ['authrim_identity_import_operation', 'authrim_identity_import_chunks']) {
      options?.onProgress?.({ kind: 'table', name, status: 'attempted' });
      options?.onProgress?.({ kind: 'table', name, status: 'created' });
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
      omittedDatasets: Array.from({ length: 15 }, (_, i) => `omitted-${i}`),
    } as Awaited<ReturnType<typeof verifyDsqlIdentitySubset>>;
  });
  execute.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.startsWith('UPDATE')) changed = params?.[0] !== '9007199254740993';
    return { success: true, rowsAffected: 1, durationMs: 0 };
  });
  transaction.mockRejectedValue(Object.assign(new Error('redacted'), { code: '23505' }));
});

describe('native DSQL identity probe boundary', () => {
  it('reopens verified input, verifies actual counts, rejects tampering and cleans only its objects', async () => {
    const result = await runDsqlIdentityProbe(db, { writeProbe: true });
    expect(result).toMatchObject({
      passed: true,
      fullRuntimeReady: false,
      restoredRows: rows,
      chunks: 9,
      cleanup: 'complete',
    });
    expect(result.checks).toHaveLength(10);
    expect(reopen).toHaveBeenCalledOnce();
    const drops = execute.mock.calls.map(([sql]) => sql).filter((sql) => sql.startsWith('DROP'));
    expect(drops).toHaveLength(6);
    expect(drops.every((sql) => sql.includes(result.schema) && !sql.includes('CASCADE'))).toBe(
      true
    );
  });

  it('does not count an unsupported SQL statement as uniqueness enforcement', async () => {
    transaction.mockRejectedValue(
      Object.assign(new Error('secret row and statement'), { code: '0A000' })
    );
    const result = await runDsqlIdentityProbe(db, { writeProbe: true });
    expect(result.passed).toBe(false);
    expect(result.checks.at(-1)).toMatchObject({
      name: 'native-uniqueness-enforced',
      passed: false,
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.cleanup).toBe('complete');
  });

  it('does not count a transport error as rejection of a changed native row', async () => {
    const original = vi.mocked(verifyDsqlIdentitySubset).getMockImplementation();
    if (!original) throw new Error('test_mock_missing');
    vi.mocked(verifyDsqlIdentitySubset).mockImplementation(async (input) => {
      if (changed) throw new Error('transport unavailable');
      return original(input);
    });
    const result = await runDsqlIdentityProbe(db, { writeProbe: true });
    expect(result.passed).toBe(false);
    expect(result.checks.at(-1)).toMatchObject({
      name: 'precise-json-number-change-rejected',
      passed: false,
    });
  });

  it('finishes reader pin checks before fixture files can be removed', async () => {
    let readerChecked = false;
    reopen.mockResolvedValue({
      close: async () => {
        await Promise.resolve();
        readerChecked = true;
      },
    });
    const fixture = await createDsqlIdentityFixture();
    const closeFixture = vi.fn(async () => {
      if (!readerChecked) throw new Error('reader check still running');
    });
    fixture.close = closeFixture;
    const result = await runDsqlIdentityProbe(db, { writeProbe: true });
    expect(result).toMatchObject({ passed: true, cleanup: 'complete' });
    expect(readerChecked).toBe(true);
    expect(closeFixture).toHaveBeenCalledOnce();
  });

  it('still removes the fixture when closing an individual reader fails', async () => {
    const fixture = await createDsqlIdentityFixture();
    fixture.backup.close = vi.fn().mockRejectedValue(new Error('reader changed'));
    const fixtureClose = vi.fn().mockResolvedValue(undefined);
    fixture.close = fixtureClose;
    const result = await runDsqlIdentityProbe(db, { writeProbe: true });
    expect(result.passed).toBe(false);
    expect(fixtureClose).toHaveBeenCalledOnce();
    expect(result.cleanup).toBe('complete');
  });

  it('leaves objects in place when an async index may still be running', async () => {
    vi.mocked(initializeDsqlIdentitySchema).mockImplementation(async (_db, schema, options) => {
      options?.onProgress?.({ kind: 'schema', name: schema, status: 'created' });
      options?.onProgress?.({ kind: 'table', name: 'users_core', status: 'created' });
      options?.onProgress?.({ kind: 'index', name: 'index_probe', status: 'attempted' });
      options?.onProgress?.({
        kind: 'index',
        name: 'index_probe',
        status: 'created',
        jobId: 'known',
      });
      throw new Error('private job timeout');
    });
    const result = await runDsqlIdentityProbe(db, { writeProbe: true });
    expect(result).toMatchObject({ passed: false, cleanup: 'creation-unconfirmed' });
    expect(execute).not.toHaveBeenCalled();
    expect(createDsqlIdentityFixture).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('does not remove a schema after an uncertain CREATE response', async () => {
    vi.mocked(initializeDsqlIdentitySchema).mockImplementation(async (_db, schema, options) => {
      options?.onProgress?.({ kind: 'schema', name: schema, status: 'attempted' });
      throw new Error('connection lost');
    });
    const result = await runDsqlIdentityProbe(db, { writeProbe: true });
    expect(result.cleanup).toBe('creation-unconfirmed');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects invalid counts and absent write opt-in before any operation', async () => {
    for (const options of [
      { writeProbe: false },
      { writeProbe: true, userCount: 2001 },
      { writeProbe: true, userCount: 1.5 },
    ]) {
      await expect(runDsqlIdentityProbe(db, options as { writeProbe: true })).rejects.toThrow(
        'dsql_identity_probe_explicit_write_required'
      );
    }
    expect(initializeDsqlIdentitySchema).not.toHaveBeenCalled();
    expect(createDsqlIdentityFixture).not.toHaveBeenCalled();
  });
});
