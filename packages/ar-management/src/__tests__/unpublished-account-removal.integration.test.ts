/**
 * The directory removal of an account whose route was never published, end to end on real SQL
 * (tenant core and Lookup baselines): prepared on its creation's route
 * (prepareUnpublishedAccountDirectoryRemoval), made ready, then run by the removal coordinator.
 * What the creation reserved is released and its pending routes disabled, so the address can be
 * reserved again by the person's next sign-up.
 */
import { readFileSync } from 'node:fs';
import type { D1Database } from '@cloudflare/workers-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLookupBlindIndex,
  markAccountDirectoryRemovalReady,
  type AccountDirectoryPublication,
  type DatabaseAdapter,
  type Env,
  type LookupBlindIndex,
} from '@authrim/ar-lib-core';
import { renderPortableMigrationSql } from '../../../ar-lib-core/dist/migrations/sql-portability';
import { openCoreStore } from './helpers/core-schema-sqlite';
import { DatabaseSync, type SQLInputValue, type SQLiteDatabase } from './test-sqlite';

vi.mock('../lookup-hmac-runtime', () => ({
  loadLookupHmacRuntimeKeys: async () => ({
    readKeys: [{ generation: 1, secret: '0123456789abcdef0123456789abcdef' }],
    writeKeys: [{ generation: 1, secret: '0123456789abcdef0123456789abcdef' }],
  }),
}));

const { prepareUnpublishedAccountDirectoryRemoval } =
  await import('../account-directory-removal-producer');
const { AccountDirectoryRemovalCoordinator } = await import('../account-directory-removal');

const TENANT = 'tenant-a';
const USER = 'user-unpublished';
const ACCOUNT = `account:${USER}`;
const KEY = { generation: 1, secret: '0123456789abcdef0123456789abcdef' };
const NOW = 1_800_000_000;

/** A D1 binding over a SQLite database (sessions read and write it directly). */
function d1(db: SQLiteDatabase): D1Database {
  const values = (params: unknown[]) =>
    params.map((value) => (value === undefined ? null : value) as SQLInputValue);
  const prepare = (sql: string) => ({
    bind: (...params: unknown[]) => ({
      first: async () => db.prepare(sql).get(...values(params)) ?? null,
      all: async () => ({ success: true, results: db.prepare(sql).all(...values(params)) }),
      run: async () => ({
        success: true,
        meta: { changes: Number(db.prepare(sql).run(...values(params)).changes) },
      }),
    }),
  });
  const session = { prepare, getBookmark: () => 'bookmark' };
  return { prepare, withSession: () => session, batch: async () => [] } as unknown as D1Database;
}

let core: ReturnType<typeof openCoreStore>;
let lookup: SQLiteDatabase;
let email: LookupBlindIndex;
let accountIndex: LookupBlindIndex;

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
    indexes: [accountIndex, email],
  };
}

function lookupRoute(index: LookupBlindIndex) {
  lookup
    .prepare(
      `INSERT INTO lookup_identifiers (virtual_bucket, index_kind, normalization_version,
         hmac_key_generation, identifier_blind_digest, tenant_id, account_id, route_schema_version,
         account_route_generation, required_binding_route_generation, residency_policy_id,
         route_projection_json, tenant_lifecycle_state, runtime_route_status, lifecycle_state,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 'policy-a', '{}', 'active', 'pending', 'pending', ?, ?)`
    )
    .run(
      index.virtualBucket,
      index.indexKind,
      index.normalizationVersion,
      index.hmacKeyGeneration,
      index.digest,
      TENANT,
      ACCOUNT,
      NOW - 4 * 3600,
      NOW - 4 * 3600
    );
}

beforeEach(async () => {
  core = openCoreStore(TENANT);
  lookup = new DatabaseSync(':memory:');
  lookup.exec(
    renderPortableMigrationSql(
      readFileSync(
        new URL('../../../../migrations/lookup/d1/001_0_5_0_lookup_baseline.sql', import.meta.url),
        'utf8'
      ),
      'sqlite'
    )
  );
  accountIndex = await createLookupBlindIndex('account_id', ACCOUNT, KEY);
  email = await createLookupBlindIndex('email_exact', 'person@example.com', KEY);
  // Written, never published: its account row pending, its creation's publication pending.
  core.db
    .prepare(
      `INSERT INTO identity_accounts (id, tenant_id, account_type, lifecycle_state, legacy_user_id,
         created_at, updated_at, directory_publication_state)
       VALUES (?, ?, 'user', 'active', ?, 1, 1, 'pending')`
    )
    .run(ACCOUNT, TENANT, USER);
  core.db
    .prepare(
      `INSERT INTO account_routing_outbox (outbox_id, tenant_id, account_id, event_kind,
         route_generation, route_schema_version, hmac_key_generation, payload_json, status,
         created_at, updated_at)
       VALUES ('created-1', ?, ?, 'account_created', 1, 1, 1, ?, 'pending', 1, 1)`
    )
    .run(TENANT, ACCOUNT, JSON.stringify(await creation()));
  // What the creation reserved and routed in Lookup, never activated.
  lookup
    .prepare(
      `INSERT INTO lookup_identifier_reservations (virtual_bucket, tenant_id, index_kind,
         normalization_version, hmac_key_generation, identifier_blind_digest, account_id,
         reservation_state, operation_id, lease_expires_at, created_at, updated_at)
       VALUES (?, ?, 'email_exact', ?, ?, ?, ?, 'reserved', 'operation-unpublished', ?, ?, ?)`
    )
    .run(
      email.virtualBucket,
      TENANT,
      email.normalizationVersion,
      email.hmacKeyGeneration,
      email.digest,
      ACCOUNT,
      NOW - 2 * 3600,
      NOW - 4 * 3600,
      NOW - 4 * 3600
    );
  lookupRoute(accountIndex);
  lookupRoute(email);
});

describe("an unpublished account's directory removal", () => {
  it('releases what its creation reserved and disables its pending routes', async () => {
    const pii = { queryOne: async () => null, query: async () => [] } as unknown as DatabaseAdapter;
    const coreAdapter = { ...core.adapter, getType: () => 'd1' };
    const removals = await prepareUnpublishedAccountDirectoryRemoval(
      {} as Env,
      { tenantId: TENANT, userId: USER, core: coreAdapter, pii, creation: await creation() },
      NOW
    );
    expect(removals).toHaveLength(1);
    for (const removal of removals) {
      await markAccountDirectoryRemovalReady(coreAdapter, removal.operationId, NOW);
    }

    const coordinator = new AccountDirectoryRemovalCoordinator({
      tenantCore: d1(core.db),
      lookupForBucket: async () => d1(lookup),
      now: () => NOW,
    });
    for (const removal of removals) {
      await expect(coordinator.remove(removal)).resolves.toMatchObject({ status: 201 });
    }

    expect(
      lookup
        .prepare(
          `SELECT account_id, reservation_state FROM lookup_identifier_reservations
            WHERE index_kind = 'email_exact'`
        )
        .all()
    ).toEqual([{ account_id: ACCOUNT, reservation_state: 'released' }]);
    expect(
      lookup
        .prepare('SELECT index_kind, lifecycle_state FROM lookup_identifiers ORDER BY index_kind')
        .all()
    ).toEqual([
      { index_kind: 'account_id', lifecycle_state: 'disabled' },
      { index_kind: 'email_exact', lifecycle_state: 'disabled' },
    ]);
    expect(
      core.db
        .prepare(`SELECT status FROM account_routing_outbox WHERE event_kind = 'account_deleted'`)
        .all()
    ).toEqual([{ status: 'succeeded' }]);
  });
});
