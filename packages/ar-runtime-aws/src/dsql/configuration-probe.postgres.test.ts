import { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuroraDsqlAdapter } from './adapter';
import { createDsqlConfigurationSchemaPlan } from './configuration-schema';
import { runDsqlConfigurationProbe } from './configuration-probe';

// This test checks the complete probe's SQL/backup/resume/cleanup orchestration on
// local PostgreSQL. It does not demonstrate DSQL's service or ASYNC index support.
vi.mock('./configuration-schema', async (original) => ({
  ...(await original<typeof import('./configuration-schema')>()),
  initializeDsqlConfigurationSchema: vi.fn<
    typeof import('./configuration-schema').initializeDsqlConfigurationSchema
  >(async (db, schema, options) => {
    const plan = createDsqlConfigurationSchemaPlan(schema);
    options?.onProgress?.({ kind: 'schema', name: schema, status: 'attempted' });
    await db.execute(`CREATE SCHEMA "${schema}"`);
    options?.onProgress?.({ kind: 'schema', name: schema, status: 'created' });
    for (const table of plan.tables) {
      options?.onProgress?.({ kind: 'table', name: table.name, status: 'attempted' });
      await db.execute(table.sql);
      options?.onProgress?.({ kind: 'table', name: table.name, status: 'created' });
    }
    for (const index of plan.indexes) {
      await db.execute(index.sql.replace(' INDEX ASYNC ', ' INDEX '));
    }
    return plan;
  }),
}));

const url = process.env.AUTHRIM_AWS_TEST_DATABASE_URL;
(url ? describe : describe.skip)('configuration probe on real local PostgreSQL', () => {
  let db: AuroraDsqlAdapter | undefined;
  afterEach(async () => {
    await db?.close();
    vi.restoreAllMocks();
  });

  it.each([1, 3, 101])(
    'restores %i SPs, resumes and verifies all negative cases then removes only its schema',
    async (spCount) => {
      const pool = new Pool({
        connectionString: url,
        max: 4,
        options: '-c default_transaction_isolation=repeatable\\ read',
      });
      db = new AuroraDsqlAdapter(
        {
          hostname: `${'a'.repeat(26)}.dsql.ap-northeast-1.on.aws`,
          region: 'ap-northeast-1',
          user: 'admin',
        },
        { poolFactory: () => pool }
      );
      const query = db.queryOne.bind(db);
      // The local test database has a different name from DSQL's fixed database.
      vi.spyOn(db, 'queryOne').mockImplementation((async (sql, ...args) =>
        sql === 'SELECT current_database() AS name'
          ? { name: 'postgres' }
          : query(sql, ...args)) as typeof db.queryOne);
      const execute = vi.spyOn(db, 'execute');
      const result = await runDsqlConfigurationProbe(db, { writeProbe: true, spCount });
      expect(result.checks.filter((check) => !check.passed)).toEqual([]);
      expect(result).toMatchObject({
        passed: true,
        fullRuntimeReady: false,
        cleanup: 'complete',
        chunks: 3 * Math.ceil(spCount / 100) + Math.ceil((spCount + 1) / 100),
        maxChunkRows: Math.min(100, spCount + 1),
        restoredRows: {
          'core.identity_providers': spCount,
          'core.flows': spCount,
          'core.flow_versions': spCount,
          'core.flow_assignments': spCount + 1,
        },
      });
      expect(result.checks).toHaveLength(16);
      expect(result.checks.every((check) => check.passed)).toBe(true);
      expect(result.omittedDatasets).toHaveLength(14);
      expect(
        await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [result.schema])
      ).toMatchObject({ rowCount: 0 });
      const drops = execute.mock.calls.map(([sql]) => sql).filter((sql) => sql.startsWith('DROP'));
      expect(drops).toHaveLength(7);
      expect(drops.every((sql) => sql.includes(result.schema) && !sql.includes('CASCADE'))).toBe(
        true
      );
    },
    60_000
  );
});
