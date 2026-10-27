import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DsqlProbeDatabase } from './probe';
import { createDsqlConfigurationFixture } from './configuration-fixture';
import {
  createDsqlConfigurationSchemaPlan,
  initializeDsqlConfigurationSchema,
} from './configuration-schema';
import {
  createDsqlConfigurationImportJournal,
  DsqlConfigurationImportValidationError,
  DsqlConfigurationVerificationMismatch,
  restoreDsqlConfigurationSlice,
  verifyDsqlConfigurationSubset,
  verifyDsqlConfigurationReferences,
} from './configuration-import';
import { runDsqlConfigurationProbe } from './configuration-probe';

vi.mock('./configuration-fixture', () => ({ createDsqlConfigurationFixture: vi.fn() }));
vi.mock('./configuration-schema', async (original) => ({
  ...(await original<typeof import('./configuration-schema')>()),
  initializeDsqlConfigurationSchema: vi.fn(),
}));
vi.mock('./configuration-import', async (original) => ({
  ...(await original<typeof import('./configuration-import')>()),
  createDsqlConfigurationImportJournal: vi.fn(),
  restoreDsqlConfigurationSlice: vi.fn(),
  verifyDsqlConfigurationSubset: vi.fn(),
  verifyDsqlConfigurationReferences: vi.fn(),
}));

const rows = {
  'core.identity_providers': 101,
  'core.flows': 101,
  'core.flow_versions': 101,
  'core.flow_assignments': 102,
};
const precise = '{"preciseInteger":9007199254740993}';
let changed: boolean;
let step: number;
const execute = vi.fn<DsqlProbeDatabase['execute']>();
const transaction = vi.fn<DsqlProbeDatabase['transaction']>();
const close = vi.fn();
const reopen = vi.fn();
const db = {
  getType: () => 'aurora-dsql',
  queryOne: vi.fn(async (sql: string) =>
    sql.includes('current_database')
      ? { name: 'postgres' }
      : sql.startsWith('SELECT runtime_snapshot_json')
        ? { runtime_snapshot_json: precise }
        : { count: '8', max_rows: 100, total_rows: '405' }
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
  vi.mocked(createDsqlConfigurationFixture).mockResolvedValue({
    backup: { close } as unknown as Awaited<
      ReturnType<typeof createDsqlConfigurationFixture>
    >['backup'],
    trustedReceiptDigest: 'a'.repeat(64),
    tenantId: 'synthetic-tenant',
    expectedRows: { ...rows, 'core.tenants': 0 },
    reopen,
    close,
  });
  vi.mocked(initializeDsqlConfigurationSchema).mockImplementation(async (_db, schema, options) => {
    options?.onProgress?.({ kind: 'schema', name: schema, status: 'attempted' });
    options?.onProgress?.({ kind: 'schema', name: schema, status: 'created' });
    for (const name of ['identity_providers', 'flows', 'flow_versions', 'flow_assignments']) {
      options?.onProgress?.({ kind: 'table', name, status: 'attempted' });
      options?.onProgress?.({ kind: 'table', name, status: 'created' });
    }
    return createDsqlConfigurationSchemaPlan(schema);
  });
  vi.mocked(createDsqlConfigurationImportJournal).mockImplementation(
    async (_db, _schema, options) => {
      for (const name of [
        'authrim_configuration_import_operation',
        'authrim_configuration_import_chunks',
      ]) {
        options?.onProgress?.({ kind: 'table', name, status: 'attempted' });
        options?.onProgress?.({ kind: 'table', name, status: 'created' });
      }
    }
  );
  vi.mocked(restoreDsqlConfigurationSlice).mockImplementation(async (input) => {
    if (input.tenantId !== 'synthetic-tenant' || input.trustedReceiptSha256 !== 'a'.repeat(64)) {
      throw new DsqlConfigurationImportValidationError();
    }
    return {
      status: step++ === 0 ? 'loading' : 'sealed',
      fullRuntimeReady: false,
      datasetIndex: 0,
      rowOffset: 100,
      revision: step,
    };
  });
  vi.mocked(verifyDsqlConfigurationSubset).mockImplementation(async () => {
    if (changed) throw new DsqlConfigurationVerificationMismatch();
    return {
      status: 'native_subset_verified',
      fullRuntimeReady: false,
      tables: Object.entries(rows).map(([datasetId, rowCount]) => ({
        datasetId,
        rowCount,
        sourceSha256: 'a'.repeat(64),
        targetSha256: 'b'.repeat(64),
      })),
      omittedDatasets: Array.from({ length: 14 }, (_, i) => `omitted-${i}`),
    } as Awaited<ReturnType<typeof verifyDsqlConfigurationSubset>>;
  });
  execute.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.startsWith('UPDATE')) {
      changed = true;
      if (
        sql.includes("SET tenant_id='dsql-synthetic-configuration'") ||
        sql.includes("SET target_id='https://sp-000000.example.test/entity'") ||
        sql.includes("SET target_type='saml_sp'") ||
        params?.[0] === precise ||
        params?.[1] === '9007199254740993'
      )
        changed = false;
    }
    return { success: true, rowsAffected: 1, durationMs: 0 };
  });
  vi.mocked(verifyDsqlConfigurationReferences).mockImplementation(async () => {
    if (changed) throw new DsqlConfigurationVerificationMismatch();
  });
  transaction.mockImplementation(async (callback) =>
    callback({
      ...db,
      execute: async (sql: string) => {
        throw Object.assign(new Error('redacted'), {
          code: sql.startsWith('INSERT')
            ? '23505'
            : sql.includes('SET target_type=')
              ? '23514'
              : '23503',
        });
      },
    })
  );
});

describe('native DSQL configuration probe boundary', () => {
  it('reopens verified input, verifies actual counts, rejects tampering and cleans only its objects', async () => {
    const result = await runDsqlConfigurationProbe(db, { writeProbe: true });
    expect(result).toMatchObject({
      passed: true,
      fullRuntimeReady: false,
      restoredRows: rows,
      chunks: 8,
      cleanup: 'complete',
    });
    expect(result.checks).toHaveLength(16);
    expect(reopen).toHaveBeenCalledOnce();
    const drops = execute.mock.calls.map(([sql]) => sql).filter((sql) => sql.startsWith('DROP'));
    expect(drops).toHaveLength(7);
    expect(drops.every((sql) => sql.includes(result.schema) && !sql.includes('CASCADE'))).toBe(
      true
    );
  });

  it('does not count an unsupported SQL statement as uniqueness enforcement', async () => {
    transaction.mockRejectedValue(
      Object.assign(new Error('secret row and statement'), { code: '0A000' })
    );
    const result = await runDsqlConfigurationProbe(db, { writeProbe: true });
    expect(result.passed).toBe(false);
    expect(result.checks.at(-1)).toMatchObject({
      name: 'native-uniqueness-enforced',
      passed: false,
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.cleanup).toBe('complete');
  });

  it('does not count a transport error as rejection of a changed native row', async () => {
    const original = vi.mocked(verifyDsqlConfigurationSubset).getMockImplementation();
    if (!original) throw new Error('test_mock_missing');
    vi.mocked(verifyDsqlConfigurationSubset).mockImplementation(async (input) => {
      if (changed) throw new Error('transport unavailable');
      return original(input);
    });
    const result = await runDsqlConfigurationProbe(db, { writeProbe: true });
    expect(result.passed).toBe(false);
    expect(result.checks.at(-1)).toMatchObject({
      name: 'precise-json-number-change-rejected',
      passed: false,
    });
  });

  it.each([
    ['23503', 'native-foreign-key-enforced'],
    ['23514', 'native-target-shape-enforced'],
  ])('does not treat a different SQL error as the %s invariant', async (code, name) => {
    const original = transaction.getMockImplementation();
    transaction.mockImplementation(async (callback) => {
      try {
        return await original?.(callback);
      } catch (error) {
        if (typeof error === 'object' && error && 'code' in error && error.code === code)
          throw Object.assign(new Error('private SQL statement'), { code: '08006' });
        throw error;
      }
    });
    const result = await runDsqlConfigurationProbe(db, { writeProbe: true });
    expect(result).toMatchObject({ passed: false, cleanup: 'complete' });
    expect(result.checks.at(-1)).toEqual({ name, passed: false });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it.each(['accept', 'outage'])(
    'fails if reference validation returns %s instead of rejecting cross-tenant data',
    async (mode) => {
      vi.mocked(verifyDsqlConfigurationReferences).mockImplementation(async () => {
        if (mode === 'outage') throw new Error('private connection');
      });
      const result = await runDsqlConfigurationProbe(db, { writeProbe: true });
      expect(result.passed).toBe(false);
      expect(result.checks.at(-1)).toEqual({
        name: 'cross-tenant-reference-rejected',
        passed: false,
      });
      expect(result.cleanup).toBe('complete');
    }
  );

  it('reports unsuccessful cleanup even when every data check passed', async () => {
    const original = execute.getMockImplementation();
    execute.mockImplementation(async (sql, params) => {
      if (sql.startsWith('DROP')) throw new Error('private cleanup failure');
      if (!original) throw new Error('test_mock_missing');
      return original(sql, params);
    });
    const result = await runDsqlConfigurationProbe(db, { writeProbe: true });
    expect(result).toMatchObject({ passed: false, cleanup: 'failed' });
    expect(result.checks.every((check) => check.passed)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('finishes reader pin checks before fixture files can be removed', async () => {
    let readerChecked = false;
    reopen.mockResolvedValue({
      close: async () => {
        await Promise.resolve();
        readerChecked = true;
      },
    });
    const fixture = await createDsqlConfigurationFixture();
    const closeFixture = vi.fn(async () => {
      if (!readerChecked) throw new Error('reader check still running');
    });
    fixture.close = closeFixture;
    const result = await runDsqlConfigurationProbe(db, { writeProbe: true });
    expect(result).toMatchObject({ passed: true, cleanup: 'complete' });
    expect(readerChecked).toBe(true);
    expect(closeFixture).toHaveBeenCalledOnce();
  });

  it('still removes the fixture when closing an individual reader fails', async () => {
    const fixture = await createDsqlConfigurationFixture();
    fixture.backup.close = vi.fn().mockRejectedValue(new Error('reader changed'));
    const fixtureClose = vi.fn().mockResolvedValue(undefined);
    fixture.close = fixtureClose;
    const result = await runDsqlConfigurationProbe(db, { writeProbe: true });
    expect(result.passed).toBe(false);
    expect(fixtureClose).toHaveBeenCalledOnce();
    expect(result.cleanup).toBe('complete');
  });

  it('leaves objects in place when an async index may still be running', async () => {
    vi.mocked(initializeDsqlConfigurationSchema).mockImplementation(
      async (_db, schema, options) => {
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
      }
    );
    const result = await runDsqlConfigurationProbe(db, { writeProbe: true });
    expect(result).toMatchObject({ passed: false, cleanup: 'creation-unconfirmed' });
    expect(execute).not.toHaveBeenCalled();
    expect(createDsqlConfigurationFixture).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('does not remove a schema after an uncertain CREATE response', async () => {
    vi.mocked(initializeDsqlConfigurationSchema).mockImplementation(
      async (_db, schema, options) => {
        options?.onProgress?.({ kind: 'schema', name: schema, status: 'attempted' });
        throw new Error('connection lost');
      }
    );
    const result = await runDsqlConfigurationProbe(db, { writeProbe: true });
    expect(result.cleanup).toBe('creation-unconfirmed');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects invalid counts and absent write opt-in before any operation', async () => {
    for (const options of [
      { writeProbe: false },
      { writeProbe: true, spCount: 2001 },
      { writeProbe: true, spCount: 1.5 },
    ]) {
      await expect(runDsqlConfigurationProbe(db, options as { writeProbe: true })).rejects.toThrow(
        'dsql_configuration_probe_explicit_write_required'
      );
    }
    expect(initializeDsqlConfigurationSchema).not.toHaveBeenCalled();
    expect(createDsqlConfigurationFixture).not.toHaveBeenCalled();
  });
});
