import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
  (await import('./helpers/mut-factor-totp-harness')).libCoreMock(await importOriginal())
);
vi.mock('../registration-policy-gate', async (importOriginal) =>
  (await import('./helpers/mut-factor-totp-harness')).registrationGateMock(await importOriginal())
);
vi.mock('../flow-session-profile', async (importOriginal) =>
  (await import('./helpers/mut-factor-totp-harness')).flowSessionMock(await importOriginal())
);
vi.mock('../sign-in-attempt-recording', async (importOriginal) =>
  (await import('./helpers/mut-factor-totp-harness')).attemptRecordingMock(await importOriginal())
);
vi.mock('../account-provisioning', async (importOriginal) =>
  (await import('./helpers/mut-factor-totp-harness')).accountProvisioningMock(
    await importOriginal()
  )
);
vi.mock('../invitation-redemption', async (importOriginal) =>
  (await import('./helpers/mut-factor-totp-harness')).invitationMock(await importOriginal())
);
vi.mock('../direct-auth', async () => ({
  consumeAuthorizationChallengeContinuation: (await import('./helpers/mut-factor-totp-harness')).m
    .consumeContinuation,
}));
vi.mock('../human-verification', async () => ({
  verifyHumanVerificationForAction: (await import('./helpers/mut-factor-totp-harness')).m
    .verifyHumanVerification,
}));
vi.mock('../lite-mode', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lite-mode')>()),
  readLiteMode: (await import('./helpers/mut-factor-totp-harness')).m.readLiteMode,
}));
vi.mock('../registration-field-utils', async (importOriginal) => {
  const { m } = await import('./helpers/mut-factor-totp-harness');
  return {
    ...(await importOriginal<typeof import('../registration-field-utils')>()),
    validateRegistrationFieldSubmissionFromEnv: m.validateFields,
    persistRegistrationFieldValuesFromEnv: m.persistFields,
    buildCanonicalProfileRuntimeUserFields: m.buildProfileFields,
  };
});

import * as totp from '../totp';
import {
  ENABLED,
  createEnv,
  createTotpApp,
  m,
  postJson,
  resetHarness,
} from './helpers/mut-factor-totp-harness';
import { arrangeSignup } from './helpers/mut-factor-totp-fixtures';

const app = createTotpApp(totp);
const activate = (body: unknown, env = createEnv()) => postJson(app, '/activate', body, env);
const sessionMetadata = () =>
  m.sessionStore.createSessionRpc.mock.calls[0]?.[3] as Record<string, unknown>;

describe('TOTP sign-up activation: the session it makes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-23T00:00:00Z'));
    resetHarness();
  });
  afterEach(() => vi.useRealTimers());

  it('makes an otp/totp session and answers the credential and backup codes', async () => {
    const { code } = await arrangeSignup();
    const res = await activate({ challenge_id: 'signup-challenge', code });
    const now = Date.now();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      success: true,
      sessionId: 'g1:apac:3:session_new',
      credential: { id: 'cred-signup', status: 'active', label: 'Authenticator app' },
      session: {
        userId: 'user-signup-001',
        acr: 'urn:authrim:aal:2',
        amr: ['otp', 'totp'],
        authTime: Math.floor(now / 1000),
      },
      user: { id: 'user-signup-001', email: 'new@example.com' },
      redirect_url: '/',
    });
    expect(res.body).not.toHaveProperty('authorization');
    expect((res.body.backup_codes as string[]).length).toBe(10);
    expect(m.sessionStore.createSessionRpc).toHaveBeenCalledWith(
      'g1:apac:3:session_new',
      'user-signup-001',
      res.body.expires_in,
      expect.objectContaining({
        amr: ['otp', 'totp'],
        acr: 'urn:authrim:aal:2',
        proven_at: now,
        totp_credential_id: 'cred-signup',
      }),
      'default'
    );
    expect(sessionMetadata()).not.toHaveProperty('runtime_interaction_id');
    expect(m.challengeStore.deleteChallengeRpc).toHaveBeenCalledWith(
      'totp_signup:signup-challenge'
    );
    expect(m.runtimeUsers.touchLastLogin).toHaveBeenCalledWith('user-signup-001');
    expect(m.publishEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-signup-001',
          clientId: 'totp-signup',
          sessionId: 'g1:apac:3:session_new',
        }) as unknown,
      })
    );
    expect(m.createAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'user-signup-001',
        action: 'user.login',
        resourceId: 'g1:apac:3:session_new',
        ipAddress: '203.0.113.10',
        metadata: JSON.stringify({ method: 'totp', credential_id: 'cred-signup', signup: true }),
      })
    );
    const cookies = res.headers.get('Set-Cookie') ?? '';
    expect(cookies).toContain(
      `authrim_session=${encodeURIComponent('g1:apac:3:session_new')}; Max-Age=${String(res.body.expires_in)}; Path=/; HttpOnly; Secure`
    );
    expect(cookies).toMatch(/authrim_browser_state=[^;]+; Max-Age=\d+; Path=\/; Secure/);
  });

  it.each([
    ['  urn:example:acr  ', 'urn:example:acr'],
    ['   ', 'urn:authrim:aal:2'],
    [5, 'urn:authrim:aal:2'],
  ])('uses the tenant default ACR %j as %j', async (acr, expected) => {
    const { code } = await arrangeSignup();
    const res = await activate(
      { challenge_id: 'signup-challenge', code },
      createEnv({ ...ENABLED, 'authentication-methods.totp.default_acr': acr })
    );
    expect(sessionMetadata().acr).toBe(expected);
    expect((res.body.session as { acr: string }).acr).toBe(expected);
  });

  it('keeps the registration interaction on the session', async () => {
    const { code } = await arrangeSignup({ runtime_interaction_id: 'int-7' });
    await activate({ challenge_id: 'signup-challenge', code });
    expect(sessionMetadata().runtime_interaction_id).toBe('int-7');
  });

  it('continues the authorization challenge the sign-up was started for', async () => {
    const { code } = await arrangeSignup({ authorization_challenge_id: 'ac-1' });
    const res = await activate({ challenge_id: 'signup-challenge', code });
    expect(m.consumeContinuation).toHaveBeenCalledWith(
      expect.anything(),
      'default',
      'ac-1',
      'user-signup-001',
      Math.floor(Date.now() / 1000),
      'http://localhost',
      'totp',
      Date.now()
    );
    expect(res.body).toMatchObject({
      authorization: { challenge_id: 'ac-1', type: 'login' },
      redirect_url: 'https://rp.example.com/callback?code=abc',
    });
    expect(m.resolvePostLoginRedirectUrl).not.toHaveBeenCalled();
  });

  it('returns the continuation error without making a session', async () => {
    const { code } = await arrangeSignup({ authorization_challenge_id: 'ac-1' });
    m.consumeContinuation.mockResolvedValueOnce({
      error: new Response('gone', { status: 410 }),
    });
    const res = await activate({ challenge_id: 'signup-challenge', code });
    expect(res.status).toBe(410);
    expect(m.sessionStore.createSessionRpc).not.toHaveBeenCalled();
  });

  it('defers the continuation when asked to', async () => {
    const { code } = await arrangeSignup({ authorization_challenge_id: 'ac-1' });
    const res = await activate({
      challenge_id: 'signup-challenge',
      code,
      defer_authorization_continuation: true,
    });
    expect(res.status).toBe(200);
    expect(m.consumeContinuation).not.toHaveBeenCalled();
    expect(res.body).not.toHaveProperty('authorization');
    expect(res.body.redirect_url).toBe('/');
  });

  it('does not defer for a truthy value that is not true', async () => {
    const { code } = await arrangeSignup({ authorization_challenge_id: 'ac-1' });
    await activate({
      challenge_id: 'signup-challenge',
      code,
      defer_authorization_continuation: 'true',
    });
    expect(m.consumeContinuation).toHaveBeenCalledTimes(1);
  });

  it('still answers when the challenge cannot be deleted or the timestamp fails', async () => {
    const { code } = await arrangeSignup();
    m.challengeStore.deleteChallengeRpc.mockRejectedValueOnce(new Error('down'));
    m.runtimeUsers.touchLastLogin.mockRejectedValueOnce(new Error('down'));
    m.publishEvent.mockRejectedValue(new Error('down'));
    m.createAuditLog.mockRejectedValueOnce(new Error('down'));
    const res = await activate({ challenge_id: 'signup-challenge', code });
    expect(res.status).toBe(200);
    expect(res.waitUntil).toHaveBeenCalledTimes(1);
    await expect(res.waitUntil.mock.calls[0][0]).resolves.toBeUndefined();
  });
});
