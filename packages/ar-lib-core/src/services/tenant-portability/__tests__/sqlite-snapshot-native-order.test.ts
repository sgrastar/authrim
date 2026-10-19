import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SQLITE_SNAPSHOT_SCHEMA,
  sqliteSnapshotPageQuery,
  sqliteSnapshotRowQuery,
  sqliteSnapshotTriggers,
  type SnapshotTableSchema,
} from '../sqlite-snapshot';

// Integer keys make the record_key JSON text order ("10" < "9") differ from the native order.
const items: SnapshotTableSchema = {
  table: 'items',
  tenantColumn: 'tenant_id',
  columns: ['n', 'tenant_id', 'label'],
  primaryKey: ['n'],
  uniqueKeys: [],
};
const ledger: SnapshotTableSchema = {
  table: 'ledger',
  tenantColumn: 'tenant_id',
  columns: ['tenant_id', 'n', 'label'],
  primaryKey: ['tenant_id', 'n'],
  uniqueKeys: [],
};
const entries: SnapshotTableSchema = {
  table: 'entries',
  tenantColumn: 'tenant_id',
  columns: ['bucket', 'n', 'tenant_id', 'label'],
  primaryKey: ['bucket', 'n'],
  uniqueKeys: [],
};

interface PlanRow {
  id: number;
  parent: number;
  detail: string;
}

describe('SQLite snapshot native primary key paging', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE items (n INTEGER PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, label TEXT);
      CREATE INDEX items_tenant ON items(tenant_id);
      CREATE TABLE ledger (tenant_id TEXT NOT NULL, n INTEGER NOT NULL, label TEXT,
        PRIMARY KEY (tenant_id, n));
      CREATE TABLE entries (bucket TEXT NOT NULL, n INTEGER NOT NULL, tenant_id TEXT NOT NULL,
        label TEXT, PRIMARY KEY (bucket, n));
      CREATE INDEX entries_tenant ON entries(tenant_id);
      ${SQLITE_SNAPSHOT_SCHEMA}
      ${sqliteSnapshotTriggers(items, 'json')}
      ${sqliteSnapshotTriggers(ledger, 'json')}
      ${sqliteSnapshotTriggers(entries, 'json')}`);
  });
  afterEach(() => db.close());

  function plan(schema: SnapshotTableSchema): PlanRow[] {
    return db
      .prepare(`EXPLAIN QUERY PLAN ${sqliteSnapshotPageQuery(schema, 'json')}`)
      .all('s', 'a', '', 100) as unknown as PlanRow[];
  }

  it.each([
    [items, ['SCAN live', 'SEARCH live USING INTEGER PRIMARY KEY (rowid>?)']],
    [
      ledger,
      [
        // Scans read keys only; a key holding every column the flags need is a covering read.
        'SEARCH live USING COVERING INDEX sqlite_autoindex_ledger_1 (tenant_id=?)',
        'SEARCH live USING COVERING INDEX sqlite_autoindex_ledger_1 (tenant_id=? AND n>?)',
      ],
    ],
    [
      entries,
      [
        'SCAN live USING INDEX sqlite_autoindex_entries_1',
        'SEARCH live USING INDEX sqlite_autoindex_entries_1 ((bucket,n)>(?,?))',
      ],
    ],
  ] as const)('reads $table pages as primary key and preimage index ranges', (schema, live) => {
    const rows = plan(schema);
    const details = rows.map((row) => row.detail);
    expect(details).toEqual(expect.arrayContaining([...live]));
    const preimages = details.filter((detail) =>
      detail.startsWith('SEARCH previous USING INDEX tenant_backup_preimages_native_order')
    );
    expect(preimages).toEqual([
      expect.stringMatching(/\(snapshot_id=\? AND source_table=\? AND present=\?\)$/),
      ...schema.primaryKey.map((_, index) =>
        expect.stringContaining(`present=? AND ${'<expr>=? AND '.repeat(index)}<expr>>?)`)
      ),
    ]);
    // A rowid table's plain SCAN is already key order. A sort beside a source read would
    // consume the rest of the table on every page.
    const sources = rows.filter((row) => /^(SCAN|SEARCH) (live|previous)\b/.test(row.detail));
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(
        rows.filter((row) => row.parent === source.parent && row.detail.includes('TEMP B-TREE'))
      ).toEqual([]);
    }
  });

  // A 3-key scan returns pages as large as its scan; a 50-key scan walks past other tenants' and
  // omitted rows (flagged, not filtered) well beyond the 3 rows a page returns.
  const scans = [items, ledger, entries].flatMap((schema) =>
    [3, 50].map((scan) => [schema.table, scan, schema] as const)
  );

  it.each(scans)(
    'emits %s boundary rows once in native order while writes continue between pages (scan %i)',
    (_table, scan, schema) => {
      const table = schema.table;
      const insert = db.prepare(
        `INSERT INTO ${table} (${schema.columns.join(', ')}) VALUES (${schema.columns.map(() => '?').join(', ')})`
      );
      const row = (n: number, tenant: string, label: string) =>
        schema.columns.map((column) =>
          column === 'n' ? n : column === 'tenant_id' ? tenant : column === 'bucket' ? 'b' : label
        );
      for (let n = 1; n <= 40; n++) insert.run(...row(n, n % 4 === 0 ? 'b' : 'a', `t0-${n}`));
      db.exec(
        "INSERT INTO tenant_backup_snapshots (id, tenant_id, state) VALUES ('s', 'a', 'capturing')"
      );
      const expected = Array.from({ length: 40 }, (_, index) => index + 1)
        .filter((n) => n % 4 !== 0)
        .map((n) => `${n}:t0-${n}`);

      const mutations = [
        `UPDATE ${table} SET label = 'changed' WHERE n IN (2, 9, 10, 33)`,
        `DELETE FROM ${table} WHERE n IN (11, 30)`,
        `INSERT INTO ${table} (${schema.columns.join(', ')}) VALUES (${row(41, 'a', 'new')
          .map((value) => (typeof value === 'number' ? value : `'${value}'`))
          .join(', ')})`,
        `UPDATE ${table} SET tenant_id = 'b', label = 'moved' WHERE n = 21`,
        `UPDATE ${table} SET n = n + 1000 WHERE n = 22`,
        `UPDATE ${table} SET label = 'again' WHERE n IN (1, 5, 37, 39)`,
        `DELETE FROM ${table} WHERE n IN (3, 38)`,
      ];
      expect(readAll(schema, mutations, scan).emitted).toEqual(expected);
    }
  );

  it.each(scans)(
    'moves past %s runs of rewritten and new rows with bounded progress pages (scan %i)',
    (_table, scan, schema) => {
      const table = schema.table;
      const insert = db.prepare(
        `INSERT INTO ${table} (${schema.columns.join(', ')}) VALUES (${schema.columns.map(() => '?').join(', ')})`
      );
      const row = (n: number, label: string) =>
        schema.columns.map((column) =>
          column === 'n' ? n : column === 'tenant_id' ? 'a' : column === 'bucket' ? 'b' : label
        );
      for (let n = 10; n <= 300; n += 10) insert.run(...row(n, `t0-${n}`));
      db.exec(
        "INSERT INTO tenant_backup_snapshots (id, tenant_id, state) VALUES ('s', 'a', 'capturing')"
      );
      // After T0 each gap gains new rows the snapshot omits, and later T0 rows are rewritten,
      // so a 3-row live scan often sees only omitted rows.
      const mutations = [
        `WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 299)
          INSERT INTO ${table} (${schema.columns.join(', ')})
          SELECT ${schema.columns.map((column) => (column === 'n' ? 'n' : column === 'tenant_id' ? "'a'" : column === 'bucket' ? "'b'" : "'new'")).join(', ')}
          FROM g WHERE n % 10 <> 0`,
        `UPDATE ${table} SET label = 'changed' WHERE n % 10 = 0 AND n > 100`,
      ];
      const { emitted, progressPages } = readAll(schema, mutations, scan);
      expect(emitted).toEqual(
        Array.from({ length: 30 }, (_, index) => `${(index + 1) * 10}:t0-${(index + 1) * 10}`)
      );
      // A 50-key scan crosses each 9-row gap of omitted rows within one page.
      if (scan === 3) expect(progressPages).toBeGreaterThan(0);
    }
  );

  /** scan > 3 scans more keys than a page returns. */
  function readAll(schema: SnapshotTableSchema, mutations: readonly string[], scan = 3) {
    const page = db.prepare(
      sqliteSnapshotPageQuery(schema, 'json', undefined, { scanLimit: true })
    );
    const emitted: string[] = [];
    let progressPages = 0;
    let after = '';
    for (let step = 0; step < 1000; step++) {
      const rows = page.all('s', 'a', after, 3, scan) as Array<{
        record_key: string;
        row_json: string | null;
        page_order: number;
      }>;
      if (!rows.length) break;
      expect(rows.map((value) => value.page_order)).toEqual(rows.map((_, index) => index + 1));
      if (rows[0].row_json === null) {
        // A progress row stands alone and only moves the position forward.
        expect(rows).toHaveLength(1);
        progressPages++;
      } else {
        for (const value of rows) {
          const decoded = JSON.parse(value.row_json ?? '') as Record<string, [string, string]>;
          emitted.push(`${decoded.n[1]}:${decoded.label[1]}`);
        }
      }
      after = rows[rows.length - 1].record_key;
      const mutation = mutations[step];
      if (mutation) db.exec(mutation);
    }
    return { emitted, progressPages };
  }

  it.each([
    [items, 'SEARCH live USING INTEGER PRIMARY KEY (rowid=?)'],
    [ledger, 'SEARCH live USING INDEX sqlite_autoindex_ledger_1 (tenant_id=? AND n=?)'],
    [entries, 'SEARCH live USING INDEX sqlite_autoindex_entries_1 (bucket=? AND n=?)'],
  ] as const)('reads one $table row by key for fragments with point lookups', (schema, live) => {
    const details = (
      db
        .prepare(`EXPLAIN QUERY PLAN ${sqliteSnapshotRowQuery(schema, 'json')}`)
        .all('s', 'a', '[["integer","1"]]') as unknown as PlanRow[]
    ).map((row) => row.detail);
    expect(details).toContain(live);
    expect(details).toContain(
      'SEARCH previous USING INDEX sqlite_autoindex_tenant_backup_preimages_1 (snapshot_id=? AND source_table=? AND record_key=?)'
    );
    expect(details.filter((detail) => /^SCAN (live|previous|snapshot)\b/.test(detail))).toEqual([]);
  });

  it('rejects primary keys wider than the preimage order index', () => {
    const columns = ['tenant_id', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    expect(() =>
      sqliteSnapshotPageQuery({
        table: 'wide',
        tenantColumn: 'tenant_id',
        columns,
        primaryKey: columns,
        uniqueKeys: [],
      })
    ).toThrow('snapshot_primary_key_too_wide');
  });
});
