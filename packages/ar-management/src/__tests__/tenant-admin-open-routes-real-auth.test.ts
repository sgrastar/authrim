import { readRenderedMigrationSql } from '../../../../test/helpers/migration-source.mjs';

import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import { TenantDatabaseResolverError } from '@authrim/ar-lib-core';
import { DatabaseSync, type SQLiteDatabase, type SQLInputValue } from './test-sqlite';

// The step-up gate has its own tests; here it lets the request through.
vi.mock('../admin-step-up-gate', () => ({
  requireAdminStepUp: vi.fn(async () => null),
  refuseAdminFreshAuth: vi.fn(),
}));

// The audit sink needs its own storage; the invitation write before it is what is under test.
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  createAuditLogFromContext: vi.fn(async () => undefined),
}));

// The discovery alias directory is a separate lookup store (its own tests cover it).
vi.mock('../tenant-alias-directory', () => ({
  resolveTenantDiscoveryAliasDirectoryInput: vi.fn(
    async (_env: unknown, input: Record<string, unknown>) => ({
      ...input,
      routeProjection: {},
    })
  ),
  prepareTenantDiscoveryAliasDirectory: vi.fn(async () => undefined),
  activateTenantDiscoveryAliasDirectory: vi.fn(async () => undefined),
  ensureActiveTenantDiscoveryAliasDirectory: vi.fn(async () => undefined),
  disableTenantDiscoveryAliasDirectory: vi.fn(async () => undefined),
  disableTenantDiscoveryAliasDirectoryIfPublished: vi.fn(async () => undefined),
}));

import { app } from '../index';

/**
 * The tenant-admin-open routes through the REAL request context and the REAL admin
 * authentication (a session cookie, sessions and role assignments in a real Admin schema), the
 * real route access and the real invitation handlers on a real core schema. `info` and
 * `runtime-profiles` are read through their real handlers too.
 */

const REPO_ROOT = resolve(__dirname, '../../../..');
const HOST = 'op.example.com';

function sqliteAdapter(db: SQLiteDatabase): DatabaseAdapter {
  const bind = (params: unknown[] = []) => params.map((value) => (value ?? null) as SQLInputValue);
  const adapter = {
    async query(sql: string, params?: unknown[]) {
      return db.prepare(sql).all(...bind(params));
    },
    async queryOne(sql: string, params?: unknown[]) {
      return db.prepare(sql).get(...bind(params)) ?? null;
    },
    async execute(sql: string, params?: unknown[]) {
      const result = db.prepare(sql).run(...bind(params));
      return { rowsAffected: Number(result.changes), success: true };
    },
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      db.exec('BEGIN');
      try {
        const result = await fn(adapter);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    async batch(statements: Array<{ sql: string; params?: unknown[] }>) {
      return Promise.all(statements.map((item) => adapter.execute(item.sql, item.params)));
    },
    async isHealthy() {
      return { healthy: true, latencyMs: 1, type: 'sqlite' };
    },
    getType: () => 'sqlite',
    async close() {},
  };
  return adapter as unknown as DatabaseAdapter;
}

/** The D1 surface the info handler reads, over the same sqlite database. */
function d1Shim(db: SQLiteDatabase) {
  const bind = (params: unknown[]) => params.map((value) => (value ?? null) as SQLInputValue);
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => db.prepare(sql).get(...bind(params)) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...bind(params)), success: true }),
    run: async () => ({ success: true, meta: { changes: 0 } }),
  });
  return { prepare: (sql: string) => statement(sql), batch: async () => [] };
}

const adminDb = new DatabaseSync(':memory:');
const coreDb = new DatabaseSync(':memory:');

(() => {
  for (const file of ['001_0_5_0_admin_baseline.sql', '012_admin_groups.sql']) {
    adminDb.exec(readRenderedMigrationSql(resolve(REPO_ROOT, 'migrations/admin/d1/'), file));
  }
  coreDb.exec(
    readRenderedMigrationSql(
      resolve(REPO_ROOT, 'migrations/core/d1/'),
      '001_0_5_0_core_baseline.sql'
    )
  );
  const now = Math.floor(Date.now() / 1000);
  for (const id of ['t1', 't2']) {
    coreDb
      .prepare(
        `INSERT INTO tenants (id, tenant_code, tenant_key, name, is_default, created_at, updated_at, lifecycle_state)
         VALUES (?, ?, ?, ?, 0, ?, ?, 'active')`
      )
      .run(id, `code-${id}`, `key-${id}`, `Tenant ${id}`, now, now);
  }
})();

let sessions = 0;
type Assignment = { role: string; scope: 'global' | 'tenant' };

/** An Admin whose home tenant is `home`, with these assignments; returns the session cookie. */
function signIn(home: string, assignments: Assignment[]): string {
  sessions += 1;
  const userId = `admin-${sessions}`;
  const sessionId = `session-${sessions}`;
  const now = Date.now();
  adminDb
    .prepare(
      `INSERT INTO admin_users (id, tenant_id, email, is_active, status, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'active', ?, ?)`
    )
    .run(userId, home, `${userId}@example.test`, now, now);
  adminDb
    .prepare(
      `INSERT INTO admin_sessions (id, tenant_id, admin_user_id, created_at, expires_at, mfa_verified)
       VALUES (?, ?, ?, ?, ?, 0)`
    )
    .run(sessionId, home, userId, now, now + 3_600_000);
  assignments.forEach((assignment, index) => {
    adminDb
      .prepare(
        `INSERT INTO admin_role_assignments (id, tenant_id, admin_user_id, admin_role_id, scope_type, scope_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        `${userId}-assignment-${index}`,
        home,
        userId,
        assignment.role,
        assignment.scope,
        assignment.scope === 'tenant' ? home : null,
        now
      );
  });
  return `authrim_admin_session=${sessionId}`;
}

const COOKIES = {
  tenantAdminT1: signIn('t1', [{ role: 'role_ar_tenant_admin', scope: 'tenant' }]),
  platformAdmin: signIn('default', [{ role: 'role_ar_super_admin', scope: 'global' }]),
  // Not a platform administrator, but its tenant-admin role is assigned globally (scope `*`).
  globalTenantAdmin: signIn('default', [{ role: 'role_ar_tenant_admin', scope: 'global' }]),
  // Roles in no tenant at all: authenticates nowhere, never reaches a handler.
  noRoles: signIn('t1', []),
};

const counters = new Map<string, number>();
const coreAdapter = sqliteAdapter(coreDb);
const missingTenantError = () =>
  new TenantDatabaseResolverError('missing_registry_row', 'no registry row');
const env = {
  ISSUER_URL: `https://${HOST}`,
  BASE_DOMAIN: HOST,
  DEFAULT_TENANT_ID: 'default',
  DB: d1Shim(coreDb),
  DB_ADMIN: sqliteAdapter(adminDb),
  RUNTIME_DATA_PORTS: {
    resolveTenant: async (tenantId: string) => {
      if (tenantId === 'ghost') throw missingTenantError();
      return { runtimeKind: 'portable', tenantId, coreDb: coreAdapter };
    },
  },
  CONTROL: {
    getReleaseMigrationRolloutStatus: async () => ({ adminMutationMode: 'read_write' }),
  },
  SETTINGS: { get: async () => null },
  RATE_LIMITER: {
    idFromName: (name: string) => name,
    get: (id: string) => ({
      incrementRpc: async (
        _key: string,
        config: { maxRequests: number; windowSeconds: number }
      ) => {
        const current = (counters.get(id) ?? 0) + 1;
        counters.set(id, current);
        return {
          allowed: true,
          current,
          limit: config.maxRequests,
          resetAt: Math.floor(Date.now() / 1000) + config.windowSeconds,
          retryAfter: 0,
        };
      },
    }),
  },
} as unknown as Env;

let keys = 0;
async function call(
  cookie: string | null,
  method: string,
  path: string,
  options: { header?: string | null; body?: unknown } = {}
) {
  const headers: Record<string, string> = {
    Host: HOST,
    'CF-Connecting-IP': '192.0.2.10',
    'Content-Type': 'application/json',
    Origin: `https://${HOST}`,
  };
  if (cookie) headers.Cookie = cookie;
  if (options.header) headers['X-Tenant-Id'] = options.header;
  if (method === 'POST') headers['Idempotency-Key'] = `key-${(keys += 1)}-${crypto.randomUUID()}`;
  const response = await app.request(
    `https://${HOST}${path}`,
    {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    },
    env
  );
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body };
}

function seedInvitation(tenantId: string, id: string) {
  const now = Math.floor(Date.now() / 1000);
  coreDb
    .prepare(
      `INSERT INTO tenant_invitations (id, token, tenant_id, invited_by, max_uses, use_count, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, 'seed', 1, 0, ?, ?, ?)`
    )
    .run(id, `token-${id}`, tenantId, now + 3600, now, now);
}

const HEADERS_TO_TRY = [null, 't1', 't2'] as const;

describe('invitations, through the real context, authentication and handlers', () => {
  it('a t1 administrator lists, creates and cancels invitations of t1', async () => {
    for (const header of HEADERS_TO_TRY) {
      const list = await call(COOKIES.tenantAdminT1, 'GET', '/api/admin/tenants/t1/invitations', {
        header,
      });
      expect({ header, status: list.status }).toEqual({ header, status: 200 });
    }
    const create = await call(COOKIES.tenantAdminT1, 'POST', '/api/admin/tenants/t1/invitations', {
      body: { max_uses: 1, expires_in_hours: 1 },
    });
    expect(create.status).toBe(201);
    const id = create.body.id as string;
    expect(id).toBeTruthy();
    const cancel = await call(
      COOKIES.tenantAdminT1,
      'DELETE',
      `/api/admin/tenants/t1/invitations/${id}`
    );
    expect(cancel.status).toBe(200);
  });

  it("a t1 administrator is refused t2's invitations, whatever X-Tenant-Id says", async () => {
    seedInvitation('t2', 'inv-t2');
    for (const header of HEADERS_TO_TRY) {
      for (const [method, path] of [
        ['GET', '/api/admin/tenants/t2/invitations'],
        ['POST', '/api/admin/tenants/t2/invitations'],
        ['DELETE', '/api/admin/tenants/t2/invitations/inv-t2'],
      ] as const) {
        const result = await call(COOKIES.tenantAdminT1, method, path, {
          header,
          body: method === 'POST' ? { max_uses: 1, expires_in_hours: 1 } : undefined,
        });
        expect({ header, method, refused: result.status >= 400 && result.status < 500 }).toEqual({
          header,
          method,
          refused: true,
        });
        expect(JSON.stringify(result.body)).not.toContain('inv-t2');
      }
    }
    const row = coreDb.prepare('SELECT id FROM tenant_invitations WHERE id = ?').get('inv-t2');
    expect(row).toBeTruthy();
  });

  it('a platform administrator reaches t1 and t2', async () => {
    for (const tenant of ['t1', 't2']) {
      const list = await call(
        COOKIES.platformAdmin,
        'GET',
        `/api/admin/tenants/${tenant}/invitations`
      );
      expect({ tenant, status: list.status }).toEqual({ tenant, status: 200 });
      const create = await call(
        COOKIES.platformAdmin,
        'POST',
        `/api/admin/tenants/${tenant}/invitations`,
        { body: { max_uses: 1, expires_in_hours: 1 } }
      );
      expect({ tenant, status: create.status }).toEqual({ tenant, status: 201 });
    }
  });

  it('an administrator with a global tenant-admin role (not a platform administrator) reaches every tenant, as on settings and directory routes', async () => {
    for (const tenant of ['t1', 't2']) {
      const list = await call(
        COOKIES.globalTenantAdmin,
        'GET',
        `/api/admin/tenants/${tenant}/invitations`
      );
      expect({ tenant, status: list.status }).toEqual({ tenant, status: 200 });
    }
  });

  it('is refused without authentication or without any role', async () => {
    for (const cookie of [null, COOKIES.noRoles, 'authrim_admin_session=forged']) {
      const result = await call(cookie, 'GET', '/api/admin/tenants/t1/invitations');
      expect(result.status).toBe(401);
    }
  });

  it('a tenant that does not exist is a clean refusal, never a 500', async () => {
    for (const cookie of [COOKIES.platformAdmin, COOKIES.tenantAdminT1]) {
      for (const method of ['GET', 'POST'] as const) {
        const result = await call(cookie, method, '/api/admin/tenants/ghost/invitations', {
          body: method === 'POST' ? { max_uses: 1, expires_in_hours: 1 } : undefined,
        });
        expect([401, 403, 404]).toContain(result.status);
      }
    }
    // A tenant the registry resolves but the directory does not list as active.
    coreDb
      .prepare(
        `INSERT INTO tenants (id, tenant_code, tenant_key, name, is_default, created_at, updated_at, lifecycle_state)
         VALUES ('t3', 'code-t3', 'key-t3', 'T3', 0, 1, 1, 'provisioning')`
      )
      .run();
    const notYet = await call(COOKIES.platformAdmin, 'GET', '/api/admin/tenants/t3/invitations');
    expect(notYet.status).toBe(404);
  });

  it('a request that passes authentication is still refused by the handler own scope check', async () => {
    // An administrator whose scope is t1 only, reaching t2's path with the request tenant forced
    // to its own: the real context cannot be made to do this, so the handler is driven directly.
    const { listTenantInvitationsHandler } = await import('../admin-tenant-invitations');
    const store = new Map<string, unknown>([
      [
        'adminAuth',
        {
          userId: 'a',
          authMethod: 'session',
          tenantId: 't1',
          tenantScope: ['t1'],
          roles: [],
          permissions: [],
        },
      ],
      ['tenantId', 't1'],
      ['requestId', 'r'],
    ]);
    const context = {
      env,
      req: {
        param: (name: string) => (name === 'id' ? 't2' : undefined),
        path: '/api/admin/tenants/t2/invitations',
        header: () => undefined,
      },
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => store.set(key, value),
      json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
      header: () => undefined,
    };
    const response = await listTenantInvitationsHandler(context as never);
    expect(response.status).toBe(403);
  });
});

describe('info and runtime-profiles, through the real context, authentication and handlers', () => {
  for (const route of ['info', 'runtime-profiles']) {
    it(`${route}: own tenant yes, other tenant no, platform yes, unauthenticated no`, async () => {
      for (const header of HEADERS_TO_TRY) {
        const own = await call(COOKIES.tenantAdminT1, 'GET', `/api/admin/tenants/t1/${route}`, {
          header,
        });
        expect({ header, status: own.status }).toEqual({ header, status: 200 });
        const other = await call(COOKIES.tenantAdminT1, 'GET', `/api/admin/tenants/t2/${route}`, {
          header,
        });
        expect({ header, refused: other.status === 401 || other.status === 403 }).toEqual({
          header,
          refused: true,
        });
        expect(other.body.tenant_id).toBeUndefined();
      }
      for (const tenant of ['default', 't1', 't2']) {
        const platform = await call(
          COOKIES.platformAdmin,
          'GET',
          `/api/admin/tenants/${tenant}/${route}`
        );
        expect({ tenant, status: platform.status }).toEqual({ tenant, status: 200 });
      }
      for (const cookie of [null, 'authrim_admin_session=forged']) {
        const result = await call(cookie, 'GET', `/api/admin/tenants/t1/${route}`);
        expect(result.status).toBe(401);
      }
      const encoded = await call(
        COOKIES.tenantAdminT1,
        'GET',
        `/api/admin/tenants/%74%31/${route === 'info' ? '%69nfo' : 'runtime-profiles'}`
      );
      expect(encoded.status).toBe(200);
      const missing = await call(COOKIES.platformAdmin, 'GET', `/api/admin/tenants/ghost/${route}`);
      expect(missing.status).toBeLessThan(500);
    });
  }

  it('platform-only routes stay refused for the t1 administrator', async () => {
    for (const [method, path] of [
      ['GET', '/api/admin/tenants'],
      ['GET', '/api/admin/tenants/t1'],
      ['GET', '/api/admin/tenants/t1/provisioning'],
      ['POST', '/api/admin/tenants/t1/set-default'],
      ['POST', '/api/admin/tenants/t1/deletion/cancel'],
      ['DELETE', '/api/admin/tenants/t1'],
    ] as const) {
      const result = await call(COOKIES.tenantAdminT1, method, path);
      expect({ method, path, refused: result.status === 401 || result.status === 403 }).toEqual({
        method,
        path,
        refused: true,
      });
    }
  });
});
