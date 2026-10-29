import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';

interface Column {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

const D1 = new URL('../../../../../migrations/core/d1/', import.meta.url);
const POSTGRES = new URL('../../../../../migrations/core/postgresql/', import.meta.url);

async function columns(
  adapter: ReturnType<typeof sqliteAdapter>['adapter'],
  table: string
): Promise<Map<string, Column>> {
  const rows = await adapter.query<Column>(`PRAGMA table_info('${table}')`);
  return new Map(rows.map((row) => [row.name, row]));
}

describe('statement consent split foundation (additive migration)', () => {
  it('adds the hash and generation columns without touching existing rows or foreign keys', async () => {
    const fixture = sqliteAdapter('core');
    const database = fixture.db as { close(): void };
    try {
      const { adapter } = fixture;
      expect((await columns(adapter, 'user_consent_records')).get('content_hash')).toMatchObject({
        type: 'TEXT',
        notnull: 0,
        dflt_value: null,
      });
      expect(
        (await columns(adapter, 'consent_item_history')).get('content_hash_after')
      ).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });

      const statements = await columns(adapter, 'consent_statements');
      for (const name of ['definition_generation', 'closed_generation']) {
        expect(statements.get(name)).toMatchObject({
          type: 'INTEGER',
          notnull: 1,
          dflt_value: '0',
        });
      }
      expect(statements.get('retired_at')).toMatchObject({ type: 'INTEGER', notnull: 0 });

      // A statement written by code that predates the columns still inserts and reads back 0/NULL.
      await adapter.execute(
        `INSERT INTO consent_statements(id,tenant_id,slug,created_at,updated_at) VALUES(?,?,?,?,?)`,
        ['s1', 't1', 's1', 1, 1]
      );
      expect(
        await adapter.queryOne(
          `SELECT definition_generation, closed_generation, retired_at FROM consent_statements WHERE id = ?`,
          ['s1']
        )
      ).toEqual({ definition_generation: 0, closed_generation: 0, retired_at: null });

      // Removing the record foreign keys is the later destructive migration, not this one.
      const keys = await adapter.query<{ table: string }>(
        "PRAGMA foreign_key_list('user_consent_records')"
      );
      expect(keys.map((key) => key.table).sort()).toEqual([
        'consent_statement_versions',
        'consent_statements',
      ]);
      expect(await adapter.query('PRAGMA foreign_key_check')).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('rejects a negative or non-numeric generation', async () => {
    const fixture = sqliteAdapter('core');
    const database = fixture.db as { close(): void };
    try {
      await expect(
        fixture.adapter.execute(
          `INSERT INTO consent_statements(id,tenant_id,slug,created_at,updated_at,definition_generation) VALUES(?,?,?,?,?,?)`,
          ['s2', 't1', 's2', 1, 1, -1]
        )
      ).rejects.toThrow(/CHECK/i);
    } finally {
      database.close();
    }
  });

  it('only adds to the PostgreSQL stream and never rebuilds or drops', () => {
    const sql = readFileSync(
      new URL('018_statement_consent_split_foundation.sql', POSTGRES),
      'utf8'
    );
    for (const table of ['tenant_consent_requirements', 'client_consent_overrides']) {
      expect(sql).toContain(`CREATE TABLE ${table} (`);
    }
    expect(sql).toContain('CREATE UNIQUE INDEX idx_csv_unique_current');
    expect(sql).toContain('ALTER TABLE user_consent_records ADD COLUMN content_hash TEXT;');
    expect(sql).toContain('ALTER TABLE consent_item_history ADD COLUMN content_hash_after TEXT;');
    // The D1-only foreign-key removal has no PostgreSQL counterpart.
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT)\b|\bALTER\s+COLUMN\b|\bRENAME\b/iu);
    // Clients are not in this database.
    expect(sql).not.toMatch(/REFERENCES\s+oauth_clients/iu);
  });

  it('only adds to the D1 stream and never rebuilds or drops', () => {
    const sql = readFileSync(new URL('035_statement_consent_split_foundation.sql', D1), 'utf8');
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX)\b|\bRENAME\b|\bDELETE\s+FROM\b/iu);
    expect(sql.match(/ALTER TABLE/gu)).toHaveLength(5);
  });
});
