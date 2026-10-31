/**
 * Actual context helpers, canonical account/PII repositories, status transactions and PII audit
 * SQL. Lookup/registry, SessionStore/lifecycle DO transport, operational-log delivery and backup
 * effect scheduling are explicit seams; signed route verification and DO internals have their
 * own integration suites. No account context is injected into these admin requests.
 */
const piiLogRows = vi.hoisted(() => [] as Array<import('@authrim/ar-lib-core').PIIAuditLog>);
vi.mock('../../../ar-lib-core/dist/repositories/pii/audit-log', async (original) => ({
  ...(await original<typeof import('../../../ar-lib-core/dist/repositories/pii/audit-log')>()),
  writePiiAccessAuditRows: async (
    _env: unknown,
    _tenantId: string,
    rows: import('@authrim/ar-lib-core').PIIAuditLog[]
  ) => {
    piiLogRows.push(...structuredClone(rows));
  },
}));
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CanonicalRuntimeUserStore,
  type DatabaseAdapter,
  type Env,
  type PreparedStatement,
  type Session,
} from '@authrim/ar-lib-core';
import { renderPortableMigrationSql } from '../../../ar-lib-core/dist/migrations/sql-portability';
import { DatabaseSync, type SQLInputValue, type SQLiteDatabase } from './test-sqlite';

type Store = { db: SQLiteDatabase; adapter: DatabaseAdapter };
type Route = {
  tenantId: string;
  legacyUserId: string;
  coreBindingRef: string;
  piiBindingRef: string;
};
const TENANT = 'tenant-a';
const USER = 'user-1';
const SESSION = 'g1:apac:1:session_admin';
const state = vi.hoisted(() => ({
  stores: [] as Array<{ bindingRef: string; source: DatabaseAdapter }>,
  routes: new Map<string, Route[]>(),
  find: vi.fn(),
  transitions: vi.fn(),
  authState: new Map<string, string>(),
  revocations: vi.fn(),
  sessionGet: vi.fn(),
  sessionDelete: vi.fn(),
  logout: vi.fn(),
  operational: vi.fn(),
  audit: vi.fn(),
  pending: [] as Promise<unknown>[],
  beforeTransition: undefined as
    | ((input: { userId: string; lifecycle: string }) => void)
    | undefined,
}));
vi.mock('../cross-shard-account-list', async (original) => ({
  ...(await original<typeof import('../cross-shard-account-list')>()),
  CrossShardAccountExactSearchService: class {
    async findAdminContacts(input: { tenantId: string; userIds: readonly string[] }) {
      const entries = await Promise.all(
        input.userIds.map(async (identifier) => {
          const matches = await this.find({
            tenantId: input.tenantId,
            identifier,
            purpose: 'admin_view',
            indexKind: 'account_id',
          });
          if (matches.length > 1) throw new Error('cross_shard_account_search_ambiguous');
          return matches[0] ? ([identifier, matches[0]] as const) : null;
        })
      );
      return new Map(entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null));
    }
    find(input: { tenantId: string; identifier: string; purpose: string; indexKind: string }) {
      state.find(input);
      if (input.purpose !== 'admin_view' || input.indexKind !== 'account_id') {
        throw new Error('authentication_route_used_for_admin');
      }
      return Promise.resolve(state.routes.get(`${input.tenantId}:${input.identifier}`) ?? []);
    }
  },
}));
vi.mock('@authrim/ar-lib-core', async (original) => {
  const actual = await original<typeof import('@authrim/ar-lib-core')>();
  const transition = async (_env: unknown, input: { userId: string; lifecycle: string }) => {
    state.beforeTransition?.(input);
    state.transitions(input);
    state.authState.set(input.userId, input.lifecycle);
    return { lifecycle: input.lifecycle };
  };
  return {
    ...actual,
    resolveTenantAssignedDatabaseSourcesFromRegistry: async () => state.stores,
    readAccountAuthenticationState: async (_env: unknown, _tenant: string, userId: string) => ({
      lifecycle: state.authState.get(userId) ?? 'active',
      lifecycleOperationId: null,
      lifecycleVersionMs: null,
    }),
    transitionAccountAuthenticationState: transition,
    transitionAccountAuthenticationStateEndingSessions: async (
      env: unknown,
      input: { userId: string; lifecycle: string }
    ) => ({
      state: await transition(env, input),
      endedSessionIds: [`${input.userId}-ended`],
    }),
    recordUserSessionRevocationEndingSessions: state.revocations,
    getSessionStoreBySessionId: () => ({
      stub: { getSessionRpc: state.sessionGet, invalidateSessionRpc: state.sessionDelete },
    }),
    createAuditLogFromContext: state.audit,
    storeOperationalLog: state.operational,
    getOperationalLogRetentionDays: async () => 90,
    schedulePiiAccessLog: async (
      _env: unknown,
      execution: { waitUntil(promise: Promise<unknown>): void } | undefined,
      access: { write(env: unknown): Promise<unknown> }
    ) => {
      const promise = access.write(_env);
      execution?.waitUntil(promise);
      await promise;
    },
  };
});
vi.mock('../admin-session-end', async (original) => ({
  ...(await original<typeof import('../admin-session-end')>()),
  startAdminSessionEndLogout: state.logout,
}));
vi.mock('../admin-shared', async (original) => ({
  ...(await original<typeof import('../admin-shared')>()),
  scheduleAdminAuditLog: vi.fn(),
  logSanitizedError: vi.fn(),
}));
import { adminUserActivateHandler, adminUserLockHandler, adminUserSuspendHandler } from '../admin';
import {
  adminSessionGetHandler,
  adminSessionRevokeHandler,
  adminSessionsListHandler,
  adminUserRevokeAllSessionsHandler,
} from '../admin-user-sessions';

function openStore(family: 'core' | 'pii'): Store {
  const db = new DatabaseSync(':memory:');
  const migrations = new URL(`../../../../migrations/${family}/d1/`, import.meta.url);
  for (const name of [`001_0_5_0_${family}_baseline.sql`]) {
    db.exec(renderPortableMigrationSql(readFileSync(new URL(name, migrations), 'utf8'), 'sqlite'));
  }
  db.exec('PRAGMA foreign_keys=ON');
  const values = (params: unknown[] = []) =>
    params.map((value) => (value === undefined ? null : value) as SQLInputValue);
  const execute = (statement: PreparedStatement) => ({
    success: true,
    rowsAffected: Number(db.prepare(statement.sql).run(...values(statement.params)).changes),
  });
  const adapter = {
    query: async (sql: string, params?: unknown[]) => db.prepare(sql).all(...values(params)),
    queryOne: async (sql: string, params?: unknown[]) =>
      db.prepare(sql).get(...values(params)) ?? null,
    execute: async (sql: string, params?: unknown[]) => execute({ sql, params }),
    batch: async (statements: PreparedStatement[]) => {
      db.exec('BEGIN');
      try {
        const results = statements.map(execute);
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    transaction: async (operation: (tx: DatabaseAdapter) => Promise<unknown>) => {
      db.exec('BEGIN');
      try {
        const result = await operation(adapter);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    isHealthy: async () => ({ healthy: true, latencyMs: 0, type: 'sqlite' }),
    getType: () => 'sqlite',
    close: async () => db.close(),
  } as DatabaseAdapter;
  return { db, adapter };
}

for (const topology of ['shared_pool', 'tenant_exclusive', 'single'] as const) {
  describe(`admin account status and sessions: ${topology} (real SQL)`, () => {
    let metadata: Store,
      account: Store,
      second: Store,
      pii: Store,
      secondPii: Store,
      defaultPii: Store;
    let env: Env;
    let app: Hono<{ Bindings: Env }>;
    const stores: Store[] = [];
    const open = (family: 'core' | 'pii') => {
      const result = openStore(family);
      stores.push(result);
      return result;
    };
    function coreStatus(store = account, user = USER): string {
      return (
        store.db
          .prepare(
            'SELECT lifecycle_state FROM identity_accounts WHERE tenant_id=? AND legacy_user_id=?'
          )
          .get(TENANT, user) as { lifecycle_state: string }
      ).lifecycle_state;
    }
    async function seed(
      core: Store,
      personal: Store,
      user = USER,
      tenant = TENANT,
      email = `${user}@example.test`
    ) {
      await new CanonicalRuntimeUserStore({
        coreAdapter: core.adapter,
        piiAdapter: personal.adapter,
        tenantId: tenant,
      }).syncUser({
        userId: user,
        active: true,
        emailVerified: true,
        piiFields: { email: true, name: true },
        sensitiveValues: { email, name: `Name ${user}` },
      });
      core.db
        .prepare(
          "UPDATE identity_accounts SET directory_publication_state='active' WHERE tenant_id=? AND legacy_user_id=?"
        )
        .run(tenant, user);
    }
    function restrict(status: string, user = USER, store = account) {
      store.db
        .prepare(
          'UPDATE identity_accounts SET lifecycle_state=?,metadata_json=? WHERE tenant_id=? AND legacy_user_id=?'
        )
        .run(status, JSON.stringify({ status }), TENANT, user);
      store.db
        .prepare(
          'UPDATE identity_subjects SET lifecycle_state=? WHERE tenant_id=? AND id=(SELECT primary_subject_id FROM identity_accounts WHERE tenant_id=? AND legacy_user_id=?)'
        )
        .run(status, TENANT, TENANT, user);
      state.authState.set(user, status);
    }
    function persisted(id = SESSION, user = USER, tenant = TENANT) {
      const now = Math.floor(Date.now() / 1000);
      // This legacy table still references users_core. Only this compatibility fixture creates
      // that required reference row; canonical account reads must never use it for identity.
      metadata.db
        .prepare(
          'INSERT INTO users_core(id,tenant_id,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING'
        )
        .run(user, tenant, now, now);
      metadata.db
        .prepare(
          'INSERT INTO sessions(id,tenant_id,user_id,created_at,expires_at) VALUES(?,?,?,?,?)'
        )
        .run(id, tenant, user, now, now + 3600);
    }
    function live(overrides: Partial<Session> = {}): Session {
      return {
        id: SESSION,
        tenantId: TENANT,
        userId: USER,
        accountId: `account:${USER}`,
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
        revocationAuthority: 'user-session-do-v1',
        revocationBoundAtMs: Date.now(),
        ...overrides,
      };
    }
    async function request(path: string, method = 'GET', body?: unknown) {
      const response = await app.request(
        path,
        {
          method,
          headers: { 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        env,
        {
          waitUntil: (promise) => {
            state.pending.push(promise);
          },
          passThroughOnException: () => undefined,
          props: {},
        }
      );
      await Promise.all(state.pending.splice(0));
      return response;
    }
    beforeEach(async () => {
      piiLogRows.length = 0;

      vi.clearAllMocks();
      state.routes.clear();
      state.authState.clear();
      state.pending = [];
      state.beforeTransition = undefined;
      state.sessionGet.mockReset().mockResolvedValue(null);
      state.sessionDelete.mockReset().mockResolvedValue(true);
      state.revocations
        .mockReset()
        .mockResolvedValue({ endedSessionIds: ['user-1-ended'], revokedAfterMs: Date.now() });
      state.operational.mockReset().mockResolvedValue(undefined);
      state.audit.mockReset().mockResolvedValue(undefined);
      state.logout.mockReset().mockResolvedValue(undefined);
      metadata = open('core');
      account = topology === 'single' ? metadata : open('core');
      second = open('core');
      pii = open('pii');
      secondPii = open('pii');
      defaultPii = topology === 'single' ? pii : open('pii');
      env = {
        DB_PII: defaultPii.adapter,
        ACCOUNT_CORE: account.adapter,
        ACCOUNT_PII: pii.adapter,
        SECOND_CORE: second.adapter,
        SECOND_PII: secondPii.adapter,
        PII_ENCRYPTION_KEY: 'a'.repeat(64),
      } as unknown as Env;
      state.stores = [
        { bindingRef: 'ACCOUNT_CORE', source: account.adapter },
        { bindingRef: 'SECOND_CORE', source: second.adapter },
      ];
      state.routes.set(`${TENANT}:${USER}`, [
        {
          tenantId: TENANT,
          legacyUserId: USER,
          coreBindingRef: 'ACCOUNT_CORE',
          piiBindingRef: 'ACCOUNT_PII',
        },
      ]);
      await seed(account, pii);
      if (topology !== 'single')
        await seed(metadata, defaultPii, USER, TENANT, 'metadata-decoy@example.test');
      app = new Hono<{ Bindings: Env }>();
      app.use('*', async (c, next) => {
        c.set('tenantId' as never, TENANT as never);
        c.set(
          'tenantMetadataContext' as never,
          {
            tenantId: TENANT,
            coreDb: metadata.adapter,
            ...(topology === 'single'
              ? {}
              : { route: { allocationScope: topology, bindingRef: 'METADATA' } }),
          } as never
        );
        c.set(
          'adminAuth' as never,
          { userId: 'admin-1', actorType: 'human', authMethod: 'admin_session' } as never
        );
        await next();
      });
      app.post('/users/:id/suspend', adminUserSuspendHandler);
      app.post('/users/:id/lock', adminUserLockHandler);
      app.post('/users/:id/activate', adminUserActivateHandler);
      app.delete('/users/:id/sessions', adminUserRevokeAllSessionsHandler);
      app.get('/sessions', adminSessionsListHandler);
      app.get('/sessions/:id', adminSessionGetHandler);
      app.delete('/sessions/:id', adminSessionRevokeHandler);
    });
    afterEach(() => {
      for (const store of stores.splice(0)) store.db.close();
      vi.restoreAllMocks();
    });

    it.each([
      ['suspend', 'suspended'],
      ['lock', 'locked'],
    ] as const)(
      'updates only the owning account and subject: %s, DO-first',
      async (action, expected) => {
        state.beforeTransition = (input) => {
          expect(input.lifecycle).toBe(expected);
          expect(coreStatus()).toBe('active');
        };
        const response = await request(`/users/${USER}/${action}`, 'POST', {
          reason_code: 'admin_action',
          reason_detail: 'local fixture reason',
        });
        expect(response.status).toBe(200);
        expect(coreStatus()).toBe(expected);
        expect(
          account.db
            .prepare('SELECT lifecycle_state FROM identity_subjects WHERE tenant_id=?')
            .all(TENANT)
        ).toEqual([{ lifecycle_state: expected }]);
        const transition = state.transitions.mock.calls[0]?.[0] as {
          sourceVersionMs: number;
          operationId: string;
        };
        const accountMetadata = account.db
          .prepare(
            'SELECT metadata_json FROM identity_accounts WHERE tenant_id=? AND legacy_user_id=?'
          )
          .get(TENANT, USER) as { metadata_json: string };
        expect(JSON.parse(accountMetadata.metadata_json)).toMatchObject({
          lifecycle_version_ms: transition.sourceVersionMs,
          lifecycle_operation_id: transition.operationId,
        });
        if (topology !== 'single') expect(coreStatus(metadata)).toBe('active');
        expect(state.operational.mock.calls[0]?.[0]).toBe(env);
        expect(state.audit).toHaveBeenCalledWith(
          expect.anything(),
          `user.${action}`,
          'user',
          USER,
          expect.anything()
        );
        const auditDetails = state.audit.mock.calls[0]?.[4] as Record<string, unknown>;
        expect(auditDetails).not.toHaveProperty('reason_detail');
        const logout = state.logout.mock.calls[0]?.[1] as {
          tenantId: string;
          sessions: Array<{ userId: string; sessionId: string }>;
          trigger: { action: string };
        };
        expect(logout).toMatchObject({
          tenantId: TENANT,
          sessions: [{ userId: USER, sessionId: `${USER}-ended` }],
          trigger: { action: `user.${action}` },
        });
      }
    );
    it.each(['suspended', 'locked'])(
      'reactivates a %s owner DB-first and preserves PII',
      async (prior) => {
        restrict(prior);
        state.beforeTransition = (input) => {
          expect(input.lifecycle).toBe('active');
          expect(coreStatus()).toBe('active');
        };
        expect(
          (await request(`/users/${USER}/activate`, 'POST', { reason_code: 'admin_action' })).status
        ).toBe(200);
        expect(coreStatus()).toBe('active');
        expect(state.authState.get(USER)).toBe('active');
        expect(
          pii.db
            .prepare('SELECT owner_id FROM identity_sensitive_values WHERE tenant_id=?')
            .all(TENANT).length
        ).toBeGreaterThan(0);
      }
    );
    it('keeps the account active when the disable DO transition fails', async () => {
      state.beforeTransition = () => {
        throw new Error('DO unavailable');
      };
      expect(
        (await request(`/users/${USER}/suspend`, 'POST', { reason_code: 'admin_action' })).status
      ).toBe(500);
      expect(coreStatus()).toBe('active');
      expect(state.audit).not.toHaveBeenCalled();
    });
    it('does not reenable authentication when the account activation batch fails', async () => {
      restrict('locked');
      vi.spyOn(account.adapter, 'batch').mockRejectedValueOnce(new Error('account unavailable'));
      expect(
        (await request(`/users/${USER}/activate`, 'POST', { reason_code: 'admin_action' })).status
      ).toBe(500);
      expect(coreStatus()).toBe('locked');
      expect(state.authState.get(USER)).toBe('locked');
      expect(state.transitions).not.toHaveBeenCalled();
    });
    it('does not require PII to revoke an inactive account, and preserves epoch/logout/audit', async () => {
      restrict('suspended');
      delete (env as unknown as Record<string, unknown>).DB_PII;
      delete (env as unknown as Record<string, unknown>).ACCOUNT_PII;
      persisted();
      persisted('foreign-session', USER, 'tenant-b');
      const response = await request(`/users/${USER}/sessions`, 'DELETE');
      expect(response.status).toBe(200);
      expect(state.find).not.toHaveBeenCalled();
      expect(state.revocations).toHaveBeenCalledWith(env, TENANT, USER, expect.any(Number));
      expect(state.logout).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ sessions: [{ userId: USER, sessionId: 'user-1-ended' }] })
      );
      expect(metadata.db.prepare('SELECT id FROM sessions').all()).toEqual([
        { id: 'foreign-session' },
      ]);
      expect(state.audit).toHaveBeenCalledWith(
        expect.anything(),
        'user.sessions_revoked',
        'user',
        USER,
        expect.anything()
      );
    });
    it('does not mutate another tenant or use the metadata decoy when no account owner exists', async () => {
      await seed(second, secondPii, 'foreign-user', 'tenant-b');
      expect(
        (await request('/users/foreign-user/suspend', 'POST', { reason_code: 'admin_action' }))
          .status
      ).toBe(404);
      expect((await request('/users/missing/sessions', 'DELETE')).status).toBe(404);
      expect(state.transitions).not.toHaveBeenCalled();
      expect(state.revocations).not.toHaveBeenCalled();
    });
    if (topology !== 'single') {
      it('does not use a metadata account decoy when its user-store owner is absent', async () => {
        state.stores = [];
        expect(
          (await request(`/users/${USER}/suspend`, 'POST', { reason_code: 'admin_action' })).status
        ).toBe(404);
        expect(state.transitions).not.toHaveBeenCalled();
        expect(coreStatus(metadata)).toBe('active');
      });
      it('never falls back to default PII when the routed personal binding is missing', async () => {
        persisted();
        delete (env as unknown as Record<string, unknown>).ACCOUNT_PII;
        const fallbackRead = vi.spyOn(defaultPii.adapter, 'queryOne');
        expect((await request(`/sessions/${SESSION}`)).status).toBe(500);
        expect(fallbackRead).not.toHaveBeenCalled();
      });
      it.each([
        ['cross_shard_account_pii_owner_invalid', 200],
        ['route_storage_unavailable', 500],
      ] as const)('handles contact lookup failure %s without reading PII', async (code, status) => {
        persisted();
        state.find.mockImplementationOnce(() => {
          throw new Error(code);
        });
        const ownerRead = vi.spyOn(pii.adapter, 'queryOne');
        const fallbackRead = vi.spyOn(defaultPii.adapter, 'queryOne');
        const response = await request(`/sessions/${SESSION}`);
        expect(response.status).toBe(status);
        if (status === 200) {
          expect(await response.json()).toMatchObject({
            session: { userEmail: null, userName: null },
          });
        }
        expect(ownerRead).not.toHaveBeenCalled();
        expect(fallbackRead).not.toHaveBeenCalled();
        expect(pii.db.prepare('SELECT id FROM audit_log_pii').all()).toEqual([]);
      });
      it('refuses ambiguous Core ownership before the lifecycle DO is changed', async () => {
        await seed(second, secondPii);
        expect(
          (await request(`/users/${USER}/lock`, 'POST', { reason_code: 'admin_action' })).status
        ).toBe(500);
        expect(state.transitions).not.toHaveBeenCalled();
        expect(coreStatus()).toBe('active');
        expect(coreStatus(second)).toBe('active');
      });
      it('reads a session page across multiple owners and writes access audit in each PII store', async () => {
        await seed(second, secondPii, 'user-2');
        restrict('locked', 'user-2', second);
        state.routes.set(`${TENANT}:user-2`, [
          {
            tenantId: TENANT,
            legacyUserId: 'user-2',
            coreBindingRef: 'SECOND_CORE',
            piiBindingRef: 'SECOND_PII',
          },
        ]);
        persisted();
        persisted('legacy-second', 'user-2');
        const response = await request('/sessions');
        expect(response.status).toBe(200);
        const body = await response.json<{
          sessions: Array<{ user_id: string; user_email: string }>;
        }>();
        expect(new Map(body.sessions.map((item) => [item.user_id, item.user_email]))).toEqual(
          new Map([
            [USER, `${USER}@example.test`],
            ['user-2', 'user-2@example.test'],
          ])
        );
        expect(piiLogRows.map((row) => ({ target_user_id: row.target_user_id }))).toEqual([
          { target_user_id: USER },
          { target_user_id: 'user-2' },
        ]);
        expect(pii.db.prepare('SELECT id FROM audit_log_pii').all()).toEqual([]);
        expect(secondPii.db.prepare('SELECT id FROM audit_log_pii').all()).toEqual([]);
        expect(defaultPii.db.prepare('SELECT id FROM audit_log_pii').all()).toEqual([]);
      });
      it('refuses a mismatched contact route before either PII database is read', async () => {
        persisted();
        state.routes.set(`${TENANT}:${USER}`, [
          {
            tenantId: 'tenant-b',
            legacyUserId: USER,
            coreBindingRef: 'SECOND_CORE',
            piiBindingRef: 'SECOND_PII',
          },
        ]);
        const first = vi.spyOn(pii.adapter, 'queryOne'),
          other = vi.spyOn(secondPii.adapter, 'queryOne');
        expect((await request(`/sessions/${SESSION}`)).status).toBe(500);
        expect(first).not.toHaveBeenCalled();
        expect(other).not.toHaveBeenCalled();
      });
    }
    it('reads a suspended contact from its owner and records field names without values', async () => {
      restrict('suspended');
      persisted();
      const response = await request(`/sessions/${SESSION}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        session: { userEmail: `${USER}@example.test`, userName: `Name ${USER}` },
      });
      const audit = piiLogRows;
      expect(pii.db.prepare('SELECT id FROM audit_log_pii').all()).toEqual([]);
      expect(audit).toHaveLength(1);
      expect(audit[0]?.target_user_id).toBe(USER);
      expect(audit[0]?.details).toContain('user_email');
      expect(audit[0]?.details).not.toContain('@example.test');
    });
    it.each(['foreign_tenant', 'wrong_id'] as const)(
      'rejects an unowned DO session before contact read or invalidation: %s',
      async (mode) => {
        persisted();
        state.sessionGet.mockResolvedValue(
          live(mode === 'foreign_tenant' ? { tenantId: 'tenant-b' } : { id: 'other-id' })
        );
        const piiRead = vi.spyOn(pii.adapter, 'queryOne');
        const legacyRead = vi.spyOn(metadata.adapter, 'queryOne');
        const legacyWrite = vi.spyOn(metadata.adapter, 'execute');
        expect((await request(`/sessions/${SESSION}`)).status).toBe(404);
        expect((await request(`/sessions/${SESSION}`, 'DELETE')).status).toBe(404);
        expect(piiRead).not.toHaveBeenCalled();
        expect(legacyRead).not.toHaveBeenCalled();
        expect(legacyWrite).not.toHaveBeenCalled();
        expect(state.logout).not.toHaveBeenCalled();
        expect(state.find).not.toHaveBeenCalled();
        expect(state.sessionDelete).not.toHaveBeenCalled();
        expect(metadata.db.prepare('SELECT id FROM sessions').all()).toEqual([{ id: SESSION }]);
      }
    );
    it('revokes a DO-only session without requiring PII or creating a legacy row', async () => {
      state.sessionGet.mockResolvedValue(live());
      const legacyRead = vi.spyOn(metadata.adapter, 'queryOne');
      const response = await request(`/sessions/${SESSION}`, 'DELETE');
      expect(response.status).toBe(200);
      expect(state.sessionDelete).toHaveBeenCalledWith(SESSION);
      expect(state.find).not.toHaveBeenCalled();
      expect(legacyRead).not.toHaveBeenCalled();
      expect(state.logout).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ sessions: [{ userId: USER, sessionId: SESSION }] })
      );
      expect(metadata.db.prepare('SELECT id FROM sessions').all()).toEqual([]);
    });
    it('retains logout for a DO invalidation even when legacy SQL cleanup fails', async () => {
      state.sessionGet.mockResolvedValue(live());
      vi.spyOn(metadata.adapter, 'execute').mockRejectedValueOnce(
        new Error('legacy cleanup unavailable')
      );
      expect((await request(`/sessions/${SESSION}`, 'DELETE')).status).toBe(500);
      expect(state.sessionDelete).toHaveBeenCalledWith(SESSION);
      expect(state.logout).toHaveBeenCalledTimes(1);
    });
    it('refuses uncertain DO access without deleting the legacy row or claiming success', async () => {
      persisted();
      state.sessionGet.mockRejectedValueOnce(new Error('DO unavailable'));
      expect((await request(`/sessions/${SESSION}`, 'DELETE')).status).toBe(500);
      expect(metadata.db.prepare('SELECT id FROM sessions').all()).toEqual([{ id: SESSION }]);
      expect(state.sessionDelete).not.toHaveBeenCalled();
      expect(state.logout).not.toHaveBeenCalled();
    });
    it('keeps legacy sessions with no canonical owner free of personal contact data', async () => {
      if (topology === 'single')
        metadata.db
          .prepare('DELETE FROM identity_accounts WHERE tenant_id=? AND legacy_user_id=?')
          .run(TENANT, USER);
      else state.routes.delete(`${TENANT}:${USER}`);
      persisted();
      const response = await request('/sessions');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        sessions: [{ user_email: null, user_name: null, ip_address: null, user_agent: null }],
      });
      expect(pii.db.prepare('SELECT id FROM audit_log_pii').all()).toEqual([]);
    });
  });
}
