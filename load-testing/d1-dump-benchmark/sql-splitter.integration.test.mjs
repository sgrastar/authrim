import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fingerprint } from './authrim-fingerprint.mjs';
import {
  compileSchema,
  globalCountsSql,
  profile,
  schemaFingerprintSql,
  seedSql,
} from './authrim-fixture.mjs';
import { SqlStreamSplitter, splitSqlStream } from './sql-stream-splitter.mjs';

const require = createRequire(import.meta.url);
const { unstable_splitSqlQuery: splitQueries } = require('wrangler');
const compiled = await compileSchema();
const fkOff = 'PRAGMA foreign_keys=OFF;\n';
const fkOn = '\nPRAGMA foreign_keys=ON;\n';

const query = async (database, sql) =>
  splitQueries(sql).map((statement) => ({
    success: true,
    results: database.prepare(statement).all(),
  }));

function quoted(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`;
  return `'${value.replaceAll("'", "''")}'`;
}

function rowInserts(database, table) {
  return database
    .prepare(`SELECT * FROM "${table}" ORDER BY rowid`)
    .all()
    .map((row) => {
      const names = Object.keys(row);
      return `INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(',')})
      VALUES (${names.map((name) => quoted(row[name])).join(',')});`;
    });
}

function makeSourceAndDump() {
  const source = new DatabaseSync(':memory:');
  source.exec(`PRAGMA foreign_keys=ON; BEGIN; ${compiled.schemaSql} COMMIT;`);
  source.exec(seedSql(1, 8));
  source.exec(`UPDATE identity_subjects SET display_label = '合成ユーザー; "quoted" 🐱'
    WHERE id = 'bench-subject-000000000001';`);
  const rows = profile.populatedTables.flatMap((table) => rowInserts(source, table));
  // The original canonical triggers remain active in this script. Their restored
  // outbox IDs/timestamps must be copied from the source rather than regenerated.
  const derived = profile.triggerPopulatedTables.flatMap((table) => [
    `DELETE FROM "${table}";`,
    ...rowInserts(source, table),
  ]);
  const dump = `\ufeff${compiled.schemaSql}\n${rows.join('\n')}\n${derived.join('\n')}\n`;
  return { source, dump };
}

async function* bytesInAwkwardChunks(bytes) {
  const lengths = [1, 2, 3, 5, 8, 13, 89, 1021];
  let offset = 0;
  let index = 0;
  while (offset < bytes.length) {
    const end = Math.min(bytes.length, offset + lengths[index++ % lengths.length]);
    yield bytes.subarray(offset, end);
    offset = end;
  }
}

async function prepareParts(bytes, targetBytes) {
  const parts = [];
  let current = '';
  let currentBytes = 0;
  let statements = 0;
  for await (const piece of splitSqlStream(bytesInAwkwardChunks(bytes), {
    rejectForeignKeysEnable: true,
  })) {
    current += piece.text;
    currentBytes += Buffer.byteLength(piece.text);
    if (piece.boundary) {
      statements++;
      if (currentBytes >= targetBytes) {
        parts.push(current);
        current = '';
        currentBytes = 0;
      }
    }
  }
  if (current) parts.push(current);
  return { parts, statements };
}

test('canonical Authrim schema and seeded rows survive small SQL parts with independent FK wrappers', async (t) => {
  const { source, dump } = makeSourceAndDump();
  try {
    assert.equal(compiled.schemaStatements.length, 723);
    const original = await fingerprint(query, source, { accountCount: 8 });
    const bytes = Buffer.from(dump);
    const sha256 = (value) => createHash('sha256').update(value).digest('hex');
    for (const targetBytes of [1024, 4096]) {
      await t.test(`target ${targetBytes} bytes`, async () => {
        const restored = new DatabaseSync(':memory:');
        try {
          const { parts, statements } = await prepareParts(bytes, targetBytes);
          assert.ok(parts.length > 20);
          assert.ok(statements > compiled.schemaStatements.length);
          assert.equal(parts.join(''), dump);
          assert.equal(sha256(Buffer.from(parts.join(''))), sha256(bytes));
          restored.exec('PRAGMA foreign_keys=ON;');
          for (const part of parts) {
            // Validate each file on its own as well as the full streaming input.
            // An internal trigger-body semicolon must never close a part.
            const independent = new SqlStreamSplitter({ rejectForeignKeysEnable: true });
            independent.push(part);
            independent.finish();
            const file = `${fkOff}${part}${fkOn}`;
            restored.exec(file); // Deliberately use autocommit, with no outer transaction.
            assert.equal(restored.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
          }
          assert.deepEqual(
            restored.prepare(schemaFingerprintSql).all(),
            source.prepare(schemaFingerprintSql).all()
          );
          assert.deepEqual(
            restored.prepare(globalCountsSql).all(),
            source.prepare(globalCountsSql).all()
          );
          assert.deepEqual(await fingerprint(query, restored, { accountCount: 8 }), original);
          assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(), []);
          assert.equal(restored.prepare('PRAGMA quick_check').get().quick_check, 'ok');
          assert.equal(
            restored
              .prepare(
                "SELECT display_label FROM identity_subjects WHERE id = 'bench-subject-000000000001'"
              )
              .get().display_label,
            '合成ユーザー; "quoted" 🐱'
          );
        } finally {
          restored.close();
        }
      });
    }
  } finally {
    source.close();
  }
});
