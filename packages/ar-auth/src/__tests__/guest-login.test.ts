import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
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
vi.mock('../session-ttl', () => ({ resolveSessionTtl: async () => ({ seconds: 3600 }) }));
import { guestLoginHandler, guestResumeHash } from '../guest-login';

function request(
  cookie?: string,
  body: Record<string, unknown> = { authorizationChallengeId: 'login-challenge' },
  origin = 'https://login.example.com'
) {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/api/auth/guest/login', guestLoginHandler);
  return app.request(
    '/api/auth/guest/login',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify(body),
    },
    {} as Env
  );
}

describe('browser guest login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.directClient.mockResolvedValue({ valid: true });
    mocks.humanVerification.mockResolvedValue(null);
    mocks.challenge.mockResolvedValue({
      type: 'login',
      tenantId: 'tenant-a',
      consumed: false,
      expiresAt: Date.now() + 60000,
      metadata: { client_id: 'client-a', scope: 'openid' },
    });
    mocks.settings.mockResolvedValue({
      loginEnabled: true,
      policy: { deletionAfterDays: null },
      policyVersion: 'v1',
    });
    mocks.contract.mockResolvedValue({
      guestAuth: { enabled: true, allowedScopes: ['openid'] },
    });
    mocks.route.mockResolvedValue({ legacyUserId: 'guest-a' });
    mocks.query.mockResolvedValue({
      id: 'resume-a',
      user_id: 'guest-a',
      expires_at: null,
      created_at: Date.now() - 1000,
    });
    mocks.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
    mocks.lifecycle.mockResolvedValue({
      phase: 'active',
      client_id: 'client-a',
      deletion_due_at: 1,
    });
    mocks.user.mockResolvedValue({ account_type: 'user', registration_state: 'guest' });
    mocks.getSession.mockResolvedValue(null);
    mocks.createSession.mockResolvedValue(undefined);
    mocks.audit.mockResolvedValue(undefined);
    mocks.publishEvent.mockResolvedValue(undefined);
  });
  it('creates a direct browser session using the validated client without an OAuth grant', async () => {
    const response = await request(undefined, { clientId: 'client-a' });
    expect(response.status).toBe(200);
    expect(mocks.directClient).toHaveBeenCalledWith(
      expect.anything(),
      'client-a',
      'browser',
      'https://login.example.com'
    );
    expect(mocks.contract).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.anything(),
      'tenant-a',
      'client-a'
    );
    expect(mocks.createSession).toHaveBeenCalledWith(
      'session-a',
      'guest-a',
      3600,
      expect.objectContaining({ client_id: 'client-a', is_guest_session: true }),
      'tenant-a'
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: 'tenant-a',
        userId: 'guest-a',
        action: 'user.login',
        resourceId: 'session-a',
      })
    );
    expect(mocks.publishEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'auth.login.succeeded',
        tenantId: 'tenant-a',
        data: expect.objectContaining({ userId: 'guest-a', method: 'guest' }),
      })
    );
    expect(await response.json()).toEqual({ success: true });
  });
  it('rejects direct requests without a browser origin before provisioning', async () => {
    expect((await request(undefined, { clientId: 'client-a' }, '')).status).toBe(403);
    expect(mocks.directClient).not.toHaveBeenCalled();
    expect(mocks.route).not.toHaveBeenCalled();
  });
  it('rejects a disallowed or cross-tenant direct client before provisioning', async () => {
    mocks.directClient.mockResolvedValue({
      valid: false,
      errorResponse: new Response(null, { status: 403 }),
    });
    expect((await request(undefined, { clientId: 'client-b' })).status).toBe(403);
    expect(mocks.contract).not.toHaveBeenCalled();
    expect(mocks.route).not.toHaveBeenCalled();
  });
  it.each([null, '', 1, 'expired-challenge'])(
    'never falls back to direct login for an invalid supplied challenge: %j',
    async (authorizationChallengeId) => {
      mocks.challenge.mockResolvedValue(null);
      expect(
        (await request(undefined, { clientId: 'client-a', authorizationChallengeId })).status
      ).toBeGreaterThanOrEqual(400);
      expect(mocks.directClient).not.toHaveBeenCalled();
      expect(mocks.route).not.toHaveBeenCalled();
    }
  );
  it('requires explicit openid permission for direct guest sessions', async () => {
    mocks.contract.mockResolvedValue({ guestAuth: { enabled: true, allowedScopes: [] } });
    expect((await request(undefined, { clientId: 'client-a', scope: 'email' })).status).toBe(400);
    expect(mocks.route).not.toHaveBeenCalled();
  });
  it('creates a session from a secret credential even after the deletion eligibility time', async () => {
    const response = await request(`authrim_guest_resume=${'a'.repeat(64)}`);
    expect(response.status).toBe(200);
    expect(mocks.route).toHaveBeenCalledWith(
      expect.anything(),
      await guestResumeHash('a'.repeat(64), 'tenant-a', 'client-a')
    );
    expect(mocks.createSession).toHaveBeenCalledWith(
      'session-a',
      'guest-a',
      3600,
      expect.objectContaining({
        is_guest_session: true,
        client_id: 'client-a',
        guest_resume_credential: true,
      }),
      'tenant-a'
    );
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.stringContaining('SET last_used_at = ?'),
      expect.arrayContaining(['tenant-a', 'guest-a'])
    );
    expect(await response.json()).toEqual({ success: true });
  });
  it.each([
    { type: 'reauth' },
    { tenantId: 'tenant-b' },
    { consumed: true },
    { expiresAt: 1 },
    { expiresAt: undefined },
    { metadata: { tenant_id: 'tenant-b', client_id: 'client-a' } },
  ])('rejects invalid authorization challenge before provisioning: %j', async (change) => {
    mocks.challenge.mockResolvedValue({ ...(await mocks.challenge()), ...change });
    expect((await request()).status).toBeGreaterThanOrEqual(400);
    expect(mocks.route).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
  it('does not provision or resume an account when human verification fails', async () => {
    mocks.humanVerification.mockResolvedValue(new Response('rejected', { status: 400 }));
    expect((await request()).status).toBe(400);
    expect(mocks.provision).not.toHaveBeenCalled();
    expect(mocks.route).not.toHaveBeenCalled();
  });
  it('reuses human verification only for the same private credential and transaction', async () => {
    const challenge = await mocks.challenge();
    const secret = 'a'.repeat(64);
    mocks.challenge.mockResolvedValueOnce(challenge).mockResolvedValueOnce({
      type: 'anon_login',
      tenantId: 'tenant-a',
      consumed: false,
      expiresAt: Date.now() + 10000,
      challenge: await guestResumeHash(secret, 'tenant-a', 'client-a'),
      metadata: { purpose: 'guest_human_verification', client_id: 'client-a' },
    });
    expect((await request(`authrim_guest_resume=${secret}`)).status).toBe(200);
    expect(mocks.humanVerification).not.toHaveBeenCalled();
  });
  it('requires both tenant and client permission', async () => {
    mocks.settings.mockResolvedValue({ loginEnabled: false });
    expect((await request()).status).toBeGreaterThanOrEqual(400);
    expect(mocks.route).not.toHaveBeenCalled();
    mocks.settings.mockResolvedValue({ loginEnabled: true });
    mocks.contract.mockResolvedValue({ guestAuth: { enabled: false } });
    expect((await request()).status).toBeGreaterThanOrEqual(400);
    expect(mocks.route).not.toHaveBeenCalled();
  });
  it('rejects scopes outside the anonymous allow-list', async () => {
    mocks.contract.mockResolvedValue({ guestAuth: { enabled: true, allowedScopes: [] } });
    expect((await request()).status).toBe(400);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
  it('does not replace a registered browser session', async () => {
    mocks.getSession.mockResolvedValue({
      expiresAt: Date.now() + 10000,
      data: { is_guest_session: false },
    });
    expect((await request('authrim_session=registered-session')).status).toBe(409);
    expect(mocks.route).not.toHaveBeenCalled();
  });
  it('does not authenticate with an expired or revoked resume credential', async () => {
    mocks.query.mockResolvedValue({ user_id: 'guest-a', created_at: 1 });
    const response = await request();
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mocks.query, JSON.stringify(await response.clone().json())).toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
  it('does not create a session when concurrent credential revocation wins', async () => {
    mocks.execute.mockResolvedValueOnce({ success: true, rowsAffected: 0 });
    const response = await request();
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
  it.each(['deleting', 'deleted', 'registered', 'upgrading'])('rejects %s state', async (phase) => {
    mocks.lifecycle.mockResolvedValue({ phase, client_id: 'client-a' });
    expect((await request()).status).toBeGreaterThanOrEqual(400);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
  it('does not publish a session cookie if deletion wins during session creation', async () => {
    mocks.lifecycle
      .mockResolvedValueOnce({ phase: 'active', client_id: 'client-a' })
      .mockResolvedValueOnce({ phase: 'deleting' });
    const response = await request();
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mocks.createSession, JSON.stringify(await response.clone().json())).toHaveBeenCalled();
    expect(response.headers.get('set-cookie') ?? '').not.toContain('authrim_session=');
    expect(mocks.invalidateSession).toHaveBeenCalledWith('session-a');
  });
  it('keeps the private resume credential across asynchronous provisioning', async () => {
    mocks.route.mockResolvedValue(null);
    mocks.provision.mockResolvedValue({
      status: 'pending',
      response: new Response(JSON.stringify({ status: 'pending' }), { status: 202 }),
    });
    const response = await request();
    expect(response.status).toBe(202);
    expect(response.headers.get('set-cookie')).toMatch(/authrim_guest_resume=[a-f0-9]{64}/);
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(mocks.provision).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        resumeCredential: expect.objectContaining({
          expiresInDays: 180,
          guestLifecycle: { clientId: 'client-a', deletionAfterDays: null, policyVersion: 'v1' },
        }),
      })
    );
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
  it('records a distinct audit event when it provisions a new browser guest', async () => {
    mocks.route.mockResolvedValue(null);
    mocks.provision.mockResolvedValue({
      status: 'ready',
      accountId: 'account:guest-a',
      userId: 'guest-a',
    });
    const response = await request();
    expect(response.status).toBe(200);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: 'tenant-a',
        userId: 'guest-a',
        action: 'account.guest.created',
        resource: 'user',
        resourceId: 'guest-a',
      })
    );
  });
  it('scopes secrets to each tenant and client', async () => {
    const secret = 'b'.repeat(64);
    const hashes = await Promise.all([
      guestResumeHash(secret, 'tenant-a', 'client-a'),
      guestResumeHash(secret, 'tenant-b', 'client-a'),
      guestResumeHash(secret, 'tenant-a', 'client-b'),
    ]);
    expect(new Set(hashes).size).toBe(3);
    await expect(guestResumeHash('device-id', 'tenant-a', 'client-a')).rejects.toThrow(
      'invalid_guest_resume_credential'
    );
  });
});
