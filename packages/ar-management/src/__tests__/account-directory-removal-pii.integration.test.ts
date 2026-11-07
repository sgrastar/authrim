import { readMigrationSource } from '../../../../test/helpers/migration-source.mjs';
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
import {
  AccountDeletionHeldError,
  eraseAccountPiiAfterDirectoryRemovalPrepared,
  fenceAccountDeletion,
  hasUnfinishedAccountDeletion,
} from '../account-directory-removal-producer';

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
    database.exec(
      readMigrationSource(
        new URL('../../../../migrations/pii/d1/', import.meta.url),
        '002_guest_upgrade_operations.sql'
      )
    );
    database.exec(
      readMigrationSource(
        new URL('../../../../migrations/pii/d1/', import.meta.url),
        '004_account_webhook_snapshots.sql'
      ) +
        readMigrationSource(
          new URL('../../../../migrations/pii/d1/', import.meta.url),
          '003_screen_responses.sql'
        )
    );
    database.exec(`
      CREATE TABLE identity_accounts (id TEXT, tenant_id TEXT, legacy_user_id TEXT,
        account_type TEXT, registration_state TEXT, lifecycle_state TEXT,
        directory_publication_state TEXT);
      INSERT INTO identity_accounts VALUES ('account:user-a', 'tenant-a', 'user-a',
        'user', 'registered', 'active', 'active');
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
        value_key TEXT, value_json TEXT, lifecycle_state TEXT, updated_at INTEGER
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
      CREATE TABLE user_anonymization_map (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
        anonymized_user_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE(tenant_id, user_id)
      );
      INSERT INTO user_anonymization_map (id, tenant_id, user_id, anonymized_user_id, created_at)
      VALUES ('map-a', 'tenant-a', 'user-a', 'anon-a', 1),
             ('map-b', 'tenant-b', 'user-b', 'anon-b', 1),
             ('map-a-other-tenant', 'tenant-b', 'user-a', 'anon-a2', 1);
      INSERT INTO users_pii (id, tenant_id) VALUES
        ('user-a', 'tenant-a'),
        ('user-b', 'tenant-b');
      INSERT INTO pairwise_subject_identifiers (id, tenant_id, user_id) VALUES
        ('pairwise-a', 'tenant-a', 'user-a'),
        ('pairwise-b', 'tenant-b', 'user-b');
      INSERT INTO subject_identifiers (id, tenant_id, subject_id) VALUES
        ('subject-a', 'tenant-a', 'user-a'),
        ('subject-b', 'tenant-b', 'user-b');
      INSERT INTO screen_responses
        (id, tenant_id, user_id, screen_id, screen_key, answers_json, created_at, updated_at)
      VALUES ('response-a', 'tenant-a', 'user-a', 'screen-1', 'survey', '{"plan":"pro"}', 1, 1),
             ('response-a-other-tenant', 'tenant-b', 'user-a', 'screen-1', 'survey', '{}', 1, 1),
             ('response-b', 'tenant-b', 'user-b', 'screen-1', 'survey', '{}', 1, 1);
    `);
    database.exec(`INSERT INTO identity_sensitive_values
      (id,tenant_id,owner_type,owner_id,value_key,value_json,lifecycle_state,updated_at)
      VALUES ('email-a','tenant-a','runtime_user','user-a','email','"before@example.com"','active',1)`);
    adapter = new SqliteAdapter(database);
  });

  afterEach(() => database.close());

  it('does not erase PII if its deletion snapshot cannot be persisted', async () => {
    database.exec('DROP TABLE account_webhook_snapshots');
    await expect(
      eraseAccountPiiAfterDirectoryRemovalPrepared(
        adapter,
        { tenantId: 'tenant-a', userId: 'user-a', core: adapter },
        100
      )
    ).rejects.toThrow();
    expect(database.prepare('SELECT value_json FROM identity_sensitive_values').get()).toEqual({
      value_json: '"before@example.com"',
    });
  });

  it('deletes both identifier models only for the requested tenant and user', async () => {
    await eraseAccountPiiAfterDirectoryRemovalPrepared(
      adapter,
      { tenantId: 'tenant-a', userId: 'user-a', core: adapter },
      100
    );
    expect(
      database.prepare('SELECT email_before_json FROM account_webhook_snapshots').get()
    ).toEqual({
      email_before_json: '"before@example.com"',
    });
    expect(database.prepare('SELECT value_json FROM identity_sensitive_values').get()).toEqual({
      value_json: null,
    });
    expect(database.prepare('SELECT id FROM subject_identifiers ORDER BY id').all()).toEqual([
      { id: 'subject-b' },
    ]);
    expect(
      database.prepare('SELECT id FROM pairwise_subject_identifiers ORDER BY id').all()
    ).toEqual([{ id: 'pairwise-b' }]);
    // The audit pseudonym: the unified event log's records of the user no longer lead to it.
    expect(database.prepare('SELECT id FROM user_anonymization_map ORDER BY id').all()).toEqual([
      { id: 'map-a-other-tenant' },
      { id: 'map-b' },
    ]);
    // What the person answered to login screens goes with them.
    expect(await adapter.query('SELECT id FROM screen_responses ORDER BY id')).toEqual([
      { id: 'response-a-other-tenant' },
      { id: 'response-b' },
    ]);

    await eraseAccountPiiAfterDirectoryRemovalPrepared(
      adapter,
      { tenantId: 'tenant-a', userId: 'user-b', core: adapter },
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

/** What the fence tests use of node:sqlite (whose types this package does not load). */
interface FenceDatabase {
  exec(sql: string): void;
  prepare(sql: string): { get(...params: unknown[]): unknown };
  close(): void;
}

function openFenceDatabase(): FenceDatabase {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- node:sqlite is untyped here
  return new DatabaseSync(':memory:');
}

/** The governance writes run only on D1 or PostgreSQL; SQLite here is D1's engine. */
class D1LikeAdapter extends SqliteAdapter {
  getType(): string {
    return 'd1';
  }
}

describe('account deletion fence', () => {
  let database: FenceDatabase;
  let adapter: D1LikeAdapter;

  beforeEach(() => {
    database = openFenceDatabase();
    database.exec(`
      CREATE TABLE identity_accounts (id TEXT PRIMARY KEY, tenant_id TEXT, legacy_user_id TEXT,
        account_type TEXT, registration_state TEXT, lifecycle_state TEXT,
        directory_publication_state TEXT, updated_at INTEGER, deleted_at INTEGER);
      CREATE TABLE account_legal_hold_states (tenant_id TEXT, account_id TEXT,
        projection_state TEXT, active_hold_id TEXT, updated_at INTEGER);
      CREATE TABLE legal_holds (id TEXT PRIMARY KEY, tenant_id TEXT, subject_id TEXT,
        subject_type TEXT, state TEXT);
      CREATE TABLE account_routing_outbox (outbox_id TEXT PRIMARY KEY, tenant_id TEXT,
        account_id TEXT, event_kind TEXT, status TEXT);
      INSERT INTO identity_accounts VALUES ('account:user-a', 'tenant-a', 'user-a', 'user',
        'registered', 'active', 'active', 1, NULL);
      INSERT INTO account_legal_hold_states VALUES ('tenant-a', 'account:user-a', 'inactive',
        NULL, 1);
    `);
    adapter = new D1LikeAdapter(database);
  });

  afterEach(() => database.close());

  const lifecycle = () =>
    (
      database
        .prepare("SELECT lifecycle_state FROM identity_accounts WHERE id = 'account:user-a'")
        .get() as { lifecycle_state: string }
    ).lifecycle_state;

  it('moves the account to deleting before anything is erased, and again on a retry', async () => {
    await fenceAccountDeletion(adapter, { tenantId: 'tenant-a', userId: 'user-a' });
    expect(lifecycle()).toBe('deleting');
    await fenceAccountDeletion(adapter, { tenantId: 'tenant-a', userId: 'user-a' });
    expect(lifecycle()).toBe('deleting');
  });

  it('stops at a hold placed after the deletion checked for one', async () => {
    database.exec(`INSERT INTO legal_holds VALUES ('hold-1', 'tenant-a', 'account:user-a',
      'account', 'active')`);
    await expect(
      fenceAccountDeletion(adapter, { tenantId: 'tenant-a', userId: 'user-a' })
    ).rejects.toBeInstanceOf(AccountDeletionHeldError);
    expect(lifecycle()).toBe('active');
  });

  it('has nothing to fence for a deleted account or one that is not there', async () => {
    database.exec("UPDATE identity_accounts SET lifecycle_state = 'deleted'");
    await fenceAccountDeletion(adapter, { tenantId: 'tenant-a', userId: 'user-a' });
    expect(lifecycle()).toBe('deleted');
    await fenceAccountDeletion(adapter, { tenantId: 'tenant-a', userId: 'user-missing' });
  });

  it('tells a deletion that stopped before its directory removal became pending', async () => {
    const unfinished = () =>
      hasUnfinishedAccountDeletion(adapter, { tenantId: 'tenant-a', userId: 'user-a' });
    await expect(unfinished()).resolves.toBe(false);
    database.exec(`INSERT INTO account_routing_outbox VALUES ('o-1', 'tenant-a',
      'account:user-a', 'account_deleted', 'prepared')`);
    await expect(unfinished()).resolves.toBe(true);
    await expect(
      hasUnfinishedAccountDeletion(adapter, { tenantId: 'tenant-b', userId: 'user-a' })
    ).resolves.toBe(false);
    database.exec("UPDATE account_routing_outbox SET status = 'pending'");
    await expect(unfinished()).resolves.toBe(false);
  });
});
