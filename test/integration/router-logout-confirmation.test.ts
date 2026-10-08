import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createLogger, type Env } from '@authrim/ar-lib-core';
import router from '../../packages/ar-router/src/index';
import { frontChannelLogoutHandler } from '../../packages/ar-auth/src/logout';

/**
 * Production composition: browser -> ar-router -> OP_AUTH (ar-auth).
 *
 * The RP-Initiated Logout confirmation page is rendered by ar-auth at GET /logout and posts back
 * to the relative action "/logout". In production that POST also passes through ar-router, so the
 * router must forward it (with the confirmation cookie and CSRF token intact) to ar-auth.
 *
 * OP_AUTH is the real ar-auth logout handler on the same routes ar-auth registers. ar-auth's
 * tenant-runtime-registry middleware is outside this test's scope (it needs registry bindings).
 */
const authApp = new Hono<{ Bindings: Env }>();
const coreDb = {
  query: async () => [],
  queryOne: async () => null,
  execute: async () => ({ success: true, rowsAffected: 0 }),
  transaction: async (callback: (value: unknown) => unknown) => callback(coreDb),
  batch: async () => [],
  isHealthy: async () => ({ healthy: true, latencyMs: 0, type: 'mock' }),
  getType: () => 'mock',
  close: async () => undefined,
};
authApp.use('*', async (c, next) => {
  c.set('tenantMetadataContext' as never, { tenantId: 'default', coreDb } as never);
  c.set('tenantId' as never, 'default' as never);
  c.set(
    'logger' as never,
    createLogger({ requestId: 'router-logout', tenantId: 'default' }) as never
  );
  await next();
});
authApp.get('/logout', frontChannelLogoutHandler);
authApp.post('/logout', frontChannelLogoutHandler);

const ISSUER = 'https://op.example.com';

const executionContext = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
} as unknown as ExecutionContext;

// A sharded session id (generation:region:shard:session_...) as ar-auth issues them.
const SESSION_ID = 'g1:apac:0:session_0123456789abcdefghijkl';

function createSessionStore() {
  const sessions = new Map<string, Record<string, unknown>>();
  const invalidateSessionRpc = vi.fn(async (sessionId: string) => sessions.delete(sessionId));
  const stub = {
    getSessionRpc: vi.fn(async (sessionId: string) => sessions.get(sessionId) ?? null),
    invalidateSessionRpc,
  };
  return {
    idFromName: vi.fn((name: string) => ({ toString: () => name, name })),
    get: vi.fn(() => stub),
    _sessions: sessions,
    _invalidateSessionRpc: invalidateSessionRpc,
  };
}

function createEnv() {
  const sessionStore = createSessionStore();
  sessionStore._sessions.set(SESSION_ID, {
    id: SESSION_ID,
    userId: 'user-1',
    createdAt: Date.now() - 60_000,
    expiresAt: Date.now() + 3_600_000,
    data: { authTime: Math.floor(Date.now() / 1000) - 60 },
  });
  const authFetcher = {
    fetch: (request: Request) => Promise.resolve(authApp.fetch(request, env, executionContext)),
  };
  const env = {
    ISSUER_URL: ISSUER,
    OP_AUTH: authFetcher,
    SESSION_STORE: sessionStore,
  } as unknown as Env & { SESSION_STORE: ReturnType<typeof createSessionStore> };
  return env;
}

function cookieHeaderFrom(response: Response): string {
  const setCookie = response.headers.get('Set-Cookie') ?? '';
  return setCookie.split(';')[0];
}

describe('logout confirmation through ar-router', () => {
  it('completes GET /logout -> confirmation form -> POST /logout -> redirect', async () => {
    const env = createEnv();

    const confirmation = await router.fetch(
      new Request(`${ISSUER}/logout`, {
        headers: { Cookie: `authrim_session=${SESSION_ID}` },
      }),
      env,
      executionContext
    );
    expect(confirmation.status).toBe(200);
    // Showing the confirmation page must not end the session.
    expect(env.SESSION_STORE._sessions.has(SESSION_ID)).toBe(true);
    expect(env.SESSION_STORE._invalidateSessionRpc).not.toHaveBeenCalled();
    const html = await confirmation.text();
    expect(html).toContain('<form method="post" action="/logout">');
    const token = /name="confirmation_token" value="([^"]+)"/.exec(html)?.[1];
    expect(token).toBeTruthy();
    const confirmationCookie = cookieHeaderFrom(confirmation);
    expect(confirmationCookie).toContain(`authrim_logout_confirmation=${token}`);

    // What the browser does when the user presses "Log out".
    const submitted = await router.fetch(
      new Request(`${ISSUER}/logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: ISSUER,
          Cookie: `authrim_session=${SESSION_ID}; ${confirmationCookie}`,
        },
        body: new URLSearchParams({ confirmation_token: token! }),
      }),
      env,
      executionContext
    );

    expect(submitted.status).toBe(302);
    expect(submitted.headers.get('Location')).toBe(`${ISSUER}/logged-out`);
    // The confirmed POST really ended the browser session.
    expect(env.SESSION_STORE._invalidateSessionRpc).toHaveBeenCalledWith(SESSION_ID);
    expect(env.SESSION_STORE._sessions.has(SESSION_ID)).toBe(false);
  });

  it('rejects the confirmation POST when the double-submit cookie does not match', async () => {
    const env = createEnv();
    const response = await router.fetch(
      new Request(`${ISSUER}/logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: ISSUER,
          Cookie: `authrim_session=${SESSION_ID}; authrim_logout_confirmation=other-token`,
        },
        body: new URLSearchParams({ confirmation_token: 'forged-token' }),
      }),
      env,
      executionContext
    );

    expect(response.status).toBe(400);
    expect(env.SESSION_STORE._sessions.has(SESSION_ID)).toBe(true);
  });

  it('keeps the router CSRF check in front of POST /logout for foreign origins', async () => {
    const env = createEnv();
    const response = await router.fetch(
      new Request(`${ISSUER}/logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'https://evil.example',
          Cookie: `authrim_session=${SESSION_ID}; authrim_logout_confirmation=token-1`,
        },
        body: new URLSearchParams({ confirmation_token: 'token-1' }),
      }),
      env,
      executionContext
    );

    expect(response.status).toBe(403);
    expect(env.SESSION_STORE._sessions.has(SESSION_ID)).toBe(true);
  });
});
