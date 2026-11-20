import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock(
  '@simplewebauthn/server',
  async () => (await import('./helpers/mut-factor-passkey-harness')).pm.webauthn
);
vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
  (await import('./helpers/mut-factor-passkey-harness')).passkeyLibCoreMock(await importOriginal())
);
vi.mock('../account-provisioning', async (importOriginal) =>
  (await import('./helpers/mut-factor-passkey-harness')).passkeyProvisioningMock(
    await importOriginal()
  )
);
vi.mock('../lite-mode', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lite-mode')>()),
  readLiteMode: (await import('./helpers/mut-factor-passkey-harness')).pm.readLiteMode,
}));

import * as passkey from '../passkey';
import {
  passkeyApp,
  passkeyEnv,
  pm,
  resetPasskeyHarness,
  send,
} from './helpers/mut-factor-passkey-harness';
import { base64, callArg } from './helpers/mut-factor-call-arg';

const app = passkeyApp(passkey);
const METHODS_KEY = 'settings:tenant:default:authentication-methods';
const credentialId = 'Y3JlZC0x';
const body = {
  challengeId: 'ch-1',
  credential: { id: credentialId, response: { clientDataJSON: 'x' } },
};
const verify = (headers: Record<string, string> = {}, env = passkeyEnv()) =>
  send(app, 'https://login.example.com/login/verify', body, env, {
    origin: 'https://login.example.com',
    ...headers,
  });
const asAdmin = () =>
  pm.runtimeUsers.findAccountAuthenticationState.mockResolvedValue({
    userId: 'user-1',
    accountType: 'admin',
    lifecycle: 'active',
    sourceVersionMs: 1,
  });
const failureCodes = () =>
  pm.publishEvent.mock.calls
    .map((call) => (call[1] as { data: { errorCode?: string } }).data.errorCode)
    .filter(Boolean);

describe('passkey login verify: after the assertion', () => {
  beforeEach(() => {
    resetPasskeyHarness();
    pm.passkeyRepo.findByCredentialId.mockResolvedValue({
      id: 'pk-1',
      user_id: 'user-1',
      credential_id: credentialId,
      public_key: base64('k'),
      counter: 7,
    });
  });

  it('refuses an account with no authentication state', async () => {
    pm.runtimeUsers.findAccountAuthenticationState.mockResolvedValueOnce(null);
    const res = await verify();
    expect(res.body.error_code).toBe('AR000005');
    expect(pm.advanceState).not.toHaveBeenCalled();
  });

  it('answers 503 when the sign-in switch cannot be read', async () => {
    const res = await verify({}, passkeyEnv({ [METHODS_KEY]: '{broken' }));
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'Authentication settings are unavailable.',
    });
    expect(pm.advanceState).not.toHaveBeenCalled();
  });

  it('refuses a user when passkey sign-in is off', async () => {
    const off = passkeyEnv({
      [METHODS_KEY]: JSON.stringify({ 'authentication-methods.passkey.login_enabled': false }),
    });
    const res = await verify({}, off);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error_code: 'AR050006',
      authentication_method: 'passkey',
      usage: 'login',
    });
    expect(pm.advanceState).not.toHaveBeenCalled();
  });

  it('lets an administrator in whatever the end-user switch says', async () => {
    asAdmin();
    const off = passkeyEnv({ [METHODS_KEY]: '{broken' });
    const res = await verify({}, off);
    expect(res.status).toBe(200);
    expect(pm.assertGuestAllowed).not.toHaveBeenCalled();
  });

  it('checks guest accounts and advances the counter for a user', async () => {
    const res = await verify();
    expect(res.status).toBe(200);
    expect(pm.assertGuestAllowed).toHaveBeenCalledWith(pm.coreAdapter, 'default', 'user-1');
    expect(pm.advanceState).toHaveBeenCalledWith({
      tenantId: 'default',
      userId: 'user-1',
      credentialId: 'pk-1',
      storedCounter: 7,
      observedCounter: 8,
      observedAtMs: expect.any(Number) as number,
    });
  });

  it('answers 503 when the counter cannot be advanced', async () => {
    pm.advanceState.mockRejectedValueOnce(new Error('do unavailable'));
    const res = await verify();
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('1');
    expect(res.body).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'Authentication state unavailable.',
    });
    expect(failureCodes()).toEqual([]);
  });

  it.each([
    ['passkey_counter_replay', 'counter_replay'],
    ['account_authentication_not_allowed', 'user_inactive'],
  ])('answers a %s denial as a failed passkey', async (message, code) => {
    pm.advanceState.mockRejectedValueOnce(new Error(message));
    const res = await verify();
    expect(res.body.error_code).toBe('AR000005');
    expect(res.waitUntil).toHaveBeenCalledTimes(1);
    expect(pm.publishEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        data: { userId: 'user-1', method: 'passkey', clientId: 'passkey-auth', errorCode: code },
      })
    );
    expect(pm.sessionStore.createSessionRpc).not.toHaveBeenCalled();
  });

  it('refuses a user of a lite tenant', async () => {
    pm.readLiteMode.mockResolvedValue('on');
    const res = await verify({ Referer: 'https://login.example.com/admin/login' });
    expect(res.body.error_code).toBe('AR000005');
    expect(pm.sessionStore.createSessionRpc).not.toHaveBeenCalled();
  });

  it('lets an administrator of a lite tenant into the console', async () => {
    pm.readLiteMode.mockResolvedValue('on');
    asAdmin();
    const res = await verify({ Referer: 'https://login.example.com/admin/login' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toContain('authrim_admin_session=session-new');
  });

  it('gives an administrator outside the console an end-user session', async () => {
    pm.readLiteMode.mockResolvedValue('on');
    asAdmin();
    const lite = await verify({ Referer: 'https://login.example.com/login' });
    expect(lite.body.error_code).toBe('AR000005');
    pm.readLiteMode.mockResolvedValue('off');
    const res = await verify();
    expect(res.headers.get('Set-Cookie')).toContain('authrim_session=session-new');
    expect(res.headers.get('Set-Cookie')).not.toContain('authrim_admin_session');
  });

  it('makes the session and answers the user', async () => {
    const res = await verify({
      'X-Forwarded-For': '198.51.100.7, 10.0.0.1',
      'User-Agent': 'agent/1',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      verified: true,
      sessionId: 'session-new',
      userId: 'user-1',
      user: {
        id: 'user-1',
        email: 'person@example.com',
        name: 'Person',
        email_verified: 1,
        created_at: 'c',
        updated_at: 'u',
        last_login_at: null,
      },
    });
    const [, userId, , metadata] = pm.sessionStore.createSessionRpc.mock.calls[0] as [
      string,
      string,
      number,
      Record<string, unknown>,
    ];
    expect(userId).toBe('user-1');
    expect(metadata).toMatchObject({ amr: ['passkey'], acr: 'urn:mace:incommon:iap:bronze' });
    expect(pm.createAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        ipAddress: '198.51.100.7',
        userAgent: 'agent/1',
        metadata: JSON.stringify({ method: 'passkey', passkey_id: 'pk-1' }),
      })
    );
    await Promise.all(res.waitUntil.mock.calls.map((call) => call[0] as unknown));
    expect(pm.passkeyRepo.mirrorCounterAfterAuth).toHaveBeenCalledWith('pk-1', 8);
    expect(pm.runtimeUsers.touchLastLogin).toHaveBeenCalledWith('user-1');
  });

  it('answers a session store failure', async () => {
    pm.sessionStore.createSessionRpc.mockRejectedValueOnce(new Error('down'));
    const res = await verify();
    expect(res.status).toBe(500);
    expect(res.waitUntil).not.toHaveBeenCalled();
    expect(pm.publishEvent).not.toHaveBeenCalled();
  });

  it('records an administrator session in the admin database', async () => {
    asAdmin();
    const env = passkeyEnv({}, { DB_ADMIN: {} });
    const before = Date.now();
    const res = await verify(
      { 'CF-Connecting-IP': '203.0.113.5', 'User-Agent': 'console/2', Referer: 'https://x/admin' },
      env
    );
    expect(res.status).toBe(200);
    expect(pm.requireAdminAdapter).toHaveBeenCalledWith(env, 'passkey-admin');
    const created = callArg<Record<string, unknown> & { expires_at: number }>(
      pm.adminCreateSession,
      0,
      0
    );
    expect(created).toMatchObject({
      id: 'session-new',
      tenant_id: 'default',
      admin_user_id: 'user-1',
      ip_address: '203.0.113.5',
      user_agent: 'console/2',
      mfa_verified: true,
      passkey_credential_id: credentialId,
    });
    expect(created.expires_at).toBeGreaterThan(before);
    expect(pm.scheduleAdminAudit).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'default',
      action: 'admin.login',
      method: 'passkey',
      adminUserId: 'user-1',
      sessionId: 'session-new',
    });
  });

  it('takes the forwarded address and no agent when those are all there is', async () => {
    asAdmin();
    await verify({ 'X-Forwarded-For': '198.51.100.9' }, passkeyEnv({}, { DB_ADMIN: {} }));
    expect(pm.adminCreateSession.mock.calls[0][0]).toMatchObject({
      ip_address: '198.51.100.9',
      user_agent: undefined,
    });
  });

  it('still answers when the admin session cannot be recorded', async () => {
    asAdmin();
    pm.adminCreateSession.mockRejectedValueOnce(new Error('db down'));
    const res = await verify({}, passkeyEnv({}, { DB_ADMIN: {} }));
    expect(res.status).toBe(200);
    expect(pm.scheduleAdminAudit).not.toHaveBeenCalled();
  });

  it('answers a write fence as retryable', async () => {
    pm.runtimeUsers.findAccountAuthenticationState.mockRejectedValueOnce(
      new Error('tenant_placement_migration_write_fenced')
    );
    const res = await verify();
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('1');
    pm.runtimeUsers.findAccountAuthenticationState.mockRejectedValueOnce(new Error('boom'));
    const other = await verify();
    expect(other.body.error_code).toBe('AR900001');
  });
});
