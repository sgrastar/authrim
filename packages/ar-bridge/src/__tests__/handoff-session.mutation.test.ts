import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { argRec, rec } from './helpers/mock-args';
import { handleHandoffFinalize, handleHandoffVerify } from '../handlers/handoff';

const NOW = 1_700_000_000_000;

const m = vi.hoisted(() => ({
  moduleNames: [] as string[],
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  consume: vi.fn(),
  challengeStore: vi.fn(),
  getSession: vi.fn(),
  createSession: vi.fn(),
  sessionStoreFor: vi.fn(),
  newSessionStore: vi.fn(),
  sharded: vi.fn(),
  findClient: vi.fn(),
  findUser: vi.fn(),
  checkRateLimit: vi.fn(),
  originAllowed: vi.fn(),
  extractDpop: vi.fn(),
  validateDpop: vi.fn(),
  settings: vi.fn(),
  usagePolicy: vi.fn(),
  accountCtx: vi.fn(),
  postLogin: vi.fn(),
  tenant: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async () => ({
  resolveEffectiveSettings: m.settings,
  readExternalProviderUsagePolicy: m.usagePolicy,
  falRequiresSignedPushedRequest: (
    await vi.importActual<typeof import('@authrim/ar-lib-core/services/assurance')>(
      '@authrim/ar-lib-core/services/assurance'
    )
  ).falRequiresSignedPushedRequest,
  CanonicalRuntimeUserStore: class {
    findById(userId: string) {
      return m.findUser(userId) as unknown;
    }
  },
  AR_ERROR_CODES: {
    VALIDATION_REQUIRED_FIELD: 'validation_required_field',
    RATE_LIMIT_EXCEEDED: 'rate_limit_exceeded',
    AUTH_ORIGIN_NOT_ALLOWED: 'auth_origin_not_allowed',
    AUTH_CLIENT_NOT_FOUND: 'auth_client_not_found',
    CLIENT_METADATA_INVALID: 'client_metadata_invalid',
    AUTH_INVALID_CODE: 'auth_invalid_code',
    INTERNAL_ERROR: 'internal_error',
    AUTH_SESSION_EXPIRED: 'auth_session_expired',
    USER_INVALID_CREDENTIALS: 'user_invalid_credentials',
  },
  createErrorResponse: (
    c: { json: (b: unknown, s: number) => Response },
    code: string,
    options?: unknown
  ) => c.json({ error: code, options }, 400),
  createPhase1ErrorDetails: (code: string) => ({ code }),
  getLogger: () => ({
    module: (name: string) => {
      m.moduleNames.push(name);
      return m.log;
    },
  }),
  checkRateLimit: m.checkRateLimit,
  getTenantIdFromContext: m.tenant,
  createAuthContextFromHono: () => ({ repositories: { client: { findByClientId: m.findClient } } }),
  resolveAccountDataContextFromHono: m.accountCtx,
  createAccountAuthContextFromHono: () => ({ coreAdapter: 'core' }),
  createPIIContextFromHono: () => ({ defaultPiiAdapter: 'pii' }),
  isAllowedOriginForClient: m.originAllowed,
  getChallengeStoreByChallengeId: m.challengeStore,
  getSessionStoreBySessionId: m.sessionStoreFor,
  getSessionStoreForNewSession: m.newSessionStore,
  isShardedSessionId: m.sharded,
  extractDPoPProof: m.extractDpop,
  validateDPoPProof: m.validateDpop,
  getSessionCookieSameSite: () => 'Lax',
  resolvePostLoginRedirectUrl: m.postLogin,
}));

interface Req {
  env?: Record<string, unknown>;
  headers?: Record<string, string | null>;
  body?: Record<string, unknown>;
  path?: string;
  url?: string;
}

async function call(handler: 'verify' | 'finalize', req: Req = {}): Promise<Response> {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/handoff/verify', handleHandoffVerify);
  app.post('/handoff/finalize', handleHandoffFinalize);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Origin: 'https://rp.example.com',
    DPoP: 'proof',
    'cf-connecting-ip': '203.0.113.9',
  };
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    if (v === null) delete headers[k];
    else headers[k] = v;
  }
  const base = req.url ?? 'https://issuer.example.com';
  return app.request(
    `${base}/handoff/${handler}${req.path ?? ''}`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        handoff_token: 'tok',
        state: 'st',
        client_id: 'cid',
        ...req.body,
      }),
    },
    { ENVIRONMENT: 'production', ...req.env }
  );
}

function artifact(extra: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) {
  return {
    challenge: 'sess-1',
    userId: 'user-1',
    metadata: { client_id: 'cid', state: 'st', aud: 'handoff', created_at: NOW, ...meta },
    ...extra,
  };
}

async function errorOf(res: Response): Promise<unknown> {
  return rec(await res.json()).error;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  m.moduleNames.length = 0;
  m.tenant.mockReset().mockReturnValue('tenant-1');
  m.consume.mockReset().mockResolvedValue(artifact());
  m.challengeStore.mockReset().mockResolvedValue({ consumeChallengeRpc: m.consume });
  m.getSession.mockReset().mockResolvedValue({ data: { amr: ['pwd'], acr: 'acr-x' } });
  m.createSession.mockReset().mockResolvedValue(undefined);
  m.sessionStoreFor.mockReset().mockReturnValue({ stub: { getSessionRpc: m.getSession } });
  m.newSessionStore
    .mockReset()
    .mockResolvedValue({ sessionId: 'rp-token', stub: { createSessionRpc: m.createSession } });
  m.sharded.mockReset().mockReturnValue(true);
  m.findClient
    .mockReset()
    .mockResolvedValue({ redirect_uris: '["https://rp.example.com/callback"]' });
  m.findUser
    .mockReset()
    .mockResolvedValue({ email: 'u@example.com', name: 'U', email_verified: 1 });
  m.checkRateLimit.mockReset().mockResolvedValue({ allowed: true });
  m.originAllowed.mockReset().mockReturnValue(true);
  m.extractDpop.mockReset().mockReturnValue('proof');
  m.validateDpop.mockReset().mockResolvedValue({ valid: true, jkt: 'jkt-1' });
  m.settings.mockReset().mockResolvedValue({});
  m.usagePolicy.mockReset().mockResolvedValue({ loginEnabled: true, signupEnabled: false });
  m.accountCtx.mockReset().mockResolvedValue(undefined);
  m.postLogin.mockReset().mockResolvedValue({ redirectUrl: '/home' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the session behind the artifact', () => {
  it('refuses a session id that is not sharded', async () => {
    m.sharded.mockReturnValue(false);
    expect(await errorOf(await call('finalize'))).toBe('internal_error');
    expect(m.sessionStoreFor).not.toHaveBeenCalled();
  });

  it('looks the AS session up by its id and tenant', async () => {
    await call('finalize');
    expect(m.sharded).toHaveBeenCalledWith('sess-1');
    expect(m.sessionStoreFor).toHaveBeenCalledWith(expect.anything(), 'sess-1', 'tenant-1');
    expect(m.getSession).toHaveBeenCalledWith('sess-1');
  });

  it('refuses an artifact whose AS session has ended', async () => {
    m.getSession.mockResolvedValue(null);
    expect(await errorOf(await call('finalize'))).toBe('auth_session_expired');
    expect(m.log.warn).toHaveBeenCalledWith('AS SSO session expired', {
      sessionId: 'sess-1',
      client_id: 'cid',
    });
    expect(m.createSession).not.toHaveBeenCalled();
  });

  it('refuses a user whose account is inactive', async () => {
    m.accountCtx.mockRejectedValue(
      new Error('lookup_destination_revalidation_failed', { cause: 'account_inactive' })
    );
    expect(await errorOf(await call('finalize'))).toBe('user_invalid_credentials');
    expect(m.accountCtx).toHaveBeenCalledWith(expect.anything(), 'user-1');
    expect(m.findUser).not.toHaveBeenCalled();
  });

  it.each([
    ['another message', new Error('other', { cause: 'account_inactive' })],
    ['another cause', new Error('lookup_destination_revalidation_failed', { cause: 'x' })],
    ['no cause', new Error('lookup_destination_revalidation_failed')],
    ['a non-Error', 'lookup_destination_revalidation_failed'],
  ])('fails the request on an account lookup error with %s', async (_n, error) => {
    m.accountCtx.mockRejectedValue(error);
    const res = await call('finalize');
    expect(await errorOf(res)).toBe('internal_error');
    expect(m.log.error).toHaveBeenCalledWith(
      'Handoff finalize error',
      expect.objectContaining({ action: 'handoff_finalize' })
    );
    expect(m.createSession).not.toHaveBeenCalled();
  });

  it('refuses a user that no longer exists', async () => {
    m.findUser.mockResolvedValue(null);
    expect(await errorOf(await call('finalize'))).toBe('user_invalid_credentials');
    expect(m.findUser).toHaveBeenCalledWith('user-1');
    expect(m.log.warn).toHaveBeenCalledWith('User not found or inactive', {
      userId: 'user-1',
      client_id: 'cid',
    });
    expect(m.createSession).not.toHaveBeenCalled();
  });
});

describe('the RP session', () => {
  it('creates a cookie session with the defaults of an external sign-in', async () => {
    m.getSession.mockResolvedValue({ data: {} });
    await call('finalize');
    expect(m.newSessionStore).toHaveBeenCalledWith(expect.anything(), 'tenant-1');
    expect(m.createSession.mock.calls).toEqual([
      [
        'rp-token',
        'user-1',
        3600,
        {
          email: 'u@example.com',
          name: 'U',
          amr: ['external_idp'],
          acr: 'urn:mace:incommon:iap:bronze',
          client_id: 'cid',
          audience: 'rp',
          source_session_id: 'sess-1',
          token_type: 'Cookie',
        },
        'tenant-1',
      ],
    ]);
  });

  it('carries the AS session assurance over, and binds a DPoP session to its key', async () => {
    m.getSession.mockResolvedValue({
      data: {
        amr: ['pwd', 'otp'],
        acr: 'acr-high',
        unverified_amr: ['x'],
        upstream_acr: 'up-acr',
        reauth_proven_amr: ['pwd'],
        reauth_proven_at: 1234,
      },
    });
    await call('verify');
    expect(argRec(m.createSession, 0, 3)).toEqual({
      email: 'u@example.com',
      name: 'U',
      amr: ['pwd', 'otp'],
      acr: 'acr-high',
      unverified_amr: ['x'],
      upstream_acr: 'up-acr',
      reauth_proven_amr: ['pwd'],
      reauth_proven_at: 1234,
      client_id: 'cid',
      audience: 'rp',
      source_session_id: 'sess-1',
      token_type: 'DPoP',
      cnf: { jkt: 'jkt-1' },
    });
  });

  it('keeps an empty unverified_amr, and drops malformed assurance evidence', async () => {
    m.getSession.mockResolvedValue({
      data: {
        unverified_amr: [],
        upstream_acr: 5,
        reauth_proven_amr: 'pwd',
        reauth_proven_at: 1,
      },
    });
    await call('finalize');
    const data = argRec(m.createSession, 0, 3);
    expect(data.unverified_amr).toEqual([]);
    for (const key of ['upstream_acr', 'reauth_proven_amr', 'reauth_proven_at']) {
      expect(data).not.toHaveProperty(key);
    }
    m.createSession.mockClear();
    m.getSession.mockResolvedValue({ data: { reauth_proven_amr: ['pwd'], reauth_proven_at: '1' } });
    await call('finalize');
    expect(argRec(m.createSession, 0, 3)).not.toHaveProperty('reauth_proven_amr');
    expect(argRec(m.createSession, 0, 3)).not.toHaveProperty('unverified_amr');
  });

  it('logs the successful handoff with its response mode', async () => {
    await call('finalize');
    expect(m.log.info).toHaveBeenCalledWith('Handoff successful', {
      userId: 'user-1',
      client_id: 'cid',
      rpAccessToken: 'rp-token',
      responseMode: 'cookie-only',
    });
    await call('verify');
    expect(m.log.info).toHaveBeenLastCalledWith(
      'Handoff successful',
      expect.objectContaining({ responseMode: 'dpop-json' })
    );
  });
});

describe('POST /handoff/finalize', () => {
  it('sets the session cookie and answers without the token', async () => {
    const res = await call('finalize');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, expires_in: 3600, redirect_url: '/home' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Pragma')).toBe('no-cache');
    expect(res.headers.get('Set-Cookie')).toBe(
      'authrim_session=rp-token; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax'
    );
    expect(m.postLogin).toHaveBeenCalledWith(expect.anything(), 'tenant-1');
  });

  it('omits Secure over plain http', async () => {
    const res = await call('finalize', { url: 'http://localhost:8787' });
    expect(res.headers.get('Set-Cookie')).toBe(
      'authrim_session=rp-token; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax'
    );
  });

  it.each([
    ['handoff_token', { handoff_token: '' }],
    ['state', { state: '' }],
    ['client_id', { client_id: '' }],
  ])('requires %s', async (_n, body) => {
    const res = await call('finalize', { body });
    expect(await res.json()).toEqual({
      error: 'validation_required_field',
      options: { variables: { field: 'handoff_token, state, client_id' } },
    });
    expect(m.checkRateLimit).not.toHaveBeenCalled();
  });

  it('answers with the plain internal error and logs the cause on a crash', async () => {
    m.postLogin.mockRejectedValue(new RangeError('redirect lookup'));
    const res = await call('finalize');
    expect(await errorOf(res)).toBe('internal_error');
    expect(m.log.error).toHaveBeenCalledWith('Handoff finalize error', {
      action: 'handoff_finalize',
      errorType: 'RangeError',
      errorMessage: 'redirect lookup',
    });
    m.postLogin.mockRejectedValue('text');
    await call('finalize');
    expect(m.log.error).toHaveBeenLastCalledWith('Handoff finalize error', {
      action: 'handoff_finalize',
      errorType: 'Unknown',
      errorMessage: 'Unknown',
    });
  });
});

describe('POST /handoff/verify', () => {
  it('logs under the HANDOFF module', async () => {
    await call('verify');
    expect(m.moduleNames).toEqual(['HANDOFF', 'HANDOFF']);
  });

  it('gives a session without data the defaults of an external sign-in', async () => {
    m.getSession.mockResolvedValue({});
    await call('verify');
    expect(argRec(m.createSession, 0, 3)).toMatchObject({
      amr: ['external_idp'],
      acr: 'urn:mace:incommon:iap:bronze',
    });
    expect(argRec(m.createSession, 0, 3)).not.toHaveProperty('unverified_amr');
  });

  it('returns a DPoP token response bound to the proof', async () => {
    const res = await call('verify');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      token_type: 'DPoP',
      access_token: 'rp-token',
      expires_in: 3600,
    });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Pragma')).toBe('no-cache');
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(m.validateDpop).toHaveBeenCalledWith(
      'proof',
      'POST',
      'https://issuer.example.com/handoff/verify',
      undefined,
      expect.anything(),
      'cid',
      'tenant-1'
    );
  });

  it('adds the session and the user on include=session,user', async () => {
    const res = await call('verify', { path: '?include=session,user' });
    expect(await res.json()).toEqual({
      token_type: 'DPoP',
      access_token: 'rp-token',
      expires_in: 3600,
      session: {
        id: 'rp-token',
        userId: 'user-1',
        createdAt: new Date(NOW).toISOString(),
        expiresAt: new Date(NOW + 3_600_000).toISOString(),
      },
      user: { id: 'user-1', email: 'u@example.com', name: 'U', emailVerified: true },
    });
  });

  it('reports an unverified email as such', async () => {
    m.findUser.mockResolvedValue({ email: null, name: null, email_verified: 0 });
    const res = await call('verify', { path: '?include=session,user' });
    expect(rec(rec(await res.json()).user)).toEqual({
      id: 'user-1',
      email: null,
      name: null,
      emailVerified: false,
    });
  });

  it.each(['session', 'user', 'user,session', 'SESSION,USER'])(
    'rejects include=%s',
    async (include) => {
      const res = await call('verify', { path: `?include=${include}` });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'invalid_request',
        error_description: 'Unsupported include parameter. Use include=session,user.',
      });
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(m.consume).not.toHaveBeenCalled();
    }
  );

  it('ignores an empty include parameter', async () => {
    const res = await call('verify', { path: '?include=' });
    expect(rec(await res.json())).not.toHaveProperty('session');
  });

  it.each([
    ['handoff_token', { handoff_token: '' }],
    ['state', { state: '' }],
    ['client_id', { client_id: '' }],
  ])('requires %s before looking at DPoP', async (_n, body) => {
    const res = await call('verify', { body });
    expect(await errorOf(res)).toBe('validation_required_field');
    expect(m.extractDpop).not.toHaveBeenCalled();
  });

  it('requires a DPoP proof', async () => {
    m.extractDpop.mockReturnValue(null);
    const res = await call('verify');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'invalid_request',
      error_description: 'DPoP proof is required for handoff token verification',
      error_details: { code: 'dpop_proof_missing' },
    });
    expect(m.validateDpop).not.toHaveBeenCalled();
  });

  it.each([
    [{ valid: false, error_description: 'bad htm' }, 'bad htm'],
    [{ valid: false }, 'DPoP validation failed'],
    [{ valid: true }, 'DPoP validation failed'],
    [{ valid: true, jkt: '' }, 'DPoP validation failed'],
  ])('rejects the proof validation result %j', async (validation, description) => {
    m.validateDpop.mockResolvedValue(validation);
    const res = await call('verify');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'invalid_request',
      error_description: description,
      error_details: { code: 'dpop_proof_invalid' },
    });
    expect(m.consume).not.toHaveBeenCalled();
  });

  it('refuses at FAL3 before spending the artifact', async () => {
    m.settings.mockResolvedValue({
      'assurance.enabled': true,
      'assurance.default_fal': 'FAL3',
      'assurance.fal3_requires_par': true,
    });
    const res = await call('verify');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'unauthorized_client',
      error_description: 'A handoff does not meet the required federation assurance level (FAL3)',
    });
    expect(m.settings).toHaveBeenCalledWith(expect.anything(), 'assurance', {
      tenantId: 'tenant-1',
    });
    expect(m.consume).not.toHaveBeenCalled();
  });

  it('answers 503 while the assurance settings cannot be read', async () => {
    m.settings.mockRejectedValue(new Error('kv'));
    const res = await call('verify');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'Assurance settings are temporarily unavailable',
    });
    expect(m.log.error).toHaveBeenCalledWith(
      'Failed to load assurance settings',
      { action: 'assurance_settings' },
      expect.any(Error)
    );
    expect(m.consume).not.toHaveBeenCalled();
  });

  it('passes a failed redemption through unchanged', async () => {
    m.consume.mockRejectedValue(new Error('used'));
    const res = await call('verify');
    expect(await errorOf(res)).toBe('auth_invalid_code');
    expect(m.createSession).not.toHaveBeenCalled();
  });

  it('answers with the plain internal error and logs the cause on a crash', async () => {
    m.newSessionStore.mockRejectedValue(new TypeError('no store'));
    const res = await call('verify');
    expect(await errorOf(res)).toBe('internal_error');
    expect(m.log.error).toHaveBeenCalledWith('Handoff verify error', {
      action: 'handoff_verify',
      errorType: 'TypeError',
      errorMessage: 'no store',
    });
    m.newSessionStore.mockRejectedValue(5);
    await call('verify');
    expect(m.log.error).toHaveBeenLastCalledWith('Handoff verify error', {
      action: 'handoff_verify',
      errorType: 'Unknown',
      errorMessage: 'Unknown',
    });
  });

  it('rejects a malformed JSON body as an internal error', async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.post('/handoff/verify', handleHandoffVerify);
    const res = await app.request(
      'https://issuer.example.com/handoff/verify',
      { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } },
      {}
    );
    expect(await errorOf(res)).toBe('internal_error');
  });
});
