import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
const mocks = vi.hoisted(() => ({
  challenge: vi.fn(),
  humanVerification: vi.fn(),
  storeProof: vi.fn(),
  settings: vi.fn(),
  contract: vi.fn(),
  route: vi.fn(),
  provision: vi.fn(),
  query: vi.fn(),
  lifecycle: vi.fn(),
  user: vi.fn(),
  createSession: vi.fn(),
  invalidateSession: vi.fn(),
  getSession: vi.fn(),
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
  createAccountAuthContextFromHono: () => ({ coreAdapter: { queryOne: mocks.query } }),
  createPIIContextFromHono: () => ({ defaultPiiAdapter: {} }),
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
}));
vi.mock('../account-provisioning', () => ({
  provisionAnonymousAccount: mocks.provision,
  resolveAnonymousAccountRoute: mocks.route,
}));
vi.mock('../human-verification', () => ({
  verifyHumanVerificationForAction: mocks.humanVerification,
}));
vi.mock('../session-ttl', () => ({ resolveSessionTtl: async () => ({ seconds: 3600 }) }));
import { guestLoginHandler, guestResumeHash } from '../guest-login';

function request(cookie?: string) {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/api/auth/guest/login', guestLoginHandler);
  return app.request(
    '/api/auth/guest/login',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ authorizationChallengeId: 'login-challenge' }),
    },
    {} as Env
  );
}

describe('browser guest login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      anonymousAuth: { enabled: true, allowedScopes: ['openid'] },
    });
    mocks.route.mockResolvedValue({ legacyUserId: 'guest-a' });
    mocks.query.mockResolvedValue({ user_id: 'guest-a', created_at: Date.now() - 1000 });
    mocks.lifecycle.mockResolvedValue({
      phase: 'active',
      client_id: 'client-a',
      deletion_due_at: 1,
    });
    mocks.user.mockResolvedValue({ account_type: 'anonymous' });
    mocks.getSession.mockResolvedValue(null);
    mocks.createSession.mockResolvedValue(undefined);
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
        is_anonymous: true,
        client_id: 'client-a',
        guest_resume_credential: true,
      }),
      'tenant-a'
    );
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
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
    mocks.contract.mockResolvedValue({ anonymousAuth: { enabled: false } });
    expect((await request()).status).toBeGreaterThanOrEqual(400);
    expect(mocks.route).not.toHaveBeenCalled();
  });
  it('rejects scopes outside the anonymous allow-list', async () => {
    mocks.contract.mockResolvedValue({ anonymousAuth: { enabled: true, allowedScopes: [] } });
    expect((await request()).status).toBe(400);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
  it('does not replace a registered browser session', async () => {
    mocks.getSession.mockResolvedValue({
      expiresAt: Date.now() + 10000,
      data: { is_anonymous: false },
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
        device: expect.objectContaining({
          expiresInDays: null,
          guestLifecycle: { clientId: 'client-a', deletionAfterDays: null, policyVersion: 'v1' },
        }),
      })
    );
    expect(mocks.createSession).not.toHaveBeenCalled();
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
