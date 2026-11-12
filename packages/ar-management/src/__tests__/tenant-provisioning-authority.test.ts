import { describe, expect, it, vi } from 'vitest';
import type { Context, Next } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import { ADMIN_PERMISSIONS, hasAdminPermission, hasGlobalAdminRole } from '@authrim/ar-lib-core';
import { app } from '../index';
import {
  ADMIN_ROUTE_ACCESS_RULES,
  findAdminRouteAccessRule,
  tenantProvisioningRoutePermission,
} from '../admin-route-access';

/**
 * Drives the real management app (routing, declared route access, the tenant system-admin guard)
 * for the five tenant routes an automation machine principal may run on its own permission, and
 * for every other tenant route and system-admin route around them. Only the request context
 * (which names the caller) and the tenant handlers (stubs that answer 200) are replaced; the
 * handler-level checks have their own tests.
 */
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requestContextMiddleware:
      () =>
      async (c: Context<{ Bindings: Env }>, next: Next): Promise<void> => {
        const ctx = c as unknown as { set(key: string, value: unknown): void };
        ctx.set('requestId', 'tenant-provisioning-authority');
        const tenantId = c.req.header('X-Tenant-Id') ?? 'default';
        ctx.set('tenantId', tenantId);
        ctx.set(
          'logger',
          actual.createLogger({ requestId: 'tenant-provisioning-authority', tenantId })
        );
        ctx.set('startTime', Date.now());
        const persona = c.req.header('X-Test-Persona');
        if (persona) {
          ctx.set(
            'adminAuth',
            (globalThis as unknown as { __personas: Personas }).__personas[persona]
          );
        }
        await next();
      },
  };
});

vi.mock('../admin-tenants', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const stubbed: Record<string, unknown> = { ...actual };
  for (const [name, value] of Object.entries(actual)) {
    if (typeof value === 'function' && /^adminTenant.*Handler$/.test(name)) {
      stubbed[name] = (c: Context) => c.json({ stub: name });
    }
  }
  return stubbed;
});

type Personas = Record<string, AdminAuthContext>;

const PROVISION = ADMIN_PERMISSIONS.TENANT_PROVISION;
const DELETE = ADMIN_PERMISSIONS.TENANT_DELETE;
const NEW_PERMISSIONS: string[] = [PROVISION, DELETE];
// Every ordinary permission except the wildcards: what a broad machine holds when it can pass
// every declared route rule and is stopped only by the guard.
const BROAD = (Object.values(ADMIN_PERMISSIONS) as string[]).filter(
  (permission) => permission !== '*' && permission !== 'admin:*'
);
const BROAD_WITHOUT_NEW = BROAD.filter((permission) => !NEW_PERMISSIONS.includes(permission));

function machine(permissions: string[], scope: string[] = ['*']): AdminAuthContext {
  return {
    userId: 'machine-1',
    authMethod: 'machine_access_token',
    actorType: 'machine',
    actorId: 'machine-1',
    tenantId: 'default',
    tenantScope: scope,
    roles: [],
    globalRoles: [],
    permissions,
    globalPermissions: scope.includes('*') ? permissions : [],
    hierarchyLevel: 0,
    mfaVerified: false,
  };
}

function human(overrides: Partial<AdminAuthContext>): AdminAuthContext {
  return {
    userId: 'human-1',
    authMethod: 'bearer',
    actorType: 'human',
    tenantId: 'default',
    tenantScope: ['*'],
    roles: [],
    globalRoles: [],
    permissions: [],
    globalPermissions: [],
    hierarchyLevel: 0,
    mfaVerified: true,
    ...overrides,
  };
}

const PERSONAS: Personas = {
  provisionOnly: machine([PROVISION]),
  deleteOnly: machine([DELETE]),
  both: machine(NEW_PERMISSIONS),
  broadWithNew: machine(BROAD),
  broadWithoutNew: machine(BROAD_WITHOUT_NEW),
  settingsOnly: machine([ADMIN_PERMISSIONS.SETTINGS_READ, ADMIN_PERMISSIONS.SETTINGS_WRITE]),
  adminStar: machine(['admin:*']),
  tenantScopedBroad: machine(BROAD, ['default']),
  superAdmin: human({
    roles: ['ar_super_admin'],
    globalRoles: ['ar_super_admin'],
    permissions: ['*'],
  }),
  customGlobalRole: human({
    roles: ['custom'],
    globalRoles: ['custom'],
    permissions: BROAD,
    globalPermissions: BROAD,
  }),
  tenantAdmin: human({
    roles: ['ar_tenant_admin'],
    tenantScope: ['default'],
    permissions: BROAD,
  }),
};
(globalThis as unknown as { __personas: Personas }).__personas = PERSONAS;

const counters = new Map<string, number>();
const env = {
  ISSUER_URL: 'https://op.example.com',
  BASE_DOMAIN: 'op.example.com',
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

async function call(persona: string, method: string, path: string) {
  const response = await app.request(
    path,
    {
      method,
      headers: {
        'CF-Connecting-IP': '192.0.2.10',
        // These routes are tenant-scoped: the header has to name the tenant of the path.
        'X-Tenant-Id': /\/tenants\/tenant-x\/(placement-migrations|runtime-registry)/.test(path)
          ? 'tenant-x'
          : 'default',
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
        'X-Test-Persona': persona,
      },
      ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }),
    },
    env
  );
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body };
}

const TARGETS = [
  { name: 'create', method: 'POST', path: '/api/admin/tenants', permission: PROVISION },
  {
    name: 'status',
    method: 'GET',
    path: '/api/admin/tenants/tenant-x/provisioning',
    permission: PROVISION,
  },
  {
    name: 'retry',
    method: 'POST',
    path: '/api/admin/tenants/tenant-x/provisioning/retry',
    permission: PROVISION,
  },
  {
    name: 'cleanup',
    method: 'POST',
    path: '/api/admin/tenants/tenant-x/provisioning/cleanup',
    permission: PROVISION,
  },
  { name: 'delete', method: 'DELETE', path: '/api/admin/tenants/tenant-x', permission: DELETE },
] as const;

const OTHER_TENANT_ROUTES = [
  ['GET', '/api/admin/tenants'],
  ['GET', '/api/admin/tenants/tenant-x'],
  ['PATCH', '/api/admin/tenants/tenant-x'],
  ['POST', '/api/admin/tenants/tenant-x/set-default'],
  ['POST', '/api/admin/tenants/tenant-x/clone'],
  ['POST', '/api/admin/tenants/tenant-x/lifecycle/suspend'],
  ['POST', '/api/admin/tenants/tenant-x/lifecycle/resume'],
  ['POST', '/api/admin/tenants/tenant-x/lifecycle/freeze'],
  ['POST', '/api/admin/tenants/tenant-x/lifecycle/unfreeze'],
  ['POST', '/api/admin/tenants/tenant-x/lifecycle/restore-validate'],
  ['GET', '/api/admin/tenants/tenant-x/lifecycle/jobs'],
  ['GET', '/api/admin/tenants/tenant-x/placement-migrations/latest'],
  ['POST', '/api/admin/tenants/tenant-x/placement-migrations'],
  ['POST', '/api/admin/tenants/tenant-x/runtime-registry/emergency-purge'],
] as const;

const OTHER_SYSTEM_ADMIN_ROUTES = [
  ['GET', '/api/admin/runtime-profiles'],
  ['GET', '/api/admin/runtime-profiles/defaults'],
  ['PUT', '/api/admin/runtime-profiles/defaults'],
  ['PUT', '/api/admin/runtime-profiles/kind/id'],
  ['DELETE', '/api/admin/runtime-profiles/kind/id'],
] as const;

const GUARD_REFUSAL = { status: 403, body: { error: 'access_denied' } };

describe('the five tenant provisioning and deletion routes', () => {
  const ALLOWED: Record<string, string[]> = {
    provisionOnly: ['create', 'status', 'retry', 'cleanup'],
    deleteOnly: ['delete'],
    both: ['create', 'status', 'retry', 'cleanup', 'delete'],
    broadWithNew: ['create', 'status', 'retry', 'cleanup', 'delete'],
    adminStar: ['create', 'status', 'retry', 'cleanup', 'delete'],
    superAdmin: ['create', 'status', 'retry', 'cleanup', 'delete'],
    // Passes the declared rule through its settings permission and is stopped by the guard.
    broadWithoutNew: [],
    settingsOnly: [],
    tenantScopedBroad: [],
    customGlobalRole: [],
    tenantAdmin: [],
  };

  for (const [persona, allowed] of Object.entries(ALLOWED)) {
    for (const target of TARGETS) {
      const expectAllowed = allowed.includes(target.name);
      it(`${persona}: ${target.name} is ${expectAllowed ? 'admitted' : 'refused'}`, async () => {
        const result = await call(persona, target.method, target.path);
        if (expectAllowed) {
          expect(result.status).toBe(200);
          expect(result.body.stub).toMatch(/^adminTenant/);
        } else {
          expect(result.status).toBe(403);
        }
      });
    }
  }

  it('refuses at the guard, not only at the declared rule, a caller the rule admits', async () => {
    for (const persona of [
      'broadWithoutNew',
      'settingsOnly',
      'tenantScopedBroad',
      'customGlobalRole',
      'tenantAdmin',
    ]) {
      for (const target of TARGETS) {
        const result = await call(persona, target.method, target.path);
        expect({ persona, target: target.name, ...result }).toMatchObject({
          persona,
          target: target.name,
          ...GUARD_REFUSAL,
        });
      }
    }
  });

  it('refuses a provisioning-only machine on the delete route at the declared rule', async () => {
    const result = await call('provisionOnly', 'DELETE', '/api/admin/tenants/tenant-x');
    expect(result).toMatchObject({ status: 403, body: { error: 'insufficient_permissions' } });
  });
});

describe('every other tenant route and system-admin route', () => {
  for (const persona of [
    'provisionOnly',
    'deleteOnly',
    'both',
    'broadWithNew',
    'tenantScopedBroad',
  ]) {
    it(`${persona} is refused on all of them`, async () => {
      for (const [method, path] of [...OTHER_TENANT_ROUTES, ...OTHER_SYSTEM_ADMIN_ROUTES]) {
        const result = await call(persona, method, path);
        expect({ method, path, status: result.status }).toEqual({ method, path, status: 403 });
      }
    });
  }

  it('a broad machine holding the new permissions is stopped by the guard (not only the declared rule) on every other tenant route', async () => {
    for (const [method, path] of OTHER_TENANT_ROUTES) {
      const result = await call('broadWithNew', method, path);
      expect({ method, path, ...result }).toMatchObject({ method, path, ...GUARD_REFUSAL });
    }
  });

  it('a broad machine holding the new permissions is stopped by system-admin guards on the others', async () => {
    for (const [method, path] of OTHER_SYSTEM_ADMIN_ROUTES) {
      const result = await call('broadWithNew', method, path);
      expect({ method, path, status: result.status }).toEqual({ method, path, status: 403 });
    }
  });

  it('a global machine with admin:* and a super admin reach the tenant routes as before', async () => {
    for (const persona of ['adminStar', 'superAdmin']) {
      for (const [method, path] of OTHER_TENANT_ROUTES.filter(
        ([, p]) => !p.includes('placement-migrations') && !p.endsWith('/clone')
      )) {
        const result = await call(persona, method, path);
        // A stub answers 200; the emergency-purge handler (not stubbed) refuses the empty body
        // with 400. Either way the caller got past every gate.
        expect({ persona, method, path, reached: [200, 400].includes(result.status) }).toEqual({
          persona,
          method,
          path,
          reached: true,
        });
      }
    }
  });
});

describe('path strictness', () => {
  const ODD = [
    ['POST', '/api/admin/tenants/'],
    ['POST', '/api/admin/tenants//'],
    ['GET', '/api/admin/tenants/tenant-x/provisioning/'],
    ['POST', '/api/admin/tenants/tenant-x/provisioning/retry/'],
    ['POST', '/api/admin/tenants/tenant-x/provisioning/retry/extra'],
    ['POST', '/api/admin/tenants/tenant-x/provisioning/cleanup/extra'],
    ['DELETE', '/api/admin/tenants/tenant-x/'],
    ['DELETE', '/api/admin/tenants/tenant-x/provisioning'],
    ['DELETE', '/api/admin/tenants/tenant-x/extra'],
    ['GET', '/api/admin/tenants/tenant-x/provisioning/retry'],
    ['PUT', '/api/admin/tenants/tenant-x/provisioning'],
    ['PATCH', '/api/admin/tenants/tenant-x/provisioning/retry'],
    ['POST', '/api/admin/tenants/tenant-x/provisioning'],
    ['POST', '/api/admin/tenants/tenant-x%2Fprovisioning%2Fretry'],
    ['POST', '/api/admin/tenants/tenant-x/provisioning%2Fretry'],
    ['POST', '/api/admin/tenants/tenant-x%2Fprovisioning/retry'],
    ['POST', '/api/admin/tenants/tenant-x/provisioning%252Fretry'],
    ['GET', '/api/admin/tenants/tenant-x%2Fprovisioning'],
    ['POST', '/api/admin/Tenants'],
    ['POST', '/api/admin/tenants/tenant-x/provisioning/retry%00'],
  ] as const;

  it('never gives a spelling other than the five exact routes the machine treatment', async () => {
    for (const persona of ['both', 'broadWithNew']) {
      for (const [method, path] of ODD) {
        const result = await call(persona, method, path);
        expect({ persona, method, path, stub: result.body.stub ?? null }).toEqual({
          persona,
          method,
          path,
          stub: null,
        });
      }
    }
  });

  it('classifies only the five exact method and path pairs', () => {
    for (const target of TARGETS) {
      expect(tenantProvisioningRoutePermission(target.method, target.path)).toBe(target.permission);
    }
    for (const [method, path] of ODD) {
      expect([method, path, tenantProvisioningRoutePermission(method, path)]).toEqual([
        method,
        path,
        null,
      ]);
    }
    for (const [method, path] of [...OTHER_TENANT_ROUTES, ...OTHER_SYSTEM_ADMIN_ROUTES]) {
      expect(tenantProvisioningRoutePermission(method, path)).toBeNull();
    }
  });
});

describe('declared rule decisions', () => {
  // The table as it was before the five rules: they are told apart by their descriptions.
  const NEW_DESCRIPTIONS = new Set([
    'tenant administration create',
    'tenant provisioning status',
    'tenant provisioning retry',
    'tenant provisioning cleanup',
    'tenant deletion',
  ]);
  const before = ADMIN_ROUTE_ACCESS_RULES.filter((rule) => !NEW_DESCRIPTIONS.has(rule.description));

  const regexOf = (pattern: string) =>
    new RegExp(
      `^${pattern
        .split('/')
        .map((segment) =>
          segment === '*'
            ? '.*'
            : segment.startsWith(':')
              ? '[^/]+'
              : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        )
        .join('/')}$`
    );
  const lookup = (table: typeof before, method: string, path: string) =>
    table.find(
      (rule) => rule.methods.includes(method as never) && regexOf(rule.pattern).test(path)
    );
  const decides = (auth: AdminAuthContext, rule: (typeof before)[number] | undefined): boolean => {
    if (!rule) return false;
    if (rule.authenticated) return true;
    const permissions = auth.permissions ?? [];
    return (
      (rule.permissions?.every((p) => hasAdminPermission(permissions, p)) ?? false) ||
      (rule.anyPermissions?.some((p) => hasAdminPermission(permissions, p)) ?? false) ||
      (rule.roles ? hasGlobalAdminRole(auth, rule.roles) : false)
    );
  };

  const callers: Record<string, AdminAuthContext> = {
    ...PERSONAS,
    settingsRead: machine([ADMIN_PERMISSIONS.SETTINGS_READ]),
    lifecycle: machine([
      ADMIN_PERMISSIONS.TENANT_LIFECYCLE_STANDARD,
      ADMIN_PERMISSIONS.TENANT_LIFECYCLE_RECOVERY,
    ]),
    adminTenantsStar: machine(['admin:tenants:*']),
    nobody: machine([]),
  };

  const samples: Array<[string, string]> = [
    ...OTHER_TENANT_ROUTES.map(([m, p]) => [m, p] as [string, string]),
    ['PUT', '/api/admin/tenants'],
    ['DELETE', '/api/admin/tenants'],
    ['PUT', '/api/admin/tenants/tenant-x'],
    ['POST', '/api/admin/tenants/tenant-x'],
    ['GET', '/api/admin/tenants/tenant-x/provisioning/retry'],
    ['GET', '/api/admin/tenants/tenant-x/provisioning/cleanup'],
    ['DELETE', '/api/admin/tenants/tenant-x/provisioning'],
    ['POST', '/api/admin/tenants/tenant-x/provisioning'],
    ['PATCH', '/api/admin/tenants/tenant-x/provisioning'],
    ['POST', '/api/admin/tenants/tenant-x/provisioning/retry/extra'],
    ['DELETE', '/api/admin/tenants/tenant-x/extra'],
    ['GET', '/api/admin/users'],
    ['DELETE', '/api/admin/users/u1'],
  ];

  it('decides every route other than the five as before, for every caller', () => {
    for (const [method, path] of samples) {
      for (const [name, auth] of Object.entries(callers)) {
        const old = decides(auth, lookup(before, method, path));
        const now = decides(auth, lookup(ADMIN_ROUTE_ACCESS_RULES, method, path));
        expect({ name, method, path, now }).toEqual({ name, method, path, now: old });
        // The table the gate really uses agrees with this reading of it.
        expect(findAdminRouteAccessRule(method, path)).toBe(
          lookup(ADMIN_ROUTE_ACCESS_RULES, method, path) ?? null
        );
      }
    }
  });

  it('admits on the five routes whoever was admitted before, and the holder of the new permission', () => {
    for (const target of TARGETS) {
      for (const [name, auth] of Object.entries(callers)) {
        const old = decides(auth, lookup(before, target.method, target.path));
        const now = decides(auth, lookup(ADMIN_ROUTE_ACCESS_RULES, target.method, target.path));
        if (old)
          expect({ name, target: target.name, now }).toEqual({
            name,
            target: target.name,
            now: true,
          });
        const holds = hasAdminPermission(auth.permissions ?? [], target.permission);
        if (holds)
          expect({ name, target: target.name, now }).toEqual({
            name,
            target: target.name,
            now: true,
          });
        if (!old && !holds)
          expect({ name, target: target.name, now }).toEqual({
            name,
            target: target.name,
            now: false,
          });
      }
    }
  });
});
