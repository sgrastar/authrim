import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

vi.mock('jose', () => ({ jwtVerify: vi.fn(), importJWK: vi.fn() }));
vi.mock('hono/cookie', () => ({ getCookie: vi.fn(), setCookie: vi.fn() }));

const store = vi.hoisted(() => ({
  getSessionRpc: vi.fn<(id: string) => Promise<unknown>>(),
  invalidateSessionRpc: vi.fn<(id: string) => Promise<boolean>>(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuditLog: vi.fn().mockResolvedValue(undefined),
    publishEvent: vi.fn().mockResolvedValue(undefined),
    revokeGuestResumeForSession: vi.fn().mockResolvedValue(undefined),
    verifyClientSecretHash: vi.fn(
      async (secret: string, hash: string) => hash === `hash_${secret}`
    ),
    validateIdTokenHint: vi.fn(),
    isNativeSSOEnabled: vi.fn().mockResolvedValue(false),
    validatePostLogoutRedirectUri: vi.fn(),
    validateLogoutParameters: vi.fn(),
    revokeDeviceSecretsForLogoutScope: vi.fn(),
    resolveLogoutTargetsFromSessionClientStore: vi.fn().mockResolvedValue(null),
    resolveLogoutIssuerWithRetry: vi.fn(async () => 'https://canonical.example.com'),
    reportLogoutNotSent: vi.fn().mockResolvedValue({ sessions: 0, clients: 0 }),
    reportIncompleteLogouts: vi.fn().mockResolvedValue(undefined),
    reportLogoutTargetsUnavailable: vi.fn().mockResolvedValue(undefined),
    resolveLogoutConfig: vi.fn(actual.resolveLogoutConfig),
    sendBackchannelLogoutFanout: vi.fn().mockResolvedValue(null),
    sendLogoutWebhookFanout: vi.fn().mockResolvedValue(null),
    purgeEndedSessionsFromSessionClientStore: vi.fn().mockResolvedValue(undefined),
    isShardedSessionId: vi.fn((sessionId: string) => /^\d+_session_/.test(sessionId)),
    getSessionStoreBySessionId: vi.fn(() => ({ stub: store })),
    recordHybridUserSessionRevocationEpoch: vi.fn().mockResolvedValue(1),
  };
});

import { backChannelLogoutHandler } from '../logout';
import { getCookie } from 'hono/cookie';
import { importJWK, jwtVerify } from 'jose';
import {
  validateLogoutParameters,
  validatePostLogoutRedirectUri,
  validateIdTokenHint,
  isNativeSSOEnabled,
  recordHybridUserSessionRevocationEpoch,
  publishEvent,
  createAuditLog,
  getSessionStoreBySessionId,
  revokeDeviceSecretsForLogoutScope,
  USER_EVENTS,
  SESSION_EVENTS,
} from '@authrim/ar-lib-core';

const BACKCHANNEL_EVENT = { 'http://schemas.openid.net/event/backchannel-logout': {} };

function createContext(options: {
  method?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  clientRow?: Record<string, unknown> | null;
  keys?: unknown[];
}) {
  const first = vi.fn(async () => options.clientRow ?? null);
  const DB = {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first,
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 0 } }),
      }),
    }),
  } as unknown as D1Database;
  const keyManager = {
    getAllPublicKeysRpc: vi
      .fn()
      .mockResolvedValue(options.keys ?? [{ kty: 'RSA', kid: 'key-1', n: 'n', e: 'AQAB' }]),
  };
  const env = {
    ISSUER_URL: 'https://op.example.com',
    DB,
    KEY_MANAGER: {
      idFromName: vi.fn().mockReturnValue('km'),
      get: vi.fn().mockReturnValue(keyManager),
    },
  } as unknown as Env;
  const contextStore = new Map<string, unknown>([
    ['tenantId', 'default'],
    ['tenantMetadataContext', { tenantId: 'default', coreDb: DB }],
  ]);
  const waitUntil = vi.fn();
  const c = {
    req: {
      query: (name: string) => options.query?.[name],
      header: (name: string) => options.headers?.[name],
      method: options.method ?? 'POST',
      parseBody: vi.fn(async (): Promise<Record<string, unknown>> => options.body ?? {}),
    },
    env,
    executionCtx: { waitUntil },
    json: vi.fn(
      (body: unknown, status?: number) =>
        new Response(JSON.stringify(body), { status: status ?? 200 })
    ),
    redirect: vi.fn(
      (url: string, status?: number) =>
        new Response(null, { status: status ?? 302, headers: { Location: url } })
    ),
    body: vi.fn(
      (body: BodyInit | null, status?: number, headers?: Record<string, string>) =>
        new Response(body, { status: status ?? 200, headers })
    ),
    get: vi.fn((key: string) => contextStore.get(key)),
    set: vi.fn((key: string, value: unknown) => contextStore.set(key, value)),
  };
  return { c, keyManager, waitUntil };
}

function cookies(values: Record<string, string | undefined>) {
  vi.mocked(getCookie).mockImplementation(((_c: unknown, name: string) => values[name]) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  store.getSessionRpc.mockReset().mockResolvedValue(null);
  store.invalidateSessionRpc.mockReset().mockResolvedValue(true);
  vi.mocked(importJWK).mockResolvedValue({} as never);
  vi.mocked(validateLogoutParameters).mockReturnValue({ valid: true });
  vi.mocked(validatePostLogoutRedirectUri).mockReturnValue({ valid: true });
  vi.mocked(validateIdTokenHint).mockResolvedValue({ valid: false, error: 'invalid' });
  vi.mocked(isNativeSSOEnabled).mockResolvedValue(false);
  cookies({});
});

afterEach(() => {
  vi.mocked(getCookie).mockReset();
});

const AUTH = { Authorization: `Basic ${btoa('client-123:client-secret')}` };
const CLIENT_ROW = { client_id: 'client-123', client_secret_hash: 'hash_client-secret' };

function header(json: Record<string, unknown>): string {
  return btoa(JSON.stringify(json)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function backchannel(
  options: {
    headers?: Record<string, string>;
    token?: string;
    keys?: unknown[];
    payload?: Record<string, unknown>;
  } = {}
) {
  const ctx = createContext({
    body: { logout_token: options.token ?? `${header({ alg: 'RS256' })}.p.s` },
    headers: options.headers ?? AUTH,
    clientRow: CLIENT_ROW,
    keys: options.keys,
  });
  vi.mocked(jwtVerify).mockResolvedValue({
    payload: options.payload ?? { sub: 'user-1', sid: '0_session_1', events: BACKCHANNEL_EVENT },
    protectedHeader: { alg: 'RS256' },
  });
  const response = await backChannelLogoutHandler(ctx.c as never);
  return { ...ctx, response };
}

async function errorOf(response: Response) {
  return { status: response.status, body: await response.json() };
}

describe('back-channel logout client authentication', () => {
  it('describes a Basic header without a colon separator', async () => {
    const { response } = await backchannel({
      headers: { Authorization: `Basic ${btoa('client')}` },
    });
    expect(await errorOf(response)).toEqual({
      status: 401,
      body: {
        error: 'invalid_client',
        error_description: 'Invalid Authorization header format: missing colon separator',
      },
    });
  });

  it('describes a Basic header that is not base64', async () => {
    const { response } = await backchannel({ headers: { Authorization: 'Basic %%%' } });
    expect(await errorOf(response)).toEqual({
      status: 401,
      body: { error: 'invalid_client', error_description: 'Invalid Authorization header format' },
    });
    expect(jwtVerify).not.toHaveBeenCalled();
  });
});

describe('back-channel logout token verification', () => {
  it('refuses the token when the key manager has no keys', async () => {
    const { response } = await backchannel({ keys: [] });
    expect(await errorOf(response)).toEqual({
      status: 400,
      body: { error: 'invalid_request', error_description: 'Invalid logout_token' },
    });
    expect(importJWK).not.toHaveBeenCalled();
  });

  it('uses the key the token header names', async () => {
    const keys = [
      { kty: 'RSA', kid: 'key-1', n: 'n1', e: 'AQAB' },
      { kty: 'RSA', kid: 'key-2', n: 'n2', e: 'AQAB' },
    ];
    const { response } = await backchannel({ keys, token: `${header({ kid: 'key-2' })}.p.s` });
    expect(response.status).toBe(200);
    expect(importJWK).toHaveBeenCalledWith(keys[1]);
    expect(jwtVerify).toHaveBeenCalledWith(
      expect.any(String),
      {},
      {
        issuer: 'https://op.example.com',
        algorithms: ['RS256'],
      }
    );
  });

  it('falls back to the first key for a header without kid or an unparseable header', async () => {
    const keys = [
      { kty: 'RSA', kid: 'key-1', n: 'n1', e: 'AQAB' },
      { kty: 'RSA', kid: 'key-2', n: 'n2', e: 'AQAB' },
    ];
    for (const token of [`${header({ alg: 'RS256' })}.p.s`, 'not-json.p.s']) {
      vi.mocked(importJWK).mockClear();
      await backchannel({ keys, token });
      expect(importJWK).toHaveBeenCalledWith(keys[0]);
    }
  });
});

describe('back-channel logout session handling', () => {
  it('refuses a token without sid whose sub is not shown to be the user id', async () => {
    const { response } = await backchannel({
      payload: { sub: 'user-1', events: BACKCHANNEL_EVENT },
    });
    expect(await errorOf(response)).toEqual({
      status: 400,
      body: { error: 'invalid_request', error_description: 'logout_token must contain sid claim' },
    });
    expect(recordHybridUserSessionRevocationEpoch).not.toHaveBeenCalled();
  });

  it("ends every session of a sub shown to be the user's id by advancing the revocation epoch", async () => {
    const { response } = await backchannel({
      payload: { sub: 'user-1', token_use: 'logout', jti: 'j-1', events: BACKCHANNEL_EVENT },
    });
    expect(response.status).toBe(200);
    expect(recordHybridUserSessionRevocationEpoch).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'default',
      'user-1'
    );
    expect(store.invalidateSessionRpc).not.toHaveBeenCalled();
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('only warns for a legacy (non-sharded) sid', async () => {
    const { response } = await backchannel({
      payload: { sub: 'user-1', sid: 'legacy', events: BACKCHANNEL_EVENT },
    });
    expect(response.status).toBe(200);
    expect(recordHybridUserSessionRevocationEpoch).not.toHaveBeenCalled();
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('answers 503 and keeps the session when the session cannot be read', async () => {
    store.getSessionRpc.mockRejectedValueOnce(new Error('do down'));
    const { response } = await backchannel();
    expect(await errorOf(response)).toEqual({
      status: 503,
      body: {
        error: 'temporarily_unavailable',
        error_description: 'Guest sign-out could not be completed',
      },
    });
    expect(store.invalidateSessionRpc).not.toHaveBeenCalled();
  });

  it('answers 503 when the session cannot be invalidated', async () => {
    store.invalidateSessionRpc.mockRejectedValueOnce(new Error('do down'));
    const { response } = await backchannel();
    expect(await errorOf(response)).toEqual({
      status: 503,
      body: {
        error: 'temporarily_unavailable',
        error_description: 'Sign-out could not be completed',
      },
    });
  });

  it('still answers 200 when routing to the session store fails otherwise', async () => {
    vi.mocked(getSessionStoreBySessionId).mockImplementationOnce(() => {
      throw new Error('bad shard');
    });
    const { response } = await backchannel();
    expect(response.status).toBe(200);
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('publishes nothing when the session was not found to delete', async () => {
    store.invalidateSessionRpc.mockResolvedValueOnce(false);
    const { response } = await backchannel();
    expect(response.status).toBe(200);
    expect(publishEvent).not.toHaveBeenCalled();
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it('publishes the logout with the session user and records the audit entry', async () => {
    store.getSessionRpc.mockResolvedValueOnce({ id: '0_session_1', userId: 'user-9', data: {} });
    const { response, waitUntil } = await backchannel({
      headers: { ...AUTH, 'X-Forwarded-For': ' 203.0.113.5 , 10.0.0.1', 'User-Agent': 'rp-agent' },
    });
    expect(response.status).toBe(200);
    const events = vi.mocked(publishEvent).mock.calls.map(([, event]) => event);
    expect(events).toEqual([
      expect.objectContaining({
        type: USER_EVENTS.LOGOUT,
        data: { sessionId: '0_session_1', userId: 'user-9', reason: 'logout' },
      }),
      expect.objectContaining({
        type: SESSION_EVENTS.USER_DESTROYED,
        data: { sessionId: '0_session_1', userId: 'user-9', reason: 'logout' },
      }),
    ]);
    const audit = vi.mocked(createAuditLog).mock.calls[0][1];
    expect(audit).toMatchObject({
      userId: 'user-9',
      action: 'user.logout',
      resource: 'session',
      resourceId: '0_session_1',
      ipAddress: '203.0.113.5',
      userAgent: 'rp-agent',
    });
    expect(JSON.parse(audit.metadata)).toMatchObject({
      client_id: 'client-123',
      reason: 'backchannel_logout',
    });
    expect(waitUntil).toHaveBeenCalled();
  });

  it('publishes an empty user id when the session is already gone', async () => {
    const { response } = await backchannel({ headers: AUTH });
    expect(response.status).toBe(200);
    for (const [, event] of vi.mocked(publishEvent).mock.calls) {
      expect((event as { data: { userId: string } }).data.userId).toBe('');
    }
    const audit = vi.mocked(createAuditLog).mock.calls[0][1];
    expect(audit).toMatchObject({ userId: '', ipAddress: 'unknown', userAgent: 'unknown' });
  });

  it('does not revoke device secrets for a session that is already gone', async () => {
    vi.mocked(isNativeSSOEnabled).mockResolvedValue(true);
    await backchannel();
    expect(revokeDeviceSecretsForLogoutScope).not.toHaveBeenCalled();
    expect(store.invalidateSessionRpc).toHaveBeenCalledWith('0_session_1');
  });

  it('keeps the session when device secret revocation fails', async () => {
    vi.mocked(isNativeSSOEnabled).mockResolvedValue(true);
    store.getSessionRpc.mockResolvedValueOnce({ id: '0_session_1', userId: 'user-9', data: {} });
    vi.mocked(revokeDeviceSecretsForLogoutScope).mockRejectedValue(new Error('d1 down'));
    const { response } = await backchannel();
    expect(await errorOf(response)).toEqual({
      status: 503,
      body: {
        error: 'temporarily_unavailable',
        error_description: 'Sign-out could not be completed',
      },
    });
    expect(store.invalidateSessionRpc).not.toHaveBeenCalled();
  });
});
