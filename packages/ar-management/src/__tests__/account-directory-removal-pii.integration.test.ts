// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import type {
  DatabaseAdapter,
  ExecuteResult,
  HealthStatus,
  PreparedStatement,
  QueryOptions,
  TransactionContext,
} from '@authrim/ar-lib-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eraseAccountPiiAfterDirectoryRemovalPrepared } from '../account-directory-removal-producer';

type SqliteValue = string | number | bigint | null | Uint8Array;

function values(input: readonly unknown[] = []): SqliteValue[] {
  return input.map((value) => {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    throw new TypeError('unsupported SQLite value');
  });
}

class SqliteAdapter implements DatabaseAdapter {
  constructor(private readonly database: DatabaseSync) {}

  async query<T>(sql: string, params?: unknown[], _options?: QueryOptions): Promise<T[]> {
    return this.database.prepare(sql).all(...values(params)) as T[];
  }

  async queryOne<T>(sql: string, params?: unknown[], _options?: QueryOptions): Promise<T | null> {
    return (this.database.prepare(sql).get(...values(params)) as T | undefined) ?? null;
  }

  async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
    const result = this.database.prepare(sql).run(...values(params));
    return { success: true, rowsAffected: Number(result.changes) };
  }

  async transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn({
        query: (sql, params) => this.query(sql, params),
        queryOne: (sql, params) => this.queryOne(sql, params),
        execute: (sql, params) => this.execute(sql, params),
      });
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async batch(statements: PreparedStatement[]): Promise<ExecuteResult[]> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(({ sql, params }) => {
        const result = this.database.prepare(sql).run(...values(params));
        return { success: true, rowsAffected: Number(result.changes) };
      });
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async isHealthy(): Promise<HealthStatus> {
    return { healthy: true, latencyMs: 0, type: 'sqlite-test' };
  }

  getType(): string {
    return 'sqlite-test';
  }

  async close(): Promise<void> {}
}

describe('account directory removal PII erasure', () => {
  let database: DatabaseSync;
  let adapter: SqliteAdapter;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(`
      CREATE TABLE identity_identifier_replacement_operations (
        operation_id TEXT PRIMARY KEY, tenant_id TEXT, account_id TEXT, state TEXT,
        error_code TEXT, lease_owner TEXT, lease_expires_at INTEGER,
        next_attempt_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE identity_identifier_replacement_outbox (
        id TEXT PRIMARY KEY, tenant_id TEXT, account_id TEXT, status TEXT,
        error_code TEXT, lease_owner TEXT, lease_expires_at INTEGER,
        next_attempt_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE identity_identifier_replacement_history (
        id TEXT PRIMARY KEY, operation_id TEXT, old_value_json TEXT, new_value_json TEXT,
        raw_values_erased_at INTEGER
      );
      CREATE TABLE identity_identifier_replacement_challenges (
        id TEXT PRIMARY KEY, tenant_id TEXT, account_id TEXT, normalized_value_json TEXT,
        raw_value_erased_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE external_identifier_unlink_operations (
        id TEXT PRIMARY KEY, tenant_id TEXT, account_id TEXT, state TEXT,
        issuer_json TEXT, subject_json TEXT, raw_values_erased_at INTEGER,
        error_code TEXT, lease_owner TEXT, lease_expires_at INTEGER,
        next_attempt_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE identity_sensitive_values (
        id TEXT PRIMARY KEY, tenant_id TEXT, owner_type TEXT, owner_id TEXT,
        value_json TEXT, lifecycle_state TEXT, updated_at INTEGER
      );
      CREATE TABLE linked_identities (
        id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT
      );
      CREATE TABLE users_pii (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL
      );
      CREATE TABLE pairwise_subject_identifiers (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL
      );
      CREATE TABLE subject_identifiers (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, subject_id TEXT NOT NULL
      );
      INSERT INTO users_pii (id, tenant_id) VALUES
        ('user-a', 'tenant-a'),
        ('user-b', 'tenant-b');
      INSERT INTO pairwise_subject_identifiers (id, tenant_id, user_id) VALUES
        ('pairwise-a', 'tenant-a', 'user-a'),
        ('pairwise-b', 'tenant-b', 'user-b');
      INSERT INTO subject_identifiers (id, tenant_id, subject_id) VALUES
        ('subject-a', 'tenant-a', 'user-a'),
        ('subject-b', 'tenant-b', 'user-b');
    `);
    adapter = new SqliteAdapter(database);
  });

  afterEach(() => database.close());

  it('deletes both identifier models only for the requested tenant and user', async () => {
    await eraseAccountPiiAfterDirectoryRemovalPrepared(
      adapter,
      { tenantId: 'tenant-a', userId: 'user-a' },
      100
    );
    expect(database.prepare('SELECT id FROM subject_identifiers ORDER BY id').all()).toEqual([
      { id: 'subject-b' },
    ]);
    expect(
      database.prepare('SELECT id FROM pairwise_subject_identifiers ORDER BY id').all()
    ).toEqual([{ id: 'pairwise-b' }]);

    await eraseAccountPiiAfterDirectoryRemovalPrepared(
      adapter,
      { tenantId: 'tenant-a', userId: 'user-b' },
      101
    );
    expect(database.prepare('SELECT id FROM subject_identifiers ORDER BY id').all()).toEqual([
      { id: 'subject-b' },
    ]);
    expect(
      database.prepare('SELECT id FROM pairwise_subject_identifiers ORDER BY id').all()
    ).toEqual([{ id: 'pairwise-b' }]);
  });
});
