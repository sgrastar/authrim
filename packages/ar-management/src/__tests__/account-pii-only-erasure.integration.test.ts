import { readMigrationSource } from '../../../../test/helpers/migration-source.mjs';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import type {
  DatabaseAdapter,
  ExecuteResult,
  HealthStatus,
  PreparedStatement,
  TransactionContext,
} from '@authrim/ar-lib-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  eraseRetainedAccountPii,
  findPiiOnlyErasureBlocker,
  redactEarlierWebhookEmailSnapshots,
} from '../account-pii-only-erasure';

/** What these tests use of node:sqlite (whose types this package does not load). */
interface TestDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number | bigint };
  };
  close(): void;
}

function openDatabase(): TestDatabase {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- node:sqlite is untyped here
  return new DatabaseSync(':memory:');
}

class SqliteAdapter implements DatabaseAdapter {
  constructor(private readonly database: TestDatabase) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.database.prepare(sql).all(...params) as T[];
  }

  async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    return (this.database.prepare(sql).get(...params) as T | undefined) ?? null;
  }

  async execute(sql: string, params: unknown[] = []): Promise<ExecuteResult> {
    const result = this.database.prepare(sql).run(...params);
    return { success: true, rowsAffected: Number(result.changes) };
  }

  async transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return fn({
      query: (sql, params) => this.query(sql, params),
      queryOne: (sql, params) => this.queryOne(sql, params),
      execute: (sql, params) => this.execute(sql, params),
    });
  }

  async batch(statements: PreparedStatement[]): Promise<ExecuteResult[]> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(({ sql, params }) => {
        const result = this.database.prepare(sql).run(...(params ?? []));
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

const PII_MIGRATIONS = new URL('../../../../migrations/pii/d1/', import.meta.url);
const NOW = 1_800_000_000_000;
const NOW_SECONDS = 1_800_000_000;
const ACCOUNT = { tenantId: 'tenant-a', userId: 'user-a' };

describe('PII-only deletion erasure', () => {
  let pii: TestDatabase;
  let core: TestDatabase;

  beforeEach(() => {
    pii = openDatabase();
    pii.exec(
      readMigrationSource(PII_MIGRATIONS, '004_account_webhook_snapshots.sql') +
        readMigrationSource(PII_MIGRATIONS, '003_screen_responses.sql')
    );
    pii.exec(`
      CREATE TABLE identity_sensitive_values (
        id TEXT PRIMARY KEY, tenant_id TEXT, owner_type TEXT, owner_id TEXT,
        value_key TEXT, value_json TEXT, value_hash TEXT, lifecycle_state TEXT, updated_at INTEGER
      );
      CREATE TABLE linked_identities (
        id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, provider_id TEXT,
        provider_user_id TEXT, provider_email TEXT, provider_name TEXT, raw_attributes TEXT,
        raw_claims TEXT, profile_data TEXT, access_token_encrypted TEXT, updated_at INTEGER,
        provisioning_state TEXT NOT NULL DEFAULT 'active'
      );
      CREATE TABLE identity_identifier_replacement_operations (
        operation_id TEXT PRIMARY KEY, tenant_id TEXT, account_id TEXT, state TEXT
      );
      CREATE TABLE identity_identifier_replacement_history (
        operation_id TEXT PRIMARY KEY, old_value_json TEXT, new_value_json TEXT,
        raw_values_erased_at INTEGER
      );
      CREATE TABLE external_identifier_unlink_operations (
        operation_id TEXT PRIMARY KEY, tenant_id TEXT, account_id TEXT, user_id TEXT,
        issuer_json TEXT, subject_json TEXT, state TEXT, raw_values_erased_at INTEGER,
        updated_at INTEGER
      );
      CREATE TABLE guest_upgrade_operations (
        operation_id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, state TEXT,
        proof_payload_json TEXT, reservation_publication_json TEXT, challenge_verifier TEXT,
        updated_at INTEGER
      );
      CREATE TABLE identity_identifier_replacement_challenges (
        challenge_id TEXT PRIMARY KEY, tenant_id TEXT, account_id TEXT,
        normalized_value_json TEXT, raw_value_erased_at INTEGER, attempt_count INTEGER,
        attempt_limit INTEGER, consumed_at INTEGER, updated_at INTEGER
      );
      INSERT INTO identity_sensitive_values VALUES
        ('v-email', 'tenant-a', 'runtime_user', 'user-a', 'email', '"a@example.com"', 'h', 'deleted', 1),
        ('v-name', 'tenant-a', 'runtime_user', 'user-a', 'name', '"Ann"', NULL, 'deleted', 1),
        ('v-again', 'tenant-a', 'runtime_user', 'user-a', 'nickname', '"new"', NULL, 'active', 1),
        ('v-field', 'tenant-a', 'runtime_user', 'user-a', 'custom_attribute:passport', '"P123"', NULL, 'active', 1),
        ('v-other', 'tenant-a', 'runtime_user', 'user-b', 'email', '"b@example.com"', NULL, 'deleted', 1),
        ('v-tenant', 'tenant-b', 'runtime_user', 'user-a', 'email', '"t@example.com"', NULL, 'deleted', 1);
      INSERT INTO linked_identities
        (id, tenant_id, user_id, provider_id, provider_user_id, provider_email, provider_name,
         raw_attributes, raw_claims, profile_data, access_token_encrypted, updated_at)
      VALUES
        ('li-a', 'tenant-a', 'user-a', 'google', 'sub-a', 'a@gmail.com', 'Ann', '{"x":1}',
         '{"email":"a@gmail.com"}', '{"name":"Ann"}', 'enc-token', 1),
        ('li-b', 'tenant-a', 'user-b', 'google', 'sub-b', 'b@gmail.com', 'Bob', NULL, NULL, NULL, NULL, 1);
      INSERT INTO identity_identifier_replacement_operations VALUES
        -- Self-service and SCIM name the account by its user id; others by its account id.
        ('op-done', 'tenant-a', 'user-a', 'completed'),
        ('op-prefixed', 'tenant-a', 'account:user-a', 'canceled'),
        ('op-other', 'tenant-a', 'user-b', 'completed');
      INSERT INTO identity_identifier_replacement_history VALUES
        ('op-done', '"old@example.com"', '"a@example.com"', NULL),
        ('op-prefixed', '"x@example.com"', '"y@example.com"', NULL),
        ('op-other', '"b0@example.com"', '"b@example.com"', NULL);
      INSERT INTO identity_identifier_replacement_challenges VALUES
        ('ch-open', 'tenant-a', 'user-a', '"next@example.com"', NULL, 1, 5, NULL, 1),
        ('ch-used', 'tenant-a', 'user-a', '"a@example.com"', NULL, 1, 5, 10, 1),
        ('ch-other', 'tenant-a', 'user-b', '"b@example.com"', NULL, 0, 5, NULL, 1);
      INSERT INTO external_identifier_unlink_operations VALUES
        ('un-blocked', 'tenant-a', 'account:user-a', 'user-a', '"github"', '"a@users.example"',
         'blocked', NULL, 1),
        ('un-other', 'tenant-a', 'account:user-b', 'user-b', '"github"', '"b@users.example"',
         'blocked', NULL, 1);
      INSERT INTO guest_upgrade_operations VALUES
        ('gu-done', 'tenant-a', 'user-a', 'completed', '{"email":"a@example.com"}', '{}', 'v', 1),
        ('gu-other', 'tenant-a', 'user-b', 'completed', '{"email":"b@example.com"}', '{}', 'v', 1);
      INSERT INTO account_webhook_snapshots
        (id, tenant_id, user_id, account_id, event_type, registration_state,
         email_before_json, email_after_json, created_at, expires_at)
      VALUES
        ('evt-a', 'tenant-a', 'user-a', 'account:user-a', 'account.email.changed', 'registered',
         '"old@example.com"', '"a@example.com"', 1, 9999999999999),
        ('evt-removed', 'tenant-a', 'user-a', 'account:user-a', 'account.email.changed',
         'registered', '"a@example.com"', 'null', 2, 9999999999999),
        ('evt-b', 'tenant-a', 'user-b', 'account:user-b', 'account.email.changed', 'registered',
         '"b0@example.com"', '"b@example.com"', 1, 9999999999999);
      INSERT INTO screen_responses
        (id, tenant_id, user_id, screen_id, screen_key, answers_json, created_at, updated_at)
      VALUES
        ('r-a', 'tenant-a', 'user-a', 's', 'k', '{}', 1, 1),
        ('r-b', 'tenant-a', 'user-b', 's', 'k', '{}', 1, 1);
    `);
    core = openDatabase();
    core.exec(`
      CREATE TABLE user_custom_fields (tenant_id TEXT, user_id TEXT, field_key TEXT, value TEXT);
      INSERT INTO user_custom_fields VALUES
        ('tenant-a', 'user-a', 'department', 'Sales'),
        ('tenant-a', 'user-b', 'department', 'Legal');
    `);
  });

  afterEach(() => {
    pii.close();
    core.close();
  });

  it('erases what the account kept, for this account only', async () => {
    await eraseRetainedAccountPii(new SqliteAdapter(pii), new SqliteAdapter(core), ACCOUNT, NOW);

    expect(
      pii
        .prepare(
          'SELECT id, value_json, lifecycle_state FROM identity_sensitive_values ORDER BY id'
        )
        .all()
    ).toEqual([
      // A value entered again since (active) is the person's own and stays.
      { id: 'v-again', value_json: '"new"', lifecycle_state: 'active' },
      { id: 'v-email', value_json: null, lifecycle_state: 'deleted' },
      // A per-field PII custom attribute: erased and no longer read (readers take active rows).
      { id: 'v-field', value_json: null, lifecycle_state: 'deleted' },
      { id: 'v-name', value_json: null, lifecycle_state: 'deleted' },
      // Another user's, and the same user id in another tenant, are untouched.
      { id: 'v-other', value_json: '"b@example.com"', lifecycle_state: 'deleted' },
      { id: 'v-tenant', value_json: '"t@example.com"', lifecycle_state: 'deleted' },
    ]);
    expect(pii.prepare("SELECT * FROM linked_identities WHERE id = 'li-a'").get()).toEqual({
      id: 'li-a',
      tenant_id: 'tenant-a',
      user_id: 'user-a',
      // The sign-in identifiers stay.
      provider_id: 'google',
      provider_user_id: 'sub-a',
      provider_email: null,
      provider_name: null,
      raw_attributes: null,
      raw_claims: null,
      profile_data: null,
      access_token_encrypted: 'enc-token',
      updated_at: NOW,
      provisioning_state: 'active',
    });
    expect(
      pii.prepare("SELECT provider_email FROM linked_identities WHERE id = 'li-b'").get()
    ).toEqual({ provider_email: 'b@gmail.com' });
    expect(
      pii
        .prepare('SELECT * FROM identity_identifier_replacement_history ORDER BY operation_id')
        .all()
    ).toEqual([
      {
        operation_id: 'op-done',
        old_value_json: null,
        new_value_json: null,
        raw_values_erased_at: NOW_SECONDS,
      },
      {
        operation_id: 'op-other',
        old_value_json: '"b0@example.com"',
        new_value_json: '"b@example.com"',
        raw_values_erased_at: null,
      },
      {
        operation_id: 'op-prefixed',
        old_value_json: null,
        new_value_json: null,
        raw_values_erased_at: NOW_SECONDS,
      },
    ]);
    expect(
      pii
        .prepare(
          'SELECT operation_id, subject_json, raw_values_erased_at FROM external_identifier_unlink_operations ORDER BY operation_id'
        )
        .all()
    ).toEqual([
      // A stopped unlinking's identifier (no longer a sign-in identifier) is erased.
      { operation_id: 'un-blocked', subject_json: null, raw_values_erased_at: NOW_SECONDS },
      { operation_id: 'un-other', subject_json: '"b@users.example"', raw_values_erased_at: null },
    ]);
    expect(
      pii
        .prepare(
          'SELECT operation_id, proof_payload_json, challenge_verifier FROM guest_upgrade_operations ORDER BY operation_id'
        )
        .all()
    ).toEqual([
      { operation_id: 'gu-done', proof_payload_json: null, challenge_verifier: null },
      {
        operation_id: 'gu-other',
        proof_payload_json: '{"email":"b@example.com"}',
        challenge_verifier: 'v',
      },
    ]);
    expect(
      pii
        .prepare(
          `SELECT challenge_id, normalized_value_json, raw_value_erased_at, attempt_count
             FROM identity_identifier_replacement_challenges ORDER BY challenge_id`
        )
        .all()
    ).toEqual([
      // An unused challenge is used up: its code is answered as invalid.
      {
        challenge_id: 'ch-open',
        normalized_value_json: 'null',
        raw_value_erased_at: NOW_SECONDS,
        attempt_count: 5,
      },
      {
        challenge_id: 'ch-other',
        normalized_value_json: '"b@example.com"',
        raw_value_erased_at: null,
        attempt_count: 0,
      },
      {
        challenge_id: 'ch-used',
        normalized_value_json: 'null',
        raw_value_erased_at: NOW_SECONDS,
        attempt_count: 1,
      },
    ]);
    expect(pii.prepare('SELECT id FROM screen_responses').all()).toEqual([{ id: 'r-b' }]);
    expect(core.prepare('SELECT user_id FROM user_custom_fields').all()).toEqual([
      { user_id: 'user-b' },
    ]);
  });

  it("keeps a pending identity provider account creation's plan (the deletion waits for it)", async () => {
    pii.exec(`UPDATE linked_identities SET provisioning_state = 'pending' WHERE id = 'li-a'`);

    expect(await findPiiOnlyErasureBlocker(new SqliteAdapter(pii), ACCOUNT)).toBe(
      'account_provisioning_pending'
    );
    await eraseRetainedAccountPii(new SqliteAdapter(pii), new SqliteAdapter(core), ACCOUNT, NOW);
    expect(
      pii.prepare("SELECT profile_data FROM linked_identities WHERE id = 'li-a'").get()
    ).toEqual({ profile_data: '{"name":"Ann"}' });
  });

  it('waits while an identifier change is in progress', async () => {
    const adapter = new SqliteAdapter(pii);
    expect(await findPiiOnlyErasureBlocker(adapter, ACCOUNT)).toBeNull();
    pii.exec(`INSERT INTO identity_identifier_replacement_operations VALUES
      ('op-open', 'tenant-a', 'user-a', 'directory_pending')`);
    expect(await findPiiOnlyErasureBlocker(adapter, ACCOUNT)).toBe('identifier_change_in_progress');
    // Another account's change does not hold this one.
    expect(
      await findPiiOnlyErasureBlocker(adapter, { tenantId: 'tenant-a', userId: 'user-b' })
    ).toBeNull();
  });

  it('waits while an unlinking or a guest registration is under way', async () => {
    const adapter = new SqliteAdapter(pii);
    pii.exec(`INSERT INTO guest_upgrade_operations VALUES
      ('gu-open', 'tenant-a', 'user-a', 'verified', '{"email":"a@example.com"}', NULL, 'v', 1)`);
    expect(await findPiiOnlyErasureBlocker(adapter, ACCOUNT)).toBe('guest_upgrade_in_progress');
    pii.exec(`INSERT INTO external_identifier_unlink_operations VALUES
      ('un-open', 'tenant-a', 'account:user-a', 'user-a', '"github"', '"a@users.example"',
       'pending', NULL, 1)`);
    expect(await findPiiOnlyErasureBlocker(adapter, ACCOUNT)).toBe('external_unlink_in_progress');
  });

  it("redacts earlier webhook events' addresses, keeping a removal notice to its expiry", async () => {
    await redactEarlierWebhookEmailSnapshots(new SqliteAdapter(pii), ACCOUNT);

    expect(
      pii
        .prepare(
          'SELECT id, email_before_json, email_after_json FROM account_webhook_snapshots ORDER BY id'
        )
        .all()
    ).toEqual([
      // Redacted as JSON null: a delivery still sends the event, without the address.
      { id: 'evt-a', email_before_json: 'null', email_after_json: 'null' },
      { id: 'evt-b', email_before_json: '"b0@example.com"', email_after_json: '"b@example.com"' },
      // The notice that the address was removed (the deletion's own, also when it is retried).
      { id: 'evt-removed', email_before_json: '"a@example.com"', email_after_json: 'null' },
    ]);
  });

  it('can run again (a retried deletion)', async () => {
    await eraseRetainedAccountPii(new SqliteAdapter(pii), new SqliteAdapter(core), ACCOUNT, NOW);
    await expect(
      eraseRetainedAccountPii(new SqliteAdapter(pii), new SqliteAdapter(core), ACCOUNT, NOW + 1000)
    ).resolves.toBeUndefined();
    expect(
      pii
        .prepare(
          "SELECT raw_value_erased_at FROM identity_identifier_replacement_challenges WHERE challenge_id = 'ch-open'"
        )
        .get()
    ).toEqual({ raw_value_erased_at: NOW_SECONDS });
  });
});
