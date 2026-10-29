import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync as UntypedDatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}
const DatabaseSync = UntypedDatabaseSync as unknown as new (path: string) => SqliteDatabase;

const mocks = vi.hoisted(() => ({ adapter: undefined as unknown }));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  // The trace of the real resolver echoes the client's encryption settings as a step input.
  createPolicyResolver: vi.fn(() => ({
    resolve: vi.fn(async () => ({
      success: true,
      policy: { encryption: {} },
      debug: {
        steps: [
          {
            step: 'resolveEncryptionSettings',
            input: {
              client: { jwks: { keys: [{ kty: 'RSA', n: 'modulus', e: 'AQAB', d: 'exponent' }] } },
            },
          },
        ],
      },
    })),
  })),
  getTenantIdFromContext: vi.fn(
    (c: { get(key: string): { tenantId: string } }) => c.get('adminAuth').tenantId
  ),
  createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
}));

import {
  ADMIN_ROLE_DEFINITIONS,
  ADMIN_ROLES,
  type AdminAuthContext,
  type Env,
} from '@authrim/ar-lib-core';
import { registerDeclaredAdminRouteAccessMiddleware } from '../admin-route-access';
import { requireTenantAdminForChanges } from '../admin-role-gates';
import { adminFlowGetHandler } from '../admin-flows';
import { adminRelationDefinitionGetHandler } from '../admin-rebac';
import policyRouter from '../routes/policy';

/**
 * Reads that index.ts used to hold to the tenant admin role as well as to the permission of the
 * access table. A viewer or support session that holds the permission reads them now; changes,
 * the report download and `GET /tenant-policy` (which saves a default when there is none) keep the
 * role. Three layers: the registrations in index.ts, the gate in front of the real policy router,
 * and real handlers behind the real gate, to show another tenant's record is a 404.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const source = readFileSync(resolve(__dirname, '../index.ts'), 'utf8');

const [SUPER, TENANT_ADMIN, SUPPORT, VIEWER] = [
  ADMIN_ROLES.SUPER_ADMIN,
  ADMIN_ROLES.TENANT_ADMIN,
  ADMIN_ROLES.SUPPORT,
  ADMIN_ROLES.VIEWER,
];
const ROLES = [SUPER, TENANT_ADMIN, SUPPORT, VIEWER] as const;

function contextOf(roleName: string, tenantId: string): AdminAuthContext {
  const role = ADMIN_ROLE_DEFINITIONS.find((definition) => definition.name === roleName)!;
  const isGlobal = roleName === SUPER;
  return {
    userId: `user-${roleName}`,
    authMethod: 'session',
    tenantId,
    roles: [roleName],
    permissions: [...role.permissions],
    hierarchyLevel: role.hierarchyLevel,
    mfaVerified: true,
    tenantScope: isGlobal ? ['*'] : [tenantId],
    globalRoles: isGlobal ? [roleName] : [],
    globalPermissions: isGlobal ? [...role.permissions] : [],
    globalHierarchyLevel: isGlobal ? role.hierarchyLevel : 0,
  } as unknown as AdminAuthContext;
}

type TestApp = Hono<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

/** The caller's role comes from `X-Test-Role` and its tenant from `X-Test-Tenant`. */
function newApp(): TestApp {
  const app: TestApp = new Hono();
  app.use('*', async (c, next) => {
    c.set(
      'adminAuth',
      contextOf(c.req.header('X-Test-Role')!, c.req.header('X-Test-Tenant') ?? 'default')
    );
    await next();
  });
  registerDeclaredAdminRouteAccessMiddleware(app);
  return app;
}

async function statusOf(app: TestApp, method: string, path: string, role: string, tenant?: string) {
  const headers: Record<string, string> = { 'X-Test-Role': role };
  if (tenant) headers['X-Test-Tenant'] = tenant;
  return (await app.request(path, { method, headers })).status;
}

describe('registrations in index.ts', () => {
  const READ_THROUGH = [
    '/api/admin/rebac',
    '/api/admin/rebac/*',
    '/api/admin/attributes',
    '/api/admin/attributes/*',
    '/api/admin/custom-claims',
    '/api/admin/custom-claims/*',
    '/api/admin/flows',
    '/api/admin/flows/*',
    '/api/admin/flow-assignments',
    '/api/admin/access-trace',
    '/api/admin/access-trace/*',
    '/api/admin/access-control/*',
    '/api/admin/stats/*',
    '/api/admin/security/*',
    '/api/admin/compliance/*',
  ];

  it.each(READ_THROUGH)('%s asks for the role on changes only', (path) => {
    expect(source).toContain(`app.use('${path}', requireTenantAdminForChanges());`);
  });

  it('leaves exactly these paths on the role for every method', () => {
    const stillRoleGated = [
      ...source.matchAll(
        /app\.use\(\s*'([^']+)',\s*requireAnyRole\(ADMIN_ROLE_GROUPS\.tenantAdmin\)\s*\);/g
      ),
    ].map((match) => match[1]);
    expect(stillRoleGated.sort()).toEqual(
      [
        // State changes (POST only).
        '/api/admin/data-retention/*',
        '/api/admin/users/:id/activate',
        '/api/admin/users/:id/lock',
        '/api/admin/users/:id/suspend',
        // Platform-wide access to the tenant's PII settings goes through requireSystemAdmin first.
        '/api/admin/tenants/:tenantId/audit/*',
      ].sort()
    );
  });

  it('keeps the report file with the tenant administrators', () => {
    expect(source).toMatch(
      /app\.get\(\s*'\/api\/admin\/compliance\/reports\/:id\/download',\s*requireAnyRole\(ADMIN_ROLE_GROUPS\.tenantAdmin\)/
    );
  });

  it('keeps the jobs (results and artifacts are exports) with the tenant administrators', () => {
    const jobs = readFileSync(resolve(__dirname, '../admin-jobs.ts'), 'utf8');
    expect(jobs).toContain(
      "app.use('/api/admin/jobs/*', requireAnyRole(ADMIN_JOB_MANAGER_ROLES));"
    );
  });

  it('runs the declared access table before any of these gates', () => {
    const table = source.indexOf('registerDeclaredAdminRouteAccessMiddleware(app);');
    expect(table).toBeGreaterThan(-1);
    for (const path of READ_THROUGH) {
      expect(source.indexOf(`app.use('${path}', requireTenantAdminForChanges());`)).toBeGreaterThan(
        table
      );
    }
  });
});

describe('the policy router', () => {
  function policyApp(): TestApp {
    const app = newApp();
    app.route('/api/admin', policyRouter as never);
    return app;
  }

  it.each([
    // [method, path, super, tenant admin, support, viewer]
    ['GET', '/api/admin/client-profile-presets', 200, 200, 403, 200],
    ['GET', '/api/admin/tenant-policy/presets', 200, 200, 403, 200],
    // Saves a default contract when there is none, so it is not a read-only call.
    ['GET', '/api/admin/tenant-policy', null, null, 403, 403],
    ['PUT', '/api/admin/tenant-policy', null, null, 403, 403],
    ['POST', '/api/admin/tenant-policy/apply-preset', null, null, 403, 403],
    ['POST', '/api/admin/clients/client-1/apply-preset', null, null, 403, 403],
  ] as const)('%s %s', async (method, path, ...expected) => {
    const app = policyApp();
    for (const [index, role] of ROLES.entries()) {
      const status = await statusOf(app, method, path, role);
      if (expected[index] === null) {
        // Past the gates: the handler answers (it has no KV here), whatever it says.
        expect(status, role).not.toBe(403);
      } else {
        expect(status, role).toBe(expected[index]);
      }
    }
  });
});

describe('the client profile', () => {
  const PROFILE = {
    encryption: {
      jwks: {
        keys: [
          { kty: 'RSA', kid: 'public', n: 'modulus', e: 'AQAB', d: 'private-exponent', p: 'prime' },
          { kty: 'oct', kid: 'shared', k: 'symmetric-secret' },
        ],
      },
    },
  };
  const kv = {
    get: vi.fn(async (key: string) =>
      key === 'dev:contract:client:default:client-1'
        ? PROFILE
        : key === 'dev:contract:tenant:default'
          ? { version: 3 }
          : null
    ),
  };

  beforeAll(() => {
    mocks.adapter = {
      async queryOne(_sql: string, params: unknown[] = []) {
        return params[0] === 'default' && params[1] === 'client-1'
          ? { client_id: 'client-1', tenant_id: 'default' }
          : null;
      },
    };
  });

  function get(role: string, tenant: string) {
    const app = newApp();
    app.route('/api/admin', policyRouter as never);
    return app.request(
      '/api/admin/clients/client-1/profile',
      { headers: { 'X-Test-Role': role, 'X-Test-Tenant': tenant } },
      { AUTHRIM_CONFIG: kv } as unknown as Env
    );
  }

  it.each([TENANT_ADMIN, SUPPORT, VIEWER])(
    'is read by %s without the private part of the client keys',
    async (role) => {
      const response = await get(role, 'default');
      expect(response.status).toBe(200);
      const { profile } = JSON.parse(await response.text()) as { profile: typeof PROFILE };
      expect(profile.encryption.jwks.keys).toEqual([
        { kty: 'RSA', kid: 'public', n: 'modulus', e: 'AQAB' },
      ]);
    }
  );

  it('is a 404 from another tenant', async () => {
    expect((await get(VIEWER, 'tenant-b')).status).toBe(404);
  });

  it('is not read back through the debug trace of the effective policy', async () => {
    const app = newApp();
    app.route('/api/admin', policyRouter as never);
    const response = await app.request(
      '/api/admin/effective-policy?client_id=client-1&debug=true',
      { headers: { 'X-Test-Role': VIEWER, 'X-Test-Tenant': 'default' } },
      { AUTHRIM_CONFIG: kv } as unknown as Env
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('modulus');
    expect(text).not.toContain('exponent');
  });

  it('is still changed by the tenant admin only', async () => {
    const app = newApp();
    app.route('/api/admin', policyRouter as never);
    const statuses = await Promise.all(
      ROLES.map(
        async (role) =>
          (
            await app.request('/api/admin/clients/client-1/profile', {
              method: 'PUT',
              headers: { 'X-Test-Role': role },
            })
          ).status
      )
    );
    expect(statuses.slice(2)).toEqual([403, 403]);
    expect(statuses[1]).not.toBe(403);
  });
});

describe('real handlers behind the real gate', () => {
  const OWN = 'default';
  const OTHER = 'tenant-b';

  beforeAll(() => {
    const db = new DatabaseSync(':memory:');
    db.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/core/d1/001_0_4_0_core_baseline.sql'), 'utf8')
        .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
        .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()')
    );
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare(
      `INSERT INTO relation_definitions
         (id, tenant_id, object_type, relation_name, definition_json, priority, is_active, created_at, updated_at)
       VALUES ('def-1', ?, 'document', 'viewer', '{"union":["owner"]}', 10, 1, 0, 0)`
    ).run(OWN);
    const values = (params: unknown[] = []) =>
      params.map((value) => (value === undefined ? null : value));
    mocks.adapter = {
      async queryOne(sql: string, params?: unknown[]) {
        return db.prepare(sql).get(...values(params)) ?? null;
      },
      async query(sql: string, params?: unknown[]) {
        return db.prepare(sql).all(...values(params));
      },
    };
  });

  function appWithRealHandlers(): TestApp {
    const app = newApp();
    app.use('/api/admin/rebac/*', requireTenantAdminForChanges());
    app.use('/api/admin/flows/*', requireTenantAdminForChanges());
    app.get(
      '/api/admin/rebac/relation-definitions/:id',
      adminRelationDefinitionGetHandler as never
    );
    app.put('/api/admin/rebac/relation-definitions/:id', (c) => c.json({ changed: true }));
    app.get('/api/admin/flows/:id', adminFlowGetHandler as never);
    app.put('/api/admin/flows/:id', (c) => c.json({ changed: true }));
    return app;
  }

  // support holds neither `admin:roles:read` nor `admin:settings:read`.
  it.each([
    ['/api/admin/rebac/relation-definitions/def-1', [200, 200, 403, 200]],
    ['/api/admin/flows/flow-default-login-no-consent', [200, 200, 403, 200]],
  ] as const)('GET %s reads by permission in its own tenant', async (path, expected) => {
    const app = appWithRealHandlers();
    const statuses = await Promise.all(ROLES.map((role) => statusOf(app, 'GET', path, role, OWN)));
    expect(statuses).toEqual([...expected]);
  });

  it.each([
    '/api/admin/rebac/relation-definitions/def-1',
    '/api/admin/flows/flow-default-login-no-consent',
  ])('GET %s is a 404 from another tenant, for the viewer and the tenant admin', async (path) => {
    const app = appWithRealHandlers();
    for (const role of [TENANT_ADMIN, VIEWER]) {
      expect(await statusOf(app, 'GET', path, role, OTHER), role).toBe(404);
    }
  });

  it.each([
    '/api/admin/rebac/relation-definitions/def-1',
    '/api/admin/flows/flow-default-login-no-consent',
  ])('PUT %s still needs the tenant admin role', async (path) => {
    const app = appWithRealHandlers();
    const statuses = await Promise.all(ROLES.map((role) => statusOf(app, 'PUT', path, role, OWN)));
    expect(statuses).toEqual([200, 200, 403, 403]);
  });
});
