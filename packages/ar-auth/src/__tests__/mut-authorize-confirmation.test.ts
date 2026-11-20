import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core/types/env';
import {
  DEFAULT_CLIENT,
  authorizeQuery,
  createAuthorizeApp,
  createMockEnv,
  SESSION_ID,
  challengeMap,
  seedSession,
  sessionMap,
} from './helpers/mut-authorize-env';

const mockGetClient = vi.hoisted(() =>
  vi.fn<(env: unknown, clientId: string) => Promise<Record<string, unknown> | null>>()
);
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getClient: mockGetClient,
    getClientCached: vi.fn((_c: unknown, env: unknown, clientId: string) =>
      mockGetClient(env, clientId)
    ),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(
      async (env: { DB: unknown }, partition?: string) =>
        (
          actual as unknown as {
            ensureDatabaseAdapter: (db: unknown, partition?: string) => unknown;
          }
        ).ensureDatabaseAdapter(env.DB, partition)
    ),
  };
});

let app: Hono<{ Bindings: Env }>;
let env: Env;

function useClient(overrides: Record<string, unknown> = {}) {
  mockGetClient.mockResolvedValue({ ...DEFAULT_CLIENT, ...overrides });
}

beforeEach(() => {
  vi.clearAllMocks();
  useClient();
  app = createAuthorizeApp();
  env = createMockEnv();
});

const SESSION_COOKIE = `authrim_session=${encodeURIComponent(SESSION_ID)}`;

function seedChallenge(id: string, metadata: Record<string, unknown>, userId = 'test-user') {
  challengeMap(env).set(id, {
    id,
    tenantId: 'default',
    type: 'reauth',
    userId,
    challenge: id,
    metadata,
  });
}

async function confirm(param: string, id: string, cookie?: string, extra = '') {
  return app.request(
    `${authorizeQuery()}&${param}=${encodeURIComponent(id)}${extra}`,
    { method: 'GET', headers: cookie ? { Cookie: cookie } : {} },
    env
  );
}

async function expectJson(response: Response, status: number, body: Record<string, string>) {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual(body);
}

describe('authorize: login confirmation challenge (_confirmation_challenge)', () => {
  const P = '_confirmation_challenge';
  const binding = 'login-browser';
  const bindingCookie = `authrim_authorize_confirmation=${binding}`;

  it('refuses an unknown challenge', async () => {
    await expectJson(await confirm(P, 'missing'), 400, {
      error: 'invalid_request',
      error_description: 'Invalid or expired confirmation challenge',
    });
  });

  it('refuses a challenge with another purpose without consuming it', async () => {
    seedChallenge('c1', { purpose: 'authorize_consent_confirmation', browserBinding: binding });
    await expectJson(await confirm(P, 'c1', bindingCookie), 400, {
      error: 'invalid_request',
      error_description: 'Invalid or expired confirmation challenge',
    });
    expect(challengeMap(env).has('c1')).toBe(true);
  });

  it.each([undefined, ''])('requires a browser binding (%j)', async (browserBinding) => {
    seedChallenge('c2', { purpose: 'authorize_confirmation', browserBinding });
    await expectJson(await confirm(P, 'c2', bindingCookie), 401, {
      error: 'access_denied',
      error_description: 'Authorization confirmation requires browser binding',
    });
    expect(challengeMap(env).has('c2')).toBe(true);
  });

  it.each([
    ['no cookie', undefined],
    ['another binding', 'authrim_authorize_confirmation=other'],
    ['a malformed cookie', 'authrim_authorize_confirmation=%E0%A4%A'],
    ['a cookie with a longer name', 'xauthrim_authorize_confirmation=login-browser'],
  ])('requires the originating browser: %s', async (_label, cookie) => {
    seedChallenge('c3', { purpose: 'authorize_confirmation', browserBinding: binding });
    await expectJson(await confirm(P, 'c3', cookie), 401, {
      error: 'access_denied',
      error_description: 'Authorization confirmation requires the originating browser',
    });
    expect(challengeMap(env).has('c3')).toBe(true);
  });

  it.each([
    ['no session cookie', bindingCookie],
    ['another session', `${bindingCookie}; authrim_session=g1:apac:3:session_other`],
    ['a malformed session cookie', `${bindingCookie}; authrim_session=%E0%A4%A`],
  ])('requires the bound session: %s', async (_label, cookie) => {
    seedSession(env);
    seedChallenge('c4', {
      purpose: 'authorize_confirmation',
      browserBinding: binding,
      sessionId: SESSION_ID,
    });
    await expectJson(await confirm(P, 'c4', cookie), 401, {
      error: 'access_denied',
      error_description: 'Authorization confirmation requires the bound session',
    });
    expect(challengeMap(env).has('c4')).toBe(true);
  });

  it('requires the bound session id to be a sharded session id', async () => {
    seedChallenge('c5', {
      purpose: 'authorize_confirmation',
      browserBinding: binding,
      sessionId: 'plain-session',
    });
    const response = await confirm(P, 'c5', `${bindingCookie}; authrim_session=plain-session`);
    expect(response.status).toBe(401);
  });

  it.each([
    ['is missing', null],
    ['belongs to another user', { userId: 'someone-else' }],
    ['has expired', { expiresAt: Date.now() - 1 }],
  ])('refuses when the bound session %s', async (_label, change) => {
    seedSession(env);
    if (change === null) sessionMap(env).delete(SESSION_ID);
    else Object.assign(sessionMap(env).get(SESSION_ID)!, change);
    seedChallenge('c6', {
      purpose: 'authorize_confirmation',
      browserBinding: binding,
      sessionId: SESSION_ID,
    });
    await expectJson(await confirm(P, 'c6', `${bindingCookie}; ${SESSION_COOKIE}`), 401, {
      error: 'access_denied',
      error_description: 'Authorization confirmation requires the bound session',
    });
  });

  it('consumes the challenge and clears the binding cookie', async () => {
    seedSession(env);
    seedChallenge('c7', {
      purpose: 'authorize_confirmation',
      browserBinding: binding,
      sessionId: SESSION_ID,
      authTime: Math.floor(Date.now() / 1000) - 5,
    });
    const response = await confirm(P, 'c7', `${bindingCookie}; ${SESSION_COOKIE}`);
    expect(challengeMap(env).has('c7')).toBe(false);
    expect(response.headers.get('Set-Cookie') ?? '').toContain(
      'authrim_authorize_confirmation=; Path=/authorize; HttpOnly;'
    );
    expect(response.headers.get('Set-Cookie') ?? '').toContain('Max-Age=0');
  });

  it('refuses an invalid authorization continuation after consuming the challenge', async () => {
    seedChallenge('c8', {
      purpose: 'authorize_confirmation',
      browserBinding: binding,
      authorization_request: { source: 'frontchannel' },
    });
    await expectJson(await confirm(P, 'c8', bindingCookie), 400, {
      error: 'invalid_request',
      error_description: 'Invalid authorization continuation',
    });
    expect(challengeMap(env).has('c8')).toBe(false);
  });

  it('restores the request from the continuation, not from the query', async () => {
    seedChallenge('c9', {
      purpose: 'authorize_confirmation',
      browserBinding: binding,
      authorization_request: {
        source: 'frontchannel',
        authorization_server: 'default',
        integrity_protected: false,
        response_type: 'code',
        client_id: 'test-client',
        redirect_uri: 'https://example.com/callback',
        scope: 'openid unknown-scope',
        state: 'restored-state',
      },
    });
    const response = await confirm(P, 'c9', bindingCookie);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('Location')!);
    expect(location.searchParams.get('error')).toBe('invalid_scope');
    expect(location.searchParams.get('state')).toBe('restored-state');
  });
});

describe('authorize: consent confirmation challenge (_consent_confirmation_challenge)', () => {
  const P = '_consent_confirmation_challenge';
  const binding = 'consent-browser';
  const cookies = `authrim_consent_confirmation=${binding}; ${SESSION_COOKIE}`;

  function seedConsent(id: string, metadata: Record<string, unknown> = {}) {
    seedChallenge(id, {
      purpose: 'authorize_consent_confirmation',
      sessionId: SESSION_ID,
      browserBinding: binding,
      ...metadata,
    });
  }

  it('refuses an unknown or mis-purposed challenge', async () => {
    seedChallenge('k0', { purpose: 'authorize_confirmation' });
    for (const id of ['missing', 'k0']) {
      await expectJson(await confirm(P, id, cookies), 400, {
        error: 'invalid_request',
        error_description: 'Invalid or expired consent confirmation challenge',
      });
    }
  });

  it.each([
    ['no session', { sessionId: undefined }],
    ['an empty session', { sessionId: '' }],
    ['no browser binding', { browserBinding: undefined }],
    ['an empty browser binding', { browserBinding: '' }],
  ])('requires session and browser binding: %s', async (_label, metadata) => {
    seedConsent('k1', metadata);
    await expectJson(await confirm(P, 'k1', cookies), 401, {
      error: 'access_denied',
      error_description: 'Consent confirmation requires session and browser binding',
    });
  });

  it.each([
    ['no cookie', SESSION_COOKIE],
    ['another binding', `authrim_consent_confirmation=x; ${SESSION_COOKIE}`],
    ['a malformed binding', `authrim_consent_confirmation=%E0%A4%A; ${SESSION_COOKIE}`],
  ])('requires the originating browser: %s', async (_label, cookie) => {
    seedSession(env);
    seedConsent('k2');
    await expectJson(await confirm(P, 'k2', cookie), 401, {
      error: 'access_denied',
      error_description: 'Consent confirmation requires the originating browser',
    });
  });

  it.each([
    ['no session cookie', `authrim_consent_confirmation=${binding}`],
    [
      'a malformed session cookie',
      `authrim_consent_confirmation=${binding}; authrim_session=%E0%A4%A`,
    ],
    [
      'another session',
      `authrim_consent_confirmation=${binding}; authrim_session=g1:apac:3:session_x`,
    ],
  ])('requires the bound session: %s', async (_label, cookie) => {
    seedSession(env);
    seedConsent('k3');
    await expectJson(await confirm(P, 'k3', cookie), 401, {
      error: 'access_denied',
      error_description: 'Consent confirmation requires the bound session',
    });
  });

  it.each([
    ['is missing', null],
    ['belongs to another user', { userId: 'someone-else' }],
    ['has expired', { expiresAt: Date.now() - 1 }],
  ])('refuses when the bound session %s', async (_label, change) => {
    seedSession(env);
    if (change === null) sessionMap(env).delete(SESSION_ID);
    else Object.assign(sessionMap(env).get(SESSION_ID)!, change);
    seedConsent('k4');
    await expectJson(await confirm(P, 'k4', cookies), 401, {
      error: 'access_denied',
      error_description: 'Consent confirmation requires the bound session',
    });
    expect(challengeMap(env).has('k4')).toBe(true);
  });

  it('consumes the challenge and clears its cookie', async () => {
    seedSession(env);
    seedConsent('k5', { consent_generation: 0 });
    const response = await confirm(P, 'k5', cookies);
    expect(challengeMap(env).has('k5')).toBe(false);
    expect(response.headers.get('Set-Cookie') ?? '').toContain(
      'authrim_consent_confirmation=; Path=/authorize; HttpOnly;'
    );
  });

  it('refuses an invalid continuation', async () => {
    seedSession(env);
    seedConsent('k6', { authorization_request: 'not-an-object' });
    await expectJson(await confirm(P, 'k6', cookies), 400, {
      error: 'invalid_request',
      error_description: 'Invalid authorization continuation',
    });
  });
});

describe('authorize: POST body', () => {
  it('reads the parameters from a form body', async () => {
    const body = new URLSearchParams({
      response_type: 'code',
      client_id: 'test-client',
      redirect_uri: 'https://example.com/callback',
      scope: 'openid nope',
      state: 'posted-state',
    });
    const response = await app.request(
      '/authorize',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      },
      env
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('Location')!);
    expect(location.searchParams.get('error')).toBe('invalid_scope');
    expect(location.searchParams.get('state')).toBe('posted-state');
  });

  it('refuses request and request_uri together in a form body', async () => {
    const response = await app.request(
      '/authorize',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'request=a.b.c&request_uri=urn%3Ax',
      },
      env
    );
    await expectJson(response, 400, {
      error: 'invalid_request',
      error_description: 'request and request_uri must not be used together',
    });
  });

  it('refuses max_age in a form body like in a query', async () => {
    const response = await app.request(
      '/authorize',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'response_type=code&client_id=test-client&max_age=x',
      },
      env
    );
    expect(response.status).toBe(400);
    expect((await response.json<{ error_description: string }>()).error_description).toBe(
      'max_age must be a non-negative integer'
    );
  });
});
