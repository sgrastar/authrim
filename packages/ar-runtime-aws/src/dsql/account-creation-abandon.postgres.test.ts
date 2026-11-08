/**
 * The creation operation's compare-and-sets on a real PostgreSQL Core (every fresh-install
 * migration applied), as the clean-up of unfinished sign-ups and a resuming request use them: a
 * resume's touch (never past now), the clean-up's giving up only as it read the operation, and
 * the giving up of one blocked for another reason (its null-safe compare).
 *
 * The directory removal itself (insertPreparedUnpublishedAccountRemovals) has no PostgreSQL path
 * to test: the PostgreSQL Core has no routing outbox (directory routing runs on Cloudflare only).
 */
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLookupBlindIndex, type AccountDirectoryPublication } from '@authrim/ar-lib-core';
import { PostgresAdapter } from '../../../ar-lib-core/src/db/adapters/postgres-adapter';
import { renderPortableMigrationSql } from '../../../ar-lib-core/src/migrations/sql-portability';
import { AccountCreationOperationRepository } from '../../../ar-management/src/account-creation-operation';
import { freshInstallMigrationFiles } from '../migrations/fresh-install-files';

const databaseUrl = process.env.AUTHRIM_AWS_TEST_DATABASE_URL;
const coreMigrations = new URL('../../../../migrations/core/postgresql/', import.meta.url);

const TENANT = 'tenant-a';
const USER = 'user-unpublished';
const ACCOUNT = `account:${USER}`;
const KEY = { generation: 1, secret: '0123456789abcdef0123456789abcdef' };
const NOW = 1_800_000_000;

function databaseConnectionString(name: string): string {
  if (!databaseUrl) throw new Error('AUTHRIM_AWS_TEST_DATABASE_URL is required');
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function creation(): Promise<AccountDirectoryPublication> {
  return {
    operationId: 'operation-unpublished',
    tenantId: TENANT,
    accountId: ACCOUNT,
    idempotencyKey: `account-create:${'c'.repeat(64)}`,
    routeProjection: {
      schemaVersion: 1,
      accountRouteGeneration: 1,
      residencyPolicyId: 'policy-a',
      targets: [
        {
          dataRole: 'tenant_core/users',
          residencyPartition: 'default',
          shardId: 'users-1',
          bindingRef: 'TDB_CORE_1',
          requiredBindingRouteGeneration: 1,
        },
        {
          dataRole: 'tenant_pii',
          residencyPartition: 'default',
          shardId: 'pii-1',
          bindingRef: 'TDB_PII_1',
          requiredBindingRouteGeneration: 1,
        },
      ],
    },
    indexes: [
      await createLookupBlindIndex('account_id', ACCOUNT, KEY),
      await createLookupBlindIndex('email_exact', 'person@example.com', KEY),
    ],
  };
}

(databaseUrl ? describe : describe.skip)("an unfinished creation's operation on PostgreSQL", () => {
  const databaseName = `aws_unpublished_${randomUUID().replaceAll('-', '')}`;
  let admin: Client;
  let pool: Pool;
  let adapter: PostgresAdapter;

  beforeAll(async () => {
    admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const core = new Client({ connectionString: databaseConnectionString(databaseName) });
    await core.connect();
    try {
      for (const filename of freshInstallMigrationFiles(await readdir(coreMigrations))) {
        // The baseline leaves search_path empty; the migration executor restores it before every
        // later delta, as here.
        await core.query('SET search_path TO public');
        const sql = await readFile(new URL(filename, coreMigrations), 'utf8');
        await core.query(renderPortableMigrationSql(sql, 'postgres'));
      }
    } finally {
      await core.end();
    }
    pool = new Pool({
      connectionString: databaseConnectionString(databaseName),
      max: 4,
      options: '-c search_path=public',
    });
    adapter = new PostgresAdapter({
      connectionString: databaseConnectionString(databaseName),
      clientFactory: () => pool,
    });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await admin.end();
    }
  });

  /** Written, never published: the account pending, its operation idle for 4 hours. */
  async function unpublished(
    options: { operation?: { status: string; error: string | null } } = {}
  ) {
    for (const table of ['account_creation_operations', 'identity_accounts', 'tenants']) {
      await pool.query(`DELETE FROM ${table}`);
    }
    await pool.query(
      `INSERT INTO tenants (id, tenant_code, tenant_key, name, is_default, created_at, updated_at)
         VALUES ($1, $1, $1, $1, FALSE, 1, 1)`,
      [TENANT]
    );
    await pool.query(
      `INSERT INTO identity_accounts (id, tenant_id, account_type, lifecycle_state, legacy_user_id,
         created_at, updated_at, directory_publication_state, registration_state)
       VALUES ($1, $2, 'user', 'active', $3, 1, 1, 'pending', 'registered')`,
      [ACCOUNT, TENANT, USER]
    );
    const operation = options.operation ?? { status: 'preparing', error: null };
    await pool.query(
      `INSERT INTO account_creation_operations (operation_id, tenant_id, actor_id,
         idempotency_key, allocation_idempotency_key, request_hash, user_id, account_id, status,
         publication_json, created_at, updated_at)
       VALUES ('operation-unpublished', $1, 'auth:email_code', $2, $3, $4, $5, $6, 'preparing',
         $7, 1, 1)`,
      [
        TENANT,
        `auth-account:${'a'.repeat(64)}`,
        `account-create:${'c'.repeat(64)}`,
        'b'.repeat(64),
        USER,
        ACCOUNT,
        JSON.stringify(await creation()),
      ]
    );
    // Through the status machine (its trigger admits only real transitions).
    const path: Record<string, string[]> = {
      preparing: [],
      reserved: ['reserved'],
      writing: ['reserved', 'writing'],
      directory_pending: ['reserved', 'writing', 'directory_pending'],
      blocked: ['reserved', 'writing', 'blocked'],
    };
    for (const step of path[operation.status]) {
      await pool.query(
        `UPDATE account_creation_operations SET status = $1, last_error_code = $2
          WHERE operation_id = 'operation-unpublished'`,
        [step, step === 'blocked' ? operation.error : null]
      );
    }
    await pool.query(
      `UPDATE account_creation_operations SET updated_at = $1
        WHERE operation_id = 'operation-unpublished'`,
      [NOW - 4 * 3600]
    );
  }

  /** The account's creation operation, as the clean-up reads it. */
  async function read(repository: AccountCreationOperationRepository) {
    const found = await repository.findByAccountId({ tenantId: TENANT, accountId: ACCOUNT });
    if (!found) throw new Error('operation_missing');
    return found;
  }

  const one = async <T>(sql: string, values: unknown[] = []) =>
    (await pool.query(sql, values)).rows[0] as T;

  describe("the creation operation's compare-and-sets", () => {
    it('touches a resumed operation to now, never later, however often', async () => {
      await unpublished({ operation: { status: 'directory_pending', error: null } });
      const repository = new AccountCreationOperationRepository(adapter);
      for (let i = 0; i < 3; i++) {
        const found = await read(repository);
        await repository.touch(found.operation, NOW);
      }

      expect(
        await one(
          `SELECT updated_at::bigint AS updated_at FROM account_creation_operations
            WHERE account_id = $1`,
          [ACCOUNT]
        )
      ).toEqual({ updated_at: String(NOW) });
    });

    it('gives up an idle operation only as it was read', async () => {
      await unpublished({ operation: { status: 'directory_pending', error: null } });
      const repository = new AccountCreationOperationRepository(adapter);
      const found = await read(repository);

      // A resume moved it after the read: kept.
      await repository.touch(found.operation, NOW);
      await expect(repository.abandon({ ...found, now: NOW })).resolves.toBe(false);
      // Read again: given up, and a resume from then on is refused.
      const again = await read(repository);
      await expect(repository.abandon({ ...again, now: NOW })).resolves.toBe(true);
      await expect(repository.touch(again.operation, NOW)).rejects.toThrow(
        'account_creation_operation_blocked'
      );
    });

    it.each([['directory_routing_retry_budget_exhausted'], [null]])(
      'finalises one blocked for another reason (%s; the null-safe compare)',
      async (error) => {
        await unpublished({ operation: { status: 'blocked', error } });
        const repository = new AccountCreationOperationRepository(adapter);
        const found = await read(repository);

        await expect(repository.abandon({ ...found, now: NOW })).resolves.toBe(true);
        expect(
          await one(
            'SELECT status, last_error_code FROM account_creation_operations WHERE account_id = $1',
            [ACCOUNT]
          )
        ).toEqual({ status: 'blocked', last_error_code: 'registration_abandoned' });
      }
    );
  });
});
