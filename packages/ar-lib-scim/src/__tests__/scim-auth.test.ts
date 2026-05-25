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
