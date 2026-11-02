import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  bootstrapSql,
  compileSchema,
  DEFAULT_METADATA_BYTES,
  globalCountsSql,
  globalVerificationPlan,
  loadSchema,
  MAX_SEED_ACCOUNTS,
  MAX_VERIFICATION_ACCOUNTS,
  relationshipCheckSql,
  schemaFingerprintSql,
  schemaProvisioningBatches,
  seedSql,
  syntheticId,
  verificationPlan,
} from './authrim-fixture.mjs';

const compiled = await compileSchema();

function withDatabase(callback) {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON; BEGIN;');
    database.exec(compiled.schemaSql);
    database.exec('COMMIT;');
    callback(database);
  } finally {
    database.close();
  }
}

function counts(database) {
  return Object.fromEntries(
    database
      .prepare(globalCountsSql)
      .all()
      .map((row) => [row.table_name, row.row_count])
  );
}

function verification(database, start, count) {
  return verificationPlan(start, count).map((entry) => ({
    name: entry.name,
    aggregate: database.prepare(entry.sql).get(),
    first: database.prepare(entry.sampleSql).all(),
    last: database.prepare(entry.lastSampleSql).all(),
  }));
}

test('canonical draft files render with verified checksums and compile to the exact final schema', async () => {
  const loaded = await loadSchema();
  assert.equal(loaded.profile.productVersion, '0.4.2');
  assert.equal(loaded.migrations.length, 19);
  assert.equal(loaded.migrations[0].path, 'migrations/core/d1/001_0_4_0_core_baseline.sql');
  assert.equal(
    loaded.migrations.at(-1).path,
    'migrations/core/d1/019_oauth_client_minimum_ial.sql'
  );
  assert.ok(loaded.migrations.every((entry) => /^[0-9a-f]{64}$/.test(entry.checksum)));
  const canonical = new DatabaseSync(':memory:');
  try {
    for (const migration of loaded.migrations) canonical.exec(migration.sql);
    canonical.exec(bootstrapSql);
    withDatabase((restored) => {
      assert.deepEqual(
        restored.prepare(schemaFingerprintSql).all(),
        canonical.prepare(schemaFingerprintSql).all()
      );
      for (const table of ['tenants', 'flows', 'oidc_scopes', 'roles', 'oauth_clients']) {
        const stable = (rows) =>
          rows.map((row) =>
            Object.fromEntries(
              Object.entries(row).filter(([key]) => key !== 'tenant_key' && !key.endsWith('_at'))
            )
          );
        assert.deepEqual(
          stable(restored.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
          stable(canonical.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
        );
      }
      assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(), []);
    });
  } finally {
    canonical.close();
  }
  assert.ok(compiled.profile.tableCount >= 190);
  assert.ok(compiled.profile.indexCount >= 650);
  assert.ok(compiled.profile.triggerCount >= 80);
  assert.ok(compiled.schemaStatements.every((sql) => Buffer.byteLength(sql) <= 100000));
});

test('REST provisioning batches commit independently with immediate foreign-key enforcement', () => {
  const batches = schemaProvisioningBatches(compiled);
  const statements = batches.flat();
  assert.equal(statements.length, compiled.schemaStatements.length - 2);
  assert.ok(batches.every((batch) => batch.length > 0 && batch.length <= 32));
  assert.ok(statements.every((sql) => !/^PRAGMA/.test(sql)));
  const insertPosition = (table) =>
    statements.findIndex((sql) => sql.startsWith(`INSERT INTO "${table}" `));
  assert.ok(insertPosition('flows') < insertPosition('flow_versions'));
  assert.ok(insertPosition('flows') < insertPosition('flow_assignments'));
  const firstInsert = statements.findIndex((sql) => /^INSERT INTO/.test(sql));
  const lastIndex = statements.findLastIndex((sql) => /^CREATE (?:UNIQUE )?INDEX/.test(sql));
  assert.ok(lastIndex < firstInsert);
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON;');
    for (const batch of batches) {
      database.exec('BEGIN;');
      try {
        for (const sql of batch) database.exec(sql);
        database.exec('COMMIT;');
      } catch (error) {
        database.exec('ROLLBACK;');
        throw error;
      }
      assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
      assert.equal(database.prepare('PRAGMA defer_foreign_keys').get().defer_foreign_keys, 0);
    }
    withDatabase((reference) => {
      assert.deepEqual(
        database.prepare(schemaFingerprintSql).all(),
        reference.prepare(schemaFingerprintSql).all()
      );
      assert.deepEqual(counts(database), counts(reference));
    });
    database.exec(seedSql(1, 8));
    assert.equal(database.prepare(relationshipCheckSql(1, 8)).get().invalid_relationships, 0);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(database.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  } finally {
    database.close();
  }
  assert.throws(() => schemaProvisioningBatches(compiled, { batchSize: 0 }));
  assert.throws(() => schemaProvisioningBatches(compiled, { batchSize: 513 }));
});

test('seeds current accounts and related tables, including canonical trigger side effects', () => {
  withDatabase((database) => {
    database.exec(seedSql(1, 8));
    const actual = counts(database);
    for (const table of [
      'users_core',
      'identity_subjects',
      'identity_accounts',
      'subject_account_links',
      'role_assignments',
      'oauth_client_consents',
      'sessions',
      'user_token_families',
      'account_webhook_outbox',
      'service_group_inputs',
      'account_legal_hold_states',
    ]) {
      assert.equal(actual[table], 8, table);
    }
    assert.equal(actual.passkeys, 10);
    assert.equal(actual.roles, 4);
    assert.equal(actual.oauth_clients, 4);
    assert.equal(actual.users, 0);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name = 'users_pii'").get().n,
      0
    );
    assert.equal(database.prepare(relationshipCheckSql(1, 8)).get().invalid_relationships, 0);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(database.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    for (const table of ['identity_subjects', 'identity_accounts', 'role_assignments']) {
      const rows = database.prepare(`SELECT metadata_json FROM ${table}`).all();
      for (const row of rows) {
        const metadata = JSON.parse(row.metadata_json);
        assert.equal(metadata.source, 'synthetic-benchmark');
        assert.equal(Buffer.byteLength(metadata.application_context), DEFAULT_METADATA_BYTES);
        assert.match(metadata.application_context, /^[A-F0-9]+$/);
      }
      assert.equal(new Set(rows.map((row) => row.metadata_json)).size, rows.length);
    }
  });
});

test('batch retries preserve all values and overlapping batches introduce no account gaps', () => {
  withDatabase((database) => {
    database.exec(seedSql(1, 8));
    const original = verification(database, 1, 8);
    const originalCounts = counts(database);
    database.exec(seedSql(1, 8));
    assert.deepEqual(verification(database, 1, 8), original);
    assert.deepEqual(counts(database), originalCounts);
    database.exec(seedSql(6, 8));
    assert.equal(counts(database).users_core, 13);
    assert.deepEqual(
      database
        .prepare('SELECT id FROM users_core ORDER BY id')
        .all()
        .map((row) => row.id),
      Array.from({ length: 13 }, (_, index) => syntheticId('user', index + 1))
    );
    assert.deepEqual(verification(database, 1, 8), original);
    assert.equal(database.prepare(relationshipCheckSql(1, 13)).get().invalid_relationships, 0);
  });
});

test('verification partitions cover passkey variants and keep every numeric sum safely representable', () => {
  withDatabase((database) => {
    database.exec(seedSql(1, MAX_SEED_ACCOUNTS, { metadataBytes: 17 }));
    const all = verification(database, 1, MAX_SEED_ACCOUNTS);
    const left = verification(database, 1, 250);
    const right = verification(database, 251, 250);
    for (let index = 0; index < all.length; index++) {
      assert.equal(
        all[index].aggregate.row_count,
        left[index].aggregate.row_count + right[index].aggregate.row_count
      );
      assert.equal(
        all[index].aggregate.time_sum,
        left[index].aggregate.time_sum + right[index].aggregate.time_sum
      );
      assert.ok(Number.isSafeInteger(all[index].aggregate.time_sum));
    }
    assert.equal(all.find((entry) => entry.name === 'passkeys').aggregate.row_count, 625);
    assert.equal(
      database
        .prepare(
          "SELECT length(json_extract(metadata_json, '$.application_context')) AS n FROM identity_accounts LIMIT 1"
        )
        .get().n,
      17
    );
    assert.equal(database.prepare(relationshipCheckSql(1, 500)).get().invalid_relationships, 0);
  });
});

test('account verification uses existing PK ranges and returns exactly the previous SQL results', () => {
  withDatabase((database) => {
    database.exec(seedSql(1, 8));
    for (const entry of verificationPlan(1, 8)) {
      for (const sql of [entry.sql, entry.sampleSql, entry.lastSampleSql]) {
        const oldSql = sql.replace(/ INDEXED BY "[^"]+"/g, '');
        assert.deepEqual(database.prepare(sql).all(), database.prepare(oldSql).all());
        if (
          ['service_group_inputs', 'account_legal_hold_states', 'account_webhook_outbox'].includes(
            entry.name
          )
        )
          continue;
        const details = database
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all()
          .map((row) => row.detail);
        assert.ok(
          details.some(
            (detail) =>
              detail.includes(`sqlite_autoindex_${entry.name}_1`) &&
              /(?:id|jti)>\? AND (?:id|jti)<\?/.test(detail)
          ),
          entry.name
        );
        assert.ok(
          details.every((detail) => !detail.includes('TEMP B-TREE')),
          entry.name
        );
      }
    }
    const global = globalVerificationPlan(8);
    assert.deepEqual(
      global.map((entry) => entry.name),
      ['account_webhook_outbox']
    );
    assert.deepEqual(
      database.prepare(global[0].sql).all(),
      database
        .prepare(
          verificationPlan(1, 8).find((entry) => entry.name === 'account_webhook_outbox').sql
        )
        .all()
    );
  });
});

test('application relationship validation detects an existing but cross-tenant subject link', () => {
  withDatabase((database) => {
    database.exec(seedSql(1, 2));
    database.exec(`UPDATE subject_account_links SET tenant_id = 'other-tenant'
      WHERE id = '${syntheticId('link', 1)}'`);
    // The actual schema's ID foreign keys alone permit this tenant mismatch.
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(database.prepare(relationshipCheckSql(1, 2)).get().invalid_relationships, 1);
    assert.throws(
      () => database.exec("UPDATE role_assignments SET role_id = 'missing-role'"),
      /FOREIGN KEY/
    );
  });
});

test('probe writes leave account fingerprints unchanged and inputs remain bounded', () => {
  withDatabase((database) => {
    database.exec(seedSql(1, 1));
    const original = verification(database, 1, 1);
    database.exec('UPDATE bench_probe SET writes = writes + 1 WHERE id = 1');
    assert.equal(database.prepare('SELECT writes FROM bench_probe').get().writes, 1);
    assert.deepEqual(verification(database, 1, 1), original);
  });
  for (const [start, count] of [
    [0, 1],
    [1, 0],
    [1, MAX_SEED_ACCOUNTS + 1],
    [1.5, 2],
  ]) {
    assert.throws(() => seedSql(start, count));
  }
  assert.throws(() => seedSql(1, 1, { metadataBytes: -1 }));
  assert.throws(() => seedSql(1, 1, { metadataBytes: 4097 }));
  assert.throws(() => verificationPlan(1, MAX_VERIFICATION_ACCOUNTS + 1));
  assert.throws(() => relationshipCheckSql(999999999999, 2));
  assert.ok(Buffer.byteLength(seedSql(1, MAX_SEED_ACCOUNTS)) < 100000);
});
