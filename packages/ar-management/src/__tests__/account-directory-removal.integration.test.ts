import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import {
  accountDirectoryRemovalOutboxId,
  createLookupBlindIndex,
  type AccountDirectoryRemovalPublication,
} from '@authrim/ar-lib-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountDirectoryRemovalCoordinator } from '../account-directory-removal';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const KEY = { generation: 1, secret: '0123456789abcdef0123456789abcdef' };

function sqlValues(values: unknown[]): SqlValue[] {
  return values.map((value) => {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      value === null ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    throw new Error('unsupported_sqlite_test_value');
  });
}

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[]
  ) {}

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async run() {
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class UnboundStatement {
  constructor(
    private readonly sql: string,
    private readonly database: DatabaseSync
  ) {}

  bind(...values: unknown[]): BoundStatement {
    return new BoundStatement(this.database.prepare(this.sql), sqlValues(values));
  }
}

class SqliteD1 {
  constructor(private readonly database: DatabaseSync) {}

  private session(constraint: string): D1DatabaseSession {
    if (constraint !== 'first-primary') throw new Error('primary_session_required');
    return {
      prepare: (sql: string) => new UnboundStatement(sql, this.database),
      getBookmark: () => null,
    } as unknown as D1DatabaseSession;
  }

  readonly binding = {
    withSession: (constraint: string) => this.session(constraint),
  } as unknown as D1Database;
}

async function removal(scope: 'account' | 'identifier' = 'account') {
  const accountIndex = await createLookupBlindIndex('account_id', 'account-a', KEY);
  const emailIndex = await createLookupBlindIndex('email_exact', 'person@example.com', KEY);
  const publication: AccountDirectoryRemovalPublication = {
    operationId: `remove-${scope}`,
    tenantId: 'tenant-a',
    accountId: 'account-a',
    idempotencyKey: `remove-${scope}`,
    routeProjection: {
      schemaVersion: 1,
      accountRouteGeneration: 1,
      residencyPolicyId: 'default-policy',
      targets: [
        {
          dataRole: 'tenant_core/users',
          residencyPartition: 'default',
          shardId: 'users-1',
          bindingRef: 'TDB_USERS_1',
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
    scope,
    indexes: scope === 'account' ? [accountIndex, emailIndex] : [emailIndex],
  };
  return { publication, accountIndex, emailIndex };
}

describe('AccountDirectoryRemovalCoordinator', () => {
  let tenantDatabase: DatabaseSync;
  let lookupDatabase: DatabaseSync;
  let tenant: SqliteD1;
  let lookup: SqliteD1;

  beforeEach(() => {
    tenantDatabase = new DatabaseSync(':memory:');
    lookupDatabase = new DatabaseSync(':memory:');
    tenantDatabase.exec(
      `PRAGMA foreign_keys = ON;
       CREATE TABLE identity_accounts (
         id TEXT PRIMARY KEY,
         tenant_id TEXT NOT NULL,
         lifecycle_state TEXT NOT NULL DEFAULT 'active',
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         deleted_at INTEGER
       );
       INSERT INTO identity_accounts (id, tenant_id, lifecycle_state, created_at, updated_at)
       VALUES ('account-a', 'tenant-a', 'active', 1, 1);`
    );
    tenantDatabase.exec(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/032_tenant_directory_and_plugin_outboxes.sql'),
        'utf8'
      )
    );
    lookupDatabase.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/lookup/001_lookup_directory.sql'), 'utf8')
    );
    tenant = new SqliteD1(tenantDatabase);
    lookup = new SqliteD1(lookupDatabase);
  });

  afterEach(() => {
    tenantDatabase.close();
    lookupDatabase.close();
  });

  async function seed(input: Awaited<ReturnType<typeof removal>>, status = 'pending') {
    tenantDatabase
      .prepare(
        `UPDATE identity_accounts SET lifecycle_state = ?, directory_publication_state = ?
          WHERE id = 'account-a'`
      )
      .run(
        input.publication.scope === 'account' ? 'deleting' : 'active',
        input.publication.scope === 'account' ? 'disabled' : 'active'
      );
    tenantDatabase
      .prepare(
        `INSERT INTO account_routing_outbox (
           outbox_id, tenant_id, account_id, event_kind, route_generation,
           route_schema_version, hmac_key_generation, payload_json, status,
           attempt_count, lease_owner, lease_expires_at, created_at, updated_at
         ) VALUES (?, 'tenant-a', 'account-a', ?, 1, 1, 1, ?, ?, 1, ?, ?, 1, 1)`
      )
      .run(
        accountDirectoryRemovalOutboxId(input.publication.operationId),
        input.publication.scope === 'account' ? 'account_deleted' : 'identifier_removed',
        JSON.stringify(input.publication),
        status,
        status === 'leased' ? 'owner-a' : null,
        status === 'leased' ? 200 : null
      );
    for (const index of input.publication.indexes) {
      lookupDatabase
        .prepare(
          `INSERT INTO lookup_identifiers (
             virtual_bucket, index_kind, normalization_version, hmac_key_generation,
             identifier_blind_digest, tenant_id, account_id, route_schema_version,
             account_route_generation, required_binding_route_generation, residency_policy_id,
             route_projection_json, tenant_lifecycle_state, runtime_route_status,
             lifecycle_state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'tenant-a', 'account-a', 1, 1, 1, 'default-policy',
                     ?, 'active', 'active', 'active', 1, 1)`
        )
        .run(
          index.virtualBucket,
          index.indexKind,
          index.normalizationVersion,
          index.hmacKeyGeneration,
          index.digest,
          JSON.stringify(input.publication.routeProjection)
        );
      if (index.indexKind !== 'account_id') {
        lookupDatabase
          .prepare(
            `INSERT INTO lookup_identifier_reservations (
               virtual_bucket, tenant_id, index_kind, normalization_version,
               hmac_key_generation, identifier_blind_digest, account_id,
               reservation_state, operation_id, committed_at, created_at, updated_at
             ) VALUES (?, 'tenant-a', ?, ?, ?, ?, 'account-a', 'committed',
                       'create-a', 1, 1, 1)`
          )
          .run(
            index.virtualBucket,
            index.indexKind,
            index.normalizationVersion,
            index.hmacKeyGeneration,
            index.digest
          );
      }
    }
  }

  function coordinator() {
    return new AccountDirectoryRemovalCoordinator({
      tenantCore: tenant.binding,
      lookupForBucket: async () => lookup.binding,
      now: () => 100,
    });
  }

  it('disables every account index, releases reservations, and completes the outbox', async () => {
    const input = await removal();
    await seed(input);

    await expect(coordinator().remove(input.publication)).resolves.toMatchObject({ status: 201 });
    expect(
      lookupDatabase
        .prepare(`SELECT DISTINCT lifecycle_state, runtime_route_status FROM lookup_identifiers`)
        .all()
    ).toEqual([{ lifecycle_state: 'disabled', runtime_route_status: 'disabled' }]);
    expect(
      lookupDatabase.prepare(`SELECT reservation_state FROM lookup_identifier_reservations`).get()
    ).toEqual({ reservation_state: 'released' });
    expect(tenantDatabase.prepare(`SELECT status FROM account_routing_outbox`).get()).toEqual({
      status: 'succeeded',
    });
  });

  it('supports exact identifier unlink while the account remains active', async () => {
    const input = await removal('identifier');
    await seed(input);

    await expect(coordinator().remove(input.publication)).resolves.toMatchObject({ status: 201 });
    expect(tenantDatabase.prepare(`SELECT lifecycle_state FROM identity_accounts`).get()).toEqual({
      lifecycle_state: 'active',
    });
  });

  it('rejects a stale scheduled claim before changing Lookup state', async () => {
    const input = await removal();
    await seed(input, 'leased');

    await expect(
      coordinator().remove(input.publication, { ownerId: 'stale-owner', fencingToken: 1 })
    ).rejects.toThrow('directory_removal_outbox_stale_lease');
    expect(
      lookupDatabase.prepare(`SELECT DISTINCT lifecycle_state FROM lookup_identifiers`).all()
    ).toEqual([{ lifecycle_state: 'active' }]);
  });
});
