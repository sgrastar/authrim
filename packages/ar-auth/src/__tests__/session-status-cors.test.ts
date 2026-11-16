import { describe, expect, it, vi } from 'vitest';
import type { Context, Next } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantSettingsDocument: vi.fn(async () => null),
    getSessionStoreBySessionId: vi.fn(() => ({
      stub: {
        getSessionRpc: async () => ({
          userId: 'user_1',
          createdAt: Date.now() - 1000,
          expiresAt: Date.now() + 60_000,
        }),
      },
    })),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: {} })),
    loadTenantLoginFlowCompletion: vi.fn(async () => ({ behavior: 'home' })),
    requestContextMiddleware: vi.fn(() => async (context: Context, next: Next) => {
      context.set('tenantId', 'default');
      await next();
    }),
  };
});

import app from '../index';

const env = {
  ALLOWED_ORIGINS: 'https://allowed.example',
  ISSUER_URL: 'https://issuer.example',
} as Env;

describe('session status CORS with post-login destination requested', () => {
  const path = '/api/sessions/status?include=basic,post_login';
  const fetchStatus = (init: RequestInit) =>
    app.fetch(new Request(`https://issuer.example${path}`, init), env, {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext);

  it('allows a configured browser origin for GET with credentials', async () => {
    const response = await fetchStatus({
      headers: {
        Origin: 'https://allowed.example',
        Cookie: 'authrim_session=g1:apac:1:session_active',
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ active: true, post_login_redirect: '/' });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://allowed.example');
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('does not allow an unconfigured browser origin', async () => {
    const response = await fetchStatus({
      headers: {
        Origin: 'https://untrusted.example',
        Cookie: 'authrim_session=g1:apac:1:session_active',
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ active: true, post_login_redirect: '/' });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('answers preflight through the same route policy', async () => {
    const response = await fetchStatus({
      method: 'OPTIONS',
      headers: {
        Origin: 'https://allowed.example',
        'Access-Control-Request-Method': 'GET',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://allowed.example');
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });
});
