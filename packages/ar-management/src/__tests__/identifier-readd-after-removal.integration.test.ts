import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import {
  accountDirectoryRemovalOutboxId,
  createLookupBlindIndex,
  LookupDirectoryRepository,
  type AccountDirectoryPublication,
  type AccountDirectoryRemovalPublication,
  type LookupBlindIndex,
} from '@authrim/ar-lib-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountDirectoryServiceBinding, DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import { AccountDirectoryCoordinator } from '../account-directory-coordinator';
import {
  publishAccountExternalSubjectAddition,
  publishAccountExternalSubjectRemoval,
} from '../account-identifier-addition';
import { InitialAccountIdentifierReservationService } from '../account-directory-reservation';
import { AccountDirectoryRemovalCoordinator } from '../account-directory-removal';

/**
 * An identifier that was removed from an account can be added again, to the same account or to
 * another one, through a new operation. Everything here runs real SQL on the Lookup and tenant core
 * baselines; only a reservation that is free (released, or reserved with an expired lease) can be
 * taken over.
 */

const shared = vi.hoisted(() => ({
  lookup: undefined as unknown,
  key: { generation: 1, secret: '0123456789abcdef0123456789abcdef' },
}));

// The production path (publishAccountExternalSubjectAddition / Removal) reads its keys and its
// Lookup binding from the runtime; here both are the test's own.
vi.mock('../lookup-hmac-runtime', () => ({
  loadLookupHmacRuntimeKeys: async () => ({ readKeys: [shared.key], writeKeys: [shared.key] }),
}));
vi.mock('../lookup-bucket-write-route', () => ({
  createLookupBucketWriteResolver: async () => async () => shared.lookup,
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  runTenantBackupCoveredEffect: async (_env: unknown, _scope: unknown, effect: () => unknown) =>
    effect(),
}));

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const KEY = { generation: 1, secret: '0123456789abcdef0123456789abcdef' };
const DID = { issuer: 'did', subject: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH' };

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
    private readonly values: SqlValue[]
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
    return this.executeRun();
  }

  executeRun() {
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
    return new BoundStatement(this.sql, this.database.prepare(this.sql), sqlValues(values));
  }
}

class SqliteD1 {
  constructor(readonly database: DatabaseSync) {}

  readonly binding = {
    prepare: (sql: string) => new UnboundStatement(sql, this.database),
    batch: async (statements: unknown[]) => this.batch(statements),
    withSession: () => this.session(),
  } as unknown as D1Database;

  private session(): D1DatabaseSession {
    return {
      prepare: (sql: string) => new UnboundStatement(sql, this.database),
      batch: async (statements: unknown[]) => this.batch(statements),
      getBookmark: () => 'bookmark',
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

const ROUTE = {
  schemaVersion: 1,
  accountRouteGeneration: 1,
  residencyPolicyId: 'default-policy',
  targets: [
    {
      dataRole: 'tenant_core/users' as const,
      residencyPartition: 'default',
      shardId: 'users-1',
      bindingRef: 'TDB_USERS_1',
      requiredBindingRouteGeneration: 3,
    },
    {
      dataRole: 'tenant_pii' as const,
      residencyPartition: 'default',
      shardId: 'pii-1',
      bindingRef: 'TDB_PII_1',
      requiredBindingRouteGeneration: 3,
    },
  ],
};

describe('adding an identifier again after it was removed', () => {
  let tenantDatabase: DatabaseSync;
  let lookupDatabase: DatabaseSync;
  let tenant: SqliteD1;
  let lookup: SqliteD1;
  let didIndex: LookupBlindIndex;
  let clock = 1000;

  beforeEach(async () => {
    tenantDatabase = new DatabaseSync(':memory:');
    lookupDatabase = new DatabaseSync(':memory:');
    const placeholders = (sql: string) =>
      sql
        .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
        .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()');
    tenantDatabase.exec(
      placeholders(
        readFileSync(resolve(REPO_ROOT, 'migrations/core/d1/001_0_4_0_core_baseline.sql'), 'utf8')
      )
    );
    lookupDatabase.exec(
      placeholders(
        readFileSync(
          resolve(REPO_ROOT, 'migrations/lookup/d1/001_0_4_0_lookup_baseline.sql'),
          'utf8'
        )
      )
    );
    tenant = new SqliteD1(tenantDatabase);
    lookup = new SqliteD1(lookupDatabase);
    shared.lookup = lookup.binding;
    didIndex = await createLookupBlindIndex('external_subject', DID, KEY);
    clock = 1000;
    for (const accountId of ['account-a', 'account-b']) {
      tenantDatabase
        .prepare(
          `INSERT INTO identity_accounts (
             id, tenant_id, account_type, lifecycle_state, directory_publication_state,
             created_at, updated_at
           ) VALUES (?, 'tenant-a', 'person', 'active', 'active', 1, 1)`
        )
        .run(accountId);
      // The account-id base route every identifier addition requires.
      await seedBaseRoute(accountId);
    }
  });

  afterEach(() => {
    tenantDatabase.close();
    lookupDatabase.close();
  });

  async function seedBaseRoute(accountId: string) {
    const index = await createLookupBlindIndex('account_id', accountId, KEY);
    lookupDatabase
      .prepare(
        `INSERT INTO lookup_identifiers (
           virtual_bucket, index_kind, normalization_version, hmac_key_generation,
           identifier_blind_digest, tenant_id, account_id, route_schema_version,
           account_route_generation, required_binding_route_generation, residency_policy_id,
           route_projection_json, tenant_lifecycle_state, runtime_route_status,
           lifecycle_state, created_at, updated_at
         ) VALUES (?, 'account_id', ?, ?, ?, 'tenant-a', ?, 1, 1, 3, 'default-policy',
                   ?, 'active', 'active', 'active', 1, 1)`
      )
      .run(
        index.virtualBucket,
        index.normalizationVersion,
        index.hmacKeyGeneration,
        index.digest,
        accountId,
        JSON.stringify(ROUTE)
      );
  }

  async function addition(accountId: string, operationId: string) {
    const publication: AccountDirectoryPublication = {
      operationId,
      tenantId: 'tenant-a',
      accountId,
      idempotencyKey: `key-${operationId}`,
      routeProjection: ROUTE,
      indexes: [await createLookupBlindIndex('account_id', accountId, KEY), didIndex],
    };
    tenantDatabase
      .prepare(
        `INSERT OR IGNORE INTO account_routing_outbox (
           outbox_id, tenant_id, account_id, event_kind, route_generation,
           route_schema_version, hmac_key_generation, payload_json, status,
           attempt_count, created_at, updated_at
         ) VALUES (?, 'tenant-a', ?, 'identifier_added', 1, 1, 1, ?, 'pending', 0, 1, 1)`
      )
      .run(`account-routing:${operationId}`, accountId, JSON.stringify(publication));
    return publication;
  }

  async function removal(accountId: string, operationId: string, preparedAt = clock) {
    const publication: AccountDirectoryRemovalPublication = {
      operationId,
      tenantId: 'tenant-a',
      accountId,
      idempotencyKey: operationId,
      routeProjection: ROUTE,
      scope: 'identifier',
      indexes: [didIndex],
    };
    tenantDatabase
      .prepare(
        `INSERT INTO account_routing_outbox (
           outbox_id, tenant_id, account_id, event_kind, route_generation,
           route_schema_version, hmac_key_generation, payload_json, status,
           attempt_count, created_at, updated_at
         ) VALUES (?, 'tenant-a', ?, 'identifier_removed', 1, 1, 1, ?, 'pending', 0, ?, ?)`
      )
      .run(
        accountDirectoryRemovalOutboxId(operationId),
        accountId,
        JSON.stringify(publication),
        preparedAt,
        preparedAt
      );
    return publication;
  }

  const reservations = () =>
    new InitialAccountIdentifierReservationService({
      lookupForBucket: async () => lookup.binding,
      now: () => clock,
    });
  const coordinator = () =>
    new AccountDirectoryCoordinator({
      tenantCore: tenant.binding,
      lookupForBucket: async () => lookup.binding,
      now: () => clock,
    });
  const remover = () =>
    new AccountDirectoryRemovalCoordinator({
      tenantCore: tenant.binding,
      lookupForBucket: async () => lookup.binding,
      now: () => clock,
    });

  /** The whole add: reserve first, then publish (as publishAccountIdentifierAddition does). */
  async function add(accountId: string, operationId: string) {
    const publication = await addition(accountId, operationId);
    await reservations().reserve(publication);
    return coordinator().publish(publication);
  }

  async function remove(accountId: string, operationId: string) {
    clock += 10;
    return remover().remove(await removal(accountId, operationId));
  }

  /** The tenant core database behind the DatabaseAdapter the production code takes. */
  function tenantAdapter(): DatabaseAdapter {
    const bind = (params: unknown[] = []) => sqlValues(params);
    return {
      queryOne: async (sql: string, params?: unknown[]) =>
        (tenantDatabase.prepare(sql).get(...bind(params)) as unknown) ?? null,
      execute: async (sql: string, params?: unknown[]) => ({
        success: true,
        rowsAffected: Number(tenantDatabase.prepare(sql).run(...bind(params)).changes),
      }),
      batch: async (statements: Array<{ sql: string; params?: unknown[] }>) => {
        tenantDatabase.exec('BEGIN IMMEDIATE');
        try {
          const results = statements.map((statement) => ({
            success: true,
            rowsAffected: Number(
              tenantDatabase.prepare(statement.sql).run(...bind(statement.params)).changes
            ),
          }));
          tenantDatabase.exec('COMMIT');
          return results;
        } catch (error) {
          tenantDatabase.exec('ROLLBACK');
          throw error;
        }
      },
    } as unknown as DatabaseAdapter;
  }

  /** The production add: reserve, outbox, then the directory publication. */
  function productionInput(accountId: string, operationId: string) {
    return {
      operationId,
      idempotencyKey: `key-${operationId}`,
      tenantId: 'tenant-a',
      accountId,
      externalSubject: DID,
      routeProjection: ROUTE,
    };
  }
  function productionDependencies() {
    return {
      tenantCoreUsers: tenantAdapter(),
      now: () => clock,
      directory: {
        publishAccountDirectory: async (publication: AccountDirectoryPublication) =>
          coordinator().publish(publication),
        removeAccountDirectory: async (publication: AccountDirectoryRemovalPublication) =>
          remover().remove(publication),
      } as unknown as AccountDirectoryServiceBinding,
    };
  }
  const productionAdd = (accountId: string, operationId: string) =>
    publishAccountExternalSubjectAddition(
      {} as Env,
      productionInput(accountId, operationId),
      productionDependencies()
    );
  const productionRemove = (accountId: string, operationId: string) =>
    publishAccountExternalSubjectRemoval(
      {} as Env,
      productionInput(accountId, operationId),
      productionDependencies()
    );

  /** Runs `action` right before the first statement that contains `fragment` is prepared. */
  function beforeStatement(fragment: string, action: () => void): () => boolean {
    let fired = false;
    const original = lookup.binding.withSession.bind(lookup.binding);
    (lookup.binding as { withSession: unknown }).withSession = (constraint: string) => {
      const session = original(constraint);
      const prepare = session.prepare.bind(session);
      session.prepare = ((sql: string) => {
        if (!fired && sql.includes(fragment)) {
          fired = true;
          action();
        }
        return prepare(sql);
      }) as typeof session.prepare;
      return session;
    };
    return () => fired;
  }

  function publicationCount(): number {
    return Number(
      (
        lookupDatabase
          .prepare(
            `SELECT SUM(successful_route_publication_count) AS count FROM lookup_bucket_counters`
          )
          .get() as { count: number }
      ).count
    );
  }

  async function resolveAccounts(): Promise<string[]> {
    const { memberships } = await new LookupDirectoryRepository(
      lookup.binding
    ).findActiveMemberships(didIndex);
    return memberships.map((membership) => membership.accountId);
  }

  function reservationRow() {
    return lookupDatabase
      .prepare(
        `SELECT account_id, operation_id, reservation_state, lease_expires_at, committed_at,
                released_at
           FROM lookup_identifier_reservations`
      )
      .get();
  }

  function routeRows() {
    return lookupDatabase
      .prepare(
        `SELECT account_id, lifecycle_state, runtime_route_status, tenant_lifecycle_state,
                disabled_at, route_projection_json
           FROM lookup_identifiers WHERE index_kind = 'external_subject' ORDER BY account_id`
      )
      .all();
  }

  function activeCounter(): number {
    return Number(
      (
        lookupDatabase
          .prepare(
            `SELECT SUM(estimated_active_identifier_count) AS count FROM lookup_bucket_counters`
          )
          .get() as { count: number }
      ).count
    );
  }

  describe('reserve()', () => {
    function seedReservation(
      state: string,
      input: { account?: string; lease?: number | null } = {}
    ) {
      lookupDatabase
        .prepare(
          `INSERT INTO lookup_identifier_reservations (
             virtual_bucket, tenant_id, index_kind, normalization_version,
             hmac_key_generation, identifier_blind_digest, account_id,
             reservation_state, operation_id, lease_expires_at, committed_at, released_at,
             created_at, updated_at
           ) VALUES (?, 'tenant-a', 'external_subject', ?, ?, ?, ?, ?, 'old-operation', ?, ?, ?, 1, 1)`
        )
        .run(
          didIndex.virtualBucket,
          didIndex.normalizationVersion,
          didIndex.hmacKeyGeneration,
          didIndex.digest,
          input.account ?? 'account-a',
          state,
          input.lease ?? null,
          state === 'committed' ? 5 : null,
          state === 'released' ? 5 : null
        );
    }

    it('reserves a fresh identifier and accepts a replay of the same operation', async () => {
      const publication = await addition('account-a', 'op-1');
      await expect(reservations().reserve(publication)).resolves.toEqual({ reservedCount: 1 });
      await expect(reservations().reserve(publication)).resolves.toEqual({ reservedCount: 1 });
      expect(reservationRow()).toMatchObject({
        account_id: 'account-a',
        operation_id: 'op-1',
        reservation_state: 'reserved',
      });
    });

    it('takes over a released reservation of the same account with a new operation', async () => {
      seedReservation('released');
      await reservations().reserve(await addition('account-a', 'op-new'));
      expect(reservationRow()).toEqual({
        account_id: 'account-a',
        operation_id: 'op-new',
        reservation_state: 'reserved',
        lease_expires_at: clock + 7200,
        committed_at: null,
        released_at: null,
      });
    });

    it('takes over a released reservation of another account', async () => {
      seedReservation('released', { account: 'account-a' });
      await reservations().reserve(await addition('account-b', 'op-new'));
      expect(reservationRow()).toMatchObject({
        account_id: 'account-b',
        operation_id: 'op-new',
        reservation_state: 'reserved',
        released_at: null,
      });
    });

    it('takes over a reservation whose lease has expired', async () => {
      seedReservation('reserved', { account: 'account-a', lease: clock - 1 });
      await reservations().reserve(await addition('account-b', 'op-new'));
      expect(reservationRow()).toMatchObject({
        account_id: 'account-b',
        operation_id: 'op-new',
        reservation_state: 'reserved',
      });
    });

    it.each([
      ['a live lease, same account', 'reserved', 'account-a', 5000],
      ['a live lease, other account', 'reserved', 'account-b', 5000],
      ['a committed reservation, same account', 'committed', 'account-a', null],
      ['a committed reservation, other account', 'committed', 'account-b', null],
      ['a reservation being released', 'releasing', 'account-b', null],
      ['a reservation that needs repair', 'repair_required', 'account-b', null],
    ])('never takes over %s', async (_name, state, owner, lease) => {
      seedReservation(state, { account: owner, lease });
      const before = reservationRow();
      await expect(reservations().reserve(await addition('account-a', 'op-new'))).rejects.toThrow(
        'directory_identifier_reservation_conflict'
      );
      expect(reservationRow()).toEqual(before);
    });

    it('treats a lease that ends exactly now as expired, and one that ends later as live', async () => {
      seedReservation('reserved', { account: 'account-b', lease: clock + 1 });
      await expect(reservations().reserve(await addition('account-a', 'op-new'))).rejects.toThrow(
        'directory_identifier_reservation_conflict'
      );
      lookupDatabase
        .prepare(`UPDATE lookup_identifier_reservations SET lease_expires_at = ?`)
        .run(clock);
      await reservations().reserve(await addition('account-a', 'op-new'));
      expect(reservationRow()).toMatchObject({ account_id: 'account-a', operation_id: 'op-new' });
    });

    it('keeps a reserved row without a lease (never taken over on a missing expiry)', async () => {
      seedReservation('reserved', { account: 'account-b', lease: null });
      const before = reservationRow();
      await expect(reservations().reserve(await addition('account-a', 'op-new'))).rejects.toThrow(
        'directory_identifier_reservation_conflict'
      );
      expect(reservationRow()).toEqual(before);
    });
  });

  describe('add, remove, add again', () => {
    it('adds the identifier again to the same account through a new operation', async () => {
      await add('account-a', 'op-1');
      expect(await resolveAccounts()).toEqual(['account-a']);
      const activeAfterFirstAdd = activeCounter();

      await remove('account-a', 'rm-1');
      expect(await resolveAccounts()).toEqual([]);
      expect(routeRows()).toEqual([
        expect.objectContaining({ lifecycle_state: 'disabled', runtime_route_status: 'disabled' }),
      ]);
      expect(reservationRow()).toMatchObject({ reservation_state: 'released' });
      expect(activeCounter()).toBe(activeAfterFirstAdd - 1);

      clock += 10;
      await expect(add('account-a', 'op-2')).resolves.toMatchObject({ status: 201 });

      expect(await resolveAccounts()).toEqual(['account-a']);
      expect(routeRows()).toEqual([
        {
          account_id: 'account-a',
          lifecycle_state: 'active',
          runtime_route_status: 'active',
          tenant_lifecycle_state: 'active',
          disabled_at: null,
          route_projection_json: JSON.stringify(ROUTE),
        },
      ]);
      expect(reservationRow()).toMatchObject({
        account_id: 'account-a',
        operation_id: 'op-2',
        reservation_state: 'committed',
        released_at: null,
      });
      expect(activeCounter()).toBe(activeAfterFirstAdd);
    });

    it('adds the identifier to another account once it was released', async () => {
      await add('account-a', 'op-1');
      await remove('account-a', 'rm-1');

      clock += 10;
      await expect(add('account-b', 'op-2')).resolves.toMatchObject({ status: 201 });

      expect(await resolveAccounts()).toEqual(['account-b']);
      expect(routeRows()).toEqual([
        expect.objectContaining({ account_id: 'account-a', lifecycle_state: 'disabled' }),
        expect.objectContaining({ account_id: 'account-b', lifecycle_state: 'active' }),
      ]);
      expect(reservationRow()).toMatchObject({
        account_id: 'account-b',
        operation_id: 'op-2',
        reservation_state: 'committed',
      });
    });

    it('can be removed and added again repeatedly, and every removal takes the route down', async () => {
      await add('account-a', 'op-1');
      await remove('account-a', 'rm-1');
      clock += 10;
      await add('account-a', 'op-2');
      await remove('account-a', 'rm-2');
      expect(await resolveAccounts()).toEqual([]);
      clock += 10;
      await add('account-b', 'op-3');
      expect(await resolveAccounts()).toEqual(['account-b']);
      await remove('account-b', 'rm-3');
      expect(await resolveAccounts()).toEqual([]);
      clock += 10;
      await add('account-a', 'op-4');
      expect(await resolveAccounts()).toEqual(['account-a']);
    });

    it('refuses to add an identifier that is still active, for the same and for another account', async () => {
      await add('account-a', 'op-1');
      const routesBefore = routeRows();
      const reservationBefore = reservationRow();

      clock += 10;
      await expect(add('account-a', 'op-2')).rejects.toThrow(
        'directory_identifier_reservation_conflict'
      );
      await expect(add('account-b', 'op-3')).rejects.toThrow(
        'directory_identifier_reservation_conflict'
      );

      expect(routeRows()).toEqual(routesBefore);
      expect(reservationRow()).toEqual(reservationBefore);
      expect(await resolveAccounts()).toEqual(['account-a']);
    });

    it('refuses a second account while the first add is still reserved with a live lease', async () => {
      const first = await addition('account-a', 'op-1');
      await reservations().reserve(first);
      clock += 10;
      await expect(add('account-b', 'op-2')).rejects.toThrow(
        'directory_identifier_reservation_conflict'
      );
      expect(reservationRow()).toMatchObject({ account_id: 'account-a', operation_id: 'op-1' });
      expect(routeRows()).toEqual([]);
    });

    it('does not revive a disabled route for an operation that does not own the reservation', async () => {
      await add('account-a', 'op-1');
      await remove('account-a', 'rm-1');

      // A replay of the first add after its removal, through the production path (reserve, then
      // publish): the reservation the removal released belongs to that very operation, a finished
      // add, so it is not acquired again and nothing is published.
      clock += 10;
      await expect(productionAdd('account-a', 'op-1')).rejects.toThrow(
        'directory_identifier_reservation_conflict'
      );
      expect(await resolveAccounts()).toEqual([]);
      expect(routeRows()).toEqual([expect.objectContaining({ lifecycle_state: 'disabled' })]);
      expect(reservationRow()).toMatchObject({
        operation_id: 'op-1',
        reservation_state: 'released',
      });
      // The coordinator on its own refuses it too.
      await expect(coordinator().publish(await addition('account-a', 'op-1'))).rejects.toThrow(
        'directory_identifier_reservation_conflict'
      );
      expect(routeRows()).toEqual([expect.objectContaining({ lifecycle_state: 'disabled' })]);

      // Another account's operation owns the reservation: account-a's disabled row is untouched.
      await reservations().reserve(await addition('account-b', 'op-2'));
      await expect(coordinator().publish(await addition('account-a', 'op-1'))).rejects.toThrow(
        'directory_identifier_reservation_conflict'
      );
      expect(routeRows()).toEqual([expect.objectContaining({ lifecycle_state: 'disabled' })]);
    });

    it.each([
      ['taken over by another account', `account_id = 'account-b', operation_id = 'op-other'`],
      ['taken over by another operation of the account', `operation_id = 'op-other'`],
      ['released', `reservation_state = 'released', released_at = 1, lease_expires_at = NULL`],
    ])(
      're-activates only in the statement that checks the reservation (reservation %s mid-publication)',
      async (_name, assignment) => {
        await add('account-a', 'op-1');
        await remove('account-a', 'rm-1');
        clock += 10;
        const publication = await addition('account-a', 'op-2');
        await reservations().reserve(publication);
        // The lease of op-2 is taken over by account-b between the coordinator's own reservation
        // check and the route write: the route statement must then leave the disabled row alone.
        let swapped = false;
        const racing = new AccountDirectoryCoordinator({
          tenantCore: tenant.binding,
          lookupForBucket: async () => lookup.binding,
          now: () => clock,
        });
        const original = lookup.binding.withSession.bind(lookup.binding);
        (lookup.binding as { withSession: unknown }).withSession = (constraint: string) => {
          const session = original(constraint);
          const prepare = session.prepare.bind(session);
          session.prepare = ((sql: string) => {
            if (!swapped && sql.includes('INSERT OR IGNORE INTO lookup_identifiers')) {
              swapped = true;
              lookupDatabase
                .prepare(`UPDATE lookup_identifier_reservations SET ${assignment}`)
                .run();
            }
            return prepare(sql);
          }) as typeof session.prepare;
          return session;
        };
        await expect(racing.publish(publication)).rejects.toThrow();
        expect(swapped).toBe(true);
        expect(routeRows()).toEqual([expect.objectContaining({ lifecycle_state: 'disabled' })]);
        expect(await resolveAccounts()).toEqual([]);
      }
    );

    it('is idempotent when the re-adding operation is published again', async () => {
      await add('account-a', 'op-1');
      await remove('account-a', 'rm-1');
      clock += 10;
      await add('account-a', 'op-2');
      const routes = routeRows();
      const reservation = reservationRow();
      const active = activeCounter();
      const published = lookupDatabase
        .prepare(
          `SELECT SUM(successful_route_publication_count) AS count FROM lookup_bucket_counters`
        )
        .get();

      clock += 10;
      await expect(
        coordinator().publish(await addition('account-a', 'op-2'))
      ).resolves.toMatchObject({ status: 201 });
      expect(routeRows()).toEqual(routes);
      expect(reservationRow()).toEqual(reservation);
      expect(activeCounter()).toBe(active);
      expect(
        lookupDatabase
          .prepare(
            `SELECT SUM(successful_route_publication_count) AS count FROM lookup_bucket_counters`
          )
          .get()
      ).toEqual(published);
    });
  });

  describe('production path: add, remove, replay, add again', () => {
    it('refuses a replay of an add that was removed, and accepts the same identifier under a new operation', async () => {
      await expect(productionAdd('account-a', 'op-1')).resolves.toMatchObject({ status: 201 });
      clock += 10;
      await expect(productionRemove('account-a', 'rm-1')).resolves.toMatchObject({ status: 201 });
      expect(await resolveAccounts()).toEqual([]);

      clock += 10;
      await expect(productionAdd('account-a', 'op-1')).rejects.toThrow(
        'directory_identifier_reservation_conflict'
      );
      expect(await resolveAccounts()).toEqual([]);
      expect(routeRows()).toEqual([expect.objectContaining({ lifecycle_state: 'disabled' })]);
      expect(reservationRow()).toMatchObject({
        operation_id: 'op-1',
        reservation_state: 'released',
      });

      clock += 10;
      await expect(productionAdd('account-a', 'op-2')).resolves.toMatchObject({ status: 201 });
      expect(await resolveAccounts()).toEqual(['account-a']);
      expect(reservationRow()).toMatchObject({
        operation_id: 'op-2',
        reservation_state: 'committed',
      });

      clock += 10;
      await expect(productionRemove('account-a', 'rm-2')).resolves.toMatchObject({ status: 201 });
      clock += 10;
      await expect(productionAdd('account-b', 'op-3')).resolves.toMatchObject({ status: 201 });
      expect(await resolveAccounts()).toEqual(['account-b']);
    });
  });

  describe('a removal acts only on what existed when it was prepared', () => {
    /** add (clock 1000) -> removal prepared (1010) and finished -> add again (1020). */
    async function removedAndAddedAgain(accountId = 'account-a') {
      await add('account-a', 'op-1');
      const stale = await removal('account-a', 'rm-1', clock + 10);
      clock += 10;
      await remover().remove(stale);
      clock += 10;
      await add(accountId, 'op-2');
      return stale;
    }

    it('leaves a route and a reservation added again after it alone when it runs again', async () => {
      const stale = await removedAndAddedAgain();
      const routes = routeRows();
      const reservation = reservationRow();
      const active = activeCounter();

      clock += 10;
      await expect(remover().remove(stale)).resolves.toMatchObject({ status: 201 });

      expect(await resolveAccounts()).toEqual(['account-a']);
      expect(routeRows()).toEqual(routes);
      expect(reservationRow()).toEqual(reservation);
      expect(reservationRow()).toMatchObject({
        operation_id: 'op-2',
        reservation_state: 'committed',
      });
      expect(activeCounter()).toBe(active);
      expect(
        tenantDatabase
          .prepare(
            `SELECT status FROM account_routing_outbox WHERE event_kind = 'identifier_removed'`
          )
          .get()
      ).toEqual({ status: 'succeeded' });
    });

    it('leaves an identifier added again to another account alone as well', async () => {
      const stale = await removedAndAddedAgain('account-b');
      const reservation = reservationRow();
      clock += 10;
      await expect(remover().remove(stale)).resolves.toMatchObject({ status: 201 });
      expect(await resolveAccounts()).toEqual(['account-b']);
      expect(reservationRow()).toEqual(reservation);
    });

    it('leaves a route alone that was added again while the slow run was between its read and its write', async () => {
      await add('account-a', 'op-1');
      clock += 10;
      const slow = await removal('account-a', 'rm-1', clock);
      // A parallel run of the same removal finished, and the identifier was added again, right
      // before this run disables the route.
      const fired = beforeStatement('UPDATE lookup_identifiers', () => {
        lookupDatabase
          .prepare(
            `UPDATE lookup_identifier_reservations
                SET operation_id = 'op-2', created_at = ?, updated_at = ?`
          )
          .run(clock + 5, clock + 5);
      });
      await expect(remover().remove(slow)).rejects.toThrow(
        'directory_removal_lookup_reflection_failed'
      );
      expect(fired()).toBe(true);
      expect(await resolveAccounts()).toEqual(['account-a']);
      expect(reservationRow()).toMatchObject({
        operation_id: 'op-2',
        reservation_state: 'committed',
      });
      // Nothing was marked done: the next run sees the newer reservation and finishes.
      expect(
        tenantDatabase
          .prepare(
            `SELECT status FROM account_routing_outbox WHERE event_kind = 'identifier_removed'`
          )
          .get()
      ).toEqual({ status: 'pending' });
      await expect(remover().remove(slow)).resolves.toMatchObject({ status: 201 });
      expect(await resolveAccounts()).toEqual(['account-a']);
    });

    it('leaves a reservation alone that was taken again between the route write and the release', async () => {
      await add('account-a', 'op-1');
      clock += 10;
      const slow = await removal('account-a', 'rm-1', clock);
      const fired = beforeStatement("SET reservation_state = 'released'", () => {
        lookupDatabase
          .prepare(
            `UPDATE lookup_identifier_reservations
                SET operation_id = 'op-2', created_at = ?, updated_at = ?`
          )
          .run(clock + 5, clock + 5);
      });
      await expect(remover().remove(slow)).resolves.toMatchObject({ status: 201 });
      expect(fired()).toBe(true);
      expect(reservationRow()).toMatchObject({
        operation_id: 'op-2',
        reservation_state: 'committed',
      });
    });

    it('still removes everything an add made before the removal was prepared', async () => {
      await add('account-a', 'op-1');
      const active = activeCounter();
      clock += 10;
      await expect(
        remover().remove(await removal('account-a', 'rm-1', clock))
      ).resolves.toMatchObject({ status: 201 });
      expect(await resolveAccounts()).toEqual([]);
      expect(routeRows()).toEqual([
        expect.objectContaining({ lifecycle_state: 'disabled', runtime_route_status: 'disabled' }),
      ]);
      expect(reservationRow()).toMatchObject({ reservation_state: 'released' });
      expect(activeCounter()).toBe(active - 1);
    });

    it('still removes an add made in the same second the removal was prepared', async () => {
      await add('account-a', 'op-1');
      await expect(
        remover().remove(await removal('account-a', 'rm-1', clock))
      ).resolves.toMatchObject({ status: 201 });
      expect(await resolveAccounts()).toEqual([]);
    });

    it('is idempotent when a finished removal runs again', async () => {
      await add('account-a', 'op-1');
      clock += 10;
      const finished = await removal('account-a', 'rm-1', clock);
      await remover().remove(finished);
      const routes = routeRows();
      const reservation = reservationRow();
      const active = activeCounter();
      clock += 10;
      await remover().remove(finished);
      expect(routeRows()).toEqual(routes);
      expect(reservationRow()).toEqual(reservation);
      expect(activeCounter()).toBe(active);
      expect(await resolveAccounts()).toEqual([]);
    });
  });

  describe('an account removal that runs again after an identifier went to another account', () => {
    it("finishes: the other account's reservation and route stay, this account's routes are all disabled", async () => {
      await add('account-a', 'op-1');
      // The account is being deleted; its removal covers the account route and the identifier.
      tenantDatabase
        .prepare(
          `UPDATE identity_accounts
              SET lifecycle_state = 'deleting', directory_publication_state = 'disabled'
            WHERE id = 'account-a'`
        )
        .run();
      const accountIndex = await createLookupBlindIndex('account_id', 'account-a', KEY);
      const accountRemoval: AccountDirectoryRemovalPublication = {
        operationId: 'rm-account-a',
        tenantId: 'tenant-a',
        accountId: 'account-a',
        idempotencyKey: 'rm-account-a',
        routeProjection: ROUTE,
        scope: 'account',
        indexes: [didIndex, accountIndex],
      };
      tenantDatabase
        .prepare(
          `INSERT INTO account_routing_outbox (
             outbox_id, tenant_id, account_id, event_kind, route_generation,
             route_schema_version, hmac_key_generation, payload_json, status,
             attempt_count, created_at, updated_at
           ) VALUES (?, 'tenant-a', 'account-a', 'account_deleted', 1, 1, 1, ?, 'pending', 0, ?, ?)`
        )
        .run(
          accountDirectoryRemovalOutboxId('rm-account-a'),
          JSON.stringify(accountRemoval),
          clock + 10,
          clock + 10
        );

      // An earlier run got as far as the identifier: its route is disabled, its reservation
      // released. Then account-b added the same identifier, before the retry.
      clock += 10;
      lookupDatabase
        .prepare(
          `UPDATE lookup_identifiers
              SET lifecycle_state = 'disabled', runtime_route_status = 'disabled', disabled_at = ?
            WHERE account_id = 'account-a' AND index_kind = 'external_subject'`
        )
        .run(clock);
      lookupDatabase
        .prepare(
          `UPDATE lookup_identifier_reservations
              SET reservation_state = 'released', lease_expires_at = NULL, released_at = ?`
        )
        .run(clock);
      clock += 10;
      await add('account-b', 'op-2');
      const reservation = reservationRow();
      expect(reservation).toMatchObject({ account_id: 'account-b', operation_id: 'op-2' });

      clock += 10;
      await expect(remover().remove(accountRemoval)).resolves.toMatchObject({ status: 201 });

      expect(reservationRow()).toEqual(reservation);
      expect(await resolveAccounts()).toEqual(['account-b']);
      expect(
        lookupDatabase
          .prepare(
            `SELECT account_id, index_kind, lifecycle_state FROM lookup_identifiers
              WHERE account_id = 'account-a' ORDER BY index_kind`
          )
          .all()
      ).toEqual([
        { account_id: 'account-a', index_kind: 'account_id', lifecycle_state: 'disabled' },
        { account_id: 'account-a', index_kind: 'external_subject', lifecycle_state: 'disabled' },
      ]);
      expect(
        tenantDatabase
          .prepare(`SELECT status FROM account_routing_outbox WHERE event_kind = 'account_deleted'`)
          .get()
      ).toEqual({ status: 'succeeded' });
    });
  });

  describe('an identifier removal meets a reservation of another account', () => {
    it("disables this account's own route and leaves the other reservation alone, even a newer one", async () => {
      await add('account-a', 'op-1');
      clock += 10;
      const input = await removal('account-a', 'rm-1', clock);
      lookupDatabase
        .prepare(
          `UPDATE lookup_identifier_reservations
              SET account_id = 'account-b', operation_id = 'op-b', created_at = ?, updated_at = ?`
        )
        .run(clock + 5, clock + 5);
      const reservation = reservationRow();

      clock += 10;
      await expect(remover().remove(input)).resolves.toMatchObject({ status: 201 });

      expect(routeRows()).toEqual([expect.objectContaining({ lifecycle_state: 'disabled' })]);
      expect(reservationRow()).toEqual(reservation);
    });
  });

  describe('the route goes active only while its operation owns the reservation', () => {
    it.each([
      ['another account', `account_id = 'account-b', operation_id = 'op-other'`],
      ['another operation of the account', `operation_id = 'op-other'`],
    ])(
      'does not activate a route whose reservation went to %s after the last check',
      async (_name, assignment) => {
        const publication = await addition('account-a', 'op-1');
        await reservations().reserve(publication);
        const published = publicationCount();
        const active = activeCounter();
        // The lease ran out and the identifier was taken over right before the activation batch.
        const fired = beforeStatement('UPDATE lookup_bucket_counters', () => {
          lookupDatabase
            .prepare(
              `UPDATE lookup_identifier_reservations SET ${assignment}, lease_expires_at = 99999`
            )
            .run();
        });

        await expect(coordinator().publish(publication)).rejects.toThrow(
          'directory_lookup_activation_reflection_failed'
        );

        expect(fired()).toBe(true);
        expect(routeRows()).toEqual([expect.objectContaining({ lifecycle_state: 'pending' })]);
        expect(await resolveAccounts()).toEqual([]);
        expect(activeCounter()).toBe(active);
        expect(publicationCount()).toBe(published);
        expect(reservationRow()).toMatchObject({
          operation_id: 'op-other',
          reservation_state: 'reserved',
        });
      }
    );

    it('does not activate an identifier added again whose reservation was taken over before activation', async () => {
      await add('account-a', 'op-1');
      clock += 10;
      await remove('account-a', 'rm-1');
      clock += 10;
      const publication = await addition('account-a', 'op-2');
      await reservations().reserve(publication);
      beforeStatement('UPDATE lookup_bucket_counters', () => {
        lookupDatabase
          .prepare(
            `UPDATE lookup_identifier_reservations
                SET account_id = 'account-b', operation_id = 'op-other', lease_expires_at = 99999`
          )
          .run();
      });
      await expect(coordinator().publish(publication)).rejects.toThrow();
      expect(await resolveAccounts()).toEqual([]);
      expect(routeRows()).toEqual([expect.objectContaining({ lifecycle_state: 'pending' })]);
    });
  });
});
