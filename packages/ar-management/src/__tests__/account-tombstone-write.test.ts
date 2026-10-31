import { DatabaseSync, type SQLInputValue } from './test-sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderPortableMigrationSql } from '../../../ar-lib-core/dist/migrations/sql-portability';
import type { DatabaseAdapter, PreparedStatement } from '@authrim/ar-lib-core';
import { writeAccountTombstone } from '../account-tombstone-write';

const PII_MIGRATIONS = new URL('../../../../migrations/pii/d1/', import.meta.url);

/** A PII store with the executable D1 schema (so the primary key is the real one). */
function piiStore() {
  const db = new DatabaseSync(':memory:');
  for (const file of ['001_0_5_0_pii_baseline.sql']) {
    db.exec(
      renderPortableMigrationSql(readFileSync(new URL(file, PII_MIGRATIONS), 'utf8'), 'sqlite')
    );
  }
  const values = (params: unknown[] = []) =>
    params.map((value) => (value === undefined ? null : value) as SQLInputValue);
  const run = (statement: PreparedStatement) => ({
    success: true,
    rowsAffected: Number(db.prepare(statement.sql).run(...values(statement.params)).changes),
  });
  const adapter = {
    query: async (sql: string, params?: unknown[]) => db.prepare(sql).all(...values(params)),
    queryOne: async (sql: string, params?: unknown[]) =>
      db.prepare(sql).get(...values(params)) ?? null,
    execute: async (sql: string, params?: unknown[]) => run({ sql, params }),
    batch: async (statements: PreparedStatement[]) => statements.map(run),
  } as unknown as DatabaseAdapter;
  const rows = () =>
    db.prepare('SELECT id, email_blind_index FROM users_pii_tombstone ORDER BY id').all() as Array<{
      id: string;
      email_blind_index: string | null;
    }>;
  const retentionOf = (id: string) =>
    Number(
      (
        db.prepare('SELECT retention_until FROM users_pii_tombstone WHERE id = ?').get(id) as {
          retention_until: number;
        }
      ).retention_until
    );
  const age = (id: string, days: number) =>
    db
      .prepare(
        'UPDATE users_pii_tombstone SET deleted_at = deleted_at - ?, retention_until = retention_until - ? WHERE id = ?'
      )
      .run(days * DAY_MS, days * DAY_MS, id);
  return { adapter, rows, retentionOf, age, db };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const INDEX_A = `tombstone_email:v1:g1:${'a'.repeat(64)}`;
const INDEX_B = `tombstone_email:v1:g1:${'b'.repeat(64)}`;
const write = (adapter: DatabaseAdapter, emailBlindIndex: string | null, reason = 'admin_action') =>
  writeAccountTombstone(adapter, {
    tenantId: 'tenant-a',
    userId: 'user-1',
    prepared: { emailBlindIndex, retentionDays: 90 },
    deletedBy: 'admin',
    reason,
    metadata: { source: 'test' },
  });

describe('writeAccountTombstone', () => {
  it("writes the user's record once; a retried deletion refreshes it without shortening it", async () => {
    const { adapter, rows, retentionOf } = piiStore();
    const first = await write(adapter, INDEX_A);
    const retried = await write(adapter, INDEX_A);

    expect(retried.id).toBe('user-1');
    expect(retentionOf('user-1')).toBeGreaterThanOrEqual(first.retention_until);
    expect(retried.retention_until).toBe(retentionOf('user-1'));
    expect(rows()).toEqual([{ id: 'user-1', email_blind_index: INDEX_A }]);
  });

  it('does not fail on the primary key when a deletion without an address is retried', async () => {
    const { adapter, rows } = piiStore();
    await write(adapter, null);
    await expect(write(adapter, null)).resolves.toMatchObject({ id: 'user-1' });
    expect(rows()).toHaveLength(1);
  });

  it('keeps a full retention when the same address is restored and deleted again later', async () => {
    const { adapter, retentionOf, age } = piiStore();
    await write(adapter, INDEX_A);
    // 80 days later the account, given the same address back, is deleted again.
    age('user-1', 80);
    await write(adapter, INDEX_A);
    expect(retentionOf('user-1')).toBeGreaterThan(Date.now() + 89 * DAY_MS);
  });

  it("keeps the earlier address in its own record and the latest deletion in the user's", async () => {
    const { adapter, rows, retentionOf, age } = piiStore();
    // PII erasure (address A), the account kept and given address B, then deleted.
    await write(adapter, INDEX_A);
    age('user-1', 10);
    const earlierDeadline = retentionOf('user-1');
    const latest = await write(adapter, INDEX_B);
    await write(adapter, INDEX_B);

    expect(latest.id).toBe('user-1');
    expect(rows()).toEqual([
      { id: 'user-1', email_blind_index: INDEX_B },
      { id: `user-1#${'a'.repeat(16)}`, email_blind_index: INDEX_A },
    ]);
    // The earlier address keeps its own deadline; the latest gets a full retention.
    expect(retentionOf(`user-1#${'a'.repeat(16)}`)).toBe(earlierDeadline);
    expect(retentionOf('user-1')).toBeGreaterThan(Date.now() + 89 * DAY_MS);
  });

  it('keeps the latest facts of an address deleted again after another (A, B, A, C)', async () => {
    const { adapter, rows, age, db } = piiStore();
    await write(adapter, INDEX_A, 'first_a');
    age('user-1', 30);
    await write(adapter, INDEX_B, 'b');
    await write(adapter, INDEX_A, 'second_a');
    await write(adapter, `tombstone_email:v1:g1:${'c'.repeat(64)}`, 'c');

    const movedA = db
      .prepare('SELECT deletion_reason, retention_until FROM users_pii_tombstone WHERE id = ?')
      .get(`user-1#${'a'.repeat(16)}`) as { deletion_reason: string; retention_until: number };
    expect(movedA.deletion_reason).toBe('second_a');
    expect(Number(movedA.retention_until)).toBeGreaterThan(Date.now() + 89 * DAY_MS);
    expect(rows().map((row) => row.id)).toEqual([
      'user-1',
      `user-1#${'a'.repeat(16)}`,
      `user-1#${'b'.repeat(16)}`,
    ]);
  });

  it('re-creates the record when the retention task removed it meanwhile', async () => {
    const { adapter, rows, db } = piiStore();
    await write(adapter, INDEX_A);
    db.prepare('DELETE FROM users_pii_tombstone').run();
    await expect(write(adapter, INDEX_A)).resolves.toMatchObject({ id: 'user-1' });
    expect(rows()).toEqual([{ id: 'user-1', email_blind_index: INDEX_A }]);
  });

  it('never shortens a stored retention with a shorter request for the same address', async () => {
    const { adapter, retentionOf } = piiStore();
    await write(adapter, INDEX_A);
    const long = retentionOf('user-1');
    await writeAccountTombstone(adapter, {
      tenantId: 'tenant-a',
      userId: 'user-1',
      prepared: { emailBlindIndex: INDEX_A, retentionDays: 14 },
      deletedBy: 'admin',
      reason: 'user_request',
      metadata: {},
    });
    expect(retentionOf('user-1')).toBe(long);
  });

  it('does not fail a written deletion when reading the record back fails', async () => {
    const { adapter, rows } = piiStore();
    const flaky = {
      ...adapter,
      queryOne: async () => {
        throw new Error('d1_read_timeout');
      },
    } as unknown as DatabaseAdapter;
    await expect(write(flaky, INDEX_A)).resolves.toMatchObject({
      id: 'user-1',
      email_blind_index: INDEX_A,
    });
    expect(rows()).toEqual([{ id: 'user-1', email_blind_index: INDEX_A }]);
  });

  it('keeps the earlier address when the latest deletion has none to keep', async () => {
    const { adapter, rows } = piiStore();
    await write(adapter, INDEX_A);
    await write(adapter, null);
    expect(rows()).toEqual([{ id: 'user-1', email_blind_index: INDEX_A }]);
  });
});
