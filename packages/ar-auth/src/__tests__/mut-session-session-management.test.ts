import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('hono/cookie', () => ({ getCookie: vi.fn(), setCookie: vi.fn() }));

const m = vi.hoisted(() => ({
  session: {
    getSessionRpc: vi.fn(),
    createSessionRpc: vi.fn(),
    extendSessionRpc: vi.fn(),
  },
  challenge: { storeChallengeRpc: vi.fn(), consumeChallengeRpc: vi.fn() },
  readSettings: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getSessionStoreBySessionId: vi.fn(() => ({ stub: m.session })),
  getChallengeStoreByChallengeId: vi.fn(async () => m.challenge),
  readTenantSessionSettingsStrict: m.readSettings,
}));
vi.mock('../session-ttl', () => ({ resolveSessionTtl: vi.fn(async () => ({ seconds: 900 })) }));
vi.mock('../issuer', () => ({ getRequestIssuer: () => 'https://op.example.com' }));

import { getCookie, setCookie } from 'hono/cookie';
import {
  checkSessionIframeHandler,
  issueSessionTokenHandler,
  refreshSessionHandler,
  sessionStatusHandler,
  verifySessionTokenHandler,
} from '../session-management';

const SID = 'g1:apac:3:session_user_123';

function ctx(options: { headers?: Record<string, string>; body?: unknown; url?: string } = {}) {
  return {
    req: {
      header: (name: string) => options.headers?.[name],
      json: vi.fn(async () => {
        if (options.body instanceof Error) throw options.body;
        return options.body ?? {};
      }),
      raw: new Request(options.url ?? 'https://op.example.com/x', { headers: options.headers }),
    },
    env: {},
    get: (key: string) => (key === 'tenantId' ? 'default' : undefined),
    json: (body: unknown, status?: number) => Response.json(body, { status: status ?? 200 }),
  } as never;
}

async function call(handler: (c: never) => Promise<Response>, c: unknown) {
  const response = await handler(c as never);
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

function cookie(value: string | undefined) {
  vi.mocked(getCookie).mockReturnValue(value);
}

const invalidGrant = {
  error: 'invalid_grant',
  error_description: 'Session has expired or is invalid',
};

beforeEach(() => {
  vi.clearAllMocks();
  cookie(SID);
  m.session.getSessionRpc.mockResolvedValue({
    id: SID,
    userId: 'user-1',
    expiresAt: Date.now() + 60_000,
    createdAt: 1000,
    data: {},
  });
  m.readSettings.mockResolvedValue({});
});

describe('issueSessionTokenHandler', () => {
  it('refuses a non-sharded or missing session', async () => {
    cookie('legacy');
    expect(await call(issueSessionTokenHandler, ctx())).toEqual({
      status: 401,
      body: invalidGrant,
    });
    cookie(SID);
    m.session.getSessionRpc.mockResolvedValueOnce(null);
    expect(await call(issueSessionTokenHandler, ctx())).toEqual({
      status: 401,
      body: invalidGrant,
    });
  });

  it('refuses an Origin that is not an http(s) origin', async () => {
    for (const Origin of ['ftp://rp.example.com', 'not a url', 'file:///etc']) {
      expect(await call(issueSessionTokenHandler, ctx({ headers: { Origin } }))).toEqual({
        status: 400,
        body: { error: 'invalid_request', error_description: 'Invalid Origin header' },
      });
    }
  });

  it('stores a single-use token bound to the normalised origin', async () => {
    const res = await call(
      issueSessionTokenHandler,
      ctx({ headers: { Origin: 'http://rp.example.com:8080/path' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.expires_in).toBe(300);
    expect(m.challenge.storeChallengeRpc).toHaveBeenCalledWith({
      id: `session_token:${String(res.body.token)}`,
      tenantId: 'default',
      type: 'session_token',
      userId: 'user-1',
      challenge: res.body.token,
      ttl: 300,
      metadata: { sessionId: SID, rpOrigin: 'http://rp.example.com:8080' },
    });
  });

  it('answers server_error when the token cannot be stored', async () => {
    m.challenge.storeChallengeRpc.mockRejectedValueOnce(new Error('do'));
    expect(await call(issueSessionTokenHandler, ctx())).toEqual({
      status: 500,
      body: { error: 'server_error', error_description: 'Failed to issue session token' },
    });
  });
});

describe('verifySessionTokenHandler', () => {
  const expired = { error: 'session_expired', error_description: 'Original session has expired' };

  it('requires a token', async () => {
    expect(await call(verifySessionTokenHandler, ctx({ body: {} }))).toEqual({
      status: 400,
      body: { error: 'invalid_request', error_description: 'Token is required' },
    });
  });

  it('refuses a token naming no session, or a session that has ended', async () => {
    m.challenge.consumeChallengeRpc.mockResolvedValueOnce({ userId: 'user-1' });
    expect(await call(verifySessionTokenHandler, ctx({ body: { token: 't' } }))).toEqual({
      status: 401,
      body: expired,
    });
    m.challenge.consumeChallengeRpc.mockResolvedValueOnce({
      userId: 'user-1',
      metadata: { sessionId: SID },
    });
    m.session.getSessionRpc.mockResolvedValueOnce(null);
    expect(
      await call(verifySessionTokenHandler, ctx({ body: { token: 't', rp_origin: 'https://rp' } }))
    ).toEqual({
      status: 401,
      body: expired,
    });
  });

  it('creates an RP session for the origin the token was issued to', async () => {
    m.challenge.consumeChallengeRpc.mockResolvedValue({
      userId: 'user-1',
      metadata: { sessionId: SID, rpOrigin: 'https://rp.example.com' },
    });
    m.session.createSessionRpc.mockResolvedValue({ id: 'rp-session', expiresAt: 42 });
    const res = await call(
      verifySessionTokenHandler,
      ctx({ body: { token: 't', rp_origin: 'https://rp.example.com/' } })
    );
    expect(res).toEqual({
      status: 200,
      body: { session_id: 'rp-session', user_id: 'user-1', expires_at: 42, verified: true },
    });
    expect(m.session.createSessionRpc).toHaveBeenCalledWith(
      expect.any(String),
      'user-1',
      900,
      expect.objectContaining({ rpOrigin: 'https://rp.example.com', parentSessionId: SID }),
      'default'
    );
  });

  it('refuses an RP session that reuses the OP session', async () => {
    m.challenge.consumeChallengeRpc.mockResolvedValue({
      userId: 'user-1',
      metadata: { sessionId: SID },
    });
    m.session.createSessionRpc.mockResolvedValue({ id: SID, expiresAt: 42 });
    expect(
      await call(verifySessionTokenHandler, ctx({ body: { token: 't', rp_origin: 'https://rp' } }))
    ).toEqual({
      status: 500,
      body: { error: 'server_error', error_description: 'Failed to create RP session' },
    });
  });

  it('answers server_error for an unreadable body', async () => {
    expect(await call(verifySessionTokenHandler, ctx({ body: new Error('json') }))).toEqual({
      status: 500,
      body: { error: 'server_error', error_description: 'Failed to verify session token' },
    });
  });
});

describe('sessionStatusHandler', () => {
  it('reports a non-sharded or expired session as inactive', async () => {
    cookie('legacy');
    expect(await call(sessionStatusHandler, ctx())).toEqual({
      status: 200,
      body: { active: false, error: 'session_expired' },
    });
    cookie(SID);
    m.session.getSessionRpc.mockResolvedValueOnce({
      id: SID,
      userId: 'u',
      expiresAt: Date.now() - 1,
      createdAt: 0,
    });
    expect(await call(sessionStatusHandler, ctx())).toEqual({
      status: 200,
      body: { active: false, error: 'session_expired' },
    });
  });

  it('reports acr and amr when the session has them', async () => {
    m.session.getSessionRpc.mockResolvedValueOnce({
      id: SID,
      userId: 'user-1',
      expiresAt: Date.now() + 60_000,
      createdAt: 5000,
      data: { acr: 'urn:aal2', amr: ['pwd'], authTime: 7 },
    });
    const res = await call(
      sessionStatusHandler,
      ctx({ url: 'https://op.example.com/session/status?include=none' })
    );
    expect(res.body).toMatchObject({ active: true, acr: 'urn:aal2', amr: ['pwd'], auth_time: 7 });
  });

  it('answers server_error when the store fails', async () => {
    m.session.getSessionRpc.mockRejectedValueOnce(new Error('do'));
    expect(await call(sessionStatusHandler, ctx())).toEqual({
      status: 500,
      body: { error: 'server_error', error_description: 'Failed to check session status' },
    });
  });
});

describe('refreshSessionHandler', () => {
  const extended = (expiresAt = Date.now() + 3_600_000) => ({
    id: SID,
    userId: 'user-1',
    expiresAt,
  });

  it('requires a session id from the cookie or the body', async () => {
    cookie(undefined);
    expect(await call(refreshSessionHandler, ctx({ body: {} }))).toEqual({
      status: 400,
      body: { error: 'invalid_request', error_description: 'Session ID is required' },
    });
  });

  it('bounds the extension to 0..86400 seconds', async () => {
    const error = {
      error: 'invalid_request',
      error_description: 'Extension duration must be between 0 and 86400 seconds',
    };
    for (const extend_seconds of [86401, -1]) {
      expect(await call(refreshSessionHandler, ctx({ body: { extend_seconds } }))).toEqual({
        status: 400,
        body: error,
      });
    }
    m.session.extendSessionRpc.mockResolvedValue(extended());
    expect(
      (await call(refreshSessionHandler, ctx({ body: { extend_seconds: 86400 } }))).body.extended_by
    ).toBe(86400);
  });

  it('extends a body-named session by its default hour without setting cookies', async () => {
    cookie(undefined);
    m.session.extendSessionRpc.mockResolvedValue(extended());
    const res = await call(refreshSessionHandler, ctx({ body: { session_id: SID } }));
    expect(res.body).toMatchObject({
      session_id: SID,
      extended_by: 3600,
      message: 'Session extended successfully',
    });
    expect(setCookie).not.toHaveBeenCalled();
  });

  it('defaults to an hour when the cookie request has no readable body', async () => {
    m.session.extendSessionRpc.mockResolvedValue(extended());
    const res = await call(refreshSessionHandler, ctx({ body: new Error('none') }));
    expect(res.body.extended_by).toBe(3600);
    expect(vi.mocked(setCookie).mock.calls.map(([, name]) => name)).toContain('authrim_session');
  });

  it('refuses a non-sharded session id and a session that is gone', async () => {
    cookie('legacy');
    expect(await call(refreshSessionHandler, ctx())).toEqual({ status: 401, body: invalidGrant });
    cookie(SID);
    m.session.getSessionRpc.mockResolvedValueOnce(null);
    const gone = { error: 'invalid_grant', error_description: 'Session not found or has expired' };
    expect(await call(refreshSessionHandler, ctx())).toEqual({ status: 404, body: gone });
    m.session.extendSessionRpc.mockResolvedValueOnce(null);
    expect(await call(refreshSessionHandler, ctx())).toEqual({ status: 404, body: gone });
  });

  it('answers 503 when the session settings cannot be read', async () => {
    m.readSettings.mockRejectedValueOnce(new Error('kv'));
    expect(await call(refreshSessionHandler, ctx())).toEqual({
      status: 503,
      body: {
        error: 'temporarily_unavailable',
        error_description: 'Session settings are unavailable.',
      },
    });
  });

  it('answers server_error when extension fails', async () => {
    m.session.extendSessionRpc.mockRejectedValueOnce(new Error('do'));
    expect(await call(refreshSessionHandler, ctx())).toEqual({
      status: 500,
      body: { error: 'server_error', error_description: 'Failed to refresh session' },
    });
  });
});

describe('checkSessionIframeHandler', () => {
  it('serves the iframe uncached with a nonce CSP', async () => {
    const response = await checkSessionIframeHandler(ctx());
    expect(response.headers.get('Content-Security-Policy')).toMatch(
      /^default-src 'none'; script-src 'nonce-[0-9a-f-]+'; frame-ancestors \*;$/
    );
    expect(response.headers.get('Cache-Control')).toBe('no-cache, no-store, must-revalidate');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(response.headers.get('Expires')).toBe('0');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
});
