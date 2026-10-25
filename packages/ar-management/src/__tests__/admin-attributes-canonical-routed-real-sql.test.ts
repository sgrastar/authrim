/**
 * Actual Hono contexts, the shared admin account/Core/contact helpers, canonical projections,
 * independent Core/PII SQLite databases and metadata attribute SQL. Registry inventory and exact
 * Lookup transport are explicit seams; their signed routing verification is covered separately.
 * No request begins with an AccountDataContext. Audit delivery alone is recorded as a seam.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CanonicalRuntimeUserStore,
  type DatabaseAdapter,
  type Env,
  type PreparedStatement,
} from '@authrim/ar-lib-core';
import { renderPortableMigrationSql } from '../../../ar-lib-core/dist/migrations/sql-portability';
import { DatabaseSync, type SQLInputValue, type SQLiteDatabase } from './test-sqlite';

type Store = { db: SQLiteDatabase; adapter: DatabaseAdapter; binding: string };
type ContactRoute = {
  tenantId: string;
  legacyUserId: string;
  coreBindingRef: string;
  piiBindingRef: string;
};
const TENANT = 'tenant-a';
const OTHER_TENANT = 'tenant-b';
const USER = 'user-one';
const SECOND_USER = 'user-two';
const state = vi.hoisted(() => ({
  stores: [] as Array<{ bindingRef: string; source: DatabaseAdapter }>,
  routes: new Map<string, ContactRoute[]>(),
  databases: new Map<string, Store>(),
  reads: [] as Array<{ binding: string; sql: string; params: unknown[] }>,
  failedReads: new Set<string>(),
  find: vi.fn<
    (input: {
      tenantId: string;
      identifier: string;
      indexKind: string;
      purpose: string;
    }) => Promise<ContactRoute[]>
  >(),
  audit: vi.fn(),
  activeFinds: 0,
  maxActiveFinds: 0,
}));
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  resolveTenantAssignedDatabaseSourcesFromRegistry: async () => state.stores,
  createAuditLogFromContext: state.audit,
  generateId: () => 'attribute-created',
}));
vi.mock('../cross-shard-account-list', async (original) => ({
  ...(await original<typeof import('../cross-shard-account-list')>()),
  CrossShardAccountExactSearchService: class {
    async findAdminContacts(input: { tenantId: string; userIds: readonly string[] }) {
      const contacts = new Map<string, ContactRoute>();
      const pending = [...new Set(input.userIds)];
      const worker = async () => {
        for (let id = pending.shift(); id !== undefined; id = pending.shift()) {
          let matches: ContactRoute[];
          try {
            matches = await state.find({
              tenantId: input.tenantId,
              identifier: id,
              indexKind: 'account_id',
              purpose: 'admin_view',
            });
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === 'cross_shard_account_pii_owner_invalid'
            ) {
              continue;
            }
            throw error;
          }
          if (matches.length === 0) continue;
          const match = matches[0];
          if (
            matches.length !== 1 ||
            !match ||
            match.tenantId !== input.tenantId ||
            match.legacyUserId !== id
          ) {
            throw new Error('fixture_bulk_contact_route_invalid');
          }
          contacts.set(id, match);
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
      return contacts;
    }
    find(input: { tenantId: string; identifier: string; indexKind: string; purpose: string }) {
      return state.find(input);
    }
  },
}));
import {
  adminAttributeCreateHandler,
  adminAttributesListHandler,
  adminUserAttributesHandler,
} from '../admin-attributes';
import { adminAccountCoreAdapter } from '../admin-account-storage';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function openStore(family: 'core' | 'pii', binding: string): Store {
  const db = new DatabaseSync(':memory:');
  const migrations = new URL(`../../../../migrations/${family}/d1/`, import.meta.url);
  for (const filename of readdirSync(migrations)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(
      renderPortableMigrationSql(readFileSync(new URL(filename, migrations), 'utf8'), 'sqlite')
    );
  }
  db.exec('PRAGMA foreign_keys=ON');
  const values = (params: unknown[] = []) => {
    if (params.length > 100) throw new Error('fixture_d1_bind_limit_exceeded');
    return params.map((value) => (value === undefined ? null : value) as SQLInputValue);
  };
  const read = (sql: string, params: unknown[] = []) => {
    state.reads.push({ binding, sql, params });
    if (state.failedReads.has(binding)) throw new Error('fixture_storage_read_failed');
    return db.prepare(sql);
  };
  const execute = (statement: PreparedStatement) => ({
    success: true,
    rowsAffected: Number(db.prepare(statement.sql).run(...values(statement.params)).changes),
  });
  const adapter = {
    query: async (sql: string, params?: unknown[]) => read(sql, params).all(...values(params)),
    queryOne: async (sql: string, params?: unknown[]) =>
      read(sql, params).get(...values(params)) ?? null,
    execute: async (sql: string, params?: unknown[]) => execute({ sql, params }),
    batch: async (statements: PreparedStatement[]) => {
      db.exec('BEGIN');
      try {
        const result = statements.map(execute);
        db.exec('COMMIT');
        return result;
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
  const result = { db, adapter, binding };
  state.databases.set(binding, result);
  return result;
}

for (const topology of ['single', 'shared_pool', 'tenant_exclusive'] as const) {
  describe(`attribute canonical account references: ${topology} (real SQL)`, () => {
    const opened: Store[] = [];
    let metadata: Store,
      accountA: Store,
      accountB: Store,
      piiA: Store,
      piiB: Store,
      defaultPii: Store;
    let env: Env;
    let app: Hono<{ Bindings: Env }>;
    const open = (family: 'core' | 'pii', binding: string) => {
      const store = openStore(family, binding);
      opened.push(store);
      return store;
    };
    async function seedAccount(
      core: Store,
      pii: Store,
      userId = USER,
      tenantId = TENANT,
      email = `${userId}@owner.example.test`
    ) {
      await new CanonicalRuntimeUserStore({
        coreAdapter: core.adapter,
        piiAdapter: pii.adapter,
        tenantId,
      }).syncUser({
        userId,
        active: true,
        emailVerified: true,
        piiFields: { email: true, name: true },
        sensitiveValues: { email, name: `Owner ${userId}` },
      });
      core.db
        .prepare(
          "UPDATE identity_accounts SET directory_publication_state='active' WHERE tenant_id=? AND legacy_user_id=?"
        )
        .run(tenantId, userId);
    }
    function route(userId: string, core: Store, pii: Store) {
      state.routes.set(`${TENANT}:${userId}`, [
        {
          tenantId: TENANT,
          legacyUserId: userId,
          coreBindingRef: core.binding,
          piiBindingRef: pii.binding,
        },
      ]);
    }
    function attribute(core: Store, userId = USER, name = 'department', tenantId = TENANT) {
      core.db
        .prepare(
          `INSERT INTO user_verified_attributes
          (id,tenant_id,user_id,attribute_name,attribute_value,source_type,verified_at,created_at,updated_at)
         VALUES(?,?,?,?,?,'manual',1,1,1)`
        )
        .run(`attr:${tenantId}:${userId}:${name}`, tenantId, userId, name, 'engineering');
    }
    function ledger(core: Store) {
      return core.db.prepare('SELECT * FROM user_verified_attributes ORDER BY id').all();
    }
    function identity(core: Store) {
      return core.db.prepare('SELECT * FROM identity_accounts ORDER BY id').all();
    }
    function personal(pii: Store) {
      return pii.db.prepare('SELECT * FROM identity_sensitive_values ORDER BY id').all();
    }
    function restrict(status: string, userId = USER, subjectOnly = false) {
      if (!subjectOnly)
        accountA.db
          .prepare(
            'UPDATE identity_accounts SET lifecycle_state=? WHERE tenant_id=? AND legacy_user_id=?'
          )
          .run(status, TENANT, userId);
      accountA.db
        .prepare(
          `UPDATE identity_subjects SET lifecycle_state=? WHERE tenant_id=? AND id=(
           SELECT primary_subject_id FROM identity_accounts WHERE tenant_id=? AND legacy_user_id=?)`
        )
        .run(status, TENANT, TENANT, userId);
    }
    async function request(path: string, method = 'GET', body?: unknown) {
      return app.request(
        path,
        {
          method,
          headers: { 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        env
      );
    }
    const assign = (userId = USER) =>
      request('/attributes', 'POST', {
        user_id: userId,
        attribute_name: 'assigned',
        attribute_value: 'yes',
      });
    beforeEach(async () => {
      vi.clearAllMocks();
      state.routes.clear();
      state.databases.clear();
      state.failedReads.clear();
      state.reads = [];
      state.activeFinds = 0;
      state.maxActiveFinds = 0;
      state.audit.mockReset().mockResolvedValue(undefined);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      metadata = open('core', 'METADATA');
      accountA = topology === 'single' ? metadata : open('core', 'ACCOUNT_A');
      accountB = open('core', 'ACCOUNT_B');
      piiA = open('pii', 'PII_A');
      piiB = open('pii', 'PII_B');
      defaultPii = topology === 'single' ? piiA : open('pii', 'DEFAULT_PII');
      state.stores = [accountA, accountB].map((store) => ({
        bindingRef: store.binding,
        source: store.adapter,
      }));
      env = {
        DB: metadata.adapter,
        DB_PII: defaultPii.adapter,
        ACCOUNT_A: accountA.adapter,
        ACCOUNT_B: accountB.adapter,
        METADATA: metadata.adapter,
        PII_A: piiA.adapter,
        PII_B: piiB.adapter,
      } as unknown as Env;
      await seedAccount(accountA, piiA);
      await seedAccount(accountB, piiB, SECOND_USER);
      route(USER, accountA, piiA);
      route(SECOND_USER, accountB, piiB);
      if (topology !== 'single')
        await seedAccount(metadata, defaultPii, USER, TENANT, 'metadata-decoy@example.test');
      attribute(metadata);
      if (topology !== 'single') attribute(accountA, USER, 'account-decoy');
      attribute(accountB, SECOND_USER, 'account-decoy');
      state.find
        .mockReset()
        .mockImplementation(
          async (input: {
            tenantId: string;
            identifier: string;
            indexKind: string;
            purpose: string;
          }) => {
            if (input.indexKind !== 'account_id' || input.purpose !== 'admin_view') {
              throw new Error('fixture_authentication_resolver_used_for_admin_display');
            }
            state.activeFinds += 1;
            state.maxActiveFinds = Math.max(state.maxActiveFinds, state.activeFinds);
            try {
              await Promise.resolve();
              const candidates = state.routes.get(`${input.tenantId}:${input.identifier}`) ?? [];
              // Leave malformed/ambiguous transport output to the actual admin contact guard.
              if (candidates.length !== 1 || candidates[0].tenantId !== input.tenantId)
                return candidates;
              const match = candidates[0];
              const core = state.databases.get(match.coreBindingRef);
              const pii = state.databases.get(match.piiBindingRef);
              if (!core || !pii) throw new Error('fixture_route_binding_missing');
              const found = await core.adapter.queryOne<{
                lifecycle_state: string;
                directory_publication_state: string;
              }>(
                'SELECT lifecycle_state,directory_publication_state FROM identity_accounts WHERE tenant_id=? AND legacy_user_id=?',
                [input.tenantId, input.identifier]
              );
              if (
                !found ||
                ['deleting', 'deleted'].includes(found.lifecycle_state) ||
                found.directory_publication_state !== 'active'
              )
                return [];
              const owner = await pii.adapter.queryOne<{ owner_id: string }>(
                "SELECT owner_id FROM identity_sensitive_values WHERE tenant_id=? AND owner_type='runtime_user' AND owner_id=? LIMIT 1",
                [input.tenantId, input.identifier]
              );
              if (!owner) throw new Error('cross_shard_account_pii_owner_invalid');
              return candidates;
            } finally {
              state.activeFinds -= 1;
            }
          }
        );
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
        c.set('adminAuth' as never, { userId: 'admin-one', actorType: 'human' } as never);
        await next();
        expect(c.get('accountDataContext' as never)).toBeUndefined();
      });
      app.get('/attributes', adminAttributesListHandler);
      app.post('/attributes', adminAttributeCreateHandler);
      app.get('/attributes/users/:userId', adminUserAttributesHandler);
      app.get('/default-core/:userId', async (c) =>
        c.json({
          found: Boolean(await adminAccountCoreAdapter(c, TENANT, c.req.param('userId'))),
        })
      );
      state.reads = [];
    }, 20_000);
    afterEach(() => {
      for (const store of opened.splice(0)) store.db.close();
      vi.restoreAllMocks();
    });

    it('reads canonical contact from the owner while the attribute ledger stays in metadata', async () => {
      const before = [
        identity(metadata),
        identity(accountA),
        ledger(metadata),
        ledger(accountA),
        personal(piiA),
      ];
      const response = await request(`/attributes/users/${USER}`);
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      if (!isRecord(body) || !Array.isArray(body.attributes)) {
        throw new Error('fixture_attribute_response_shape_invalid');
      }
      expect(body).toMatchObject({
        user: { id: USER, email: `${USER}@owner.example.test`, name: `Owner ${USER}` },
        attributes: [{ attribute_name: 'department' }],
      });
      expect(JSON.stringify(body)).not.toContain('metadata-decoy');
      if (topology !== 'single') expect(body.attributes).toHaveLength(1);
      expect([
        identity(metadata),
        identity(accountA),
        ledger(metadata),
        ledger(accountA),
        personal(piiA),
      ]).toEqual(before);
      expect(state.audit).not.toHaveBeenCalled();
    });

    it.each(['suspended', 'locked', 'deprovisioned'])(
      'includes the %s identity on GET but rejects assigning an attribute',
      async (lifecycle) => {
        restrict(lifecycle);
        const before = ledger(metadata);
        const response = await request(`/attributes/users/${USER}`);
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ user: { id: USER } });
        expect((await assign()).status).toBe(404);
        expect(ledger(metadata)).toEqual(before);
        expect(state.audit).not.toHaveBeenCalled();
      }
    );

    it.each(['deleting', 'deleted'])(
      'shows the %s Core identity without reading PII and preserves default helper behavior',
      async (lifecycle) => {
        restrict(lifecycle);
        const before = [personal(piiA), ledger(metadata)];
        state.reads = [];
        const response = await request(`/attributes/users/${USER}`);
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          user: { id: USER, email: null, name: null },
        });
        expect(state.find).not.toHaveBeenCalled();
        expect(state.reads.filter((read) => read.binding === piiA.binding)).toEqual([]);
        expect([personal(piiA), ledger(metadata)]).toEqual(before);
        const ordinary = await request(`/default-core/${USER}`);
        await expect(ordinary.json()).resolves.toEqual({
          found: topology === 'single' || lifecycle !== 'deleted',
        });
        if (topology !== 'single')
          expect(
            state.reads.some((read) => read.sql.includes("lifecycle_state <> 'deleted'"))
          ).toBe(true);
      }
    );

    it('rejects an inactive subject and an unpublished account without reading PII', async () => {
      restrict('suspended', USER, true);
      const before = ledger(metadata);
      expect((await assign()).status).toBe(404);
      restrict('active');
      accountA.db
        .prepare(
          "UPDATE identity_accounts SET directory_publication_state='pending' WHERE tenant_id=? AND legacy_user_id=?"
        )
        .run(TENANT, USER);
      expect((await assign()).status).toBe(404);
      expect(ledger(metadata)).toEqual(before);
      expect(state.find).not.toHaveBeenCalled();
      expect(state.reads.filter((read) => read.binding === piiA.binding)).toEqual([]);
      expect(state.audit).not.toHaveBeenCalled();
    });

    it('assigns to an active account even with no readable PII, and writes and audits only metadata', async () => {
      state.failedReads.add(piiA.binding);
      const ownersBefore = [ledger(accountB), personal(piiA), personal(piiB), identity(accountA)];
      const response = await assign();
      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toMatchObject({
        attribute: {
          id: 'attribute-created',
          tenant_id: TENANT,
          user_id: USER,
          attribute_name: 'assigned',
        },
      });
      expect(
        metadata.db
          .prepare('SELECT user_id,attribute_name FROM user_verified_attributes WHERE id=?')
          .get('attribute-created')
      ).toEqual({ user_id: USER, attribute_name: 'assigned' });
      if (topology !== 'single')
        expect(
          accountA.db
            .prepare('SELECT id FROM user_verified_attributes WHERE id=?')
            .get('attribute-created')
        ).toBeUndefined();
      expect([ledger(accountB), personal(piiA), personal(piiB), identity(accountA)]).toEqual(
        ownersBefore
      );
      expect(state.find).not.toHaveBeenCalled();
      expect(state.reads.filter((read) => read.binding === piiA.binding)).toEqual([]);
      expect(state.audit).toHaveBeenCalledWith(
        expect.anything(),
        'create',
        'user_attribute',
        'attribute-created',
        { user_id: USER, attribute_name: 'assigned' }
      );
    });

    it('distinguishes a missing account from an existing account with no contact owner', async () => {
      state.routes.delete(`${TENANT}:${USER}`);
      // Nonrouted topology still has the explicit local PII owner: make contact values absent there.
      if (topology === 'single')
        piiA.db
          .prepare('DELETE FROM identity_sensitive_values WHERE tenant_id=? AND owner_id=?')
          .run(TENANT, USER);
      const known = await request(`/attributes/users/${USER}`);
      expect(known.status).toBe(200);
      await expect(known.json()).resolves.toMatchObject({
        user: { id: USER, email: null, name: null },
      });
      const absent = await request('/attributes/users/absent-user');
      expect(absent.status).toBe(200);
      await expect(absent.json()).resolves.toMatchObject({ user: null });
      expect(state.audit).not.toHaveBeenCalled();
    });

    it('keeps Core identity distinct from absent PII rows without reading a default-store decoy', async () => {
      piiA.db
        .prepare('DELETE FROM identity_sensitive_values WHERE tenant_id=? AND owner_id=?')
        .run(TENANT, USER);
      const before = [ledger(metadata), identity(accountA), personal(defaultPii)];
      state.reads = [];
      const response = await request(`/attributes/users/${USER}`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        user: { id: USER, email: null, name: null },
      });
      if (topology !== 'single')
        expect(state.reads.filter((read) => read.binding === defaultPii.binding)).toEqual([]);
      expect([ledger(metadata), identity(accountA), personal(defaultPii)]).toEqual(before);
      expect(state.audit).not.toHaveBeenCalled();
    });

    it('rejects a foreign account and a metadata decoy without mutating attribute data', async () => {
      await seedAccount(accountB, piiB, 'foreign-user', OTHER_TENANT);
      if (topology !== 'single') await seedAccount(metadata, defaultPii, 'foreign-user');
      const before = [ledger(metadata), ledger(accountA), ledger(accountB), personal(piiB)];
      expect((await assign('foreign-user')).status).toBe(404);
      expect([ledger(metadata), ledger(accountA), ledger(accountB), personal(piiB)]).toEqual(
        before
      );
      expect(state.audit).not.toHaveBeenCalled();
    });

    it('returns an error for a real PII database failure rather than a partial successful response', async () => {
      state.failedReads.add(piiA.binding);
      const before = [ledger(metadata), personal(piiA)];
      const get = await request(`/attributes/users/${USER}`);
      expect(get.status).toBe(500);
      expect(JSON.stringify(await get.json())).not.toContain('metadata-decoy');
      const list = await request('/attributes');
      expect(list.status).toBe(500);
      expect([ledger(metadata), personal(piiA)]).toEqual(before);
      expect(state.audit).not.toHaveBeenCalled();
    });

    if (topology !== 'single') {
      it('fails closed when two real account stores claim the same tenant and user', async () => {
        await seedAccount(accountB, piiB, USER);
        const before = [ledger(metadata), ledger(accountA), ledger(accountB)];
        expect((await assign()).status).toBe(500);
        expect((await request(`/attributes/users/${USER}`)).status).toBe(500);
        expect([ledger(metadata), ledger(accountA), ledger(accountB)]).toEqual(before);
        expect(state.find).not.toHaveBeenCalled();
        expect(state.audit).not.toHaveBeenCalled();
      });

      it('keeps ordinary helper callers on the non-deleted owner when another store has old deleted identity', async () => {
        restrict('deleted');
        await seedAccount(accountB, piiB, USER);
        const before = [ledger(metadata), ledger(accountA), ledger(accountB)];
        const ordinary = await request(`/default-core/${USER}`);
        expect(ordinary.status).toBe(200);
        await expect(ordinary.json()).resolves.toEqual({ found: true });
        // The explicit audit lookup refuses two owners instead of silently selecting either one.
        const audited = await request(`/attributes/users/${USER}`);
        expect(audited.status).toBe(500);
        expect([ledger(metadata), ledger(accountA), ledger(accountB)]).toEqual(before);
        expect(state.find).not.toHaveBeenCalled();
        expect(state.audit).not.toHaveBeenCalled();
      });

      it('rejects foreign or ambiguous contact routes before disclosing either PII store', async () => {
        const [valid] = state.routes.get(`${TENANT}:${USER}`) ?? [];
        if (!valid) throw new Error('fixture_contact_route_missing');
        for (const badRoutes of [
          [{ ...valid, tenantId: OTHER_TENANT }],
          [valid, { ...valid, piiBindingRef: piiB.binding }],
        ]) {
          state.routes.set(`${TENANT}:${USER}`, badRoutes);
          state.reads = [];
          const response = await request(`/attributes/users/${USER}`);
          expect(response.status).toBe(500);
          const text = JSON.stringify(await response.json());
          expect(text).not.toContain(`${USER}@owner.example.test`);
          expect(
            state.reads.filter((read) => [piiA.binding, piiB.binding].includes(read.binding))
          ).toEqual([]);
        }
        expect(state.audit).not.toHaveBeenCalled();
      });

      it('resolves 100 distinct contacts across both owners without an oversized bind or context reuse', async () => {
        metadata.db.exec('DELETE FROM user_verified_attributes');
        for (let index = 0; index < 100; index += 1) {
          const user = `page-user-${String(index).padStart(3, '0')}`;
          const core = index % 2 ? accountB : accountA;
          const pii = index % 2 ? piiB : piiA;
          await seedAccount(core, pii, user);
          route(user, core, pii);
          attribute(metadata, user);
        }
        const before = [
          ledger(metadata),
          ledger(accountA),
          ledger(accountB),
          personal(piiA),
          personal(piiB),
        ];
        state.reads = [];
        const response = await request('/attributes?limit=100');
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        if (!isRecord(body) || !Array.isArray(body.attributes)) {
          throw new Error('fixture_attribute_list_shape_invalid');
        }
        expect(body.attributes).toHaveLength(100);
        expect(body.pagination).toMatchObject({ limit: 100, total: 100, total_pages: 1 });
        for (const item of body.attributes) {
          const row: unknown = item;
          if (!isRecord(row) || typeof row.user_id !== 'string') {
            throw new Error('fixture_attribute_list_row_invalid');
          }
          expect(row.user_email).toBe(`${row.user_id}@owner.example.test`);
        }
        expect(Math.max(...state.reads.map((read) => read.params.length))).toBeLessThanOrEqual(100);
        expect(state.maxActiveFinds).toBeLessThanOrEqual(4);
        expect([
          ledger(metadata),
          ledger(accountA),
          ledger(accountB),
          personal(piiA),
          personal(piiB),
        ]).toEqual(before);
        expect(state.audit).not.toHaveBeenCalled();
      }, 30_000);
    }
  });
}
