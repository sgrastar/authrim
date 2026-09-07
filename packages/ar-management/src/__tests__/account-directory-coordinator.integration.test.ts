import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import { createLookupBlindIndex, type AccountDirectoryPublication } from '@authrim/ar-lib-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountDirectoryCoordinator } from '../account-directory-coordinator';
import { InitialAccountIdentifierReservationService } from '../account-directory-reservation';

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
    readonly sql: string,
    private readonly statement: StatementSync,
    private readonly values: SqlValue[],
    private readonly beforeRun: (sql: string) => void
  ) {}

  bind(): BoundStatement {
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async all<T>() {
    return { success: true, results: this.statement.all(...this.values) as T[], meta: {} };
  }

  async run() {
    this.beforeRun(this.sql);
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }

  executeRun() {
    this.beforeRun(this.sql);
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class UnboundStatement {
  constructor(
    private readonly sql: string,
    private readonly database: DatabaseSync,
    private readonly beforeRun: (sql: string) => void
  ) {}

  bind(...values: unknown[]): BoundStatement {
    return new BoundStatement(
      this.sql,
      this.database.prepare(this.sql),
      sqlValues(values),
      this.beforeRun
    );
  }
}

class SqliteD1 {
  readonly constraints: string[] = [];
  failOnceFor: string | null = null;

  constructor(readonly database: DatabaseSync) {}

  private readonly beforeRun = (sql: string) => {
    if (this.failOnceFor && sql.includes(this.failOnceFor)) {
      this.failOnceFor = null;
      throw new Error('simulated_response_loss');
    }
  };

  private prepare(sql: string): UnboundStatement {
    return new UnboundStatement(sql, this.database, this.beforeRun);
  }

  readonly binding = {
    prepare: (sql: string) => this.prepare(sql),
    batch: async (statements: unknown[]) => this.batch(statements),
    exec: async (sql: string) => {
      this.database.exec(sql);
      return { count: 0, duration: 0 };
    },
    dump: async () => new ArrayBuffer(0),
    withSession: (constraint: string) => this.session(constraint),
  } as unknown as D1Database;

  private session(constraint: string): D1DatabaseSession {
    this.constraints.push(constraint);
    return {
      prepare: (sql: string) => this.prepare(sql),
      batch: async (statements: unknown[]) => this.batch(statements),
      getBookmark: () => `bookmark-${this.constraints.length}`,
    } as unknown as D1DatabaseSession;
  }

  private async batch(statements: unknown[]) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof BoundStatement)) throw new Error('invalid_test_statement');
        return statement.executeRun();
      });
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

async function buildPublication(): Promise<AccountDirectoryPublication> {
  return {
    operationId: 'operation-account-a',
    tenantId: 'tenant-a',
    accountId: 'account-a',
    idempotencyKey: 'publish-account-a',
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
          requiredBindingRouteGeneration: 3,
        },
        {
          dataRole: 'tenant_pii',
          residencyPartition: 'default',
          shardId: 'pii-1',
          bindingRef: 'TDB_PII_1',
          requiredBindingRouteGeneration: 3,
        },
      ],
    },
    indexes: [
      await createLookupBlindIndex('account_id', 'account-a', KEY),
      await createLookupBlindIndex('email_exact', 'person@example.com', KEY),
    ],
  };
}

describe('AccountDirectoryCoordinator', () => {
  let tenantDatabase: DatabaseSync;
  let lookupDatabase: DatabaseSync;
  let tenant: SqliteD1;
  let lookup: SqliteD1;
  let publication: AccountDirectoryPublication;

  beforeEach(async () => {
    tenantDatabase = new DatabaseSync(':memory:');
    lookupDatabase = new DatabaseSync(':memory:');
    tenantDatabase.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/core/d1/001_0_4_0_core_baseline.sql'), 'utf8')
        .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
        .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()')
    );
    tenantDatabase.exec(
      `INSERT INTO identity_accounts (
         id, tenant_id, account_type, lifecycle_state, created_at, updated_at
       ) VALUES
         ('account-a', 'tenant-a', 'person', 'active', 1, 1),
         ('account-b', 'tenant-a', 'person', 'active', 1, 1);`
    );
    lookupDatabase.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/lookup/d1/001_0_4_0_lookup_baseline.sql'), 'utf8')
        .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
        .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()')
    );
    tenant = new SqliteD1(tenantDatabase);
    lookup = new SqliteD1(lookupDatabase);
    publication = await buildPublication();
    tenantDatabase
      .prepare(
        `INSERT INTO account_routing_outbox (
           outbox_id, tenant_id, account_id, event_kind, route_generation,
           route_schema_version, hmac_key_generation, payload_json, status,
           attempt_count, created_at, updated_at
         ) VALUES (?, ?, ?, 'account_created', 1, 1, 1, ?, 'pending', 0, 1, 1)`
      )
      .run(
        'account-routing:operation-account-a',
        'tenant-a',
        'account-a',
        JSON.stringify(publication)
      );
  });

  afterEach(() => {
    tenantDatabase.close();
    lookupDatabase.close();
  });

  function coordinator(): AccountDirectoryCoordinator {
    return new AccountDirectoryCoordinator({
      tenantCore: tenant.binding,
      lookupForBucket: async () => lookup.binding,
      now: () => 100,
    });
  }

  function reservations(): InitialAccountIdentifierReservationService {
    return new InitialAccountIdentifierReservationService({
      lookupForBucket: async () => lookup.binding,
      now: () => 90,
    });
  }

  it('publishes pending indexes, commits reservations, and activates the account last', async () => {
    await reservations().reserve(publication);
    await expect(coordinator().publish(publication)).resolves.toEqual({
      status: 201,
      accountId: 'account-a',
      operationId: 'operation-account-a',
    });
    expect(
      tenantDatabase
        .prepare(`SELECT directory_publication_state FROM identity_accounts WHERE id = 'account-a'`)
        .get()
    ).toEqual({ directory_publication_state: 'active' });
    expect(
      lookupDatabase
        .prepare(`SELECT index_kind, lifecycle_state FROM lookup_identifiers ORDER BY index_kind`)
        .all()
    ).toEqual([
      { index_kind: 'account_id', lifecycle_state: 'active' },
      { index_kind: 'email_exact', lifecycle_state: 'active' },
    ]);
    expect(
      lookupDatabase.prepare(`SELECT reservation_state FROM lookup_identifier_reservations`).get()
    ).toEqual({ reservation_state: 'committed' });
    expect(tenantDatabase.prepare(`SELECT status FROM account_routing_outbox`).get()).toEqual({
      status: 'succeeded',
    });
    expect(new Set([...tenant.constraints, ...lookup.constraints])).toEqual(
      new Set(['first-primary'])
    );
  });

  it('releases only reservations owned by the failed operation and replays idempotently', async () => {
    await reservations().reserve(publication);

    await expect(reservations().release(publication)).resolves.toEqual({ releasedCount: 1 });
    await expect(reservations().release(publication)).resolves.toEqual({ releasedCount: 0 });

    expect(
      lookupDatabase
        .prepare(
          `SELECT reservation_state, lease_expires_at, released_at, committed_at
             FROM lookup_identifier_reservations`
        )
        .get()
    ).toEqual({
      reservation_state: 'released',
      lease_expires_at: null,
      released_at: 90,
      committed_at: null,
    });
  });

  it('resumes forward after response loss at final account activation', async () => {
    await reservations().reserve(publication);
    tenant.failOnceFor = "SET directory_publication_state = 'active'";
    await expect(coordinator().publish(publication)).rejects.toThrow('simulated_response_loss');
    expect(
      tenantDatabase
        .prepare(`SELECT directory_publication_state FROM identity_accounts WHERE id = 'account-a'`)
        .get()
    ).toEqual({ directory_publication_state: 'active_pending_directory' });
    expect(
      lookupDatabase.prepare(`SELECT DISTINCT lifecycle_state FROM lookup_identifiers`).all()
    ).toEqual([{ lifecycle_state: 'active' }]);

    await expect(coordinator().publish(publication)).resolves.toMatchObject({ status: 201 });
    expect(
      tenantDatabase
        .prepare(`SELECT directory_publication_state FROM identity_accounts WHERE id = 'account-a'`)
        .get()
    ).toEqual({ directory_publication_state: 'active' });
  });

  it('is idempotent after successful response loss', async () => {
    await reservations().reserve(publication);
    await coordinator().publish(publication);
    await expect(coordinator().publish(publication)).resolves.toMatchObject({ status: 201 });
    expect(
      lookupDatabase.prepare(`SELECT COUNT(*) AS count FROM lookup_identifiers`).get()
    ).toEqual({ count: 2 });
    expect(
      lookupDatabase
        .prepare(
          `SELECT SUM(successful_route_publication_count) AS count
             FROM lookup_bucket_counters`
        )
        .get()
    ).toEqual({ count: 2 });
  });

  it('does not activate a route when its publication counter row is missing', async () => {
    await reservations().reserve(publication);
    const firstIndex = publication.indexes[0];
    if (!firstIndex) throw new Error('missing_test_index');
    lookupDatabase
      .prepare(`DELETE FROM lookup_bucket_counters WHERE virtual_bucket = ?`)
      .run(firstIndex.virtualBucket);

    await expect(coordinator().publish(publication)).rejects.toThrow(
      'directory_publication_counter_missing'
    );
    expect(
      lookupDatabase
        .prepare(
          `SELECT COUNT(*) AS count FROM lookup_identifiers WHERE lifecycle_state = 'active'`
        )
        .get()
    ).toEqual({ count: 0 });
  });

  it('adds a reserved external subject without reactivating an already active account', async () => {
    await reservations().reserve(publication);
    await coordinator().publish(publication);

    const addition: AccountDirectoryPublication = {
      ...publication,
      operationId: 'passkey-route-passkey-a',
      idempotencyKey: 'publish-passkey-a',
      indexes: [
        publication.indexes.find((index) => index.indexKind === 'account_id')!,
        await createLookupBlindIndex(
          'external_subject',
          { issuer: 'urn:authrim:passkey:example.com', subject: 'credential-a' },
          KEY
        ),
      ],
    };
    tenantDatabase
      .prepare(
        `INSERT INTO account_routing_outbox (
           outbox_id, tenant_id, account_id, event_kind, route_generation,
           route_schema_version, hmac_key_generation, payload_json, status,
           attempt_count, created_at, updated_at
         ) VALUES (?, ?, ?, 'identifier_added', 1, 1, 1, ?, 'pending', 0, 2, 2)`
      )
      .run(
        'account-routing:passkey-route-passkey-a',
        'tenant-a',
        'account-a',
        JSON.stringify(addition)
      );
    await reservations().reserve(addition);

    const onAccountActivated = vi.fn();
    const additionCoordinator = new AccountDirectoryCoordinator({
      tenantCore: tenant.binding,
      lookupForBucket: async () => lookup.binding,
      now: () => 101,
      onAccountActivated,
    });
    await expect(additionCoordinator.publish(addition)).resolves.toMatchObject({ status: 201 });

    expect(onAccountActivated).not.toHaveBeenCalled();
    expect(
      tenantDatabase
        .prepare(`SELECT directory_publication_state FROM identity_accounts WHERE id = 'account-a'`)
        .get()
    ).toEqual({ directory_publication_state: 'active' });
    expect(
      lookupDatabase
        .prepare(
          `SELECT index_kind, lifecycle_state FROM lookup_identifiers ORDER BY index_kind,
                  identifier_blind_digest`
        )
        .all()
    ).toEqual([
      { index_kind: 'account_id', lifecycle_state: 'active' },
      { index_kind: 'email_exact', lifecycle_state: 'active' },
      { index_kind: 'external_subject', lifecycle_state: 'active' },
    ]);
  });

  it('rejects identifier additions when the active account-id base route is missing', async () => {
    tenantDatabase.exec(
      `UPDATE identity_accounts SET directory_publication_state = 'active';
       UPDATE account_routing_outbox
          SET outbox_id = 'account-routing:passkey-route-passkey-a',
              event_kind = 'identifier_added';`
    );
    publication = {
      ...publication,
      operationId: 'passkey-route-passkey-a',
      indexes: [
        publication.indexes.find((index) => index.indexKind === 'account_id')!,
        await createLookupBlindIndex(
          'external_subject',
          { issuer: 'urn:authrim:passkey:example.com', subject: 'credential-a' },
          KEY
        ),
      ],
    };
    tenantDatabase
      .prepare(`UPDATE account_routing_outbox SET payload_json = ?`)
      .run(JSON.stringify(publication));
    await reservations().reserve(publication);

    await expect(coordinator().publish(publication)).rejects.toThrow(
      'directory_identifier_addition_base_route_missing'
    );
  });

  it('records the durable operation after account activation and before outbox completion', async () => {
    await reservations().reserve(publication);
    let callbackAttempts = 0;
    const withOutcome = new AccountDirectoryCoordinator({
      tenantCore: tenant.binding,
      lookupForBucket: async () => lookup.binding,
      now: () => 100,
      onAccountActivated: async (activated, now) => {
        callbackAttempts += 1;
        expect(activated.operationId).toBe(publication.operationId);
        expect(now).toBe(100);
        expect(
          tenantDatabase
            .prepare(
              `SELECT directory_publication_state FROM identity_accounts WHERE id = 'account-a'`
            )
            .get()
        ).toEqual({ directory_publication_state: 'active' });
        expect(tenantDatabase.prepare(`SELECT status FROM account_routing_outbox`).get()).toEqual({
          status: 'pending',
        });
        if (callbackAttempts === 1) throw new Error('simulated_operation_response_loss');
      },
    });

    await expect(withOutcome.publish(publication)).rejects.toThrow(
      'simulated_operation_response_loss'
    );
    expect(tenantDatabase.prepare(`SELECT status FROM account_routing_outbox`).get()).toEqual({
      status: 'pending',
    });

    await expect(withOutcome.publish(publication)).resolves.toMatchObject({ status: 201 });
    expect(callbackAttempts).toBe(2);
    expect(tenantDatabase.prepare(`SELECT status FROM account_routing_outbox`).get()).toEqual({
      status: 'succeeded',
    });
  });

  it('rejects a tenant-wide email reservation owned by another account', async () => {
    const email = publication.indexes.find((index) => index.indexKind === 'email_exact');
    if (!email) throw new Error('missing_test_email_index');
    lookupDatabase
      .prepare(
        `INSERT INTO lookup_identifier_reservations (
           virtual_bucket, tenant_id, index_kind, normalization_version,
           hmac_key_generation, identifier_blind_digest, account_id,
           reservation_state, operation_id, created_at, updated_at
         ) VALUES (?, 'tenant-a', 'email_exact', 1, 1, ?, 'account-b',
                   'committed', 'other-operation', 1, 1)`
      )
      .run(email.virtualBucket, email.digest);

    await expect(coordinator().publish(publication)).rejects.toThrow(
      'directory_identifier_reservation_conflict'
    );
    expect(
      tenantDatabase
        .prepare(`SELECT directory_publication_state FROM identity_accounts WHERE id = 'account-a'`)
        .get()
    ).toEqual({ directory_publication_state: 'pending' });
  });

  it('reserves identifiers before account publication and adopts an exact retry', async () => {
    await expect(reservations().reserve(publication)).resolves.toEqual({ reservedCount: 1 });
    await expect(reservations().reserve(publication)).resolves.toEqual({ reservedCount: 1 });
    expect(
      lookupDatabase
        .prepare(
          `SELECT tenant_id, account_id, operation_id, reservation_state, lease_expires_at
             FROM lookup_identifier_reservations`
        )
        .get()
    ).toEqual({
      tenant_id: 'tenant-a',
      account_id: 'account-a',
      operation_id: 'operation-account-a',
      reservation_state: 'reserved',
      lease_expires_at: 7290,
    });
  });

  it('requires an exact pre-reservation before writing any Lookup row', async () => {
    await expect(coordinator().publish(publication)).rejects.toThrow(
      'directory_identifier_reservation_conflict'
    );
    expect(
      lookupDatabase.prepare(`SELECT COUNT(*) AS count FROM lookup_identifiers`).get()
    ).toEqual({ count: 0 });
  });

  it('requires a matching durable outbox payload', async () => {
    tenantDatabase
      .prepare(`UPDATE account_routing_outbox SET payload_json = ?`)
      .run(JSON.stringify({ ...publication, operationId: 'different-operation' }));
    await expect(coordinator().publish(publication)).rejects.toThrow(
      'directory_routing_outbox_payload_mismatch'
    );
    expect(
      lookupDatabase.prepare(`SELECT COUNT(*) AS count FROM lookup_identifiers`).get()
    ).toEqual({
      count: 0,
    });
  });

  it('rejects a stale scheduled claim before writing Lookup rows', async () => {
    tenantDatabase.exec(
      `UPDATE account_routing_outbox
          SET status = 'leased', attempt_count = 2, lease_owner = 'current-owner',
              lease_expires_at = 999`
    );

    await expect(
      coordinator().publish(publication, { ownerId: 'stale-owner', fencingToken: 1 })
    ).rejects.toThrow('directory_routing_outbox_stale_lease');
    expect(
      lookupDatabase.prepare(`SELECT COUNT(*) AS count FROM lookup_identifiers`).get()
    ).toEqual({ count: 0 });
  });
});
