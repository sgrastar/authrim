import { describe, expect, it } from 'vitest';
import { assessDsqlCompatibility } from './compatibility';

const scan = (sql: string, kind?: 'sql' | 'typescript') =>
  assessDsqlCompatibility([{ path: 'a.sql', sql, kind }])
    .findings.map((f) => `${f.code}:${f.line}`)
    .sort();

describe('DSQL compatibility lexer (mutation hardening)', () => {
  it('line comment: ends at newline, unterminated comment consumes rest, blanks only the comment', () => {
    expect(scan('-- CREATE DATABASE x\nCREATE DATABASE y')).toEqual(['create-database:2']);
    expect(scan('-- CREATE DATABASE x')).toEqual([]);
    expect(scan('SELECT 1; -- c\nCREATE   DATABASE z')).toEqual(['create-database:2']);
  });

  it('block comment: nested, unterminated, adjacent close markers', () => {
    expect(scan('/* a /* CREATE DATABASE */ CREATE DATABASE */ SELECT 1')).toEqual([]);
    expect(scan('/* CREATE DATABASE')).toEqual([]);
    expect(scan('/* open /* inner */ still comment CREATE DATABASE')).toEqual([]);
    expect(scan('/**/CREATE DATABASE x')).toEqual(['create-database:1']);
    expect(scan('/*/ CREATE DATABASE x')).toEqual([]);
    expect(scan('/* a */ /* b */ CREATE DATABASE x')).toEqual(['create-database:1']);
  });

  it('quoted strings: escapes, doubled quotes, unterminated', () => {
    expect(scan("SELECT 'it''s CREATE DATABASE'; CREATE DATABASE a")).toEqual([
      'create-database:1',
    ]);
    expect(scan("SELECT 'a\\'CREATE DATABASE'")).toEqual([]);
    expect(scan("SELECT 'CREATE DATABASE")).toEqual([]);
    expect(scan('SELECT "CREATE DATABASE""x"; CREATE DATABASE a')).toEqual(['create-database:1']);
    expect(scan("SELECT '\\")).toEqual([]);
    expect(scan("SELECT 'x'CREATE DATABASE y")).toEqual(['create-database:1']);
    expect(scan("SELECT ''; CREATE DATABASE y")).toEqual(['create-database:1']);
    // line numbers preserved through multi-line strings
    expect(scan("SELECT 'a\nb\nc';\nCREATE DATABASE y")).toEqual(['create-database:4']);
  });

  it('dollar quoting: values are blanked, DO/AS bodies are inspected', () => {
    expect(scan('SELECT $$CREATE DATABASE$$')).toEqual([]);
    expect(scan('SELECT $t$CREATE DATABASE$t$; CREATE DATABASE x')).toEqual(['create-database:1']);
    expect(scan('DO $$ CREATE DATABASE x $$')).toEqual(['create-database:1']);
    expect(scan('DO   $$ CREATE DATABASE x $$')).toEqual(['create-database:1']);
    expect(scan('x AS $$ CREATE DATABASE x $$')).toEqual(['create-database:1']);
    expect(scan('x AS   $$ CREATE DATABASE x $$')).toEqual(['create-database:1']);
    expect(scan('xDO $$ CREATE DATABASE x $$')).toEqual([]);
    expect(scan('DOX $$ CREATE DATABASE x $$')).toEqual([]);
    expect(scan('ASX $$ CREATE DATABASE x $$')).toEqual([]);
    // unterminated procedural body consumes the rest
    expect(scan('AS $$ CREATE DATABASE x')).toEqual(['create-database:1']);
    expect(scan('SELECT $$ CREATE DATABASE x')).toEqual([]);
    // closing delimiter is blanked and text after it is scanned
    expect(scan('AS $$ x $$ CREATE DATABASE y')).toEqual(['create-database:1']);
    expect(scan('SELECT $$a$$CREATE DATABASE y')).toEqual(['create-database:1']);
    // a lone $ is not a delimiter
    expect(scan('SELECT $1 CREATE DATABASE y')).toEqual(['create-database:1']);
    expect(scan('SELECT $ CREATE DATABASE y')).toEqual(['create-database:1']);
  });

  it('typescript literals: skips comments, extracts quoted segments, reports offsets', () => {
    const ts = (src: string) => scan(src, 'typescript');
    expect(ts('// "CREATE DATABASE x"\nconst a = 1;')).toEqual(['typescript-query-flow:1']);
    expect(ts('// c')).toEqual(['typescript-query-flow:1']);
    expect(ts('/* "CREATE DATABASE x" */ const a = "CREATE DATABASE y";')).toEqual([
      'create-database:1',
      'typescript-query-flow:1',
    ]);
    expect(ts('/* unterminated "CREATE DATABASE x"')).toEqual(['typescript-query-flow:1']);
    expect(ts('/*/ "CREATE DATABASE x" */ ')).toEqual(['typescript-query-flow:1']);
    expect(ts('/**/"CREATE DATABASE x"')).toEqual(['create-database:1', 'typescript-query-flow:1']);
    expect(ts('x\ny\nq(`CREATE DATABASE x`)')).toEqual([
      'create-database:3',
      'typescript-query-flow:1',
    ]);
    expect(ts("x('a\\\\'); y('CREATE DATABASE c')")).toEqual([
      'create-database:1',
      'typescript-query-flow:1',
    ]);
    expect(ts('x("CREATE DATABASE')).toEqual(['create-database:1', 'typescript-query-flow:1']);
    expect(ts('x("\\')).toEqual(['typescript-query-flow:1']);
    expect(ts("x('')\ny('CREATE DATABASE')")).toEqual([
      'create-database:2',
      'typescript-query-flow:1',
    ]);
    // offset: segment starts after the quote
    expect(ts('a\n"\nCREATE DATABASE"')).toEqual(['create-database:3', 'typescript-query-flow:1']);
    // single slash is not a comment
    expect(ts('a / "CREATE DATABASE"')).toEqual(['create-database:1', 'typescript-query-flow:1']);
    // other quote types inside a literal do not end it
    expect(ts('x(`CREATE DATABASE "it\'s"`)')).toEqual([
      'create-database:1',
      'typescript-query-flow:1',
    ]);
    // a non-typescript source does not use the literal extractor
    expect(scan('// x\nCREATE DATABASE a', 'sql')).toEqual(['create-database:2']);
  });
});

describe('DSQL compatibility rules (mutation hardening)', () => {
  const message = (sql: string, code: string) =>
    assessDsqlCompatibility([{ path: 'a.sql', sql }]).findings.find((f) => f.code === code);

  it('reports exact severity and message for every rule', () => {
    expect(message('CREATE TRIGGER t', 'trigger')).toMatchObject({
      severity: 'blocker',
      message: 'Database triggers require an equivalent, verified application-level operation.',
    });
    expect(message('LANGUAGE plpgsql', 'procedural-language')).toMatchObject({
      severity: 'blocker',
      message: 'PL/pgSQL requires an application-level replacement; do not remove its invariants.',
    });
    expect(message('RETURNS trigger', 'trigger-function')).toMatchObject({
      severity: 'blocker',
      message: 'Trigger functions cannot be imported unchanged into Aurora DSQL.',
    });
    expect(message('DO BEGIN', 'anonymous-procedural-block')).toMatchObject({
      severity: 'blocker',
      message: 'Anonymous procedural blocks require a separate, resumable initialization path.',
    });
    expect(message('select pg_advisory_lock(1)', 'advisory-lock')).toMatchObject({
      severity: 'blocker',
      message: 'Advisory-lock coordination needs a DSQL-compatible concurrency design.',
    });
    expect(message('SERIALIZABLE', 'serializable-isolation')).toMatchObject({
      severity: 'blocker',
      message: 'DSQL uses Repeatable Read; do not silently downgrade a Serializable contract.',
    });
    expect(message('ISOLATION LEVEL READ COMMITTED', 'read-committed-isolation')).toMatchObject({
      severity: 'blocker',
      message: 'DSQL uses Repeatable Read; this explicit Read Committed contract needs review.',
    });
    expect(message('CREATE DATABASE d', 'create-database')).toMatchObject({
      severity: 'blocker',
      message:
        'DSQL has one built-in postgres database; Core/PII isolation needs a separate design.',
    });
    expect(message('CREATE INDEX i', 'synchronous-index')).toMatchObject({
      severity: 'manual-review',
      message: 'Use a dedicated asynchronous-index plan and verify completion before activation.',
    });
    expect(message('CREATE FUNCTION f', 'function-definition')).toMatchObject({
      severity: 'manual-review',
      message: 'Check the supported SQL-function subset; procedural languages are not equivalent.',
    });
  });

  it('regexes tolerate multiple whitespace and require word boundaries', () => {
    expect(scan('LANGUAGE   plpgsql')).toEqual(['procedural-language:1']);
    expect(scan('CREATE   TRIGGER t')).toEqual(['trigger:1']);
    expect(scan('CREATE  OR  REPLACE  TRIGGER t')).toEqual(['trigger:1']);
    expect(scan('CREATE  CONSTRAINT  TRIGGER t')).toEqual(['trigger:1']);
    expect(scan('CREATE OR REPLACE CONSTRAINT TRIGGER t')).toEqual(['trigger:1']);
    expect(scan('CREATE TRIGGER t')).toEqual(['trigger:1']);
    expect(scan('RETURNS   trigger')).toEqual(['trigger-function:1']);
    expect(scan('DO   BEGIN')).toEqual(['anonymous-procedural-block:1']);
    expect(scan('DO DECLARE')).toEqual(['anonymous-procedural-block:1']);
    expect(scan('DO BEGINX')).toEqual([]);
    expect(scan('pg_advisory_lock   (1)')).toEqual(['advisory-lock:1']);
    expect(scan('pg_advisory_lock(1)')).toEqual(['advisory-lock:1']);
    expect(scan('pg_advisory_lock_shared(1)')).toEqual(['advisory-lock:1']);
    expect(scan('pg_advisory_unlock_all(1)')).toEqual(['advisory-lock:1']);
    expect(scan('pg_try_advisory_xact_lock(1)')).toEqual(['advisory-lock:1']);
    expect(scan('pg_advisory_lock')).toEqual([]);
    expect(scan('ISOLATION  LEVEL  SERIALIZABLE')).toEqual(['serializable-isolation:1']);
    expect(scan('SERIALIZABLE')).toEqual(['serializable-isolation:1']);
    expect(scan('ISOLATION LEVEL  SERIALIZABLE')).toEqual(['serializable-isolation:1']);
    expect(scan('ISOLATION  LEVEL SERIALIZABLE')).toEqual(['serializable-isolation:1']);
    expect(scan('ISOLATION  LEVEL  READ  COMMITTED')).toEqual(['read-committed-isolation:1']);
    expect(scan('ISOLATION LEVEL  READ COMMITTED')).toEqual(['read-committed-isolation:1']);
    expect(scan('ISOLATION LEVEL READ  COMMITTED')).toEqual(['read-committed-isolation:1']);
    expect(scan('ISOLATION  LEVEL READ COMMITTED')).toEqual(['read-committed-isolation:1']);
    expect(scan('CREATE   DATABASE d')).toEqual(['create-database:1']);
    expect(scan('CREATE   INDEX i')).toEqual(
      ['synchronous-index:1', 'multiple-ddl-statements:1'].slice(0, 1)
    );
    expect(scan('CREATE  UNIQUE  INDEX i')).toEqual(['synchronous-index:1']);
    expect(scan('CREATE UNIQUE INDEX i')).toEqual(['synchronous-index:1']);
    expect(scan('CREATE  UNIQUE INDEX i')).toEqual(['synchronous-index:1']);
    expect(scan('CREATE UNIQUE  INDEX i')).toEqual(['synchronous-index:1']);
    expect(scan('CREATE INDEX ASYNC i')).toEqual([]);
    expect(scan('CREATE INDEX   ASYNC i')).toEqual([]);
    expect(scan('CREATE INDEX\nASYNC i')).toEqual([]);
    expect(scan('CREATE INDEX ASYNCX i')).toEqual(['synchronous-index:1']);
    expect(scan('CREATE   FUNCTION f')).toEqual(['function-definition:1']);
    expect(scan('CREATE  OR  REPLACE  FUNCTION f')).toEqual(['function-definition:1']);
    expect(scan('CREATE OR  REPLACE FUNCTION f')).toEqual(['function-definition:1']);
    expect(scan('CREATE OR REPLACE  FUNCTION f')).toEqual(['function-definition:1']);
    expect(scan('CREATE  OR REPLACE FUNCTION f')).toEqual(['function-definition:1']);
  });

  it('DDL/DML combination: counts, first offset, line numbers', () => {
    expect(scan('CREATE TABLE a (x int);\nDROP TABLE b;')).toEqual(['multiple-ddl-statements:1']);
    expect(scan('\n\nCREATE TABLE a (x int);\nALTER TABLE b ADD c int;')).toEqual([
      'multiple-ddl-statements:3',
    ]);
    // single DDL: no multiple-ddl finding, no ddl-and-dml without DML
    expect(scan('CREATE TABLE a (x int);')).toEqual([]);
    expect(scan('CREATE TABLE a (x int);\nINSERT INTO a VALUES (1);')).toEqual(['ddl-and-dml:1']);
    expect(scan('INSERT INTO a VALUES (1);\nCREATE TABLE a (x int);')).toEqual(['ddl-and-dml:2']);
    expect(scan('INSERT INTO a VALUES (1);')).toEqual([]);
    // DML detection variants
    for (const dml of ['INSERT   INTO a', 'UPDATE a SET x=1', 'DELETE   FROM a', 'update _ set']) {
      expect(scan(`CREATE TABLE t (x int);\n${dml}`)).toEqual(['ddl-and-dml:1']);
    }
    expect(scan('CREATE TABLE t (x int);\nUPDATE 1')).toEqual([]);
    expect(scan('CREATE TABLE t (x int);\nUPDATEa')).toEqual([]);
    // DDL variants
    for (const ddl of [
      'CREATE OR  REPLACE FUNCTION f',
      'CREATE  OR REPLACE FUNCTION f',
      'CREATE OR REPLACE  FUNCTION f',
      'CREATE UNIQUE  INDEX i',
      'CREATE  UNIQUE INDEX i',
      'DROP   SCHEMA s',
      'ALTER ROLE r',
    ]) {
      expect(scan(`${ddl};\nDROP TABLE z;`)).toContain('multiple-ddl-statements:1');
    }
    // offsets are segment.offset + match.index in typescript sources
    expect(scan('x\ny\nq("CREATE TABLE a"); q("DROP TABLE b");', 'typescript')).toEqual([
      'multiple-ddl-statements:3',
      'typescript-query-flow:1',
    ]);
    expect(scan('q("x"); q("CREATE TABLE a"); q("DROP TABLE b");\n', 'typescript')).toEqual([
      'multiple-ddl-statements:1',
      'typescript-query-flow:1',
    ]);
    // DML across segments (hasDml accumulates)
    expect(scan('q("CREATE TABLE a"); q("INSERT INTO a"); q("x");', 'typescript')).toEqual([
      'ddl-and-dml:1',
      'typescript-query-flow:1',
    ]);
  });

  it('reports exact multi-ddl / ddl-and-dml / typescript messages', () => {
    const r = assessDsqlCompatibility([
      {
        path: 'a.ts',
        sql: 'q("CREATE TABLE a"); q("DROP TABLE b"); q("INSERT INTO a")',
        kind: 'typescript',
      },
    ]);
    const by = (c: string) => r.findings.find((f) => f.code === c);
    expect(by('multiple-ddl-statements')).toEqual({
      path: 'a.ts',
      line: 1,
      code: 'multiple-ddl-statements',
      severity: 'manual-review',
      message: 'Multiple DDL statements require separate transactions and durable resume evidence.',
    });
    expect(by('ddl-and-dml')).toMatchObject({
      severity: 'manual-review',
      message:
        'Do not combine DDL and DML in one DSQL transaction; inspect the execution boundaries.',
    });
    expect(by('typescript-query-flow')).toMatchObject({
      severity: 'manual-review',
      message:
        'Literal inspection cannot verify computed SQL, call ordering, transaction size or retries.',
    });
  });

  it('sorts by path, then line (numeric difference), then code', () => {
    const r = assessDsqlCompatibility([
      { path: 'b.sql', sql: 'CREATE DATABASE x' },
      {
        path: 'a.sql',
        sql: 'x\nx\nx\nx\nx\nx\nx\nx\nx\nx\nCREATE DATABASE x\nSERIALIZABLE\nCREATE DATABASE y\nx\nx\nx\nx\nx\nx\nx\nx\nx\nx\nx\nx\nx\nx\nx\nx\nx\nx\nx\nx\nx\nx\nx\nx\nx\nx\nx\nx\nCREATE DATABASE z',
      },
    ]);
    expect(r.findings.map((f) => `${f.path}:${f.line}:${f.code}`)).toEqual([
      'a.sql:11:create-database',
      'a.sql:11:multiple-ddl-statements',
      'a.sql:12:serializable-isolation',
      'a.sql:13:create-database',
      'a.sql:42:create-database',
      'b.sql:1:create-database',
    ]);
    const same = assessDsqlCompatibility([
      { path: 'a.sql', sql: 'SERIALIZABLE CREATE DATABASE x' },
    ]).findings.map((f) => f.code);
    expect(same).toEqual(['create-database', 'serializable-isolation']);
  });

  it('returns exact static envelope text', () => {
    const r = assessDsqlCompatibility([]);
    expect(r).toEqual({
      schemaVersion: 1,
      assessment: 'static-triage',
      fullRuntimeReady: false,
      sourcesScanned: 0,
      findings: [],
      limitations: [
        'This lexical inventory is not a SQL or TypeScript parser and may miss dynamic or escaped SQL.',
        'No findings does not establish compatibility, complete source coverage, or runtime readiness.',
        'Foreign keys and FOR UPDATE are not classified as unsupported; their DSQL semantics still require tests.',
        'No SQL is executed or rewritten; source values and SQL excerpts are excluded from diagnostics.',
      ],
      requiredWork: [
        'Preserve legal-hold, webhook and service-group invariants when replacing database triggers.',
        'Replace the PostgreSQL initialization, authorization-code and all-at-once restore paths before full-runtime use.',
        'Verify Repeatable Read and OCC retries, uncertain commit outcomes, one-use consumption and tenant isolation.',
        'Validate DDL resume, asynchronous indexes, transaction limits, IAM/TLS and actual DSQL integration separately.',
      ],
    });
  });
});
