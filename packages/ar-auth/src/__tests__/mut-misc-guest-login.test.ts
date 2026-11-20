import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { AR_ERROR_CODES, GUEST_RESUME_COOKIE, type Env } from '@authrim/ar-lib-core';
const mocks = vi.hoisted(() => ({
  directClient: vi.fn(),
  challenge: vi.fn(),
  humanVerification: vi.fn(),
  storeProof: vi.fn(),
  settings: vi.fn(),
  contract: vi.fn(),
  route: vi.fn(),
  provision: vi.fn(),
  query: vi.fn(),
  execute: vi.fn(),
  lifecycle: vi.fn(),
  user: vi.fn(),
  createSession: vi.fn(),
  invalidateSession: vi.fn(),
  getSession: vi.fn(),
  audit: vi.fn(),
  publishEvent: vi.fn(),
  liteMode: vi.fn(),
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getTenantIdFromContext: () => 'tenant-a',
  getChallengeStoreByChallengeId: async () => ({
    getChallengeRpc: mocks.challenge,
    storeChallengeRpc: mocks.storeProof,
  }),
  resolveGuestSettings: mocks.settings,
  loadClientContractCached: mocks.contract,
  generateUserIdFromSettings: async () => 'guest-a',
  createAccountAuthContextFromHono: () => ({
    coreAdapter: { queryOne: mocks.query, execute: mocks.execute },
  }),
  createPIIContextFromHono: () => ({ defaultPiiAdapter: {} }),
  resolveAccountDataContextFromHono: async (_c: unknown, userId: string) => ({
    tenantId: 'tenant-a',
    accountId: `account:${userId}`,
    legacyUserId: userId,
  }),
  GuestLifecycleRepository: class {
    get = mocks.lifecycle;
  },
  CanonicalRuntimeUserStore: class {
    findById = mocks.user;
  },
  getSessionStoreBySessionId: () => ({ stub: { getSessionRpc: mocks.getSession } }),
  getSessionStoreForNewSession: async () => ({
    stub: { createSessionRpc: mocks.createSession, invalidateSessionRpc: mocks.invalidateSession },
    sessionId: 'session-a',
  }),
  generateBrowserState: async () => 'browser-state',
  createAuditLog: mocks.audit,
  publishEvent: mocks.publishEvent,
}));
vi.mock('../account-provisioning', () => ({
  provisionGuestAccount: mocks.provision,
  resolveGuestAccountRoute: mocks.route,
}));
vi.mock('../human-verification', () => ({
  verifyHumanVerificationForAction: mocks.humanVerification,
}));
vi.mock('../direct-auth', () => ({
  getDirectAuthWebAuthnOrigin: (_c: unknown, origin?: string) => origin,
  validateDirectAuthClient: mocks.directClient,
}));
vi.mock('../lite-mode', () => ({ readLiteMode: mocks.liteMode }));
vi.mock('../session-ttl', () => ({ resolveSessionTtl: async () => ({ seconds: 3600 }) }));
import { guestLoginHandler, guestResumeHash } from '../guest-login';

const SECRET = 'b'.repeat(64);
const resumeCookie = `${GUEST_RESUME_COOKIE}=${SECRET}`;

function request(
  body: Record<string, unknown> = { authorizationChallengeId: 'login-challenge' },
  headers: Record<string, string> = {}
) {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/api/auth/guest/login', guestLoginHandler);
  return app.request(
    '/api/auth/guest/login',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://login.example.com',
        ...headers,
      },
      body: JSON.stringify(body),
    },
    {}
  );
}

async function errorCode(response: Response) {
  return (await response.json<{ error_code?: string }>()).error_code;
}

let loginChallenge: Record<string, unknown>;
let proof: Record<string, unknown> | null;

beforeEach(() => {
  vi.clearAllMocks();
  loginChallenge = {
    type: 'login',
    tenantId: 'tenant-a',
    consumed: false,
    expiresAt: Date.now() + 60000,
    metadata: { client_id: 'client-a', scope: 'openid' },
  };
  proof = null;
  mocks.challenge.mockImplementation(async (id: string) =>
    id.startsWith('guest-human:') ? proof : loginChallenge
  );
  mocks.directClient.mockResolvedValue({ valid: true });
  mocks.humanVerification.mockResolvedValue(null);
  mocks.liteMode.mockResolvedValue('off');
  mocks.settings.mockResolvedValue({
    loginEnabled: true,
    policy: { deletionAfterDays: null },
    policyVersion: 'v1',
  });
  mocks.contract.mockResolvedValue({ guestAuth: { enabled: true, allowedScopes: ['openid'] } });
  mocks.route.mockResolvedValue({ legacyUserId: 'guest-a' });
  mocks.query.mockResolvedValue({
    id: 'resume-a',
    user_id: 'guest-a',
    expires_at: null,
    created_at: Date.now() - 1000,
  });
  mocks.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
  mocks.lifecycle.mockResolvedValue({ phase: 'active', client_id: 'client-a' });
  mocks.user.mockResolvedValue({ registration_state: 'guest' });
  mocks.getSession.mockResolvedValue(null);
  mocks.audit.mockResolvedValue(undefined);
  mocks.publishEvent.mockResolvedValue(undefined);
});

describe('guest login request checks', () => {
  it('refuses a login challenge bound to another tenant in its metadata', async () => {
    loginChallenge.metadata = { client_id: 'client-a', tenant_id: 'tenant-b' };
    const response = await request();
    expect(await errorCode(response)).toBe(AR_ERROR_CODES.AUTH_INVALID_CODE);
    expect(mocks.settings).not.toHaveBeenCalled();
  });

  it('accepts a login challenge whose metadata names this tenant and no scope', async () => {
    loginChallenge.metadata = { client_id: 'client-a', tenant_id: 'tenant-a' };
    mocks.contract.mockResolvedValue({ guestAuth: { enabled: true, allowedScopes: [] } });
    expect((await request()).status).toBe(200);
  });

  it.each([1, '', 'c'.repeat(257)])('refuses the direct client id %j', async (clientId) => {
    const response = await request({ clientId });
    expect(await errorCode(response)).toBe(AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    expect(mocks.directClient).not.toHaveBeenCalled();
  });

  it('answers a scope outside the guest allow-list with invalid_scope', async () => {
    loginChallenge.metadata = { client_id: 'client-a', scope: 'openid email' };
    const response = await request();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_scope',
      error_description: 'The client does not permit the requested guest scopes',
    });
  });

  it('refuses to start a guest over an active account session', async () => {
    mocks.getSession.mockResolvedValue({ expiresAt: Date.now() + 60000, data: {} });
    const response = await request(undefined, { cookie: 'authrim_session=s-1' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'account_session_exists',
      error_description: 'Sign out before starting a guest account',
    });
  });

  it.each([
    ['an expired account session', { expiresAt: Date.now() - 1, data: {} }],
    ['a guest session', { expiresAt: Date.now() + 60000, data: { is_guest_session: true } }],
    ['a session without data', { expiresAt: Date.now() - 1 }],
  ])('continues over %s', async (_label, session) => {
    mocks.getSession.mockResolvedValue(session);
    expect((await request(undefined, { cookie: 'authrim_session=s-1' })).status).toBe(200);
  });
});

describe('guest login human verification proof', () => {
  async function validProof(overrides: Record<string, unknown> = {}) {
    return {
      tenantId: 'tenant-a',
      type: 'anon_login',
      metadata: { purpose: 'guest_human_verification', client_id: 'client-a' },
      challenge: await guestResumeHash(SECRET, 'tenant-a', 'client-a'),
      consumed: false,
      expiresAt: Date.now() + 60000,
      ...overrides,
    };
  }

  it('skips verification for a matching stored proof', async () => {
    proof = await validProof();
    expect((await request(undefined, { cookie: resumeCookie })).status).toBe(200);
    expect(mocks.humanVerification).not.toHaveBeenCalled();
    expect(mocks.storeProof).not.toHaveBeenCalled();
  });

  it.each([
    ['another tenant', { tenantId: 'tenant-b' }],
    ['another type', { type: 'login' }],
    ['another purpose', { metadata: { purpose: 'x', client_id: 'client-a' } }],
    ['another client', { metadata: { purpose: 'guest_human_verification', client_id: 'b' } }],
    ['no metadata', { metadata: undefined }],
    ['another credential', { challenge: 'f'.repeat(64) }],
    ['a consumed proof', { consumed: true }],
    ['an expired proof', { expiresAt: Date.now() - 1 }],
  ])('verifies again for a proof with %s', async (_label, overrides) => {
    proof = await validProof(overrides);
    await request(undefined, { cookie: resumeCookie });
    expect(mocks.humanVerification).toHaveBeenCalledOnce();
  });

  it.each([
    ['off', []],
    ['on', ['signup']],
  ])('asks for the extra actions of lite mode %s', async (mode, extra) => {
    mocks.liteMode.mockResolvedValue(mode);
    await request({
      authorizationChallengeId: 'login-challenge',
      human_verification_response: 'r',
    });
    expect(mocks.humanVerification).toHaveBeenCalledWith(expect.anything(), 'login', 'r', extra);
  });

  it('stores the new proof for the credential until the challenge expires, at most five minutes', async () => {
    loginChallenge.expiresAt = Date.now() + 60_000;
    await request(undefined, { cookie: resumeCookie });
    expect(mocks.storeProof).toHaveBeenCalledWith({
      id: `guest-human:${await guestResumeHash(SECRET, 'tenant-a', 'login-challenge')}`,
      tenantId: 'tenant-a',
      type: 'anon_login',
      userId: '',
      challenge: await guestResumeHash(SECRET, 'tenant-a', 'client-a'),
      ttl: 60,
      metadata: { purpose: 'guest_human_verification', client_id: 'client-a' },
    });
  });
});

describe('guest account resolution', () => {
  it('provisions when the route is missing and records a new user', async () => {
    mocks.route.mockRejectedValue(new Error('account_data_route_not_found'));
    mocks.provision.mockResolvedValue({
      status: 'ready',
      userId: 'guest-a',
      accountId: 'account:guest-a',
    });
    expect((await request()).status).toBe(200);
    const login = (
      mocks.audit.mock.calls as Array<[unknown, { action: string; metadata: string }]>
    ).find((call) => call[1].action === 'user.login');
    expect(JSON.parse(login?.[1].metadata ?? '{}')).toEqual({
      method: 'guest',
      is_new_user: true,
      client_id: 'client-a',
    });
  });

  it.each([new Error('store_down'), 'account_data_route_not_found'])(
    'fails on another route lookup failure (%j) and keeps the minted resume cookie',
    async (failure) => {
      mocks.route.mockRejectedValue(failure);
      const response = await request();
      expect(await errorCode(response)).toBe(AR_ERROR_CODES.INTERNAL_ERROR);
      expect(mocks.provision).not.toHaveBeenCalled();
      expect(response.headers.get('set-cookie')).toContain(`${GUEST_RESUME_COOKIE}=`);
    }
  );

  it('fails when the provisioned account resolves to another route', async () => {
    mocks.route.mockResolvedValue(null);
    mocks.provision.mockResolvedValue({
      status: 'ready',
      userId: 'guest-a',
      accountId: 'account:x',
    });
    expect(await errorCode(await request())).toBe(AR_ERROR_CODES.INTERNAL_ERROR);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});

describe('guest resume credential checks', () => {
  const clearsResumeCookie = (response: Response) => {
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${GUEST_RESUME_COOKIE}=;`);
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
  };

  it('refuses an expired credential and clears the cookie', async () => {
    mocks.query.mockResolvedValue({
      id: 'resume-a',
      user_id: 'guest-a',
      expires_at: Date.now() - 1,
      created_at: Date.now() - 1000,
    });
    const response = await request(undefined, { cookie: resumeCookie });
    expect(response.status).toBe(401);
    clearsResumeCookie(response);
    expect(await response.json()).toEqual({
      error: 'invalid_guest_credential',
      error_description: 'The guest credential is no longer valid',
    });
  });

  it('accepts a credential that expires later', async () => {
    mocks.query.mockResolvedValue({
      id: 'resume-a',
      user_id: 'guest-a',
      expires_at: Date.now() + 60000,
      created_at: Date.now() - 1000,
    });
    expect((await request(undefined, { cookie: resumeCookie })).status).toBe(200);
  });

  it('refuses when the credential refresh loses a race and clears the cookie', async () => {
    mocks.execute.mockResolvedValue({ rowsAffected: 0 });
    const response = await request(undefined, { cookie: resumeCookie });
    expect(response.status).toBe(401);
    clearsResumeCookie(response);
    expect(await response.json()).toEqual({
      error: 'invalid_guest_credential',
      error_description: 'The guest credential is no longer valid',
    });
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it.each([
    [{ 'X-Forwarded-For': ' 198.51.100.1 , 10.0.0.1' }, '198.51.100.1'],
    [{ 'X-Real-IP': '203.0.113.9' }, '203.0.113.9'],
    [{}, 'unknown'],
  ])('audits the client address from %j', async (headers, ip) => {
    await request(undefined, { cookie: resumeCookie, ...headers });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'user.login', ipAddress: ip, userAgent: 'unknown' })
    );
  });
});
