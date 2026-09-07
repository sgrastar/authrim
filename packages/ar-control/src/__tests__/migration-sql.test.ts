import { describe, expect, it } from 'vitest';
import { renderLookupBucketCounterSeed } from '@authrim/ar-lib-core/services/lookup-directory/seed-sql';
import { splitMigrationSql } from '../migration-sql.js';

describe('splitMigrationSql', () => {
  it('splits ordinary statements without splitting quoted semicolons or comments', () => {
    expect(
      splitMigrationSql(`
        -- before;
        CREATE TABLE example (value TEXT DEFAULT ';');
        INSERT INTO example VALUES ('it''s;safe'); /* after; */
      `)
    ).toHaveLength(2);
  });

  it('keeps a trigger with internal statements and CASE expressions together', () => {
    const statements = splitMigrationSql(`
      CREATE TABLE source (id INTEGER, value TEXT);
      CREATE TABLE audit (value TEXT);
      CREATE TRIGGER source_audit AFTER INSERT ON source
      BEGIN
        INSERT INTO audit(value) VALUES (
          CASE WHEN NEW.value = ';' THEN 'semi;colon' ELSE NEW.value END
        );
        UPDATE source SET value = 'done;' WHERE id = NEW.id;
      END;
      CREATE INDEX idx_source_id ON source(id);
    `);

    expect(statements).toHaveLength(4);
    expect(statements[2]).toContain('UPDATE source');
    expect(statements[2]).toMatch(/END;$/u);
  });

  it('keeps a recursive seed CTE as one executable statement', () => {
    const generated = renderLookupBucketCounterSeed({
      dialect: 'sqlite',
      nowExpression: 'unixepoch()',
    });
    const statements = splitMigrationSql(generated);

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('INSERT INTO lookup_bucket_counters');
    expect(statements[0]).toMatch(/lookup_bucket_seed;$/u);
    expect(new TextEncoder().encode(statements[0]).byteLength).toBeLessThan(100_000);
  });

  it('fails closed for explicit transaction control and malformed input', () => {
    expect(() => splitMigrationSql('BEGIN; CREATE TABLE x (id INTEGER); COMMIT;')).toThrow(
      'migration_sql_explicit_transaction_forbidden'
    );
    expect(() => splitMigrationSql("SELECT 'unterminated;")).toThrow(
      'migration_sql_unterminated_token'
    );
    expect(() => splitMigrationSql('.read other.sql')).toThrow(
      'migration_sql_dot_command_forbidden'
    );
    expect(() => splitMigrationSql('\0SELECT 1')).toThrow('migration_sql_nul_forbidden');
  });

  it('enforces statement and file limits before provider execution', () => {
    expect(() => splitMigrationSql('SELECT 12345;', { maxStatementBytes: 5 })).toThrow(
      'migration_sql_statement_too_large'
    );
    expect(() => splitMigrationSql('SELECT 1;', { maxMigrationBytes: 5 })).toThrow(
      'migration_sql_file_too_large'
    );
    expect(() => splitMigrationSql('SELECT 1; SELECT 2;', { maxStatements: 1 })).toThrow(
      'migration_sql_too_many_statements'
    );
  });
});
