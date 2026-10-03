import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseAdapter, PreparedStatement } from '../../db/adapter';
import { renderPortableMigrationSql } from '../../migrations/sql-portability';
import { TotpCredentialRepository } from '../core/totp-credential';

const MIGRATIONS = new URL('../../../../../migrations/core/d1/', import.meta.url);

type SqlValue = string | number | null;
const values = (params: unknown[] = []) =>
  params.map((value): SqlValue => (value === undefined ? null : (value as SqlValue)));

/** The executable D1 schema, so a statement naming a column the table lacks fails here. */
function sqliteAdapter(): { db: DatabaseSync; adapter: DatabaseAdapter } {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(renderPortableMigrationSql(readFileSync(new URL(file, MIGRATIONS), 'utf8'), 'sqlite'));
  }
  const run = (statement: PreparedStatement) => {
    const changes = Number(db.prepare(statement.sql).run(...values(statement.params)).changes);
    return { success: true, rowsAffected: changes };
  };
  const adapter = {
    async query(sql: string, params?: unknown[]) {
      return db.prepare(sql).all(...values(params));
    },
    async queryOne(sql: string, params?: unknown[]) {
      return db.prepare(sql).get(...values(params)) ?? null;
    },
    async execute(sql: string, params?: unknown[]) {
      return run({ sql, params });
    },
    async batch(statements: PreparedStatement[]) {
      db.exec('BEGIN');
      try {
        const results = statements.map(run);
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as DatabaseAdapter;
  return { db, adapter };
}

describe('TotpCredentialRepository.delete', () => {
  let db: DatabaseSync;
  let repository: TotpCredentialRepository;

  const count = (table: string) =>
    Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

  beforeEach(() => {
    let adapter: DatabaseAdapter;
    ({ db, adapter } = sqliteAdapter());
    repository = new TotpCredentialRepository(adapter, 'tenant-a');
    db.prepare(
      `INSERT INTO totp_credentials (id, tenant_id, user_id, secret_encrypted, status, created_at)
       VALUES ('totp-1', 'tenant-a', 'user-1', 'secret', 'pending', 1)`
    ).run();
    db.prepare(
      `INSERT INTO totp_backup_codes
         (id, tenant_id, user_id, credential_id, code_hash, code_prefix, created_at)
       VALUES ('code-1', 'tenant-a', 'user-1', 'totp-1', 'hash', 'pre', 1)`
    ).run();
  });

  it('removes the credential and its backup codes together', async () => {
    await expect(repository.delete('totp-1', 'user-1')).resolves.toBe(true);
    expect(count('totp_credentials')).toBe(0);
    expect(count('totp_backup_codes')).toBe(0);
  });

  it('removes nothing when the credential is no longer in the expected status', async () => {
    db.prepare(`UPDATE totp_credentials SET status = 'active' WHERE id = 'totp-1'`).run();

    await expect(repository.delete('totp-1', 'user-1', 'pending')).resolves.toBe(false);
    expect(count('totp_credentials')).toBe(1);
    expect(count('totp_backup_codes')).toBe(1);
  });

  it('removes with the expected status', async () => {
    await expect(repository.delete('totp-1', 'user-1', 'pending')).resolves.toBe(true);
    expect(count('totp_credentials')).toBe(0);
    expect(count('totp_backup_codes')).toBe(0);
  });

  it("does not touch another user's rows", async () => {
    await expect(repository.delete('totp-1', 'user-2')).resolves.toBe(false);
    expect(count('totp_credentials')).toBe(1);
    expect(count('totp_backup_codes')).toBe(1);
  });
});
