import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { callArg, rec } from './helpers/mock-args';
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
  headers?: Record<string, string | null | undefined>;
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
    else if (v !== undefined) headers[k] = v;
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

describe('logging', () => {
  it('logs under the HANDOFF module', async () => {
    await call('finalize');
    expect(m.moduleNames).toEqual(['HANDOFF', 'HANDOFF']);
  });
});

describe('rate limiting', () => {
  it('limits ten redemptions a minute per client and address', async () => {
    await call('finalize');
    expect(m.checkRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      'handoff:verify:cid:203.0.113.9',
      { maxRequests: 10, windowSeconds: 60 },
      'tenant-1'
    );
  });

  it('keys an unknown address as unknown', async () => {
    await call('finalize', { headers: { 'cf-connecting-ip': null } });
    expect(callArg(m.checkRateLimit, 0, 1)).toBe('handoff:verify:cid:unknown');
  });

  it('refuses when the limit is exceeded, before the client is looked up', async () => {
    m.checkRateLimit.mockResolvedValue({ allowed: false });
    const res = await call('finalize');
    expect(await errorOf(res)).toBe('rate_limit_exceeded');
    expect(m.findClient).not.toHaveBeenCalled();
    expect(m.log.warn).toHaveBeenCalledWith('Rate limit exceeded', {
      client_id: 'cid',
      ip: '203.0.113.9',
    });
  });

  it('fails open, logging, when the limiter is unavailable', async () => {
    m.checkRateLimit.mockRejectedValue(new Error('rl down'));
    const res = await call('finalize');
    expect(res.status).toBe(200);
    expect(m.log.error).toHaveBeenCalledWith('Rate limit check failed', {}, expect.any(Error));
  });
});

describe('origin and client checks', () => {
  it('refuses a request with no Origin or usable Referer', async () => {
    for (const headers of [{ Origin: null }, { Origin: null, Referer: 'not a url' }]) {
      m.log.error.mockClear();
      const res = await call('finalize', { headers });
      expect(await errorOf(res)).toBe('auth_origin_not_allowed');
      expect(m.log.error).toHaveBeenCalledWith('Missing Origin header', {
        client_id: 'cid',
        ip: '203.0.113.9',
      });
    }
    expect(m.findClient).not.toHaveBeenCalled();
  });

  it('takes the origin from the Referer when Origin is absent', async () => {
    const res = await call('finalize', {
      headers: { Origin: null, Referer: 'https://rp.example.com/page?x=1' },
    });
    expect(res.status).toBe(200);
    expect(callArg(m.originAllowed, 0, 1)).toBe('https://rp.example.com');
  });

  it('prefers the Origin header over the Referer', async () => {
    const res = await call('finalize', {
      headers: { Origin: 'https://rp.example.com', Referer: 'https://other.example/page' },
    });
    expect(res.status).toBe(200);
    expect(callArg(m.originAllowed, 0, 1)).toBe('https://rp.example.com');
  });

  it('refuses an unknown or disabled client, and accepts one without an enabled flag', async () => {
    m.findClient.mockResolvedValue(null);
    expect(await errorOf(await call('finalize'))).toBe('auth_client_not_found');
    expect(m.log.error).toHaveBeenCalledWith('Client not found', {
      client_id: 'cid',
      origin: 'https://rp.example.com',
      ip: '203.0.113.9',
    });
    m.findClient.mockResolvedValue({
      enabled: false,
      redirect_uris: '["https://rp.example.com/"]',
    });
    expect(await errorOf(await call('finalize'))).toBe('auth_client_not_found');
    m.findClient.mockResolvedValue({ enabled: true, redirect_uris: '["https://rp.example.com/"]' });
    expect((await call('finalize')).status).toBe(200);
    expect(m.findClient).toHaveBeenCalledWith('cid');
  });

  it.each([
    ['an array', ['https://a.example/cb'], ['https://a.example/cb']],
    [
      'a JSON array text',
      '["https://a.example/cb","https://b.example/cb"]',
      ['https://a.example/cb', 'https://b.example/cb'],
    ],
    ['a JSON array with leading space', '  ["https://a.example/cb"]', ['https://a.example/cb']],
    ['a single URL string', 'https://a.example/cb', ['https://a.example/cb']],
  ])('reads redirect_uris given as %s', async (_n, value, expected) => {
    m.findClient.mockResolvedValue({ redirect_uris: value });
    expect((await call('finalize')).status).toBe(200);
    expect(rec(callArg(m.originAllowed, 0, 0)).redirect).toEqual({
      allowedRedirectUris: expected,
      allowLocalhost: false,
    });
  });

  it.each([
    ['missing', undefined, 'undefined', 0, 'redirect_uris is missing or null'],
    ['empty text', '', 'string', 0, 'redirect_uris is missing or null'],
    ['a number', 5, 'number', 0, 'redirect_uris has unexpected type: number'],
    ['broken JSON', '[oops', 'string', 5, expect.stringContaining('JSON')],
  ])('refuses redirect_uris that is %s', async (_n, value, type, length, message) => {
    m.findClient.mockResolvedValue({ redirect_uris: value });
    expect(await errorOf(await call('finalize'))).toBe('client_metadata_invalid');
    expect(m.log.error).toHaveBeenCalledWith('Invalid redirect_uris format', {
      client_id: 'cid',
      redirect_uris_type: type,
      redirect_uris_length: length,
      error: message as unknown,
    });
    expect(m.consume).not.toHaveBeenCalled();
  });

  it.each([
    [{ ENVIRONMENT: 'development' }, true],
    [{ ALLOW_LOCALHOST: 'true' }, true],
    [{ ALLOW_LOCALHOST: '1' }, true],
    [{ ALLOW_LOCALHOST: 'yes' }, false],
    [{ ALLOW_LOCALHOST: 'false' }, false],
    [{}, false],
  ])('derives localhost permission from %j', async (env, allowed) => {
    await call('finalize', { env });
    expect(rec(rec(callArg(m.originAllowed, 0, 0)).redirect).allowLocalhost).toBe(allowed);
  });

  it('refuses an origin the client does not allow, before consuming the artifact', async () => {
    m.originAllowed.mockReturnValue(false);
    expect(await errorOf(await call('finalize'))).toBe('auth_origin_not_allowed');
    expect(m.log.error).toHaveBeenCalledWith('Origin not allowed - POTENTIAL ATTACK', {
      client_id: 'cid',
      origin: 'https://rp.example.com',
      allowed_redirect_uris: ['https://rp.example.com/callback'],
      ip: '203.0.113.9',
    });
    expect(m.consume).not.toHaveBeenCalled();
  });
});

describe('artifact checks', () => {
  it('consumes the artifact once with its id, tenant and type', async () => {
    await call('finalize');
    expect(m.challengeStore).toHaveBeenCalledWith(expect.anything(), 'tok', 'tenant-1');
    expect(m.consume.mock.calls).toEqual([
      [{ id: 'handoff:tok', tenantId: 'tenant-1', type: 'handoff' }],
    ]);
  });

  it('refuses an unknown or already used artifact', async () => {
    m.consume.mockRejectedValue(new Error('gone'));
    expect(await errorOf(await call('finalize'))).toBe('auth_invalid_code');
    expect(m.log.warn).toHaveBeenCalledWith('Invalid or expired handoff token', {
      client_id: 'cid',
      ip: '203.0.113.9',
    });
  });

  it.each([
    ['missing', undefined],
    ['not text', 5],
    ['another audience', 'id_token'],
  ])('refuses an artifact whose audience is %s', async (_n, aud) => {
    m.consume.mockResolvedValue(artifact({}, { aud }));
    expect(await errorOf(await call('finalize'))).toBe('auth_invalid_code');
    expect(m.log.error).toHaveBeenCalledWith('Invalid token audience', {
      expected: 'handoff or saml_sp_cookie_handoff',
      received: aud,
      client_id: 'cid',
    });
    expect(m.getSession).not.toHaveBeenCalled();
  });

  it('refuses an artifact without metadata', async () => {
    m.consume.mockResolvedValue({ challenge: 'sess-1', userId: 'user-1' });
    expect(await errorOf(await call('finalize'))).toBe('auth_invalid_code');
  });

  it('binds a SAML cookie handoff to the origin it was made for', async () => {
    m.consume.mockResolvedValue(
      artifact({}, { aud: 'saml_sp_cookie_handoff', origin: 'https://other.example' })
    );
    expect(await errorOf(await call('finalize'))).toBe('auth_invalid_code');
    expect(m.log.error).toHaveBeenCalledWith('Origin mismatch - POTENTIAL ATTACK', {
      expected: 'https://other.example',
      received: 'https://rp.example.com',
      client_id: 'cid',
      ip: '203.0.113.9',
    });
    m.consume.mockResolvedValue(
      artifact({}, { aud: 'saml_sp_cookie_handoff', origin: 'https://rp.example.com' })
    );
    expect((await call('finalize')).status).toBe(200);
    m.consume.mockResolvedValue(artifact({}, { aud: 'saml_sp_cookie_handoff' }));
    expect((await call('finalize')).status).toBe(200);
    // a plain handoff is not bound to an origin it happens to carry
    m.consume.mockResolvedValue(artifact({}, { aud: 'handoff', origin: 'https://other.example' }));
    expect((await call('finalize')).status).toBe(200);
  });

  it.each([
    ['missing', undefined],
    ['text', '1700000000000'],
    ['not finite', Number.POSITIVE_INFINITY],
    ['NaN', Number.NaN],
  ])('refuses an artifact whose created_at is %s', async (_n, createdAt) => {
    m.consume.mockResolvedValue(artifact({}, { created_at: createdAt }));
    expect(await errorOf(await call('finalize'))).toBe('auth_invalid_code');
    expect(m.log.warn).toHaveBeenCalledWith(
      'Expired or malformed handoff artifact',
      expect.objectContaining({ client_id: 'cid', artifactTtlSeconds: 60, ip: '203.0.113.9' })
    );
  });

  it('expires an artifact exactly at its TTL but not a millisecond before', async () => {
    m.consume.mockResolvedValue(artifact({}, { created_at: NOW - 60_000 }));
    expect(await errorOf(await call('finalize'))).toBe('auth_invalid_code');
    m.consume.mockResolvedValue(artifact({}, { created_at: NOW - 59_999 }));
    expect((await call('finalize')).status).toBe(200);
  });

  it.each([
    ['the default', {}, {}, 60],
    ['a client value', { handoff_artifact_ttl_seconds: 120 }, {}, 120],
    ['a client text value', { handoff_artifact_ttl_seconds: ' 90 ' }, {}, 90],
    ['a fractional value truncated', { handoff_artifact_ttl_seconds: 100.9 }, {}, 100],
    ['the legacy client key', { handoff_artifact_ttl: 200 }, {}, 200],
    [
      'the primary key over the legacy one',
      { handoff_artifact_ttl_seconds: 45, handoff_artifact_ttl: 200 },
      {},
      45,
    ],
    ['a client floor', { handoff_artifact_ttl_seconds: 1 }, {}, 30],
    ['a client ceiling', { handoff_artifact_ttl_seconds: 9999 }, {}, 300],
    ['the lower boundary', { handoff_artifact_ttl_seconds: 30 }, {}, 30],
    ['the upper boundary', { handoff_artifact_ttl_seconds: 300 }, {}, 300],
    [
      'a blank client value falling back to the env',
      { handoff_artifact_ttl_seconds: '  ' },
      { HANDOFF_ARTIFACT_TTL_SECONDS: 77 },
      77,
    ],
    [
      'a non-numeric client text falling back to the env',
      { handoff_artifact_ttl_seconds: 'abc' },
      { HANDOFF_ARTIFACT_TTL_SECONDS: '150' },
      150,
    ],
    [
      'an infinite client value falling back',
      { handoff_artifact_ttl_seconds: Number.POSITIVE_INFINITY },
      {},
      60,
    ],
    ['an env ceiling', {}, { HANDOFF_ARTIFACT_TTL_SECONDS: '5000' }, 300],
    ['an env floor', {}, { HANDOFF_ARTIFACT_TTL_SECONDS: 0 }, 30],
    ['a client that is not a string or number', { handoff_artifact_ttl_seconds: true }, {}, 60],
    ['a non-numeric env', {}, { HANDOFF_ARTIFACT_TTL_SECONDS: 'x' }, 60],
  ])('resolves the artifact lifetime from %s', async (_n, client, env, seconds) => {
    m.findClient.mockResolvedValue({ redirect_uris: '["https://rp.example.com/"]', ...client });
    m.consume.mockResolvedValue(artifact({}, { created_at: NOW - seconds * 1000 + 1 }));
    expect((await call('finalize', { env })).status).toBe(200);
    m.consume.mockResolvedValue(artifact({}, { created_at: NOW - seconds * 1000 }));
    expect(await errorOf(await call('finalize', { env }))).toBe('auth_invalid_code');
  });

  it('refuses a state that does not match', async () => {
    expect(await errorOf(await call('finalize', { body: { state: 'other' } }))).toBe(
      'auth_invalid_code'
    );
    expect(m.log.error).toHaveBeenCalledWith('State mismatch - POTENTIAL CSRF ATTACK', {
      expected: 'st',
      received: 'other',
      client_id: 'cid',
      ip: '203.0.113.9',
    });
  });

  it('refuses an artifact made for another client, but accepts one with no client recorded', async () => {
    m.consume.mockResolvedValue(artifact({}, { client_id: 'other-client' }));
    expect(await errorOf(await call('finalize'))).toBe('auth_invalid_code');
    expect(m.log.error).toHaveBeenCalledWith('Client ID mismatch - POTENTIAL ATTACK', {
      expected: 'other-client',
      received: 'cid',
      ip: '203.0.113.9',
    });
    m.consume.mockResolvedValue(artifact({}, { client_id: undefined }));
    expect((await call('finalize')).status).toBe(200);
  });
});

describe('the provider that signed the user in', () => {
  const key = { providerId: 'prov', ids: ['a', 'b'] };

  it.each([
    ['null', null],
    ['a string', 'prov'],
    ['an array', [key]],
    ['no provider id', { providerId: '', ids: [] }],
    ['a non-text provider id', { providerId: 5, ids: [] }],
    ['no ids', { providerId: 'p' }],
    ['non-text ids', { providerId: 'p', ids: [1] }],
  ])('refuses a malformed provider key (%s)', async (_n, value) => {
    m.consume.mockResolvedValue(artifact({}, { external_provider_usage_key: value }));
    expect(await errorOf(await call('finalize'))).toBe('auth_invalid_code');
    expect(m.usagePolicy).not.toHaveBeenCalled();
    expect(m.getSession).not.toHaveBeenCalled();
  });

  it('accepts a key with no ids', async () => {
    m.consume.mockResolvedValue(
      artifact({}, { external_provider_usage_key: { providerId: 'p', ids: [] } })
    );
    expect((await call('finalize')).status).toBe(200);
  });

  it('checks the provider policy with the tenant and the key', async () => {
    m.consume.mockResolvedValue(artifact({}, { external_provider_usage_key: key }));
    expect((await call('finalize')).status).toBe(200);
    expect(m.usagePolicy).toHaveBeenCalledWith(expect.anything(), 'tenant-1', key);
  });

  it.each([
    ['sign-in off, sign-up on, artifact from a sign-up', 'signup', false, true, 200],
    ['sign-in off, sign-up on, artifact from a sign-in', undefined, false, true, 403],
    ['sign-in off, sign-up off, artifact from a sign-up', 'signup', false, false, 403],
    ['sign-in on, sign-up off, artifact from a sign-in', undefined, true, false, 200],
    ['sign-in on, sign-up off, artifact from a sign-up', 'signup', true, false, 200],
  ])('%s', async (_n, usage, loginEnabled, signupEnabled, status) => {
    m.usagePolicy.mockResolvedValue({ loginEnabled, signupEnabled });
    m.consume.mockResolvedValue(
      artifact({}, { external_provider_usage_key: key, external_provider_usage: usage })
    );
    const res = await call('finalize');
    expect(res.status).toBe(status);
    if (status === 403) {
      expect(await res.json()).toEqual({
        error: 'access_denied',
        error_description: 'This provider cannot be used to sign in',
      });
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Pragma')).toBe('no-cache');
      expect(m.createSession).not.toHaveBeenCalled();
      expect(m.log.warn).toHaveBeenCalledWith(
        'External provider sign-in was turned off before the handoff was redeemed',
        { client_id: 'cid' }
      );
    }
  });

  it('answers 503 and asks to retry when the provider settings cannot be read', async () => {
    m.usagePolicy.mockRejectedValue(new Error('settings down'));
    m.consume.mockResolvedValue(artifact({}, { external_provider_usage_key: key }));
    const res = await call('finalize');
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('1');
    expect(await res.json()).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'Provider settings are unavailable',
    });
    expect(m.createSession).not.toHaveBeenCalled();
    expect(m.log.error).toHaveBeenCalledWith(
      'External provider usage settings are unavailable',
      {},
      expect.any(Error)
    );
  });
});
