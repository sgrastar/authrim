import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { AuroraDsqlAdapter } from './adapter';
import { runDsqlProbe } from './probe';

const databaseUrl = process.env.AUTHRIM_AWS_TEST_DATABASE_URL;

// PostgreSQL verifies the test harness and common SQL semantics, not DSQL compatibility.
(databaseUrl ? it : it.skip)(
  'runs the complete synthetic probe against local PostgreSQL',
  async () => {
    const pool = new Pool({
      connectionString: databaseUrl,
      options: '-c default_transaction_isolation=repeatable\\ read',
      max: 4,
    });
    const db = new AuroraDsqlAdapter(
      {
        hostname: `${'a'.repeat(26)}.dsql.ap-northeast-1.on.aws`,
        region: 'ap-northeast-1',
        user: 'admin',
      },
      { poolFactory: () => pool }
    );
    try {
      // Probe requires the DSQL database name. The local fixture must use postgres.
      const report = await runDsqlProbe(db, { writeProbe: true });
      expect(report).toMatchObject({ passed: true, cleanup: 'complete', fullRuntimeReady: false });
      expect(report.checks.filter((check) => check.passed)).toHaveLength(9);
      expect(
        await db.queryOne('SELECT nspname FROM pg_namespace WHERE nspname = $1', [report.schema])
      ).toBeNull();
    } finally {
      await db.close();
    }
  }
);
