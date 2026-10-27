import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { POSTGRES_RESTORE_TABLE_CONTRACTS } from '../import/postgres-restore-table-contract';
import {
  createDsqlIdentitySchemaPlan,
  dsqlIdentityTableName,
  initializeDsqlIdentitySchema,
  type DsqlIdentitySchemaDatabase,
  type DsqlIdentitySchemaProgress,
} from './identity-schema';

const SCHEMA = `authrim_dsql_identity_${'a'.repeat(32)}`;
const ROOT = resolve(import.meta.dirname, '../../../..');
const clean = (text: string) => text.replace(/\s+/gu, ' ').trim();

function database() {
  const plan = createDsqlIdentitySchemaPlan(SCHEMA);
  const state = {
    status: 'completed',
    statuses: [] as string[],
    jobOverrides: {} as Record<string, unknown>,
    catalogValid: true,
    missingJob: false,
    missingJobId: false,
  };
  let nextIndex = 0;
  const jobs = new Map<string, (typeof plan.indexes)[number]>();
  const db = {
    execute: vi
      .fn<DsqlIdentitySchemaDatabase['execute']>()
      .mockResolvedValue({ success: true, rowsAffected: 0 }),
    queryOne: vi
      .fn<DsqlIdentitySchemaDatabase['queryOne']>()
      .mockImplementation(async <T>(sql: string, params?: unknown[]): Promise<T | null> => {
        if (sql.startsWith('CREATE ')) {
          if (state.missingJobId) return null;
          const jobId = `synthetic-job-${nextIndex}`;
          jobs.set(jobId, plan.indexes[nextIndex++]);
          return { job_id: jobId } as T;
        }
        if (sql.includes('FROM sys.jobs')) {
          if (state.missingJob) return null;
          const index = jobs.get(String(params?.[0]));
          return {
            job_id: params?.[0],
            status: state.statuses.shift() ?? state.status,
            job_type: 'INDEX_BUILD',
            object_name: `${SCHEMA}.${index?.name}`,
            ...state.jobOverrides,
          } as T;
        }
        const index = plan.indexes.find((item) => item.name === params?.[1]);
        return { is_valid: state.catalogValid, is_unique: index?.unique } as T;
      }) as DsqlIdentitySchemaDatabase['queryOne'] & {
      mock: { calls: Parameters<DsqlIdentitySchemaDatabase['queryOne']>[] };
    },
  } satisfies DsqlIdentitySchemaDatabase;
  return { db, state, plan };
}

describe('DSQL native identity evaluation schema', () => {
  it('preserves PostgreSQL column types, defaults, checks, keys and every index for the slice', () => {
    const plan = createDsqlIdentitySchemaPlan(SCHEMA);
    for (const table of plan.tables) {
      const family = table.name === 'users_pii' ? 'pii' : 'core';
      const source = readFileSync(
        resolve(ROOT, `migrations/${family}/postgresql/001_0_4_0_${family}_baseline.sql`),
        'utf8'
      );
      const body = source.match(
        new RegExp(`CREATE TABLE public\\.${table.name} \\(([\\s\\S]*?)\\n\\);`)
      );
      expect(body).not.toBeNull();
      if (!body) throw new Error('source_table_missing');
      const constraints = Array.from(
        source.matchAll(new RegExp(`ALTER TABLE ONLY public\\.${table.name}\\s+ADD ([^;]+);`, 'gu'))
      ).map((match) => match[1]);
      expect(clean(table.sql)).toBe(
        clean(
          `CREATE TABLE "${SCHEMA}"."${table.name}" (${body[1].trim()}, ${constraints.join(', ')})`
        )
      );
      const contract = POSTGRES_RESTORE_TABLE_CONTRACTS.find((item) => item.table === table.name);
      if (!contract) throw new Error('source_contract_missing');
      expect(table.datasetId).toBe(contract.datasetId);
      expect(table.columns).toEqual(contract.columns);
      const sourceColumns = body[1]
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('CONSTRAINT '))
        .map((line) => line.split(' ')[0]);
      expect([...table.columns].sort()).toEqual(sourceColumns.sort());

      const sourceIndexes = Array.from(
        source.matchAll(
          new RegExp(
            `CREATE (UNIQUE )?INDEX ([a-z_]+) ON public\\.${table.name} USING btree ([^;]+);`,
            'gu'
          )
        )
      ).map((match) =>
        clean(
          `CREATE ${match[1] ?? ''}INDEX ASYNC "${match[2]}" ON "${SCHEMA}"."${table.name}" ${match[3]}`
        )
      );
      expect(
        plan.indexes
          .filter((index) => index.table === table.name)
          .map((index) => clean(index.sql))
          .sort()
      ).toEqual(sourceIndexes.sort());

      // A later source alteration or new trigger requires explicit reevaluation,
      // never silently treating this snapshot as the current native contract.
      const directory = resolve(ROOT, `migrations/${family}/postgresql`);
      for (const filename of readdirSync(directory).filter((name) => name.endsWith('.sql'))) {
        const migration = readFileSync(resolve(directory, filename), 'utf8');
        expect(migration).not.toMatch(
          new RegExp(`CREATE TRIGGER[^;]+ ON (?:public\\.)?${table.name}\\b`, 'u')
        );
        if (!filename.startsWith('001_')) {
          expect(migration).not.toMatch(
            new RegExp(`ALTER TABLE (?:ONLY )?(?:public\\.)?${table.name}\\b`, 'u')
          );
        }
      }
    }
    expect(plan.tables.map((table) => table.name)).toEqual(['users_core', 'users_pii', 'passkeys']);
    expect(plan.indexes).toHaveLength(12);
    expect(plan.fullRuntimeReady).toBe(false);
    expect(plan.scope).toBe('identity-staging-experiment');
  });

  it('fingerprints the source contracts and native definitions independently of the trial namespace', () => {
    const first = createDsqlIdentitySchemaPlan(SCHEMA);
    const second = createDsqlIdentitySchemaPlan(`authrim_dsql_identity_${'b'.repeat(32)}`);
    expect(first.sourceContractFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.sourceContractFingerprint).toBe(second.sourceContractFingerprint);
    expect(first.tables[0].sql).not.toBe(second.tables[0].sql);
  });

  it.each([
    'public',
    'authrim_dsql_identity_',
    `authrim_dsql_identity_${'A'.repeat(32)}`,
    `${SCHEMA}";DROP SCHEMA public`,
  ])(
    'rejects non-experimental or injectable namespace %s before database access',
    async (schema) => {
      const { db } = database();
      await expect(initializeDsqlIdentitySchema(db, schema)).rejects.toThrow(
        'dsql_identity_schema_invalid'
      );
      expect(db.execute).not.toHaveBeenCalled();
      expect(db.queryOne).not.toHaveBeenCalled();
    }
  );

  it('restricts table-name interpolation to the native allowlist', () => {
    expect(dsqlIdentityTableName(SCHEMA, 'users_core')).toBe(`"${SCHEMA}"."users_core"`);
    expect(() => dsqlIdentityTableName(SCHEMA, 'users_core"' as 'users_core')).toThrow(
      'dsql_identity_table_invalid'
    );
  });

  it('initializes separate DDL operations and waits for actual job completion and catalog validity', async () => {
    const { db, state, plan } = database();
    state.statuses = ['submitted', 'processing', 'completed'];
    const progress: DsqlIdentitySchemaProgress[] = [];
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await initializeDsqlIdentitySchema(db, SCHEMA, {
      sleep,
      pollIntervalMs: 7,
      onProgress: (event) => progress.push(event),
    });
    expect(result).toEqual(plan);
    expect(sleep.mock.calls).toEqual([[7], [7]]);
    expect(db.execute.mock.calls.map(([sql]) => sql)).toEqual([
      `CREATE SCHEMA "${SCHEMA}"`,
      ...plan.tables.map((table) => table.sql),
    ]);
    expect(
      db.queryOne.mock.calls.filter(([sql]) => sql.startsWith('CREATE ')).map(([sql]) => sql)
    ).toEqual(plan.indexes.map((index) => index.sql));
    expect(progress.filter((event) => event.status === 'ready')).toHaveLength(12);
    expect(progress.slice(0, 4)).toEqual([
      { kind: 'schema', name: SCHEMA, status: 'attempted' },
      { kind: 'schema', name: SCHEMA, status: 'created' },
      { kind: 'table', name: 'users_core', status: 'attempted' },
      { kind: 'table', name: 'users_core', status: 'created' },
    ]);
    for (const [sql] of [...db.execute.mock.calls, ...db.queryOne.mock.calls]) {
      expect(sql).not.toMatch(/;|IF NOT EXISTS|DROP|CASCADE|BEGIN|COMMIT/iu);
    }
  });

  it('does not adopt an existing schema or clean up an ambiguous create', async () => {
    const { db } = database();
    const progress: DsqlIdentitySchemaProgress[] = [];
    db.execute.mockRejectedValueOnce(Object.assign(new Error('secret SQL'), { code: '42P06' }));
    await expect(
      initializeDsqlIdentitySchema(db, SCHEMA, { onProgress: (event) => progress.push(event) })
    ).rejects.toMatchObject({
      message: 'dsql_identity_schema_initialization_failed',
      code: '42P06',
    });
    expect(progress).toEqual([{ kind: 'schema', name: SCHEMA, status: 'attempted' }]);
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(db.queryOne).not.toHaveBeenCalled();
  });

  it('halts on table initialization failure without touching subsequent tables or indexes', async () => {
    const { db } = database();
    const progress: DsqlIdentitySchemaProgress[] = [];
    db.execute
      .mockResolvedValueOnce({ success: true, rowsAffected: 0 })
      .mockResolvedValueOnce({ success: false, rowsAffected: 0 });
    await expect(
      initializeDsqlIdentitySchema(db, SCHEMA, { onProgress: (event) => progress.push(event) })
    ).rejects.toThrow('dsql_identity_table_create_failed');
    expect(progress.at(-1)).toEqual({ kind: 'table', name: 'users_core', status: 'attempted' });
    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(db.queryOne).not.toHaveBeenCalled();
  });

  it.each([
    ['missing job ID', { missingJobId: true }, 'index_job_missing'],
    ['missing job status', { missingJob: true }, 'index_job_invalid'],
    ['wrong job type', { jobOverrides: { job_type: 'DROP' } }, 'index_job_invalid'],
    ['another schema', { jobOverrides: { object_name: 'public.elsewhere' } }, 'index_job_invalid'],
    ['failed job', { status: 'failed' }, 'index_build_failed'],
    ['unknown job state', { status: 'unexpected' }, 'index_status_invalid'],
    ['invalid catalog index', { catalogValid: false }, 'index_catalog_invalid'],
  ])(
    'rejects %s, never returns a ready schema or performs cleanup',
    async (_label, change, reason) => {
      const { db, state } = database();
      Object.assign(state, change);
      const progress: DsqlIdentitySchemaProgress[] = [];
      await expect(
        initializeDsqlIdentitySchema(db, SCHEMA, { onProgress: (event) => progress.push(event) })
      ).rejects.toThrow(`dsql_identity_${reason}`);
      expect(progress.some((event) => event.status === 'ready')).toBe(false);
      expect(db.queryOne.mock.calls.filter(([sql]) => sql.startsWith('CREATE '))).toHaveLength(1);
      expect(db.execute).toHaveBeenCalledTimes(4);
    }
  );

  it('bounds in-progress jobs and leaves caller-visible pending ownership for safe cleanup', async () => {
    const { db, state } = database();
    state.status = 'processing';
    const sleep = vi.fn().mockResolvedValue(undefined);
    const progress: DsqlIdentitySchemaProgress[] = [];
    await expect(
      initializeDsqlIdentitySchema(db, SCHEMA, {
        maxIndexPolls: 2,
        sleep,
        onProgress: (event) => progress.push(event),
      })
    ).rejects.toThrow('dsql_identity_index_wait_exhausted');
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(progress.at(-1)).toMatchObject({
      kind: 'index',
      status: 'created',
      jobId: 'synthetic-job-0',
    });
    expect(db.queryOne.mock.calls.filter(([sql]) => sql.includes('FROM sys.jobs'))).toHaveLength(2);
  });

  it('allows a default async index build to complete after more than sixty polls', async () => {
    const { db, state } = database();
    state.statuses = [...Array<string>(61).fill('processing'), 'completed'];
    const sleep = vi.fn().mockResolvedValue(undefined);
    const plan = await initializeDsqlIdentitySchema(db, SCHEMA, { sleep });
    expect(plan.fullRuntimeReady).toBe(false);
    expect(sleep).toHaveBeenCalledTimes(61);
    expect(sleep.mock.calls.every(([milliseconds]) => milliseconds === 500)).toBe(true);
    expect(db.queryOne.mock.calls.filter(([sql]) => sql.includes('FROM sys.jobs'))).toHaveLength(
      73
    );
  });

  it.each([
    { maxIndexPolls: 0 },
    { maxIndexPolls: 601 },
    { pollIntervalMs: -1 },
    { pollIntervalMs: 5001 },
  ])('validates poll bounds before creating objects: %j', async (options) => {
    const { db } = database();
    await expect(initializeDsqlIdentitySchema(db, SCHEMA, options)).rejects.toThrow(
      'dsql_identity_schema_poll_options_invalid'
    );
    expect(db.execute).not.toHaveBeenCalled();
  });
});
