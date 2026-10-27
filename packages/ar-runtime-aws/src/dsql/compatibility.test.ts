import { describe, expect, it } from 'vitest';
import { assessDsqlCompatibility } from './compatibility';

describe('DSQL static compatibility inventory', () => {
  it('locates procedural blockers without including source SQL or values in diagnostics', () => {
    const sql = `-- CREATE TRIGGER ignored\nCREATE FUNCTION f() RETURNS trigger\nLANGUAGE plpgsql AS $$\nBEGIN\n  PERFORM pg_advisory_xact_lock(1);\n  RAISE EXCEPTION 'private-fixture-value';\nEND;\n$$;\nCREATE TRIGGER actual AFTER INSERT ON t EXECUTE FUNCTION f();`;
    const report = assessDsqlCompatibility([{ path: 'core.sql', sql }]);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'trigger-function', line: 2, severity: 'blocker' }),
        expect.objectContaining({ code: 'procedural-language', line: 3, severity: 'blocker' }),
        expect.objectContaining({ code: 'advisory-lock', line: 5, severity: 'blocker' }),
        expect.objectContaining({ code: 'trigger', line: 9, severity: 'blocker' }),
      ])
    );
    expect(report.findings.filter((finding) => finding.code === 'trigger')).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain('private-fixture-value');
    expect(JSON.stringify(report)).not.toContain('PERFORM pg_advisory');
  });

  it('does not treat comments, strings or quoted identifiers as unsupported operations', () => {
    const sql = `/* CREATE TRIGGER bogus; /* LANGUAGE plpgsql */ */\n-- CREATE DATABASE ignored\nSELECT 'CREATE DATABASE secret', $$CREATE TRIGGER value$$, "SERIALIZABLE";\nSELECT 'a''LANGUAGE plpgsql';`;
    expect(assessDsqlCompatibility([{ path: 'values.sql', sql }]).findings).toEqual([]);
  });

  it('detects an anonymous block and preserves line numbers after comments', () => {
    const report = assessDsqlCompatibility([
      { path: 'bootstrap.sql', sql: '/* first\nsecond */\nDO $authrim$\nBEGIN\nEND\n$authrim$;' },
    ]);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: 'anonymous-procedural-block', line: 3, severity: 'blocker' })
    );
  });

  it.each([
    ['BEGIN ISOLATION LEVEL SERIALIZABLE', 'serializable-isolation'],
    ['BEGIN ISOLATION LEVEL READ COMMITTED', 'read-committed-isolation'],
    ['CREATE DATABASE database_name', 'create-database'],
    ['SELECT pg_try_advisory_lock(3)', 'advisory-lock'],
    ['SELECT pg_advisory_unlock_all()', 'advisory-lock'],
  ])('flags %s as %s', (sql, code) => {
    expect(assessDsqlCompatibility([{ path: 'input.sql', sql }]).findings).toContainEqual(
      expect.objectContaining({ code, severity: 'blocker' })
    );
  });

  it('requires review of DDL transaction boundaries and synchronous indexes', () => {
    const report = assessDsqlCompatibility([
      {
        path: 'migration.sql',
        sql: "CREATE TABLE t (id text PRIMARY KEY);\nCREATE UNIQUE INDEX idx ON t(id);\nINSERT INTO t VALUES ('one');",
      },
    ]);
    expect(report.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(['multiple-ddl-statements', 'ddl-and-dml', 'synchronous-index'])
    );
    expect(report.findings.every((finding) => finding.severity === 'manual-review')).toBe(true);
  });

  it('does not label supported foreign keys, FOR UPDATE or async indexes unsupported', () => {
    const report = assessDsqlCompatibility([
      {
        path: 'supported.sql',
        sql: 'CREATE TABLE child (id text REFERENCES parent(id) ON DELETE CASCADE);\nCREATE INDEX ASYNC idx ON child(id);\nSELECT id FROM child FOR UPDATE;',
      },
    ]);
    expect(report.findings.filter((finding) => finding.severity === 'blocker')).toEqual([]);
    expect(report.findings.some((finding) => finding.code === 'synchronous-index')).toBe(false);
    expect(report.fullRuntimeReady).toBe(false);
  });

  it('inspects literal SQL in TypeScript, excluding comments and retaining source locations', () => {
    const sql = `// await query('CREATE DATABASE ignored');\n/* await query('BEGIN ISOLATION LEVEL SERIALIZABLE'); */\nawait query('BEGIN ISOLATION LEVEL SERIALIZABLE');\nawait query(\`\nCREATE DATABASE \${name}\n\`);\nawait query(schema.sql);`;
    const report = assessDsqlCompatibility([{ path: 'restore.ts', sql, kind: 'typescript' }]);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: 'serializable-isolation', line: 3 })
    );
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: 'create-database', line: 5 })
    );
    expect(
      report.findings.filter((finding) => finding.code === 'serializable-isolation')
    ).toHaveLength(1);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: 'typescript-query-flow', severity: 'manual-review' })
    );
  });

  it('never certifies readiness, including empty input and unknown dynamically constructed SQL', () => {
    for (const sources of [
      [],
      [{ path: 'query.ts', sql: 'db.query(computedSql)', kind: 'typescript' as const }],
    ]) {
      const report = assessDsqlCompatibility(sources);
      expect(report.fullRuntimeReady).toBe(false);
      expect(report.assessment).toBe('static-triage');
      expect(report.limitations.length).toBeGreaterThan(0);
      expect(report.requiredWork.length).toBeGreaterThan(0);
    }
  });

  it('is repeatable and leaves caller sources unchanged', () => {
    const sources = Object.freeze([
      Object.freeze({ path: 'z.sql', sql: 'CREATE DATABASE z;' }),
      Object.freeze({ path: 'a.sql', sql: 'CREATE DATABASE a;' }),
    ]);
    const first = assessDsqlCompatibility(sources);
    expect(assessDsqlCompatibility(sources)).toEqual(first);
    expect(first.findings.map((finding) => finding.path)).toEqual(['a.sql', 'z.sql']);
    expect(sources[0].sql).toBe('CREATE DATABASE z;');
  });
});
