import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readSqliteRestoreSeedFingerprint } from '../sqlite-restore-seed';
let db: DatabaseSync;
function adapter() {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (db.prepare(sql).get(...(params as SQLInputValue[])) as T) ?? null;
    },
  };
}
const fingerprint = () => readSqliteRestoreSeedFingerprint(adapter(), async () => {});
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(
    "CREATE TABLE seeded(id TEXT NOT NULL PRIMARY KEY,value); INSERT INTO seeded VALUES ('a',9007199254740993),('b',x'00FF'); CREATE TABLE empty(id TEXT PRIMARY KEY NOT NULL)"
  );
});
afterEach(() => db.close());
it('is independent of insertion order but preserves types, values, duplicate counts and empty tables', async () => {
  const baseline = await fingerprint();
  expect(baseline).toMatch(/^[0-9a-f]{64}$/);
  db.exec("DELETE FROM seeded; INSERT INTO seeded VALUES ('b',x'00FF'),('a',9007199254740993)");
  expect(await fingerprint()).toBe(baseline);
  db.exec("UPDATE seeded SET value='9007199254740993' WHERE id='a'");
  expect(await fingerprint()).not.toBe(baseline);
  db.exec(
    "UPDATE seeded SET value=9007199254740993 WHERE id='a'; INSERT INTO empty VALUES ('used')"
  );
  expect(await fingerprint()).not.toBe(baseline);
  db.exec('DELETE FROM empty');
  expect(await fingerprint()).toBe(baseline);
  db.exec('DROP TABLE empty');
  expect(await fingerprint()).not.toBe(baseline);
});
it.each([
  'CREATE INDEX seed_index ON seeded(value)',
  'CREATE VIEW seed_view AS SELECT id FROM seeded',
  'CREATE TRIGGER seed_trigger AFTER INSERT ON seeded BEGIN SELECT 1; END',
  'ALTER TABLE empty ADD COLUMN enabled INTEGER DEFAULT 1',
])('detects changed schema objects: %s', async (sql) => {
  const baseline = await fingerprint();
  db.exec(sql);
  expect(await fingerprint()).not.toBe(baseline);
});
it('includes migration tracking, authentication state and autoincrement counters', async () => {
  db.exec(
    'CREATE TABLE authrim_migrations(id TEXT); CREATE TABLE sessions(id TEXT); CREATE TABLE counters(id INTEGER PRIMARY KEY AUTOINCREMENT)'
  );
  const baseline = await fingerprint();
  db.exec("INSERT INTO sessions VALUES ('used')");
  expect(await fingerprint()).not.toBe(baseline);
  db.exec("DELETE FROM sessions; INSERT INTO authrim_migrations VALUES ('different')");
  expect(await fingerprint()).not.toBe(baseline);
  db.exec(
    'DELETE FROM authrim_migrations; INSERT INTO counters DEFAULT VALUES; DELETE FROM counters'
  );
  expect(await fingerprint()).not.toBe(baseline);
});
it('retains duplicate seed multiplicity and hashes several pages', async () => {
  db.exec('CREATE TABLE duplicates(value TEXT)');
  const insert = db.prepare("INSERT INTO duplicates VALUES ('same')");
  for (let i = 0; i < 33; i++) insert.run();
  const baseline = await fingerprint();
  insert.run();
  expect(await fingerprint()).not.toBe(baseline);
});
it('stops on admission loss and detects schema changes during inspection', async () => {
  let checks = 0;
  await expect(
    readSqliteRestoreSeedFingerprint(adapter(), async () => {
      if (++checks === 3) throw new Error('admission_lost');
    })
  ).rejects.toThrow('admission_lost');
  const database = adapter();
  const query = database.query;
  let changed = false;
  database.query = async <T>(sql: string, params?: unknown[]) => {
    const result = await query<T>(sql, params);
    if (!changed && sql.includes('length(packed)')) {
      changed = true;
      db.exec('CREATE TABLE raced(id TEXT)');
    }
    return result;
  };
  await expect(readSqliteRestoreSeedFingerprint(database, async () => {})).rejects.toThrow(
    'seed_unavailable'
  );
});
it('bounds seed row size without returning data in errors', async () => {
  db.prepare('UPDATE seeded SET value=? WHERE id=?').run('private'.repeat(50000), 'a');
  await expect(fingerprint()).rejects.toThrow(/^backup_restore_seed_unavailable$/);
});
