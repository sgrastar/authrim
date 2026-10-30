import { logProducerFixture } from '../../../../test/helpers/log-iceberg-producer-fixture.mjs';
import type { LogIcebergReadScope } from '@authrim/ar-lib-core/services/log-iceberg-read';
import type { LogIcebergSqlRow } from '@authrim/ar-lib-core/services/log-iceberg-row-codec';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CanonicalIdentityRepository,
  CanonicalRuntimeUserWriter,
  createAuditLog,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { renderPortableMigrationSql } from '../../../ar-lib-core/dist/migrations/sql-portability';
import { clearAnonymizedUserIdCache } from '../../../ar-lib-core/dist/services/audit/anonymized-user-id-cache';
import {
  adminAuditLogGetHandler,
  adminAuditLogListHandler,
  adminUserActivityLogHandler,
} from '../admin';
import { eraseAccountPiiAfterDirectoryRemovalPrepared } from '../account-directory-removal-producer';
import { writeAccountTombstone } from '../account-tombstone-write';
import { DatabaseSync, type SQLiteDatabase, type SQLInputValue } from './test-sqlite';
import { d1OverSqlite } from './helpers/d1-over-sqlite';
import { listAccountOperationsHandler } from '../account-operations';
import { recordAccountOperation } from '../account-operation-log';
import { emitLogIcebergRow } from '@authrim/ar-lib-core/services/log-iceberg-emitter';

/**
 * The admin activity log reads the canonical encrypted event dataset, while account identity and
 * pseudonym resolution use the real, separate Core/PII schemas.
 */

vi.mock('@authrim/ar-lib-core/services/log-iceberg-read', () => ({
  readLogIcebergDataset: async (
    env: Env & { testLogRows: (dataset: string) => Promise<LogIcebergSqlRow[]> },
    input: LogIcebergReadScope
  ) => ({
    rows: (await env.testLogRows(input.sourceDataset)).filter(
      (row) =>
        row.tenant_id === input.tenantId &&
        (!input.eventId || row.id === input.eventId) &&
        (input.fromMs === undefined || Number(row.created_at) >= input.fromMs) &&
        (input.toMs === undefined || Number(row.created_at) <= input.toMs)
    ),
    hasArchive: false,
    consistency: 'snapshot',
    pendingDeliveries: 0,
  }),
  loadLogIcebergProtectedDetail: vi.fn(async () => null),
}));

const routes = vi.hoisted(() => ({
  accounts: new Map<string, { piiDb: unknown } & Record<string, unknown>>(),
  tenantPiiStores: [] as unknown[],
  inactive: new Set<string>(),
}));

// Session authentication is covered by account-operations.test.ts. Here the fixture supplies
// the authenticated account and the same routed context that requireAccountSession establishes.
vi.mock('../account-page', async (original) => ({
  ...(await original<typeof import('../account-page')>()),
  requireAccountSession: async (c: {
    req: { header(name: string): string | undefined };
    set(name: string, value: unknown): void;
  }) => {
    const userId = c.req.header('x-test-account-user') ?? 'user-1';
    const account = routes.accounts.get(userId);
    if (!account) throw new Error('fixture account absent');
    c.set('accountDataContext', account);
    return { userId };
  },
}));

vi.mock(
  '../../../ar-lib-core/dist/services/tenant-database-resolver.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../../ar-lib-core/dist/services/tenant-database-resolver.js')
    >()),
    // The tenant's PII stores, as the runtime registry lists them.
    resolveTenantAssignedDatabaseSourcesFromRegistry: vi.fn(async () =>
      routes.tenantPiiStores.map((source) => ({ source }))
    ),
  })
);

vi.mock('../../../ar-lib-core/dist/services/runtime-data-context.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../ar-lib-core/dist/services/runtime-data-context.js')
    >();
  // The account route (Lookup) is not under test: each known user routes to its databases.
  const resolve = (accountId: string) => {
    const account = routes.accounts.get(accountId);
    if (!account) throw new Error('account_data_route_not_found');
    return account as { piiDb: unknown };
  };
  return {
    ...actual,
    resolveAccountDataContext: vi.fn(async (_env: Env, input: { accountId: string }) =>
      resolve(input.accountId)
    ),
    resolveAccountPiiSourceForAudit: vi.fn(
      async (_env: Env, input: { accountId: string }) => resolve(input.accountId).piiDb
    ),
    resolveAccountDataContextFromHono: vi.fn(
      async (c: { set(key: string, value: unknown): void }, accountId: string) => {
        // Account contexts are for active accounts; the audit pseudonym route is not.
        if (routes.inactive.has(accountId)) {
          throw new Error('lookup_destination_revalidation_failed', { cause: 'account_inactive' });
        }
        const account = resolve(accountId);
        c.set('accountDataContext', account);
        return account;
      }
    ),
  };
});

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

let databases: SQLiteDatabase[] = [];
let loggingFixtures: Awaited<ReturnType<typeof logProducerFixture>>[] = [];

function database(family: 'core' | 'pii'): {
  db: SQLiteDatabase;
  adapter: DatabaseAdapter;
  d1: D1Database;
} {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  const dir = new URL(`../../../../migrations/${family}/d1/`, import.meta.url);
  for (const file of [`001_0_5_0_${family}_baseline.sql`]) {
    db.exec(renderPortableMigrationSql(readFileSync(new URL(file, dir), 'utf8'), 'sqlite'));
  }
  const adapter = {
    query: async <T>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).all(...((params as SQLInputValue[]) ?? [])) as T[],
    queryOne: async <T>(sql: string, params: unknown[] = []) =>
      (db.prepare(sql).get(...((params as SQLInputValue[]) ?? [])) ?? null) as T | null,
    execute: async (sql: string, params: unknown[] = []) => ({
      success: true,
      rowsAffected: Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes),
    }),
    batch: async (statements: Array<{ sql: string; params?: unknown[] }>) => {
      db.exec('BEGIN');
      try {
        const results = statements.map((statement) => ({
          success: true,
          rowsAffected: Number(
            db.prepare(statement.sql).run(...((statement.params ?? []) as SQLInputValue[])).changes
          ),
        }));
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    transaction: () => Promise.reject(new Error('unused')),
    isHealthy: async () => true,
    getType: () => 'd1',
    close: async () => {},
  } as unknown as DatabaseAdapter;
  return { db, adapter, d1: d1OverSqlite(db) };
}

async function setup() {
  const logging = await logProducerFixture('scheduled', {
    tenantId: 'default',
    separateAdmin: true,
  });
  loggingFixtures.push(logging);
  const core = database('core');
  const pii = database('pii');
  // The tenant's default PII binding; the users' mappings are in their routed store.
  const defaultPii = database('pii');
  const writer = new CanonicalRuntimeUserWriter(
    new CanonicalIdentityRepository(core.adapter, 'default'),
    pii.adapter
  );
  for (const userId of ['user-1', 'user-2']) {
    await writer.createFromRuntimeUser({
      tenantId: 'default',
      userId,
      active: true,
      emailVerified: true,
      userType: 'end_user',
      piiFields: { email: true },
      sensitiveValues: { email: `${userId}@example.com` },
    });
    routes.accounts.set(userId, {
      tenantId: 'default',
      accountId: `account:${userId}`,
      legacyUserId: userId,
      coreDb: core.d1,
      piiDb: pii.d1,
      userCacheScope: { routeGeneration: 'a:1', bindingGeneration: 'b:1', schemaGeneration: 's:1' },
      piiCacheMode: 'disabled',
    });
  }
  // D1 bindings, as the audit hot query and the audit service take them in production.
  const env = {
    ...logging.env,
    DB: core.d1,
    DB_PII: defaultPii.d1,
    testLogRows: (dataset: string) => logging.rows(dataset, 'default'),
  } as unknown as Env;

  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    c.set('tenantId' as never, 'default' as never);
    c.set('tenantMetadataContext' as never, { tenantId: 'default', coreDb: core.d1 } as never);
    await next();
  });
  app.get('/account/operations', listAccountOperationsHandler);
  app.post('/test-operation/:id', async (c) => {
    await recordAccountOperation(c, {
      userId: c.req.param('id'),
      action: 'account.profile.name_updated',
      resourceType: 'account_profile',
      resourceId: 'profile-resource',
      metadata: { fields: ['name'] },
      required: true,
    });
    return c.json({ recorded: true });
  });
  app.get('/users/:id/activity-log', adminUserActivityLogHandler);
  app.get('/audit-log', adminAuditLogListHandler);
  app.get('/audit-log/:id', adminAuditLogGetHandler);
  routes.tenantPiiStores = [pii.d1];
  const activity = async (userId: string) => {
    const response = await app.request(`/users/${userId}/activity-log`, {}, env);
    expect(response.status).toBe(200);
    return (await response.json()) as {
      data: Array<{ id: string; action: string; details: Record<string, unknown> }>;
    };
  };
  const auditList = async () => {
    const response = await app.request('/audit-log', {}, env);
    expect(response.status).toBe(200);
    return (await response.json()) as { entries: Array<{ id: string; userId: string | null }> };
  };
  const auditEntry = async (id: string) => {
    const response = await app.request(`/audit-log/${id}`, {}, env);
    expect(response.status).toBe(200);
    return (await response.json()) as { id: string; userId: string | null };
  };
  const pending: Promise<unknown>[] = [];
  const signIn = async (id: string, userId: string) => {
    await createAuditLog(
      env,
      {
        id,
        tenantId: 'default',
        userId: 'system',
        action: 'auth.passkey.succeeded',
        resource: 'auth',
        resourceId: 'passkey-auth',
        ipAddress: 'system',
        userAgent: 'event-dispatcher',
        severity: 'info',
        metadata: JSON.stringify({ userId, method: 'passkey', clientId: 'client-a' }),
      },
      { waitUntil: (promise) => pending.push(promise) }
    );
    await Promise.all(pending.splice(0));
  };
  const erase = async (userId: string) => {
    // As user deletion and anonymization do: the tombstone, then the account's PII.
    await writeAccountTombstone(pii.adapter, {
      tenantId: 'default',
      userId,
      prepared: { emailBlindIndex: null, retentionDays: 90 },
      deletedBy: 'admin',
      reason: 'admin_action',
      metadata: {},
    });
    await eraseAccountPiiAfterDirectoryRemovalPrepared(pii.adapter, {
      tenantId: 'default',
      userId,
      core: core.adapter,
    });
  };
  const mapping = (userId: string) =>
    pii.db
      .prepare('SELECT anonymized_user_id FROM user_anonymization_map WHERE user_id = ?')
      .get(userId) as { anonymized_user_id: string } | undefined;
  const accountHistoryResponse = (userId: string, query = '') =>
    app.request(`/account/operations${query}`, { headers: { 'x-test-account-user': userId } }, env);
  const accountHistory = async (userId: string) => {
    const response = await accountHistoryResponse(userId);
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    if (!isObject(body) || !Array.isArray(body.operations) || !body.operations.every(isObject))
      throw new Error('operation response invalid');
    return { operations: body.operations };
  };
  const accountOperation = async (userId: string) => {
    expect((await app.request(`/test-operation/${userId}`, { method: 'POST' }, env)).status).toBe(
      200
    );
  };
  return {
    env,
    activity,
    auditList,
    auditEntry,
    signIn,
    erase,
    mapping,
    core,
    logging,
    accountHistory,
    accountOperation,
    accountHistoryResponse,
  };
}

beforeEach(() => {
  clearAnonymizedUserIdCache();
  routes.accounts.clear();
  routes.inactive.clear();
  databases = [];
  loggingFixtures = [];
});
afterEach(() => {
  for (const db of databases) db.close();
  for (const fixture of loggingFixtures) fixture.close();
});

describe('admin user activity log (unified event_log)', () => {
  it("lists an audited sign-in in the user's activity log, and only in that user's", async () => {
    const { env, activity, core, logging } = await setup();
    const pending: Promise<unknown>[] = [];

    await createAuditLog(
      env,
      {
        id: 'evt_sign_in_user_1',
        tenantId: 'default',
        userId: 'system',
        action: 'auth.passkey.succeeded',
        resource: 'auth',
        resourceId: 'passkey-auth',
        ipAddress: 'system',
        userAgent: 'event-dispatcher',
        severity: 'info',
        metadata: JSON.stringify({
          userId: 'user-1',
          method: 'passkey',
          clientId: 'client-a',
          sessionId: 'sess-1',
        }),
      },
      { waitUntil: (promise) => pending.push(promise) }
    );
    await Promise.all(pending);

    const listed = await activity('user-1');
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]).toMatchObject({
      id: 'evt_sign_in_user_1',
      action: 'auth.passkey.succeeded',
      details: expect.objectContaining({
        method: 'passkey',
        result: 'success',
        client_id: 'client-a',
        session_id: expect.stringMatching(/^sid_[0-9a-f]{64}$/u),
      }),
    });
    // No raw user ID in the stored details.
    const stored = (await logging.rows('core.event_log', 'default')).find(
      (row) => row.id === 'evt_sign_in_user_1'
    );
    expect(stored?.details_json).toEqual(expect.any(String));
    expect(stored?.details_json).not.toContain('user-1');
    expect(core.db.prepare('SELECT count(*) n FROM event_log').get()).toMatchObject({ n: 0 });

    expect((await activity('user-2')).data).toEqual([]);
  });

  it('names the user in the audit list and entry, across the tenant PII stores', async () => {
    const { auditList, auditEntry, signIn } = await setup();
    await signIn('evt_listed', 'user-1');

    expect((await auditList()).entries).toEqual([
      expect.objectContaining({ id: 'evt_listed', userId: 'user-1' }),
    ]);
    expect(await auditEntry('evt_listed')).toMatchObject({ id: 'evt_listed', userId: 'user-1' });
  });

  it('records and shows the entry of a suspended user', async () => {
    const { auditEntry, signIn, mapping } = await setup();
    routes.inactive.add('user-1');
    await signIn('evt_suspended', 'user-1');

    expect(mapping('user-1')).toBeDefined();
    expect(await auditEntry('evt_suspended')).toMatchObject({
      id: 'evt_suspended',
      userId: 'user-1',
      user: null,
    });
  });

  it('no longer leads to the user once the user is deleted or anonymized', async () => {
    const { activity, auditList, auditEntry, signIn, erase, mapping, logging } = await setup();
    await signIn('evt_before_erasure', 'user-1');
    await signIn('evt_other_user', 'user-2');
    expect((await activity('user-1')).data).toHaveLength(1);

    await erase('user-1');

    expect(mapping('user-1')).toBeUndefined();
    expect(mapping('user-2')).toBeDefined();
    expect((await activity('user-1')).data).toEqual([]);
    expect((await auditEntry('evt_before_erasure')).userId).toBeNull();
    expect((await auditList()).entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'evt_before_erasure', userId: null }),
        expect.objectContaining({ id: 'evt_other_user', userId: 'user-2' }),
      ])
    );

    // An audit written late (after the response that erased the user) creates no mapping again.
    await signIn('evt_late', 'user-1');
    expect(mapping('user-1')).toBeUndefined();
    expect(
      (await logging.rows('core.event_log', 'default')).find((row) => row.id === 'evt_late')
    ).toMatchObject({ anonymized_user_id: null });
    expect((await activity('user-1')).data).toEqual([]);
  });
});

describe('Account Page canonical operation history', () => {
  it('reads actual new account events for the authenticated subject, with the existing response fields and seconds timestamp', async () => {
    const { accountHistory, accountOperation, logging, mapping, env } = await setup();
    await accountOperation('user-1');
    await accountOperation('user-2');
    const [mine] = (await logging.rows('core.event_log', 'default')).filter(
      (row) => row.anonymized_user_id === mapping('user-1')?.anonymized_user_id
    );
    expect(mine).toBeDefined();
    // The same subject value in another tenant may never select that tenant's event.
    await emitLogIcebergRow(env, {
      tenantId: 'tenant-b',
      sourceDataset: 'core.event_log',
      logType: 'audit',
      eventAt: Date.now(),
      expiresAt: null,
      row: { ...mine, id: 'another-tenant-operation', tenant_id: 'tenant-b' },
    });
    const result = await accountHistory('user-1');
    expect(result.operations).toEqual([
      {
        id: mine.id,
        action: 'account.profile.name_updated',
        resource_type: 'account_profile',
        resource_id: 'profile-resource',
        metadata: { fields: ['name'] },
        created_at: Math.floor(Number(mine.created_at) / 1000),
      },
    ]);
    expect((await accountHistory('user-2')).operations).toHaveLength(1);
    expect(result.operations.some((row) => row.id === 'another-tenant-operation')).toBe(false);
  });

  it("rejects another account's continuation cursor before reading its operation history", async () => {
    const { accountHistoryResponse, accountOperation } = await setup();
    await accountOperation('user-1');
    await accountOperation('user-1');
    await accountOperation('user-2');
    const first = await accountHistoryResponse('user-1', '?limit=1');
    expect(first.status).toBe(200);
    const body: unknown = await first.json();
    if (
      !isObject(body) ||
      !isObject(body.pagination) ||
      typeof body.pagination.next_cursor !== 'string'
    )
      throw new Error('continuation missing');
    expect(body.pagination.next_cursor).toEqual(expect.any(String));
    const other = await accountHistoryResponse(
      'user-2',
      `?limit=1&cursor=${encodeURIComponent(body.pagination.next_cursor ?? '')}`
    );
    expect(other.status).toBe(400);
    expect(await other.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('does not report healthy empty history when storage is unavailable after mapping erasure', async () => {
    const { accountHistoryResponse, accountOperation, erase, logging } = await setup();
    await accountOperation('user-1');
    await erase('user-1');
    vi.spyOn(logging, 'rows').mockRejectedValueOnce(new Error('fixture catalog unavailable'));
    const response = await accountHistoryResponse('user-1');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'log_query_incomplete' });
  });

  it('never reattaches an old operation after its subject mapping was erased', async () => {
    const { accountHistory, accountOperation, erase } = await setup();
    await accountOperation('user-1');
    expect((await accountHistory('user-1')).operations).toHaveLength(1);
    await erase('user-1');
    expect((await accountHistory('user-1')).operations).toEqual([]);
  });
});
