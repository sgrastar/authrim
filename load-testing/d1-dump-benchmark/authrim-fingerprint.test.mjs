import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fingerprint } from './authrim-fingerprint.mjs';
import {
  compileSchema,
  globalCountsSql,
  MAX_SEED_ACCOUNTS,
  MAX_VERIFICATION_ACCOUNTS,
  schemaFingerprintSql,
  seedSql,
  verificationPlan,
} from './authrim-fixture.mjs';

const require = createRequire(import.meta.url);
const { unstable_splitSqlQuery: splitSql } = require('wrangler');
const compiled = await compileSchema();

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`BEGIN; ${compiled.schemaSql} COMMIT; PRAGMA foreign_keys = ON;`);
  return db;
}

function localQuery(calls = []) {
  return async (db, sql, retry) => {
    assert.equal(retry, true);
    assert.ok(Buffer.byteLength(sql) <= 100000);
    const statements = splitSql(sql);
    if (statements.some((statement) => statement.split(/\nUNION ALL\n/).length >= 15)) {
      throw new Error('D1_ERROR: too many terms in compound SELECT: SQLITE_ERROR');
    }
    calls.push(statements.length);
    return statements.map((statement) => ({ success: true, results: db.prepare(statement).all() }));
  };
}

function dumpClone(source) {
  const target = new DatabaseSync(':memory:');
  target.exec('PRAGMA foreign_keys = OFF;');
  const objects = source
    .prepare(
      `SELECT type, name, sql FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
    ORDER BY CASE WHEN type = 'table' THEN 0 ELSE 1 END, type, name`
    )
    .all();
  for (const object of objects.filter((object) => object.type === 'table')) {
    target.exec(object.sql);
  }
  for (const object of objects.filter((object) => object.type === 'table')) {
    const rows = source.prepare(`SELECT * FROM "${object.name}"`).all();
    if (!rows.length) continue;
    const columns = Object.keys(rows[0]);
    const insert = target.prepare(`INSERT INTO "${object.name}"
      (${columns.map((column) => `"${column}"`).join(',')})
      VALUES (${columns.map(() => '?').join(',')})`);
    for (const row of rows) insert.run(...columns.map((column) => row[column]));
  }
  for (const object of objects.filter((object) => object.type !== 'table')) target.exec(object.sql);
  target.exec('PRAGMA foreign_keys = ON');
  return target;
}

// Preserve the previous range-by-range aggregate/sample algorithm as an independent
// output oracle. Its SQL has no index hint and includes outbox in every range.
function legacyFingerprint(database, accountCount) {
  const oldSql = (sql) => sql.replace(/ INDEXED BY "[^"]+"/g, '');
  const aggregates = {};
  for (let start = 1; start <= accountCount; start += MAX_VERIFICATION_ACCOUNTS) {
    const count = Math.min(MAX_VERIFICATION_ACCOUNTS, accountCount - start + 1);
    for (const entry of verificationPlan(start, count)) {
      const row = database.prepare(oldSql(entry.sql)).get();
      const total = (aggregates[entry.name] ??= { min_key: null, max_key: null });
      for (const [key, value] of Object.entries(row)) {
        if (key === 'min_key') {
          if (value !== null && (total.min_key === null || value < total.min_key))
            total.min_key = value;
        } else if (key === 'max_key') {
          if (value !== null && (total.max_key === null || value > total.max_key))
            total.max_key = value;
        } else total[key] = (total[key] ?? 0) + value;
      }
    }
  }
  const stableHash = (value) =>
    createHash('sha256')
      .update(
        JSON.stringify(value, (_key, entry) =>
          entry && typeof entry === 'object' && !Array.isArray(entry)
            ? Object.fromEntries(
                Object.keys(entry)
                  .sort()
                  .map((name) => [name, entry[name]])
              )
            : entry
        )
      )
      .digest('hex');
  const first = verificationPlan(1, Math.min(accountCount, MAX_VERIFICATION_ACCOUNTS));
  const lastStart =
    Math.floor((accountCount - 1) / MAX_VERIFICATION_ACCOUNTS) * MAX_VERIFICATION_ACCOUNTS + 1;
  const last = verificationPlan(lastStart, accountCount - lastStart + 1);
  return {
    accountCount,
    counts: Object.fromEntries(
      database
        .prepare(globalCountsSql)
        .all()
        .map((row) => [row.table_name, row.row_count])
    ),
    aggregates,
    sampleHashes: Object.fromEntries(
      first.map((entry, index) => [
        entry.name,
        stableHash({
          first: database.prepare(oldSql(entry.sampleSql)).all(),
          last: database.prepare(oldSql(last[index].lastSampleSql)).all(),
        }),
      ])
    ),
    schemaSha256: stableHash(database.prepare(schemaFingerprintSql).all()),
    invalidRelationships: 0,
  };
}

test('SQL dump clone matches the source fingerprint while probe writes and runtime tables are excluded', async () => {
  const source = database();
  let restored;
  try {
    source.exec(seedSql(1, 8));
    const calls = [];
    const original = await fingerprint(localQuery(calls), source, { accountCount: 8 });
    assert.deepEqual(calls, [15, 2, 12, 24]);
    assert.equal(JSON.stringify(original), JSON.stringify(legacyFingerprint(source, 8)));
    assert.equal(original.counts.users_core, 8);
    assert.equal(original.counts.passkeys, 10);
    assert.equal(original.aggregates.identity_accounts.invalid_json, 0);
    assert.match(original.schemaSha256, /^[0-9a-f]{64}$/);
    assert.ok(Object.values(original.sampleHashes).every((hash) => /^[0-9a-f]{64}$/.test(hash)));
    assert.equal(JSON.stringify(original).includes('application_context'), false);
    restored = dumpClone(source);
    assert.deepEqual(await fingerprint(localQuery(), restored, { accountCount: 8 }), original);
    restored.exec(`UPDATE bench_probe SET writes = writes + 1;
      CREATE TABLE _cf_metadata (id INTEGER PRIMARY KEY, value TEXT);
      CREATE INDEX _cf_metadata_value ON _cf_metadata(value);
      CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT);`);
    assert.deepEqual(await fingerprint(localQuery(), restored, { accountCount: 8 }), original);
    restored.exec(`UPDATE identity_subjects SET metadata_json =
      json_set(metadata_json, '$.application_context',
        CASE substr(json_extract(metadata_json, '$.application_context'), 1, 1)
          WHEN 'A' THEN 'B' ELSE 'A' END ||
          substr(json_extract(metadata_json, '$.application_context'), 2))
      WHERE id = 'bench-subject-000000000001'`);
    const changed = await fingerprint(localQuery(), restored, { accountCount: 8 });
    assert.deepEqual(changed.aggregates, original.aggregates);
    assert.notEqual(
      changed.sampleHashes.identity_subjects,
      original.sampleHashes.identity_subjects
    );
  } finally {
    restored?.close();
    source.close();
  }
});

test('cross-tenant relationship corruption fails instead of yielding a valid fingerprint', async () => {
  const db = database();
  try {
    db.exec(seedSql(1, 2));
    db.exec(
      "UPDATE subject_account_links SET tenant_id = 'other-tenant' WHERE id = 'bench-link-000000000001'"
    );
    await assert.rejects(
      fingerprint(localQuery(), db, { accountCount: 2 }),
      /Invalid fixture account relationships/
    );
  } finally {
    db.close();
  }
});

test('more than ten thousand accounts use two bounded aggregate batches and one sample batch', async () => {
  const db = database();
  try {
    for (let first = 1; first <= 10001; first += MAX_SEED_ACCOUNTS) {
      db.exec(seedSql(first, Math.min(MAX_SEED_ACCOUNTS, 10002 - first), { metadataBytes: 0 }));
    }
    const calls = [];
    const sqlBatches = [];
    const local = localQuery(calls);
    const value = await fingerprint(
      async (...args) => {
        sqlBatches.push(args[1]);
        return local(...args);
      },
      db,
      { accountCount: 10001 }
    );
    assert.deepEqual(calls, [15, 2, 12, 12, 24]);
    const outboxScans = sqlBatches
      .flatMap(splitSql)
      .filter(
        (sql) => sql.includes('FROM "account_webhook_outbox"') && sql.includes('MIN("user_id")')
      );
    assert.equal(outboxScans.length, 1);
    assert.equal(value.aggregates.account_webhook_outbox.row_count, 10001);
    assert.equal(JSON.stringify(value), JSON.stringify(legacyFingerprint(db, 10001)));
    assert.equal(value.aggregates.users_core.row_count, 10001);
    assert.equal(value.aggregates.passkeys.row_count, 12501);
    assert.equal(value.aggregates.users_core.min_key, 'bench-user-000000000001');
    assert.equal(value.aggregates.users_core.max_key, 'bench-user-000000010001');
    assert.equal(value.invalidRelationships, 0);
  } finally {
    db.close();
  }
});

test('missing rows, invalid account counts, and malformed D1 responses fail closed', async () => {
  const db = database();
  try {
    db.exec(seedSql(1, 2));
    await assert.rejects(
      fingerprint(localQuery(), db, { accountCount: 1 }),
      /Unexpected fixture row count/
    );
    await assert.rejects(fingerprint(localQuery(), db, { accountCount: 0 }));
    await assert.rejects(fingerprint(async () => [], db, { accountCount: 2 }));
    await assert.rejects(
      fingerprint(async () => [{ success: false, results: [] }], db, { accountCount: 2 })
    );
  } finally {
    db.close();
  }
});

test('D1 compound-SELECT restriction rejects the legacy UNION while batched counts succeed', async () => {
  const db = database();
  try {
    db.exec(seedSql(1, 8));
    const query = localQuery();
    await assert.rejects(query(db, globalCountsSql, true), /too many terms in compound SELECT/);
    const value = await fingerprint(query, db, { accountCount: 8 });
    assert.equal(value.counts.users_core, 8);
    assert.equal(value.counts.passkeys, 10);
  } finally {
    db.close();
  }
});
