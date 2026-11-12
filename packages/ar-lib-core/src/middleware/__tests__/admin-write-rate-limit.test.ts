/**
 * The Admin API write limit: one counter per tenant and authenticated principal, on writes only,
 * with its own class.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { requestContextMiddleware } from '../request-context';
import type { Env } from '../../types/env';
import {
  ADMIN_WRITE_RATE_LIMIT_CLASS,
  adminWritePrincipalKey,
  adminWriteRateLimitMiddleware,
  clearRateLimitConfigCache,
  clearRateLimitFastPathCache,
  getRateLimitProfileAsync,
  rateLimitMiddleware,
  RateLimitProfiles,
} from '../rate-limit';

/** A RateLimiterCounter stand-in that counts per key. */
function createEnv(settings?: Record<string, unknown>) {
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
    ...(settings
      ? {
          SETTINGS: {
            get: async (key: string) =>
              key === 'settings:platform:rate-limit' ? JSON.stringify(settings) : null,
          },
        }
      : {}),
  } as unknown as Env;
  return { env, counters };
}

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  // Stands in for admin authentication: the principal comes from headers.
  app.use('/api/admin/*', async (c, next) => {
    const userId = c.req.header('X-Test-User');
    if (userId) {
      (c as unknown as { set(k: string, v: unknown): void }).set('adminAuth', {
        userId,
        actorType: c.req.header('X-Test-Actor-Type') ?? undefined,
        actorId: c.req.header('X-Test-Actor-Id') ?? undefined,
        credentialId: c.req.header('X-Test-Credential') ?? undefined,
        // Set when the request came through the Admin Console's server (transport only).
        transportAuth: c.req.header('X-Test-Bff') ? { principalId: 'bff-principal' } : undefined,
      });
    }
    await next();
  });
  app.use('/api/admin/*', adminWriteRateLimitMiddleware());
  // A per-route limiter keyed by IP without a class, like the Admin API's per-family ones.
  app.use('/api/admin/strict/*', rateLimitMiddleware({ ...RateLimitProfiles.strict }));
  app.all('/api/admin/*', (c) => c.json({ ok: true }));
  return app;
}

const headers = (extra: Record<string, string> = {}) => ({
  'CF-Connecting-IP': '192.0.2.10',
  'X-Tenant-Id': 'tenant-a',
  'X-Test-User': 'alice',
  ...extra,
});

const key = async (tenant: string, auth: Parameters<typeof adminWritePrincipalKey>[0]) =>
  `tenant:${tenant}:rate-limit:${ADMIN_WRITE_RATE_LIMIT_CLASS}:${await adminWritePrincipalKey(auth)}`;
/** The tenant-less scope of platform, inventory and service paths. */
const globalKey = async (auth: Parameters<typeof adminWritePrincipalKey>[0]) =>
  `rate-limit:${ADMIN_WRITE_RATE_LIMIT_CLASS}:${await adminWritePrincipalKey(auth)}`;

/** Loads the platform limits into the profile cache, as the first request of an isolate does. */
async function primeProfile(env: Env) {
  const pending: Promise<unknown>[] = [];
  await getRateLimitProfileAsync(env, 'adminWrite', {
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
  } as unknown as Parameters<typeof getRateLimitProfileAsync>[2]);
  await Promise.all(pending);
}

const write = (
  app: ReturnType<typeof createApp>,
  env: Env,
  extra: Record<string, string> = {},
  path = '/api/admin/things',
  method = 'POST'
) => app.request(path, { method, headers: headers(extra) }, env);

beforeEach(() => {
  clearRateLimitConfigCache();
  clearRateLimitFastPathCache();
});

describe('principal key', () => {
  it('keys a human by the admin user id, a machine by its principal, an agent by its identity', async () => {
    const human = await adminWritePrincipalKey({ userId: 'u1' });
    expect(human).toMatch(/^admin:[A-Za-z0-9_-]{43}$/);
    expect(await adminWritePrincipalKey({ userId: 'u1', actorType: 'human' })).toBe(human);
    expect(
      await adminWritePrincipalKey({ userId: 'm1', actorType: 'machine', actorId: 'm1' })
    ).toMatch(/^machine:/);
    // The agent's human delegator is `userId`; the budget is the agent's.
    const agent = await adminWritePrincipalKey({
      userId: 'u1',
      actorType: 'agent',
      actorId: 'agent-7',
    });
    expect(agent).toBe(
      await adminWritePrincipalKey({ userId: 'other', actorType: 'agent', actorId: 'agent-7' })
    );
    expect(await adminWritePrincipalKey({})).toBeUndefined();
  });

  it('keeps actor types with the same id apart', async () => {
    const keys = [
      await adminWritePrincipalKey({ userId: 'x' }),
      await adminWritePrincipalKey({ userId: 'x', actorType: 'machine', actorId: 'x' }),
      await adminWritePrincipalKey({ userId: 'x', actorType: 'agent', actorId: 'x' }),
    ];
    expect(new Set(keys).size).toBe(3);
  });

  it('never lets long ids that differ only late share a key, and has a fixed length', async () => {
    const prefix = `client:https://client.example.com/${'a'.repeat(300)}`;
    const one = await adminWritePrincipalKey({
      userId: 'u',
      actorType: 'agent',
      actorId: `${prefix}1`,
    });
    const two = await adminWritePrincipalKey({
      userId: 'u',
      actorType: 'agent',
      actorId: `${prefix}2`,
    });

    expect(one).not.toBe(two);
    expect(one!.length).toBe(two!.length);
    expect(one!.length).toBeLessThan(64);
    expect(
      await adminWritePrincipalKey({ userId: 'u', actorType: 'agent', actorId: `${prefix}1` })
    ).toBe(one);
  });
});

describe('Admin API write limit', () => {
  it('has a generous default of 600 per minute', () => {
    expect(RateLimitProfiles.adminWrite).toEqual({ maxRequests: 600, windowSeconds: 60 });
  });

  it('never counts reads', async () => {
    const { env, counters } = createEnv();
    const app = createApp();

    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect((await write(app, env, {}, '/api/admin/things', method)).status).toBe(200);
    }

    expect([...counters.keys()]).toEqual([]);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('counts %s under the principal', async (method) => {
    const { env, counters } = createEnv();
    const app = createApp();

    expect((await write(app, env, {}, '/api/admin/things', method)).status).toBe(200);

    expect([...counters.keys()]).toEqual([await key('tenant-a', { userId: 'alice' })]);
  });

  it('does not count a request with no admin context, and never falls back to the IP', async () => {
    const { env, counters } = createEnv();
    const app = createApp();
    const { 'X-Test-User': _omitted, ...anonymous } = headers();

    const response = await app.request(
      '/api/admin/things',
      { method: 'POST', headers: anonymous },
      env
    );

    expect(response.status).toBe(200);
    expect([...counters.keys()]).toEqual([]);
  });

  it('answers the standard 429 over the limit, and lets a read through', async () => {
    const { env } = createEnv({ 'rate_limit.admin_write': 3 });
    await primeProfile(env);
    const app = createApp();

    for (let index = 0; index < 3; index++) {
      expect((await write(app, env)).status).toBe(200);
    }
    const refused = await write(app, env);

    expect(refused.status).toBe(429);
    expect(refused.headers.get('X-RateLimit-Limit')).toBe('3');
    expect(refused.headers.get('Retry-After')).not.toBeNull();
    expect(await refused.json()).toMatchObject({
      error: 'rate_limit_exceeded',
      error_description: 'Too many requests. Please try again later.',
    });
    expect((await write(app, env, {}, '/api/admin/things', 'GET')).status).toBe(200);
  });

  it('follows the platform setting for the limit', async () => {
    const { env } = createEnv({ 'rate_limit.admin_write': 2 });
    await primeProfile(env);
    const app = createApp();

    await write(app, env);
    const second = await write(app, env);
    const third = await write(app, env);

    expect(second.headers.get('X-RateLimit-Limit')).toBe('2');
    expect(third.status).toBe(429);
  });

  it('gives two administrators on the same IP and tenant independent budgets', async () => {
    const { env } = createEnv({ 'rate_limit.admin_write': 1 });
    await primeProfile(env);
    const app = createApp();

    expect((await write(app, env, { 'X-Test-User': 'alice' })).status).toBe(200);
    expect((await write(app, env, { 'X-Test-User': 'alice' })).status).toBe(429);
    expect((await write(app, env, { 'X-Test-User': 'bob' })).status).toBe(200);
  });

  it('shares one budget for the same administrator across IPs', async () => {
    const { env } = createEnv({ 'rate_limit.admin_write': 1 });
    await primeProfile(env);
    const app = createApp();

    expect((await write(app, env, { 'CF-Connecting-IP': '192.0.2.1' })).status).toBe(200);
    expect((await write(app, env, { 'CF-Connecting-IP': '192.0.2.2' })).status).toBe(429);
  });

  it('keys a human through the console server by the human, not the transport principal', async () => {
    const { env, counters } = createEnv();
    const app = createApp();

    await write(app, env, { 'X-Test-User': 'alice', 'X-Test-Bff': '1' });
    await write(app, env, { 'X-Test-User': 'bob', 'X-Test-Bff': '1' });

    expect([...counters.keys()].sort()).toEqual(
      [await key('tenant-a', { userId: 'alice' }), await key('tenant-a', { userId: 'bob' })].sort()
    );
  });

  it('keys a machine by its principal across credentials', async () => {
    const { env, counters } = createEnv();
    const app = createApp();
    const machine = {
      'X-Test-User': 'm1',
      'X-Test-Actor-Type': 'machine',
      'X-Test-Actor-Id': 'm1',
    };

    await write(app, env, { ...machine, 'X-Test-Credential': 'cred-1' });
    await write(app, env, { ...machine, 'X-Test-Credential': 'cred-2' });

    const machineKey = await key('tenant-a', { userId: 'm1', actorType: 'machine', actorId: 'm1' });
    expect([...counters.keys()]).toEqual([machineKey]);
    expect(counters.get(machineKey)).toBe(2);
  });

  it('keeps tenants apart for the same administrator', async () => {
    const { env } = createEnv({ 'rate_limit.admin_write': 1 });
    await primeProfile(env);
    const app = createApp();

    expect((await write(app, env, { 'X-Tenant-Id': 'tenant-a' })).status).toBe(200);
    expect((await write(app, env, { 'X-Tenant-Id': 'tenant-a' })).status).toBe(429);
    expect((await write(app, env, { 'X-Tenant-Id': 'tenant-b' })).status).toBe(200);
  });

  it('is separate from an IP-keyed limiter without a class, in both directions', async () => {
    const { env, counters } = createEnv({ 'rate_limit.admin_write': 1000 });
    await primeProfile(env);
    const app = createApp();

    for (let index = 0; index < 10; index++) await write(app, env, {}, '/api/admin/strict/a');
    expect((await write(app, env, {}, '/api/admin/strict/a')).status).toBe(429);
    expect((await write(app, env, {}, '/api/admin/other')).status).toBe(200);

    expect(counters.get(await key('tenant-a', { userId: 'alice' }))).toBe(12);
    const classLessKey = [...counters.keys()].find(
      (k) => !k.includes(`:${ADMIN_WRITE_RATE_LIMIT_CLASS}:`)
    );
    expect(counters.get(classLessKey!)).toBe(11);
  });

  it('counts platform and tenant-inventory paths in one tenant-less scope per principal', async () => {
    const { env, counters } = createEnv();
    const app = createApp();

    // Rotating tenant names (hosts the request context did not verify) on non-tenant-scoped paths.
    for (const [index, path] of [
      '/api/admin/platform/settings',
      '/api/admin/tenants',
      '/api/admin/tenants/t1/info',
    ].entries()) {
      await write(app, env, { 'X-Tenant-Id': `fake-${index}` }, path);
    }

    expect([...counters.keys()]).toEqual([await globalKey({ userId: 'alice' })]);
    expect(counters.get(await globalKey({ userId: 'alice' }))).toBe(3);
  });

  it('keeps real tenants apart on tenant-scoped paths, whatever the platform scope has spent', async () => {
    const { env, counters } = createEnv({ 'rate_limit.admin_write': 1 });
    await primeProfile(env);
    const app = createApp();

    expect(
      (await write(app, env, { 'X-Tenant-Id': 'tenant-a' }, '/api/admin/platform/x')).status
    ).toBe(200);
    expect(
      (await write(app, env, { 'X-Tenant-Id': 'tenant-b' }, '/api/admin/platform/x')).status
    ).toBe(429);
    expect((await write(app, env, { 'X-Tenant-Id': 'tenant-a' })).status).toBe(200);
    expect((await write(app, env, { 'X-Tenant-Id': 'tenant-b' })).status).toBe(200);
    expect(counters.size).toBe(3);
  });

  it('refuses an unknown tenant on a tenant-scoped path before the limiter (not counted)', async () => {
    const { env, counters } = createEnv();
    const app = new Hono<{ Bindings: Env }>();
    // The real request context: an unknown tenant is answered 404 before anything counts.
    app.use('*', requestContextMiddleware());
    app.use('/api/admin/*', async (c, next) => {
      (c as unknown as { set(k: string, v: unknown): void }).set('adminAuth', { userId: 'alice' });
      await next();
    });
    app.use('/api/admin/*', adminWriteRateLimitMiddleware());
    app.all('/api/admin/*', (c) => c.json({ ok: true }));

    const response = await app.request(
      '/api/admin/things',
      { method: 'POST', headers: headers({ 'X-Tenant-Id': 'no-such-tenant' }) },
      env
    );

    expect(response.status).toBe(404);
    expect([...counters.keys()]).toEqual([]);
  });

  it('fails closed with 503 when the counter cannot answer', async () => {
    const { env } = createEnv();
    (env as unknown as { RATE_LIMITER: unknown }).RATE_LIMITER = {
      idFromName: () => 'x',
      get: () => ({ incrementRpc: vi.fn().mockRejectedValue(new Error('down')) }),
    };
    (env as unknown as { STATE_STORE: unknown }).STATE_STORE = undefined;
    const app = createApp();

    expect((await write(app, env)).status).toBe(503);
  });
});
