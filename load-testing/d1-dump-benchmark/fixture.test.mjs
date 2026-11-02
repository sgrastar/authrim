import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  DEFAULT_PAYLOAD_BYTES,
  MAX_PAYLOAD_BYTES,
  MAX_SEED_ROWS,
  schemaSql,
  seedSql,
  verificationSql,
} from './fixture.mjs';

function withDatabase(callback) {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(schemaSql);
    callback(database);
  } finally {
    database.close();
  }
}

test('schema has the intended account indexes and a persistent singleton probe', () => {
  withDatabase((database) => {
    const indexes = database.prepare("PRAGMA index_list('bench_accounts')").all();
    assert.ok(indexes.some((index) => index.unique === 1));
    assert.ok(indexes.some((index) => index.name === 'bench_accounts_tenant_status_updated_at'));
    const indexedColumns = database
      .prepare("PRAGMA index_info('bench_accounts_tenant_status_updated_at')")
      .all()
      .map((column) => column.name);
    assert.deepEqual(indexedColumns, ['tenant', 'status', 'updated_at']);

    database.exec('UPDATE bench_probe SET writes = writes + 1 WHERE id = 1;');
    database.exec(schemaSql);
    assert.equal(database.prepare('SELECT writes FROM bench_probe WHERE id = 1').get().writes, 1);
    assert.throws(() => database.exec('INSERT INTO bench_probe (id) VALUES (2);'), /CHECK/);

    database.exec(seedSql(1, 1));
    assert.throws(
      () =>
        database.exec(`INSERT INTO bench_accounts
          (id, tenant, email, status, updated_at, payload)
          SELECT 2, tenant, email, status, updated_at, payload FROM bench_accounts WHERE id = 1;`),
      /UNIQUE/
    );
  });
});

test('overlapping and repeated batches preserve rows without introducing ID gaps', () => {
  withDatabase((database) => {
    database.exec(seedSql(1, 25));
    const originalRows = database.prepare('SELECT * FROM bench_accounts ORDER BY id').all();
    database.exec(seedSql(1, 25));
    assert.deepEqual(
      database.prepare('SELECT * FROM bench_accounts ORDER BY id').all(),
      originalRows
    );
    database.exec(seedSql(20, 20));
    const ids = database.prepare('SELECT id FROM bench_accounts ORDER BY id').all();
    assert.deepEqual(
      ids.map((row) => row.id),
      Array.from({ length: 39 }, (_, index) => index + 1)
    );
    assert.deepEqual(
      database.prepare('SELECT * FROM bench_accounts WHERE id <= 25 ORDER BY id').all(),
      originalRows
    );

    const verification = database.prepare(verificationSql).get();
    assert.equal(verification.account_count, 39);
    assert.equal(verification.min_id, 1);
    assert.equal(verification.max_id, 39);
    assert.equal(verification.id_sum, (39 * 40) / 2);
    assert.equal(verification.updated_at_sum, 39 * 1704067200 + (39 * 40) / 2);
    assert.equal(verification.payload_bytes, 39 * DEFAULT_PAYLOAD_BYTES);
    assert.deepEqual(
      JSON.parse(verification.sample_rows).map((row) => row.id),
      [1, 2, 3, 37, 38, 39]
    );
  });
});

test('payload sizes are exact for odd and even lengths and values vary across rows', () => {
  withDatabase((database) => {
    database.exec(seedSql(1, 8, 1025));
    database.exec(seedSql(9, 2, 2048));
    const rows = database.prepare('SELECT id, payload FROM bench_accounts ORDER BY id').all();
    for (const row of rows) {
      assert.equal(Buffer.byteLength(row.payload, 'utf8'), row.id <= 8 ? 1025 : 2048);
      assert.match(row.payload, /^[0-9A-F]+$/);
      assert.ok(new Set(row.payload).size > 1);
    }
    assert.equal(new Set(rows.map((row) => row.payload)).size, rows.length);
    const verification = database.prepare(verificationSql).get();
    assert.equal(verification.payload_bytes, 8 * 1025 + 2 * 2048);
    assert.equal(verification.min_payload_bytes, 1025);
    assert.equal(verification.max_payload_bytes, 2048);
  });
});

test('bounded recursive batch reaches the maximum row count with stable metadata', () => {
  withDatabase((database) => {
    database.exec(seedSql(1, MAX_SEED_ROWS, 1));
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM bench_accounts').get().count,
      2000
    );
    const row = database.prepare('SELECT * FROM bench_accounts WHERE id = 110').get();
    assert.equal(row.tenant, 'tenant-0009');
    assert.equal(row.email, 'account-110@example.invalid');
    assert.equal(row.status, 'disabled');
    assert.equal(row.updated_at, 1704067310);
  });
});

test('empty verification produces zero totals and no samples', () => {
  withDatabase((database) => {
    const verification = database.prepare(verificationSql).get();
    assert.equal(verification.account_count, 0);
    assert.equal(verification.payload_bytes, 0);
    assert.equal(verification.id_sum, 0);
    assert.equal(verification.min_id, null);
    assert.deepEqual(JSON.parse(verification.sample_rows), []);
  });
});

test('invalid or unsafe ranges fail before SQL generation', () => {
  for (const arguments_ of [
    [0, 1],
    [-1, 1],
    [1.5, 1],
    ['1', 1],
    [1, 0],
    [1, MAX_SEED_ROWS + 1],
    [1, 1.5],
    [1, 1, 0],
    [1, 1, MAX_PAYLOAD_BYTES + 1],
    [1, 1, '1024'],
    [Number.MAX_SAFE_INTEGER, 2],
    [NaN, 1],
    [Infinity, 1],
  ]) {
    assert.throws(() => seedSql(...arguments_), RangeError);
  }
});
