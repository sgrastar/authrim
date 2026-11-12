import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context, Next } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import {
  ADMIN_PERMISSIONS,
  ADMIN_ROLE_GROUPS,
  SETUP_MACHINE_CLIENT_ID,
  SETUP_MACHINE_PRINCIPAL_ID,
  adminWritePrincipalKey,
  clearRateLimitConfigCache,
  clearRateLimitFastPathCache,
  getRateLimitProfileAsync,
} from '@authrim/ar-lib-core';
import { app } from '../index';

/**
 * Drives the real management app (real routing, CSRF, admin auth, route access and rate-limit
 * middleware) to check the Admin API write limit: where it sits, what it counts, and that the
 * counters of the routes around it stay separate. Only the request context is replaced: it names
 * the tenant and, for the requests that say so, the already-authenticated admin.
 */
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requestContextMiddleware:
      () =>
      async (c: Context<{ Bindings: Env }>, next: Next): Promise<void> => {
        const tenantId = c.req.header('X-Tenant-Id') ?? 'default';
        const ctx = c as unknown as { set(key: string, value: unknown): void };
        ctx.set('requestId', 'admin-write-limit');
        ctx.set('tenantId', tenantId);
        ctx.set('logger', actual.createLogger({ requestId: 'admin-write-limit', tenantId }));
        ctx.set('startTime', Date.now());
        const role = c.req.header('X-Test-Admin');
        if (role) {
          ctx.set('adminAuth', {
            userId: c.req.header('X-Test-User') ?? 'admin-1',
            authMethod: 'machine_access_token',
            actorType: 'machine',
            // 'platform' is the setup machine, which the internal version routes admit.
            actorId:
              role === 'platform'
                ? SETUP_MACHINE_PRINCIPAL_ID
                : (c.req.header('X-Test-User') ?? 'admin-1'),
            ...(role === 'platform'
              ? { principalType: 'setup_tool' as const, clientId: SETUP_MACHINE_CLIENT_ID }
              : {}),
            globalPermissions: role === 'platform' ? Object.values(ADMIN_PERMISSIONS) : [],
            tenantId,
            tenantScope: [tenantId],
            roles: role === 'platform' ? [...ADMIN_ROLE_GROUPS.platform] : [],
            globalRoles: role === 'platform' ? [...ADMIN_ROLE_GROUPS.platform] : [],
            permissions:
              role === 'super' || role === 'platform' ? Object.values(ADMIN_PERMISSIONS) : [],
            hierarchyLevel: 0,
            mfaVerified: false,
          } satisfies AdminAuthContext);
        }
        await next();
      },
  };
});

/** A counting RateLimiterCounter stand-in, and the platform setting for the write limit. */
function createEnv(settings: Record<string, unknown> = {}) {
  const counters = new Map<string, number>();
  const env = {
    ISSUER_URL: 'https://op.example.com',
    // No rollout in progress: Admin API writes are not paused.
    CONTROL: {
      getReleaseMigrationRolloutStatus: async () => ({ adminMutationMode: 'read_write' }),
    },
    SETTINGS: {
      get: async (key: string) =>
        key === 'settings:platform:rate-limit' ? JSON.stringify(settings) : null,
    },
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

const base = {
  'CF-Connecting-IP': '192.0.2.10',
  'X-Tenant-Id': 'default',
  Authorization: 'Bearer test-token',
  'Content-Type': 'application/json',
};
const asAdmin = (extra: Record<string, string> = {}) => ({
  ...base,
  'X-Test-Admin': 'super',
  ...extra,
});

// A write that has a per-family limiter (strict, no class) and a declared access rule.
const WRITE_PATH = '/api/admin/users/u1/suspend';
const writeKeys = (counters: Map<string, number>) =>
  [...counters.keys()].filter((key) => key.includes(':adminWrite:'));

/** Loads the platform limits into the profile cache, as the first request of an isolate does. */
async function prime(env: Env) {
  const pending: Promise<unknown>[] = [];
  await getRateLimitProfileAsync(env, 'adminWrite', {
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
  } as unknown as Parameters<typeof getRateLimitProfileAsync>[2]);
  await Promise.all(pending);
}

beforeEach(() => {
  clearRateLimitConfigCache();
  clearRateLimitFastPathCache();
});

/** The counter of the test machine principal `admin-1` in tenant `default`. */
const keyOf = async (userId = 'admin-1', tenant = 'default') =>
  `tenant:${tenant}:rate-limit:adminWrite:${await adminWritePrincipalKey({
    userId,
    actorType: 'machine',
    actorId: userId,
  })}`;

describe('Admin API write limit on the management app', () => {
  it('counts an authorised write under the principal and never a read', async () => {
    const { env, counters } = createEnv();

    await app.request('/api/admin/stats', { headers: asAdmin() }, env);
    expect(writeKeys(counters)).toEqual([]);

    const response = await app.request(WRITE_PATH, { method: 'POST', headers: asAdmin() }, env);

    expect(response.status).not.toBe(429);
    expect(writeKeys(counters)).toEqual([await keyOf()]);
  });

  it('refuses over the limit with the standard 429, and the platform setting moves the limit', async () => {
    const { env } = createEnv({ 'rate_limit.admin_write': 2 });
    await prime(env);
    const path = '/api/admin/settings';
    const statuses: number[] = [];
    for (let index = 0; index < 3; index++) {
      const response = await app.request(path, { method: 'PUT', headers: asAdmin() }, env);
      statuses.push(response.status);
      if (response.status === 429) {
        expect(await response.json()).toMatchObject({
          error: 'rate_limit_exceeded',
          error_description: 'Too many requests. Please try again later.',
        });
        expect(response.headers.get('X-RateLimit-Limit')).toBe('2');
      }
    }

    expect(statuses[0]).not.toBe(429);
    expect(statuses[1]).not.toBe(429);
    expect(statuses[2]).toBe(429);
  });

  it('does not count an unauthenticated write, and answers it as before', async () => {
    const { env, counters } = createEnv();

    const response = await app.request(WRITE_PATH, { method: 'POST', headers: base }, env);

    expect(response.status).toBe(401);
    expect(writeKeys(counters)).toEqual([]);
  });

  it('does not count a write the caller is not authorised for, and answers it as before', async () => {
    const { env, counters } = createEnv();

    const response = await app.request(
      WRITE_PATH,
      { method: 'POST', headers: asAdmin({ 'X-Test-Admin': 'viewer' }) },
      env
    );

    expect(response.status).toBe(403);
    expect(writeKeys(counters)).toEqual([]);
  });

  it('refuses a write that matches no declared route rule before the limiter, so it is not counted', async () => {
    const { env, counters } = createEnv();

    for (const path of ['/api/admin/undocumented', '/api/admin/nothing/here']) {
      const response = await app.request(path, { method: 'POST', headers: asAdmin() }, env);
      expect([path, response.status]).toEqual([path, 403]);
    }

    expect(writeKeys(counters)).toEqual([]);
  });

  it('keeps administrators on the same IP and tenant independent, whatever one of them sends', async () => {
    const { env } = createEnv({ 'rate_limit.admin_write': 3 });
    await prime(env);
    const viewer = asAdmin({ 'X-Test-Admin': 'viewer', 'X-Test-User': 'viewer-1' });
    const paths: Array<[string, string]> = [
      // A read-only rule that admits a non-mutating POST.
      ['POST', '/api/admin/identity-mapping/preview-effective'],
      // An any-admin self-service rule, and an unregistered sub-path under it (404).
      ['POST', '/api/admin/me/passkeys/options'],
      ['POST', '/api/admin/me/passkeys/unregistered-sub'],
      ['POST', '/api/admin/notices/n1/dismiss'],
    ];

    // The viewer spends its own budget on all of these (and is refused by its own limit).
    let viewerRefused = 0;
    for (let round = 0; round < 3; round++) {
      for (const [method, path] of paths) {
        const response = await app.request(path, { method, headers: viewer, body: '{}' }, env);
        if (response.status === 429) viewerRefused += 1;
      }
    }
    expect(viewerRefused).toBeGreaterThan(0);

    // An administrator on the same IP and tenant still has the whole budget.
    for (let index = 0; index < 3; index++) {
      const response = await app.request(WRITE_PATH, { method: 'POST', headers: asAdmin() }, env);
      expect(response.status).not.toBe(429);
    }
    const fourth = await app.request(WRITE_PATH, { method: 'POST', headers: asAdmin() }, env);
    expect(fourth.status).toBe(429);
  });

  it('shares one budget for the same administrator across IPs', async () => {
    const { env } = createEnv({ 'rate_limit.admin_write': 1 });
    await prime(env);
    const path = '/api/admin/settings';

    const first = await app.request(
      path,
      { method: 'PUT', headers: asAdmin({ 'CF-Connecting-IP': '192.0.2.1' }) },
      env
    );
    const second = await app.request(
      path,
      { method: 'PUT', headers: asAdmin({ 'CF-Connecting-IP': '192.0.2.2' }) },
      env
    );

    expect(first.status).not.toBe(429);
    expect(second.status).toBe(429);
  });

  it('keeps the same administrator apart per tenant', async () => {
    const { env } = createEnv({ 'rate_limit.admin_write': 1 });
    await prime(env);
    const path = '/api/admin/settings';
    const put = (tenant: string) =>
      app.request(path, { method: 'PUT', headers: asAdmin({ 'X-Tenant-Id': tenant }) }, env);

    expect((await put('tenant-a')).status).not.toBe(429);
    expect((await put('tenant-a')).status).toBe(429);
    expect((await put('tenant-b')).status).not.toBe(429);
  });

  it('counts platform-path writes in one tenant-less scope, whatever host or tenant name arrives', async () => {
    const { env, counters } = createEnv();

    for (const tenant of ['fake-1', 'fake-2', 'fake-3']) {
      await app.request(
        '/api/admin/platform/settings/anything',
        { method: 'PUT', headers: asAdmin({ 'X-Tenant-Id': tenant }), body: '{}' },
        env
      );
    }

    expect(writeKeys(counters)).toEqual([
      `rate-limit:adminWrite:${await adminWritePrincipalKey({
        userId: 'admin-1',
        actorType: 'machine',
        actorId: 'admin-1',
      })}`,
    ]);
  });

  it('counts the internal version registration write after its own gate, in the tenant-less scope', async () => {
    const { env, counters } = createEnv();

    const refused = await app.request(
      '/api/internal/versions/ar-auth',
      { method: 'POST', headers: asAdmin({ 'X-Test-Admin': 'viewer' }), body: '{}' },
      env
    );
    expect(writeKeys(counters)).toEqual([]);

    const admitted = await app.request(
      '/api/internal/versions/ar-auth',
      { method: 'POST', headers: asAdmin({ 'X-Test-Admin': 'platform' }), body: '{}' },
      env
    );

    expect([refused.status, admitted.status]).not.toContain(429);
    expect(writeKeys(counters)).toEqual([
      `rate-limit:adminWrite:${await adminWritePrincipalKey({
        userId: 'admin-1',
        actorType: 'machine',
        actorId: SETUP_MACHINE_PRINCIPAL_ID,
      })}`,
    ]);
  });

  it('keeps the per-family (IP-keyed) limiter working on top of it', async () => {
    const { env, counters } = createEnv();
    const statuses: number[] = [];

    // The suspend route has a strict (10 per minute) limiter of its own.
    for (let index = 0; index < 11; index++) {
      const response = await app.request(
        WRITE_PATH,
        { method: 'POST', headers: asAdmin(), body: '{}' },
        env
      );
      statuses.push(response.status);
    }

    expect(statuses.slice(0, 10).every((status) => status !== 429)).toBe(true);
    expect(statuses[10]).toBe(429);
    // The 11th write was refused by the family limiter after the write limit counted it.
    expect(counters.get(await keyOf())).toBe(11);
  });
});

describe('diagnostic log ingest limit', () => {
  it('is per IP and tenant on its own counter, and does not spend the Admin API write counter', async () => {
    const { env, counters } = createEnv();

    await app.request(
      '/api/v1/diagnostic-logs/ingest',
      { method: 'POST', headers: { 'CF-Connecting-IP': '192.0.2.10' }, body: '{}' },
      env
    );

    expect([...counters.keys()]).toEqual([
      'tenant:default:rate-limit:diagnostic_log_ingest:192.0.2.10',
    ]);
  });

  it('answers the standard 429 over the moderate limit', async () => {
    const { env } = createEnv();
    let last: Response | undefined;
    for (let index = 0; index < 61; index++) {
      last = await app.request(
        '/api/v1/diagnostic-logs/ingest',
        { method: 'POST', headers: { 'CF-Connecting-IP': '192.0.2.10' }, body: '{}' },
        env
      );
    }

    expect(last?.status).toBe(429);
    expect(await last?.json()).toMatchObject({ error: 'rate_limit_exceeded' });
  });

  it('is not throttled by an exhausted class-less limiter, nor the other way round', async () => {
    const { env } = createEnv();
    // Exhaust the shared class-less counter of tenant default and this IP (strict: /register).
    for (let index = 0; index < 11; index++) {
      await app.request(
        '/register',
        { method: 'POST', headers: { 'CF-Connecting-IP': '192.0.2.10' }, body: '{}' },
        env
      );
    }
    const refused = await app.request(
      '/register',
      { method: 'POST', headers: { 'CF-Connecting-IP': '192.0.2.10' }, body: '{}' },
      env
    );
    expect(refused.status).toBe(429);

    const ingest = await app.request(
      '/api/v1/diagnostic-logs/ingest',
      { method: 'POST', headers: { 'CF-Connecting-IP': '192.0.2.10' }, body: '{}' },
      env
    );

    expect(ingest.status).not.toBe(429);
  });

  const ingest = (env: Env, requestTenant: string, bodyTenant?: string) =>
    app.request(
      '/api/v1/diagnostic-logs/ingest',
      {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '192.0.2.10', 'X-Tenant-Id': requestTenant },
        body: JSON.stringify({
          ...(bodyTenant ? { tenant_id: bodyTenant } : {}),
          client_id: 'c',
          logs: [],
        }),
      },
      env
    );

  it('counts a body tenant that matches the request tenant once, on the route counter', async () => {
    const { env, counters } = createEnv();

    await ingest(env, 'tenant-a', 'tenant-a');

    expect([...counters.keys()]).toEqual([
      'tenant:tenant-a:rate-limit:diagnostic_log_ingest:192.0.2.10',
    ]);
  });

  it('never touches the destination counter of a request that is not a valid ingest', async () => {
    const { env, counters } = createEnv();

    // Unknown client, a made-up destination tenant, and a malformed tenant id.
    await ingest(env, 'tenant-a', 'victim');
    await ingest(env, 'tenant-a', 'another-made-up');
    const malformed = await ingest(env, 'tenant-a', 'Not_A_Tenant');

    expect(malformed.status).toBe(400);
    expect([...counters.keys()]).toEqual([
      'tenant:tenant-a:rate-limit:diagnostic_log_ingest:192.0.2.10',
    ]);
  });
});
