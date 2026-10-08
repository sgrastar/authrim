import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { createLogger, type Env } from '@authrim/ar-lib-core';
import router from '../../packages/ar-router/src/index';
import { dataExportRequestHandler } from '../../packages/ar-management/src/data-export';
import { userConsentRevokeHandler } from '../../packages/ar-management/src/user-consents';

const accountDb = vi.hoisted(() => {
  const db = {
    query: async () => [],
    queryOne: async () => null,
    execute: async () => ({ success: true, rowsAffected: 0 }),
    transaction: async (callback: (value: unknown) => unknown) => callback(db),
    batch: async () => [],
    isHealthy: async () => ({ healthy: true, latencyMs: 0, type: 'mock' }),
    getType: () => 'mock',
    close: async () => undefined,
  };
  return db;
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    // Account database routing is covered by its own tests; this suite is about who is calling.
    resolveAccountDataContextFromHono: vi.fn(
      async (c: Context<{ Bindings: Env }>, userId: string) => {
        const context = { tenantId: 'default', userId, coreDb: accountDb, piiDb: accountDb };
        c.set('accountDataContext' as never, context as never);
        return context;
      }
    ),
  };
});

/**
 * Browser -> ar-router -> OP_MANAGEMENT for the user self-service API, authenticated by the
 * login session cookie (`authrim_session`) with no Bearer token. OP_MANAGEMENT runs the real
 * handlers; the management Worker's tenant-registry middleware is outside this suite.
 */
const ISSUER = 'https://op.example.com';
const SESSION_ID = 'g1:apac:0:session_0123456789abcdefghijkl';

const executionContext = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
} as unknown as ExecutionContext;

const managementApp = new Hono<{ Bindings: Env }>();
managementApp.use('*', async (c: Context<{ Bindings: Env }>, next: Next) => {
  c.set('tenantId' as never, 'default' as never);
  c.set(
    'logger' as never,
    createLogger({ requestId: 'router-user-self-service', tenantId: 'default' }) as never
  );
  await next();
});
managementApp.post('/api/user/data-export', dataExportRequestHandler);
managementApp.delete('/api/user/consents/:clientId', userConsentRevokeHandler);

function createEnv() {
  const sessions = new Map<string, Record<string, unknown>>([
    [
      SESSION_ID,
      {
        id: SESSION_ID,
        userId: 'user-1',
        tenantId: 'default',
        createdAt: Date.now() - 60_000,
        expiresAt: Date.now() + 3_600_000,
      },
    ],
  ]);
  const stub = { getSessionRpc: vi.fn(async (id: string) => sessions.get(id) ?? null) };
  const env = {
    ISSUER_URL: ISSUER,
    SESSION_STORE: {
      idFromName: (name: string) => ({ name }),
      get: () => stub,
    },
    OP_MANAGEMENT: {
      fetch: (request: Request) =>
        Promise.resolve(managementApp.fetch(request, env, executionContext)),
    },
  } as unknown as Env;
  return { env, sessions, stub };
}

function exportRequest(cookie: string, origin = ISSUER) {
  return new Request(`${ISSUER}/api/user/data-export`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}',
  });
}

describe('user self-service API through ar-router with a login session cookie', () => {
  it('accepts the authrim_session cookie (not 401) and looks up that session', async () => {
    const { env, stub } = createEnv();

    const response = await router.fetch(
      exportRequest(`authrim_session=${SESSION_ID}`),
      env,
      executionContext
    );

    // Past authentication and CSRF (what happens next depends on account storage, which this
    // suite does not provide).
    expect([401, 403]).not.toContain(response.status);
    expect(stub.getSessionRpc).toHaveBeenCalledWith(SESSION_ID);
  });

  it('answers 401 for the legacy sid cookie, an unknown session and a foreign-tenant session', async () => {
    const { env, sessions } = createEnv();

    const legacy = await router.fetch(exportRequest(`sid=${SESSION_ID}`), env, executionContext);
    expect(legacy.status).toBe(401);

    const unknown = await router.fetch(
      exportRequest('authrim_session=g1:apac:0:session_unknownunknownunknown'),
      env,
      executionContext
    );
    expect(unknown.status).toBe(401);

    sessions.set(SESSION_ID, { ...sessions.get(SESSION_ID), tenantId: 'other' });
    const foreign = await router.fetch(
      exportRequest(`authrim_session=${SESSION_ID}`),
      env,
      executionContext
    );
    expect(foreign.status).toBe(401);
  });

  it('keeps the router CSRF check in front of cookie-authenticated calls', async () => {
    const { env, stub } = createEnv();

    const response = await router.fetch(
      exportRequest(`authrim_session=${SESSION_ID}`, 'https://evil.example'),
      env,
      executionContext
    );

    expect(response.status).toBe(403);
    expect(stub.getSessionRpc).not.toHaveBeenCalled();
  });
});
