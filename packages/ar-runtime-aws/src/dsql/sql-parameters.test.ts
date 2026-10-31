import { describe, expect, it } from 'vitest';
import { toDsqlSql } from './sql-parameters';

describe('DSQL SQL parameters', () => {
  it('converts question marks but keeps quoted values, identifiers and nested comments', () => {
    expect(
      toDsqlSql(
        `SELECT '?', 'it''s ?', "what?", ? /* outer ? /* inner ? */ ? */ -- ?\nWHERE id = ?`
      )
    ).toBe(`SELECT '?', 'it''s ?', "what?", $1 /* outer ? /* inner ? */ ? */ -- ?\nWHERE id = $2`);
  });

  it('preserves escaped strings and dollar-quoted bodies', () => {
    expect(toDsqlSql(String.raw`SELECT E'can\'t ?', $$ ? $1 $$, $body$ ? $2 $body$, ?`)).toBe(
      String.raw`SELECT E'can\'t ?', $$ ? $1 $$, $body$ ? $2 $body$, $1`
    );
  });

  it('supports native PostgreSQL positional parameters', () => {
    expect(toDsqlSql(`SELECT $2, $1, '?' -- ?`)).toBe(`SELECT $2, $1, '?' -- ?`);
  });

  it.each([
    'SELECT ?, $1',
    "SELECT 'unclosed ?",
    'SELECT "unclosed ?',
    'SELECT /* unclosed ?',
    'SELECT $$ unclosed ?',
    'SELECT json ?| array[1]',
    'SELECT json ?& array[1]',
  ])('rejects ambiguous or unfinished SQL: %s', (sql) => {
    expect(() => toDsqlSql(sql)).toThrow('aurora_dsql_sql_parameters_invalid');
  });
});
