import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';

interface Column {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface Index {
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

const TEXT_REQUIRED = [
  'id',
  'tenant_id',
  'user_id',
  'statement_id',
  'version_id',
  'version',
  'status',
];
const TEXT_OPTIONAL = ['client_id', 'ip_address_hash', 'user_agent', 'receipt_id'];
const INTEGER_REQUIRED = ['created_at', 'updated_at'];
const INTEGER_OPTIONAL = [
  'granted_at',
  'withdrawn_at',
  'expires_at',
  'retain_until',
  'consent_settings_snapshot_at',
  'record_retention_days_snapshot',
  'reconsent_interval_days_snapshot',
];
const COLUMNS = [
  'id',
  'tenant_id',
  'user_id',
  'statement_id',
  'version_id',
  'version',
  'status',
  'granted_at',
  'withdrawn_at',
  'expires_at',
  'client_id',
  'ip_address_hash',
  'user_agent',
  'receipt_id',
  'created_at',
  'updated_at',
  'retain_until',
  'consent_settings_snapshot_at',
  'record_retention_days_snapshot',
  'reconsent_interval_days_snapshot',
];

describe('disabled statement-consent storage: existing schema safeguards', () => {
  it('keeps both definition FKs, all 20 columns, uniqueness and every D1 index', async () => {
    const fixture = sqliteAdapter('core');
    // Only close uses the host SQLite handle; all observations use the shared typed adapter.
    const database = fixture.db as { close(): void };
    const { adapter } = fixture;
    try {
      expect(await adapter.queryOne<{ foreign_keys: number }>('PRAGMA foreign_keys')).toEqual({
        foreign_keys: 1,
      });
      const columns = await adapter.query<Column>("PRAGMA table_info('user_consent_records')");
      expect(columns.map((column) => column.name)).toEqual(COLUMNS);
      expect(columns).toHaveLength(20);
      for (const column of columns) {
        expect(column.type).toBe(
          [...TEXT_REQUIRED, ...TEXT_OPTIONAL].includes(column.name) ? 'TEXT' : 'INTEGER'
        );
        expect(column.notnull).toBe(
          [...TEXT_REQUIRED, ...INTEGER_REQUIRED].includes(column.name) ? 1 : 0
        );
        expect(column.pk).toBe(column.name === 'id' ? 1 : 0);
        expect(column.dflt_value).toBe(
          column.name === 'tenant_id' ? "'default'" : column.name === 'status' ? "'granted'" : null
        );
      }
      const keys = await adapter.query<{
        table: string;
        from: string;
        to: string;
        on_update: string;
        on_delete: string;
      }>("PRAGMA foreign_key_list('user_consent_records')");
      expect(
        keys
          .map((key) => ({
            from: key.from,
            table: key.table,
            to: key.to,
            onUpdate: key.on_update,
            onDelete: key.on_delete,
          }))
          .sort((left, right) => left.from.localeCompare(right.from))
      ).toEqual([
        {
          from: 'statement_id',
          table: 'consent_statements',
          to: 'id',
          onUpdate: 'NO ACTION',
          onDelete: 'NO ACTION',
        },
        {
          from: 'version_id',
          table: 'consent_statement_versions',
          to: 'id',
          onUpdate: 'NO ACTION',
          onDelete: 'NO ACTION',
        },
      ]);
      const indexes = await adapter.query<Index>("PRAGMA index_list('user_consent_records')");
      expect(
        indexes
          .filter((index) => index.origin === 'c')
          .map((index) => index.name)
          .sort()
      ).toEqual([
        'idx_ucr_expires',
        'idx_ucr_retain_until',
        'idx_ucr_statement',
        'idx_ucr_status',
        'idx_ucr_user',
      ]);
      expect(indexes.filter((index) => index.origin === 'pk')).toHaveLength(1);
      expect(indexes.filter((index) => index.origin === 'u')).toHaveLength(1);
      expect(indexes).toHaveLength(7);
      const expected = new Map<string, string[]>([
        ['idx_ucr_expires', ['expires_at']],
        ['idx_ucr_retain_until', ['retain_until']],
        ['idx_ucr_statement', ['tenant_id', 'statement_id']],
        ['idx_ucr_status', ['status']],
        ['idx_ucr_user', ['tenant_id', 'user_id']],
      ]);
      for (const index of indexes) {
        expect(index.partial).toBe(0);
        expect(index.unique).toBe(index.origin === 'c' ? 0 : 1);
        const info = await adapter.query<{ name: string }>(`PRAGMA index_info('${index.name}')`);
        expect(info.map((column) => column.name)).toEqual(
          index.origin === 'pk'
            ? ['id']
            : index.origin === 'u'
              ? ['tenant_id', 'user_id', 'statement_id']
              : expected.get(index.name)
        );
      }
      expect(await adapter.query('PRAGMA foreign_key_check')).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('keeps the distinct PostgreSQL declaration without introducing a D1-style FK removal', () => {
    const directory = new URL('../../../../../migrations/core/postgresql/', import.meta.url);
    const baseline = readFileSync(new URL('001_0_4_0_core_baseline.sql', directory), 'utf8');
    const table = baseline.match(
      /CREATE TABLE public\.user_consent_records \(([\s\S]*?)\n\);/u
    )?.[1];
    expect(table).toBeDefined();
    if (!table) throw new Error('postgres_consent_record_table_missing');
    const columns = [...table.matchAll(/^\s+([a-z_]+)\s+(text|bigint)([^\n]*)/gmu)];
    expect(columns.map((match) => match[1]).sort()).toEqual([...COLUMNS].sort());
    expect(columns).toHaveLength(20);
    for (const [, name, type, constraints] of columns) {
      expect(type).toBe([...TEXT_REQUIRED, ...TEXT_OPTIONAL].includes(name) ? 'text' : 'bigint');
      expect([...INTEGER_REQUIRED, ...INTEGER_OPTIONAL].includes(name)).toBe(type === 'bigint');
      expect(/\bNOT NULL\b/u.test(constraints)).toBe(
        [...TEXT_REQUIRED, ...INTEGER_REQUIRED].includes(name)
      );
    }
    expect(table).toMatch(/tenant_id text DEFAULT 'default'::text NOT NULL/u);
    expect(table).toMatch(/status text DEFAULT 'granted'::text NOT NULL/u);
    expect(baseline).toMatch(
      /ALTER TABLE ONLY public\.user_consent_records\s+ADD CONSTRAINT user_consent_records_pkey PRIMARY KEY \(id\);/u
    );
    expect(baseline).toMatch(
      /ALTER TABLE ONLY public\.user_consent_records\s+ADD CONSTRAINT user_consent_records_unique_statement UNIQUE \(tenant_id, user_id, statement_id\);/u
    );
    const indexes = [
      ...baseline.matchAll(
        /CREATE INDEX ([a-z_]+) ON public\.user_consent_records USING btree \(([^)]+)\);/gu
      ),
    ];
    expect(indexes.map((match) => [match[1], match[2]])).toEqual([
      ['idx_user_consent_records_retain_until', 'retain_until'],
      ['idx_user_consent_records_status', 'tenant_id, status, expires_at'],
      ['idx_user_consent_records_user', 'tenant_id, user_id'],
    ]);
    const migrations = readdirSync(directory)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => readFileSync(new URL(name, directory), 'utf8'))
      .join('\n');
    expect(table).not.toMatch(/\bREFERENCES\b/iu);
    expect(migrations).not.toMatch(
      /ALTER TABLE(?: ONLY)? public\.user_consent_records\s+ADD CONSTRAINT[^;]*\bFOREIGN KEY\b/iu
    );
    // This is a PostgreSQL DDL contract, not an executed PostgreSQL migration test.
  });
});
