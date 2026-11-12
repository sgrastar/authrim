import { describe, expect, it, vi } from 'vitest';
import type { Context, Next } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import { app } from '../index';

/**
 * The platform tenant-domain-mapping routes are platform-wide: only a system administrator (the
 * global `ar_super_admin` role, or a global machine holding `admin:*`) may reach them. This drives
 * the real management app; only the request context and the mapping handlers (stubs answering
 * 200) are replaced, so a 200 means the caller got past every gate to the handler.
 */
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requestContextMiddleware:
      () =>
      async (c: Context<{ Bindings: Env }>, next: Next): Promise<void> => {
        const ctx = c as unknown as { set(key: string, value: unknown): void };
        ctx.set('requestId', 'tenant-domain-mapping-guard');
        ctx.set('tenantId', 'default');
        ctx.set(
          'logger',
          actual.createLogger({ requestId: 'tenant-domain-mapping-guard', tenantId: 'default' })
        );
        ctx.set('startTime', Date.now());
        const persona = c.req.header('X-Test-Persona');
        if (persona) {
          ctx.set(
            'adminAuth',
            (globalThis as unknown as { __domainPersonas: Record<string, AdminAuthContext> })
              .__domainPersonas[persona]
          );
        }
        await next();
      },
  };
});

vi.mock('../admin-tenant-domain-mappings', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const stubbed: Record<string, unknown> = { ...actual };
  for (const [name, value] of Object.entries(actual)) {
    if (typeof value === 'function' && /Handler$/.test(name)) {
      stubbed[name] = (c: Context) => c.json({ stub: name });
    }
  }
  return stubbed;
});

const DOMAINS = [
  'admin:tenant_domains:read',
  'admin:tenant_domains:write',
  'admin:tenant_domains:delete',
];

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

const PERSONAS: Record<string, AdminAuthContext> = {
  superAdmin: human({
    roles: ['ar_super_admin'],
    globalRoles: ['ar_super_admin'],
    permissions: ['*'],
  }),
  adminStar: machine(['admin:*']),
  tenantAdmin: human({
    roles: ['ar_tenant_admin'],
    tenantScope: ['default'],
    permissions: [...DOMAINS, 'admin:tenant_domains:*'],
  }),
  viewer: human({
    roles: ['ar_viewer'],
    tenantScope: ['default'],
    permissions: ['admin:tenant_domains:read'],
  }),
  globalDomainsMachine: machine(DOMAINS),
  tenantScopedMachine: machine(DOMAINS, ['default']),
  customGlobalRole: human({
    roles: ['custom'],
    globalRoles: ['custom'],
    permissions: DOMAINS,
    globalPermissions: DOMAINS,
  }),
};
(globalThis as unknown as { __domainPersonas: Record<string, AdminAuthContext> }).__domainPersonas =
  PERSONAS;

const env = {
  ISSUER_URL: 'https://op.example.com',
  BASE_DOMAIN: 'op.example.com',
  CONTROL: {
    getReleaseMigrationRolloutStatus: async () => ({ adminMutationMode: 'read_write' }),
  },
  SETTINGS: { get: async () => null },
  RATE_LIMITER: {
    idFromName: (name: string) => name,
    get: () => ({
      incrementRpc: async (
        _key: string,
        config: { maxRequests: number; windowSeconds: number }
      ) => ({
        allowed: true,
        current: 1,
        limit: config.maxRequests,
        resetAt: Math.floor(Date.now() / 1000) + config.windowSeconds,
        retryAfter: 0,
      }),
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
        'X-Tenant-Id': 'default',
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

const BASE = '/api/admin/platform/tenant-domain-mappings';
const ROUTES = [
  ['GET', BASE],
  ['POST', BASE],
  ['POST', `${BASE}/verify`],
  ['POST', `${BASE}/verify/confirm`],
  ['GET', `${BASE}/m1`],
  ['PUT', `${BASE}/m1`],
  ['DELETE', `${BASE}/m1`],
] as const;

describe('platform tenant domain mapping routes', () => {
  for (const [method, path] of ROUTES) {
    it(`${method} ${path}: a system administrator reaches the handler`, async () => {
      for (const persona of ['superAdmin', 'adminStar']) {
        const result = await call(persona, method, path);
        expect({
          persona,
          status: result.status,
          stubbed: /Handler$/.test(String(result.body.stub)),
        }).toEqual({ persona, status: 200, stubbed: true });
      }
    });

    it(`${method} ${path}: nobody else does`, async () => {
      for (const persona of [
        'tenantAdmin',
        'viewer',
        'globalDomainsMachine',
        'tenantScopedMachine',
        'customGlobalRole',
      ]) {
        const result = await call(persona, method, path);
        expect({ persona, status: result.status, stub: result.body.stub ?? null }).toEqual({
          persona,
          status: 403,
          stub: null,
        });
      }
    });
  }
});
