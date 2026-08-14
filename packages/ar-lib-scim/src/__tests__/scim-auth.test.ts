import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core/types/env';
import {
  generateScimToken,
  listScimTokens,
  revokeScimToken,
  scimAuthMiddleware,
} from '../middleware/scim-auth';

function createMemoryKV() {
  const store = new Map<string, string>();

  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async (options?: { prefix?: string }) => ({
      keys: [...store.keys()]
        .filter((name) => !options?.prefix || name.startsWith(options.prefix))
        .map((name) => ({ name })),
    })),
  } as unknown as KVNamespace;
}

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    INITIAL_ACCESS_TOKENS: createMemoryKV(),
    ENABLE_SCIM_AUTH_RATE_LIMIT: 'false',
    DEFAULT_TENANT_ID: 'default',
    ...overrides,
  } as Env;
}

function createProtectedApp(tenantId?: string) {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    if (tenantId) {
      c.set('tenantId', tenantId);
    }
    return scimAuthMiddleware(c, next);
  });
  app.get('/Users', (c) => c.json({ ok: true }));
  return app;
}

describe('SCIM tenant-bound authentication', () => {
  it('does not count successful requests as failed authentication attempts', async () => {
    const limiter = {
      getStatusRpc: vi.fn(async () => null),
      incrementRpc: vi.fn(),
      resetRpc: vi.fn(async () => true),
    };
    const env = createEnv({
      ENABLE_SCIM_AUTH_RATE_LIMIT: 'true',
      RATE_LIMITER: {
        idFromName: vi.fn(() => ({ toString: () => 'rate-id' })),
        get: vi.fn(() => limiter),
      } as unknown as Env['RATE_LIMITER'],
    });
    const { token } = await generateScimToken(env, { tenantId: 'default' });
    const app = createProtectedApp('default');

    for (let request = 0; request < 7; request += 1) {
      const response = await app.request(
        '/Users',
        { headers: { Authorization: `Bearer ${token}` } },
        env
      );
      expect(response.status).toBe(200);
    }

    expect(limiter.incrementRpc).not.toHaveBeenCalled();
    expect(limiter.resetRpc).toHaveBeenCalledTimes(14);
  });

  it('uses the configured lockout duration after the failed-attempt threshold', async () => {
    const records = new Map<string, { count: number; resetAt: number; firstRequestAt: number }>();
    const limiter = {
      getStatusRpc: vi.fn(async (key: string) => records.get(key) ?? null),
      incrementRpc: vi.fn(
        async (key: string, config: { windowSeconds: number; maxRequests: number }) => {
          const now = Math.floor(Date.now() / 1000);
          const existing = records.get(key);
          const record =
            existing && now < existing.resetAt
              ? { ...existing, count: existing.count + 1 }
              : { count: 1, resetAt: now + config.windowSeconds, firstRequestAt: now };
          records.set(key, record);
          return {
            allowed: record.count <= config.maxRequests,
            current: record.count,
            limit: config.maxRequests,
            resetAt: record.resetAt,
            retryAfter: Math.max(0, record.resetAt - now),
          };
        }
      ),
      resetRpc: vi.fn(async (key: string) => records.delete(key)),
    };
    const env = createEnv({
      ENABLE_SCIM_AUTH_RATE_LIMIT: 'true',
      SCIM_AUTH_MAX_FAILED_ATTEMPTS: '2',
      SCIM_AUTH_WINDOW_SECONDS: '30',
      SCIM_AUTH_LOCKOUT_SECONDS: '600',
      SCIM_AUTH_FAILURE_DELAY_MS: '1',
      RATE_LIMITER: {
        idFromName: vi.fn(() => ({ toString: () => 'rate-id' })),
        get: vi.fn(() => limiter),
      } as unknown as Env['RATE_LIMITER'],
    });
    const app = createProtectedApp('default');

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app.request(
        '/Users',
        { headers: { Authorization: 'Bearer invalid-token' } },
        env
      );
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({ detail: 'Authentication failed' });
    }

    const lockedResponse = await app.request(
      '/Users',
      { headers: { Authorization: 'Bearer invalid-token' } },
      env
    );

    expect(lockedResponse.status).toBe(401);
    expect(Number(lockedResponse.headers.get('Retry-After'))).toBeGreaterThanOrEqual(599);
    await expect(lockedResponse.json()).resolves.toMatchObject({
      detail: expect.stringContaining('Too many failed authentication attempts'),
    });
    expect(limiter.incrementRpc).toHaveBeenCalledWith('unknown:lockout', {
      windowSeconds: 600,
      maxRequests: 0,
    });
  });

  it('accepts a token only for its bound tenant', async () => {
    const env = createEnv({ BASE_DOMAIN: 'example.com' });
    const { token } = await generateScimToken(env, { tenantId: 'tenant-a' });
    const app = createProtectedApp('tenant-a');

    const res = await app.request('/Users', { headers: { Authorization: `Bearer ${token}` } }, env);

    expect(res.status).toBe(200);
  });

  it('rejects a valid token when the request tenant is different', async () => {
    const env = createEnv({ BASE_DOMAIN: 'example.com' });
    const { token } = await generateScimToken(env, { tenantId: 'tenant-a' });
    const app = createProtectedApp('tenant-b');

    const res = await app.request('/Users', { headers: { Authorization: `Bearer ${token}` } }, env);

    expect(res.status).toBe(401);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toBe('Authentication failed');
  });

  it('rejects multi-tenant requests without tenant context', async () => {
    const env = createEnv({ BASE_DOMAIN: 'example.com' });
    const { token } = await generateScimToken(env, { tenantId: 'tenant-a' });
    const app = createProtectedApp();

    const res = await app.request('/Users', { headers: { Authorization: `Bearer ${token}` } }, env);

    expect(res.status).toBe(403);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toBe('Tenant context is required');
  });

  it('lists and revokes tokens only within the selected tenant', async () => {
    const env = createEnv({ BASE_DOMAIN: 'example.com' });
    const tenantAToken = await generateScimToken(env, { tenantId: 'tenant-a' });
    await generateScimToken(env, { tenantId: 'tenant-b' });

    const tenantATokens = await listScimTokens(env, { tenantId: 'tenant-a' });
    expect(tenantATokens).toHaveLength(1);
    expect(tenantATokens[0].tokenHash).toBe(tenantAToken.tokenHash);

    await revokeScimToken(env, tenantAToken.tokenHash, { tenantId: 'tenant-a' });

    expect(await listScimTokens(env, { tenantId: 'tenant-a' })).toHaveLength(0);
    expect(await listScimTokens(env, { tenantId: 'tenant-b' })).toHaveLength(1);
  });
});
