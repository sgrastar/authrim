import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  globalCountsSql,
  globalVerificationPlan,
  MAX_VERIFICATION_ACCOUNTS,
  profile,
  relationshipCheckSql,
  schemaFingerprintSql,
  verificationPlan,
} from './authrim-fixture.mjs';

/**
 * Fingerprint a quiescent synthetic core shard. Probe writes are excluded. Aggregate
 * scans use indexed account ranges; the unindexed outbox is scanned once globally.
 * Complete first/last row samples are hashed locally. This is not an all-record
 * content checksum or a cross-query snapshot.
 * query(db, sql, true) must return one D1 result object per SQL statement.
 */
export async function fingerprint(query, db, { accountCount }) {
  assert.ok(Number.isSafeInteger(accountCount) && accountCount >= 1);
  const execute = async (statements) => {
    const sql = statements.map((statement) => `${statement.trim().replace(/;$/, '')};`).join('\n');
    assert.ok(Buffer.byteLength(sql) <= 100000, 'Fingerprint SQL batch exceeds 100 KB.');
    const results = await query(db, sql, true);
    assert.ok(Array.isArray(results) && results.length === statements.length);
    for (const result of results) {
      assert.notEqual(result.success, false, 'Fingerprint query failed.');
      assert.ok(Array.isArray(result.results), 'Fingerprint query returned no rows array.');
    }
    return results.map((result) => result.results);
  };

  // D1's compound-SELECT term limit is lower than desktop SQLite's. Keep the
  // existing named COUNT queries in one provider batch without a UNION expression.
  const countRows = (await execute(globalCountsSql.split(/\nUNION ALL\n/))).flat();
  const counts = Object.fromEntries(countRows.map((row) => [row.table_name, row.row_count]));
  assert.equal(counts.users, 0, 'The legacy users table should remain empty.');
  for (const name of [...profile.populatedTables, ...profile.triggerPopulatedTables]) {
    const expected =
      name === 'passkeys' ? accountCount + Math.floor(accountCount / 4) : accountCount;
    assert.equal(counts[name], expected, `Unexpected fixture row count: ${name}`);
  }
  const globalPlan = globalVerificationPlan(accountCount);
  const globalByName = new Map(globalPlan.map((entry) => [entry.name, entry]));
  const [schemaRows, ...globalRows] = await execute([
    schemaFingerprintSql,
    ...globalPlan.map((entry) => entry.sql),
  ]);
  const schema = schemaRows.filter(
    (row) =>
      !row.name.startsWith('_cf_') &&
      !row.tbl_name.startsWith('_cf_') &&
      row.name !== 'd1_migrations' &&
      row.tbl_name !== 'd1_migrations'
  );
  schema.sort((left, right) =>
    left.type < right.type
      ? -1
      : left.type > right.type
        ? 1
        : left.name < right.name
          ? -1
          : left.name > right.name
            ? 1
            : 0
  );

  const first = verificationPlan(1, Math.min(accountCount, MAX_VERIFICATION_ACCOUNTS));
  // Preserve property order as well as values: persisted backup manifests hash the
  // complete JSON fingerprint, including aggregate table order.
  const aggregates = Object.fromEntries(
    first.map((entry) => [entry.name, { min_key: null, max_key: null }])
  );
  const accumulate = (name, row) => {
    const total = aggregates[name];
    for (const [key, value] of Object.entries(row)) {
      if (key === 'min_key') {
        if (value !== null && (total.min_key === null || value < total.min_key))
          total.min_key = value;
      } else if (key === 'max_key') {
        if (value !== null && (total.max_key === null || value > total.max_key))
          total.max_key = value;
      } else {
        assert.ok(Number.isSafeInteger(value), `Unsafe fingerprint value: ${name}.${key}`);
        total[key] = (total[key] ?? 0) + value;
        assert.ok(Number.isSafeInteger(total[key]), `Unsafe fingerprint sum: ${name}.${key}`);
      }
    }
    if ('invalid_json' in total) assert.equal(total.invalid_json, 0, 'Invalid JSON metadata.');
  };
  for (let index = 0; index < globalPlan.length; index++) {
    assert.equal(globalRows[index].length, 1);
    accumulate(globalPlan[index].name, globalRows[index][0]);
  }
  for (let start = 1; start <= accountCount; start += MAX_VERIFICATION_ACCOUNTS) {
    const count = Math.min(MAX_VERIFICATION_ACCOUNTS, accountCount - start + 1);
    const plan = verificationPlan(start, count).filter((entry) => !globalByName.has(entry.name));
    const results = await execute([
      ...plan.map((entry) => entry.sql),
      relationshipCheckSql(start, count),
    ]);
    const relations = results.pop();
    assert.equal(relations.length, 1);
    assert.equal(relations[0].invalid_relationships, 0, 'Invalid fixture account relationships.');
    for (let index = 0; index < plan.length; index++) {
      assert.equal(results[index].length, 1);
      accumulate(plan[index].name, results[index][0]);
    }
  }
  for (const [name, aggregate] of Object.entries(aggregates)) {
    assert.equal(aggregate.row_count, counts[name], `Out-of-range fixture records: ${name}`);
  }

  const lastStart =
    Math.floor((accountCount - 1) / MAX_VERIFICATION_ACCOUNTS) * MAX_VERIFICATION_ACCOUNTS + 1;
  const last = verificationPlan(lastStart, accountCount - lastStart + 1);
  const sampleResults = await execute(
    first.flatMap((entry, index) => [
      globalByName.get(entry.name)?.sampleSql ?? entry.sampleSql,
      globalByName.get(entry.name)?.lastSampleSql ?? last[index].lastSampleSql,
    ])
  );
  const sampleHashes = Object.fromEntries(
    first.map((entry, index) => [
      entry.name,
      hash({ first: sampleResults[index * 2], last: sampleResults[index * 2 + 1] }),
    ])
  );
  return {
    accountCount,
    counts,
    aggregates,
    sampleHashes,
    schemaSha256: hash(schema),
    invalidRelationships: 0,
  };
}

function hash(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

function canonical(value) {
  if (value instanceof Uint8Array) return [...value];
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    );
  }
  return value;
}
