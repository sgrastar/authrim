import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@authrim/ar-lib-core/services/log-iceberg-emitter', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core/services/log-iceberg-emitter')>()),
  emitLogIcebergRow: vi.fn(async () => ({})),
}));
vi.mock('@authrim/ar-lib-core', async (o) =>
  (await import('./helpers/mut-directory-login-harness')).coreMock(o as never)
);
vi.mock('../sign-in-attempt-recording', async (o) =>
  (await import('./helpers/mut-directory-login-harness')).localMocks().signInAttempt(o as never)
);
vi.mock('../flow-session-profile', async (o) =>
  (await import('./helpers/mut-directory-login-harness')).localMocks().flowSession(o as never)
);
vi.mock('../direct-auth', async (o) =>
  (await import('./helpers/mut-directory-login-harness')).localMocks().directAuth(o as never)
);
vi.mock('../human-verification', async (o) =>
  (await import('./helpers/mut-directory-login-harness')).localMocks().humanVerification(o as never)
);
vi.mock('../registration-policy-gate', async (o) =>
  (await import('./helpers/mut-directory-login-harness')).localMocks().registrationGate(o as never)
);
vi.mock('../account-provisioning', async (o) =>
  (await import('./helpers/mut-directory-login-harness'))
    .localMocks()
    .accountProvisioning(o as never)
);

import { InteractionChallengeMismatchError } from '@authrim/ar-lib-core';
import { createDirectoryPasswordLoginHandler } from '../directory-password-login';
import {
  WW_CONNECTOR,
  createContext,
  failedEvents,
  m,
  resetHarness,
  verdictFetcher,
} from './helpers/mut-directory-login-harness';

const creds = { username: 'alice', password: 'correct' };

async function login(
  body: Record<string, unknown> = creds,
  options: Parameters<typeof createContext>[1] = {}
) {
  const handler = createDirectoryPasswordLoginHandler(verdictFetcher());
  const response = await handler(createContext(body, options) as never);
  return {
    response,
    status: response.status,
    body: await response.json<Record<string, unknown>>(),
  };
}

const campaign = { id: 'damc_1', transaction_ttl_seconds: 600 };

beforeEach(() => resetHarness());

describe('directory password login: session creation', () => {
  it('creates a session with directory claims, cookies, events, and audit', async () => {
    m.sessionForChallenge.mockResolvedValue({
      allowed: true,
      interactionId: 'ix_1',
      profiled: {
        ttl: { seconds: 3600, milliseconds: 3_600_000 },
        snapshot: { session_profile: 'strict' },
      },
    });
    const before = Date.now();
    const { response, status, body } = await login();
    expect(status).toBe(200);
    const [sessionId, userId, ttl, meta, tenant] = m.sessionStore.createSessionRpc.mock
      .calls[0] as [string, string, number, Record<string, number>, string];
    expect([sessionId, userId, ttl, tenant]).toEqual(['sess_1', 'user_1', 3600, 'tenant-a']);
    expect(meta).toMatchObject({
      email: 'alice@example.com',
      name: 'Alice',
      amr: ['pwd', 'directory'],
      acr: 'urn:mace:incommon:iap:bronze',
      directory_connector_id: 'campus',
      wordwarden_connector_id: WW_CONNECTOR,
      runtime_interaction_id: 'ix_1',
      session_profile: 'strict',
    });
    expect(meta.proven_at).toBeGreaterThanOrEqual(before);
    expect(meta.authTime).toBe(Math.floor(meta.proven_at / 1000));

    expect(body).toEqual({
      ok: true,
      expires_in: 3600,
      session: {
        userId: 'user_1',
        createdAt: meta.proven_at,
        expiresAt: meta.proven_at + 3_600_000,
        authTime: meta.authTime,
        acr: 'urn:mace:incommon:iap:bronze',
        amr: ['pwd', 'directory'],
      },
      user: { id: 'user_1', email: 'alice@example.com', name: 'Alice' },
      redirect_url: '/account',
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    const cookies = response.headers.get('set-cookie') ?? '';
    expect(cookies).toMatch(/authrim_session=sess_1;[^,]*Max-Age=3600[^,]*HttpOnly[^,]*Secure/);
    expect(cookies).toContain('browser-state');

    const types = m.publishEvent.mock.calls.map((c) => (c[1] as { type: string }).type);
    expect(types).toEqual(['auth.directory_password.succeeded', 'session.user.created']);
    expect(m.publishEvent.mock.calls[0][1]).toMatchObject({
      data: {
        userId: 'user_1',
        method: 'directory_password',
        clientId: 'directory-password-auth',
        sessionId: 'sess_1',
        connectorId: 'campus',
      },
    });
    expect(m.publishEvent.mock.calls[1][1]).toMatchObject({
      data: { sessionId: 'sess_1', userId: 'user_1', ttlSeconds: 3600 },
    });
    const audit = m.createAuditLog.mock.calls[0][1] as Record<string, string>;
    expect(audit).toMatchObject({
      tenantId: 'tenant-a',
      userId: 'user_1',
      action: 'user.login',
      resource: 'session',
      resourceId: 'sess_1',
      ipAddress: '203.0.113.10',
      userAgent: 'Test Browser',
      severity: 'info',
    });
    expect(JSON.parse(audit.metadata)).toMatchObject({
      method: 'directory_password',
      connector_id: 'campus',
      wordwarden_connector_id: WW_CONNECTOR,
      transport: 'direct',
      directory_status: 'ok',
    });
    expect(m.failures).toEqual([]);
  });

  it('omits runtime_interaction_id without an interaction and uses the flow redirect', async () => {
    m.flowCompletionRedirect.mockResolvedValue('/flow-done');
    const { body } = await login();
    expect(m.sessionStore.createSessionRpc.mock.calls[0][3]).not.toHaveProperty(
      'runtime_interaction_id'
    );
    expect(body.redirect_url).toBe('/flow-done');
  });

  it('falls back to X-Forwarded-For, X-Real-IP, then unknown for the audit IP', async () => {
    await login(creds, {
      headers: { 'cf-connecting-ip': '', 'x-forwarded-for': '198.51.100.1, 10.0.0.1' },
    });
    await login(creds, { headers: { 'cf-connecting-ip': '', 'x-real-ip': '192.0.2.9' } });
    await login(creds, { headers: { 'cf-connecting-ip': '', 'user-agent': '' } });
    const ips = m.createAuditLog.mock.calls.map((c) => (c[1] as Record<string, string>).ipAddress);
    expect(ips).toEqual(['198.51.100.1', '192.0.2.9', 'unknown']);
    expect((m.createAuditLog.mock.calls[2][1] as Record<string, string>).userAgent).toBe('unknown');
  });

  it('does not set the Secure flag over http', async () => {
    const { response } = await login(creds, {
      url: 'http://localhost/api/auth/directory-password/login',
    });
    expect(response.headers.get('set-cookie')).not.toContain('Secure');
  });

  it('records service_unavailable with the user when session creation throws', async () => {
    m.sessionStore.createSessionRpc.mockRejectedValue(new Error('do down'));
    const handler = createDirectoryPasswordLoginHandler(verdictFetcher());
    await expect(handler(createContext(creds) as never)).rejects.toThrow('do down');
    expect(m.failures).toEqual([{ reason: 'service_unavailable', userId: 'user_1' }]);
  });
});

describe('directory password login: authorization continuation', () => {
  it('consumes the continuation and returns its redirect', async () => {
    const { body } = await login({ ...creds, authorization_challenge_id: ' ch_1 ' });
    const args = m.consumeContinuation.mock.calls[0];
    expect(args.slice(1, 4)).toEqual(['tenant-a', 'ch_1', 'user_1']);
    expect(args.slice(5, 7)).toEqual(['https://auth.example.com', 'directory_password']);
    expect(body.authorization).toEqual({ challenge_id: 'ch_1', type: 'login' });
    expect(body.redirect_url).toBe('https://rp.example/cb');
  });

  it('skips the continuation when deferred', async () => {
    const { body } = await login({
      ...creds,
      authorization_challenge_id: 'ch_1',
      defer_authorization_continuation: true,
    });
    expect(m.consumeContinuation).not.toHaveBeenCalled();
    expect(body.authorization).toBeUndefined();
    expect(body.redirect_url).toBe('/account');
  });

  it('returns a continuation error as a challenge mismatch', async () => {
    m.consumeContinuation.mockResolvedValue({
      error: Response.json({ error: 'bad_challenge' }, { status: 400 }),
    });
    const { status, body } = await login({ ...creds, authorization_challenge_id: 'ch_1' });
    expect([status, body]).toEqual([400, { error: 'bad_challenge' }]);
    expect(m.failures).toEqual([{ reason: 'challenge_mismatch', userId: 'user_1' }]);
    expect(m.sessionStore.createSessionRpc).not.toHaveBeenCalled();
  });
});

describe('directory password login: flow session and account state', () => {
  it('answers a flow interaction mismatch with 403', async () => {
    m.sessionForChallenge.mockRejectedValue(new InteractionChallengeMismatchError());
    const { status, body } = await login();
    expect(status).toBe(403);
    expect(body.error).toBe('authorization_challenge_mismatch');
    expect(m.failures).toEqual([{ reason: 'challenge_mismatch', userId: 'user_1' }]);
  });

  it('answers unreadable session settings with 503', async () => {
    m.sessionForChallenge.mockRejectedValue(new Error('kv'));
    const { status, body } = await login();
    expect([status, body]).toEqual([
      503,
      { error: 'temporarily_unavailable', error_description: 'Session settings are unavailable.' },
    ]);
    expect(m.failures[0].reason).toBe('service_unavailable');
  });

  it('refuses a flow that does not take directory passwords', async () => {
    m.sessionForChallenge.mockResolvedValue({ allowed: false, interactionId: null, profiled: {} });
    const { status, body } = await login();
    expect(status).toBe(403);
    expect(body).toMatchObject({ authentication_method: 'directory_password', usage: 'login' });
    expect(m.failures).toEqual([{ reason: 'method_disabled', userId: 'user_1' }]);
  });

  it('answers 503 with Retry-After when the account state cannot be read', async () => {
    m.ensureAuthState.mockRejectedValue(new Error('db'));
    const { response, status, body } = await login();
    expect([status, body]).toEqual([
      503,
      { error: 'temporarily_unavailable', error_description: 'Authentication state unavailable.' },
    ]);
    expect(response.headers.get('Retry-After')).toBe('1');
  });

  it.each([
    ['account_authentication_not_allowed', 'account_unavailable'],
    ['passkey_counter_replay', 'replay_detected'],
  ])('refuses an account denied with %s', async (message, reason) => {
    m.ensureAuthState.mockRejectedValue(new Error(message));
    const { status, body } = await login();
    expect(status).toBe(400);
    expect(body.error_code).toBeDefined();
    expect(m.failures).toEqual([{ reason, userId: 'user_1' }]);
    expect(m.sessionStore.createSessionRpc).not.toHaveBeenCalled();
  });
});

describe('directory password login: migration decisions', () => {
  it('blocks sign-in for a blocked migration without passkeys', async () => {
    m.migrationDecision.mockResolvedValue({ action: 'blocked', campaign });
    const { status, body } = await login();
    expect([status, body]).toEqual([403, { error: 'directory_migration_blocked' }]);
    expect(m.failures).toEqual([{ reason: 'migration_blocked', userId: 'user_1' }]);
    expect(failedEvents()[0]).toMatchObject({ errorCode: 'directory_migration_blocked' });
  });

  it('marks the user enrolled and signs in when a passkey already exists', async () => {
    m.passkeys.findByUserId.mockResolvedValue([{ id: 'pk' }]);
    m.migrationDecision.mockResolvedValue({
      action: 'prompt_passkey',
      campaign,
      userState: { state: 'prompted' },
      passkeyRequiredAt: 123,
    });
    const { status, body } = await login();
    expect(status).toBe(200);
    expect(body.migration).toBeUndefined();
    expect(m.markEnrolled).toHaveBeenCalledWith(
      m.coreAdapter,
      expect.objectContaining({
        tenantId: 'tenant-a',
        campaignId: 'damc_1',
        userId: 'user_1',
      })
    );
  });

  it('adds a passkey prompt to the session response', async () => {
    m.migrationDecision.mockResolvedValue({
      action: 'prompt_passkey',
      campaign,
      userState: { state: 'prompted' },
      passkeyRequiredAt: 123,
    });
    const { body } = await login();
    expect(body.migration).toEqual({
      required: false,
      action: 'prompt_passkey',
      campaign_id: 'damc_1',
      state: 'prompted',
      passkey_required_at: 123,
      transaction_ttl_seconds: 600,
    });
    expect(m.markEnrolled).not.toHaveBeenCalled();
  });

  it('does not query passkeys when no migration applies', async () => {
    await login();
    expect(m.passkeys.findByUserId).not.toHaveBeenCalled();
  });
});
