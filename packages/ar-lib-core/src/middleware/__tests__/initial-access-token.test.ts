import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types/env';
import { hashInitialAccessToken, initialAccessTokenMiddleware } from '../initial-access-token';

function createEnv(options: {
  tokenData: Record<string, unknown> | null;
  incrementRpc: ReturnType<typeof vi.fn>;
}): Env {
  const kv = {
    get: vi.fn(async () => options.tokenData),
    delete: vi.fn(async () => undefined),
  } as unknown as KVNamespace;

  return {
    DCR_REQUIRE_INITIAL_ACCESS_TOKEN: 'true',
    INITIAL_ACCESS_TOKENS: kv,
    RATE_LIMITER: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ incrementRpc: options.incrementRpc })),
    },
  } as unknown as Env;
}

function createApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', initialAccessTokenMiddleware());
  app.post('/register', (c) => c.json({ registered: true }, 201));
  return app;
}

describe('initialAccessTokenMiddleware', () => {
  it('allows only one concurrent use of a single-use token', async () => {
    let claims = 0;
    const incrementRpc = vi.fn(async () => {
      claims += 1;
      return {
        allowed: claims === 1,
        current: claims,
        limit: 1,
        resetAt: Math.floor(Date.now() / 1000) + 3600,
        retryAfter: claims === 1 ? 0 : 3600,
      };
    });
    const env = createEnv({
      tokenData: {
        single_use: true,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
      incrementRpc,
    });
    const app = createApp();
    const token = 'single-use-secret';
    const request = () =>
      app.request(
        '/register',
        { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
        env
      );

    const responses = await Promise.all([request(), request()]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 401]);
    expect(incrementRpc).toHaveBeenCalledTimes(2);
    expect(incrementRpc).toHaveBeenCalledWith('consume', {
      windowSeconds: expect.any(Number),
      maxRequests: 1,
    });
    expect(env.RATE_LIMITER.idFromName).toHaveBeenCalledWith(
      `tenant:default:iat-consume:${await hashInitialAccessToken(token)}`
    );
    expect(env.INITIAL_ACCESS_TOKENS?.delete).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the atomic consumption gate is unavailable', async () => {
    const incrementRpc = vi.fn(async () => {
      throw new Error('Durable Object unavailable');
    });
    const env = createEnv({ tokenData: { single_use: true }, incrementRpc });
    const app = createApp();

    const response = await app.request(
      '/register',
      { method: 'POST', headers: { Authorization: 'Bearer single-use-secret' } },
      env
    );

    expect(response.status).toBe(500);
    expect(env.INITIAL_ACCESS_TOKENS?.delete).not.toHaveBeenCalled();
  });
});

describe('initialAccessTokenMiddleware and the dynamic client registration capability', () => {
  const capabilityEnv = (value: boolean | 'down'): Env => {
    const settings = {
      get: vi.fn(async (key: string) => {
        if (value === 'down') throw new Error('kv down');
        return key === 'settings:platform:tenant-capabilities'
          ? JSON.stringify({ 'tenant_capabilities.dynamic_client_registration': value })
          : null;
      }),
      put: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      getWithMetadata: vi.fn(),
    } as unknown as KVNamespace;
    return { DCR_REQUIRE_INITIAL_ACCESS_TOKEN: 'false', SETTINGS: settings } as unknown as Env;
  };

  it('refuses with access_denied while off, before anything else', async () => {
    const response = await createApp().request(
      '/register',
      { method: 'POST' },
      capabilityEnv(false)
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'access_denied',
      error_description: 'Dynamic Client Registration is disabled for this tenant',
    });
  });

  it('passes while on, and when the switch cannot be read (the earlier behaviour)', async () => {
    for (const value of [true, 'down'] as const) {
      const response = await createApp().request(
        '/register',
        { method: 'POST' },
        capabilityEnv(value)
      );
      expect(response.status).toBe(201);
    }
  });
});
