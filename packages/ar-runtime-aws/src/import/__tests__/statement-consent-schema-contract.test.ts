import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { POSTGRES_RESTORE_EXTENSION_CONTRACTS } from '../postgres-restore-extension-contract';

/** Static parity only: this does not execute PostgreSQL or prove trigger behavior. */
describe('statement consent additive schema restore contracts', () => {
  const ddl = (dialect: string, number: string) =>
    readFileSync(
      new URL(
        `../../../../../migrations/core/${dialect}/${number}_statement_consent_atomic_foundation.sql`,
        import.meta.url
      ),
      'utf8'
    );
  for (const table of [
    'statement_consent_guards',
    'statement_consent_key_states',
    'statement_consent_operations',
    'statement_consent_admissions',
  ]) {
    it(`preserves every ${table} column and numeric boundary`, () => {
      const contract = POSTGRES_RESTORE_EXTENSION_CONTRACTS.find((entry) => entry.table === table);
      expect(contract).toBeDefined();
      for (const [dialect, number, numeric] of [
        ['d1', '036', 'INTEGER'],
        ['postgresql', '019', 'BIGINT'],
      ]) {
        const body = ddl(dialect, number).match(
          new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\)`)
        )?.[1];
        if (!body) throw new Error('statement_consent_schema_missing');
        const columns = [...body.matchAll(/^ {2}([a-z][a-z0-9_]*) (TEXT|INTEGER|BIGINT)/gm)];
        expect(contract?.columns).toEqual(columns.map((column) => column[1]));
        expect(contract?.sqliteIntegerColumns).toEqual(
          columns
            .filter((column) => column[2] === numeric || column[2] === 'INTEGER')
            .map((column) => column[1])
        );
      }
    });
  }
  it('adds no production trigger before PR7', () => {
    for (const [dialect, number] of [
      ['d1', '036'],
      ['postgresql', '019'],
    ])
      expect(ddl(dialect, number)).not.toMatch(/CREATE (?:TRIGGER|FUNCTION)/i);
  });
  it('keeps retention permits in matching D1/PG rebuild-only schemas', () => {
    const columns = (dialect: string, number: string) => {
      const sql = readFileSync(
        new URL(
          `../../../../../migrations/core/${dialect}/${number}_statement_consent_enforcement.sql`,
          import.meta.url
        ),
        'utf8'
      );
      const body = sql.match(
        /CREATE TABLE statement_consent_retention_permits \(([\s\S]*?)\n\)/
      )?.[1];
      if (!body) throw new Error('retention_permit_schema_missing');
      return [...body.matchAll(/^ {2}([a-z][a-z0-9_]*) (TEXT|INTEGER|BIGINT)/gm)].map((m) => [
        m[1],
        m[2] === 'TEXT' ? 'text' : 'integer',
      ]);
    };
    expect(columns('d1', '037')).toEqual(columns('postgresql', '020'));
    expect(
      POSTGRES_RESTORE_EXTENSION_CONTRACTS.some(
        (s) => s.table === 'statement_consent_retention_permits'
      )
    ).toBe(false);
  });
});
