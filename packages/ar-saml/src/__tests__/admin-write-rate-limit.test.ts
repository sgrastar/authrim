import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context, Next } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import {
  ADMIN_PERMISSIONS,
  adminWritePrincipalKey,
  clearRateLimitConfigCache,
  clearRateLimitFastPathCache,
} from '@authrim/ar-lib-core';
import { app } from '../index';

const keyOf = async (userId: string, tenant = 'default') =>
  `tenant:${tenant}:rate-limit:adminWrite:${await adminWritePrincipalKey({
    userId,
    actorType: 'machine',
    actorId: userId,
  })}`;

/**
 * ar-router sends the SAML admin routes to this worker directly, so the Admin API write limit has
 * to be applied here, on the same counter class ar-management uses. Only the request context is
 * replaced: it names the tenant and, for requests that say so, the already-authenticated admin.
 */
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requestContextMiddleware:
      () =>
      async (c: Context<{ Bindings: Env }>, next: Next): Promise<void> => {
        const tenantId = c.req.header('X-Tenant-Id') ?? 'default';
        c.set('requestId' as never, 'saml-admin-write' as never);
        c.set('tenantId' as never, tenantId as never);
        c.set(
          'logger' as never,
          actual.createLogger({ requestId: 'saml-admin-write', tenantId }) as never
        );
        c.set('startTime' as never, Date.now() as never);
        if (c.req.header('X-Test-Admin')) {
          c.set(
            'adminAuth' as never,
            {
              userId: c.req.header('X-Test-User') ?? 'admin-1',
              authMethod: 'machine_access_token',
              actorType: 'machine',
              actorId: c.req.header('X-Test-User') ?? 'admin-1',
              tenantId,
              tenantScope: [tenantId],
              roles: [],
              permissions:
                c.req.header('X-Test-Admin') === 'read-only'
                  ? [ADMIN_PERMISSIONS.SAML_PROVIDERS_LIST, ADMIN_PERMISSIONS.SAML_PROVIDERS_READ]
                  : Object.values(ADMIN_PERMISSIONS),
              hierarchyLevel: 0,
              mfaVerified: false,
            } satisfies AdminAuthContext as never
          );
        }
        await next();
      },
  };
});

function createEnv() {
  const counters = new Map<string, number>();
  const env = {
    ISSUER_URL: 'https://op.example.com',
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
            allowed: current <= config.maxRequests,
            current,
            limit: config.maxRequests,
            resetAt: Math.floor(Date.now() / 1000) + config.windowSeconds,
            retryAfter: 0,
          };
        },
      }),
    },
  } as unknown as Env;
  return { env, counters };
}

const executionCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const admin = {
  'CF-Connecting-IP': '192.0.2.10',
  'X-Tenant-Id': 'default',
  Authorization: 'Bearer test-token',
  'X-Test-Admin': '1',
};

const call = (
  env: Env,
  method: string,
  headers: Record<string, string>,
  path = '/api/admin/saml-providers'
) => app.request(path, { method, headers }, env, executionCtx);

beforeEach(() => {
  clearRateLimitConfigCache();
  clearRateLimitFastPathCache();
});

describe('Admin API write limit on the SAML admin routes', () => {
  it('counts an authenticated write under the principal and never a read', async () => {
    const { env, counters } = createEnv();

    await call(env, 'GET', admin);
    expect([...counters.keys()]).toEqual([]);

    await call(env, 'POST', admin);

    expect([...counters.keys()]).toEqual([await keyOf('admin-1')]);
  });

  it('answers the standard 429 after 600 writes of one principal in a window', async () => {
    const { env } = createEnv();
    let last: Response | undefined;
    for (let index = 0; index < 601; index++) {
      last = await call(env, 'DELETE', admin, '/api/admin/saml-providers/provider-1');
    }

    expect(last?.status).toBe(429);
    expect(await last?.json()).toMatchObject({ error: 'rate_limit_exceeded' });
  });

  it('does not count an unauthenticated write', async () => {
    const { env, counters } = createEnv();
    const { 'X-Test-Admin': _omitted, ...unauthenticated } = admin;

    const response = await call(env, 'POST', unauthenticated);

    expect(response.status).toBe(401);
    expect([...counters.keys()]).toEqual([]);
  });

  it('keeps administrators on the same IP and tenant independent, whatever one sends', async () => {
    const { env, counters } = createEnv();
    const reader = { ...admin, 'X-Test-Admin': 'read-only', 'X-Test-User': 'reader' };

    // Refused by the handler (403), unregistered spellings (404): all spend the reader's own budget.
    for (const [method, path] of [
      ['POST', '/api/admin/saml-providers'],
      ['POST', '/api/admin/saml-providers/'],
      ['PATCH', '/api/admin/saml-providers/provider-1'],
    ]) {
      await call(env, method, reader, path);
    }
    await call(env, 'POST', admin);

    expect(counters.get(await keyOf('reader'))).toBe(3);
    expect(counters.get(await keyOf('admin-1'))).toBe(1);
  });

  it('shares one budget for the same principal across IPs, and keeps tenants apart', async () => {
    const { env, counters } = createEnv();

    await call(env, 'POST', { ...admin, 'CF-Connecting-IP': '192.0.2.1' });
    await call(env, 'POST', { ...admin, 'CF-Connecting-IP': '192.0.2.2' });
    await call(env, 'POST', { ...admin, 'X-Tenant-Id': 'tenant-b' });

    expect(counters.get(await keyOf('admin-1'))).toBe(2);
    expect(counters.get(await keyOf('admin-1', 'tenant-b'))).toBe(1);
  });
});
