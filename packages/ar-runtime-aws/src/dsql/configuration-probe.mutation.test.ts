import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DsqlProbeDatabase } from './probe';
import { createDsqlConfigurationFixture } from './configuration-fixture';
import { initializeDsqlConfigurationSchema } from './configuration-schema';
import {
  createDsqlConfigurationImportJournal,
  restoreDsqlConfigurationSlice,
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

const execute = vi.fn<DsqlProbeDatabase['execute']>();
const db = {
  getType: () => 'aurora-dsql',
  queryOne: vi.fn(async () => ({ name: 'postgres' })),
  execute,
  transaction: vi.fn(),
} as unknown as DsqlProbeDatabase;
type Event = { kind: 'schema' | 'table' | 'index'; name: string; status: string };
const e = (kind: Event['kind'], name: string, status: string) => ({ kind, name, status }) as never;
const drops = () => execute.mock.calls.map(([sql]) => sql).filter((sql) => sql.startsWith('DROP'));
const run = () => runDsqlConfigurationProbe(db, { writeProbe: true });
const initFails = (thrown: unknown, events: unknown[] = []) =>
  vi.mocked(initializeDsqlConfigurationSchema).mockImplementation(async (_db, _s, options) => {
    for (const event of events) options?.onProgress?.(event as never);
    throw thrown;
  });

beforeEach(() => {
  vi.resetAllMocks();
  execute.mockResolvedValue({ success: true, rowsAffected: 1, durationMs: 0 });
  vi.mocked(createDsqlConfigurationImportJournal).mockResolvedValue(undefined);
  (db.queryOne as ReturnType<typeof vi.fn>).mockResolvedValue({ name: 'postgres' });
});

describe('configuration probe (mutation hardening)', () => {
  it.each([
    'dsql_configuration_schema_create_failed',
    'dsql_configuration_table_create_failed',
    'dsql_configuration_index_job_missing',
    'dsql_configuration_index_job_invalid',
    'dsql_configuration_index_build_failed',
    'dsql_configuration_index_catalog_invalid',
    'dsql_configuration_index_status_invalid',
    'dsql_configuration_index_wait_exhausted',
    'dsql_configuration_schema_initialization_failed',
  ])('exposes the allow-listed failure code %s', async (code) => {
    initFails(new Error(code));
    expect((await run()).checks).toEqual([
      { name: 'database', passed: true },
      { name: 'native-schema-and-indexes', passed: false, failureCode: code },
    ]);
  });

  it('withholds unknown messages, non-Errors and malformed SQLSTATEs; keeps valid SQLSTATEs', async () => {
    const last = async (thrown: unknown) => {
      initFails(thrown);
      return (await run()).checks.at(-1);
    };
    const base = { name: 'native-schema-and-indexes', passed: false };
    expect(await last(new Error('private'))).toEqual(base);
    expect(await last({ message: 'dsql_configuration_schema_create_failed' })).toEqual(base);
    expect(await last(null)).toEqual(base);
    expect(await last('text')).toEqual(base);
    expect(await last(Object.assign(new Error('x'), { code: '42P01' }))).toEqual({
      ...base,
      sqlState: '42P01',
    });
    for (const code of ['abcde', '1234', 'ABCDE1', '-ABCDE', 12345])
      expect(await last(Object.assign(new Error('x'), { code })), String(code)).toEqual(base);
    expect(
      await last(
        Object.assign(new Error('dsql_configuration_table_create_failed'), { code: '23505' })
      )
    ).toEqual({
      ...base,
      failureCode: 'dsql_configuration_table_create_failed',
      sqlState: '23505',
    });
  });

  it('decides cleanup from the tracked progress events', async () => {
    const scenario = async (events: Event[]) => {
      execute.mockClear();
      initFails(new Error('stop'), events);
      return run();
    };
    let r = await scenario([]);
    expect(r).toMatchObject({ cleanup: 'not-needed', passed: false });
    r = await scenario([e('table', 't', 'created')]);
    expect(r.cleanup).toBe('not-needed');
    expect(execute).not.toHaveBeenCalled();
    r = await scenario([e('schema', 's', 'ready'), e('index', 'i', 'ready')]);
    expect(r.cleanup).toBe('not-needed');
    r = await scenario([e('schema', 's', 'attempted')]);
    expect(r.cleanup).toBe('creation-unconfirmed');
    r = await scenario([e('schema', 's', 'attempted'), e('schema', 's', 'created')]);
    expect(r.cleanup).toBe('complete');
    expect(drops()).toEqual([`DROP SCHEMA "${r.schema}"`]);
    r = await scenario([
      e('schema', 's', 'created'),
      e('table', 'a_table', 'attempted'),
      e('table', 'a_table', 'created'),
    ]);
    expect(drops()).toEqual([`DROP TABLE "${r.schema}"."a_table"`, `DROP SCHEMA "${r.schema}"`]);
    r = await scenario([
      e('schema', 's', 'created'),
      e('table', 'a_table', 'attempted'),
      e('table', 'a_table', 'ready'),
    ]);
    expect(r.cleanup).toBe('creation-unconfirmed');
    expect(execute).not.toHaveBeenCalled();
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
  });

  it('marks cleanup failed for a failed drop or an unsafe table name', async () => {
    execute.mockImplementation(async (sql: string) => {
      if (sql.startsWith('DROP SCHEMA')) throw new Error('denied');
      return { success: true, rowsAffected: 1, durationMs: 0 };
    });
    initFails(new Error('stop'), [e('schema', 's', 'created')]);
    expect(await run()).toMatchObject({ passed: false, cleanup: 'failed' });
    for (const bad of ['Xusers', 'users1', 'Bad-Name', 'a b', '']) {
      execute.mockReset();
      execute.mockResolvedValue({ success: true, rowsAffected: 1, durationMs: 0 });
      initFails(new Error('stop'), [e('schema', 's', 'created'), e('table', bad, 'created')]);
      const r = await run();
      expect(r.cleanup, bad).toBe('failed');
      expect(r.passed).toBe(false);
      expect(drops()).toEqual([]);
    }
  });

  it('marks failures closing the local fixture without hiding remote cleanup', async () => {
    vi.mocked(initializeDsqlConfigurationSchema).mockImplementation(async (_db, schema, o) => {
      o?.onProgress?.({ kind: 'schema', name: schema, status: 'created' });
      return undefined as never;
    });
    const backupClose = vi.fn().mockRejectedValue(new Error('x'));
    const fixtureClose = vi.fn().mockResolvedValue(undefined);
    vi.mocked(createDsqlConfigurationFixture).mockResolvedValue({
      backup: { close: backupClose },
      tenantId: 't',
      trustedReceiptDigest: 'a'.repeat(64),
      expectedRows: {},
      reopen: vi.fn(),
      close: fixtureClose,
    } as never);
    vi.mocked(restoreDsqlConfigurationSlice).mockResolvedValue({ status: 'sealed' } as never);
    const r = await run();
    expect(r.passed).toBe(false);
    expect(r.checks).toEqual([
      { name: 'database', passed: true },
      { name: 'native-schema-and-indexes', passed: true },
      { name: 'encrypted-synthetic-backup', passed: true },
      { name: 'partial-import', passed: false },
      { name: 'local-fixture-cleanup', passed: false },
    ]);
    expect(fixtureClose).toHaveBeenCalledTimes(1);
    expect(backupClose).toHaveBeenCalledTimes(1);
    expect(r.cleanup).toBe('complete');
  });

  it('does not mark local cleanup failed when both closes succeed', async () => {
    vi.mocked(initializeDsqlConfigurationSchema).mockResolvedValue(undefined as never);
    const backupClose = vi.fn().mockResolvedValue(undefined);
    const fixtureClose = vi.fn().mockResolvedValue(undefined);
    vi.mocked(createDsqlConfigurationFixture).mockResolvedValue({
      backup: { close: backupClose },
      tenantId: 't',
      trustedReceiptDigest: 'a'.repeat(64),
      expectedRows: {},
      reopen: vi.fn(),
      close: fixtureClose,
    } as never);
    vi.mocked(restoreDsqlConfigurationSlice).mockResolvedValue({ status: 'sealed' } as never);
    const r = await run();
    expect(r.checks.some((c) => c.name === 'local-fixture-cleanup')).toBe(false);
    expect(r.checks.at(-1)).toEqual({ name: 'partial-import', passed: false });
    expect(r.cleanup).toBe('not-needed');
  });
});
