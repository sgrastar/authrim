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
import { arrangeSignup, currentCode } from './helpers/mut-factor-totp-fixtures';

const app = createTotpApp(totp);
const activate = (body: unknown, env = createEnv()) => postJson(app, '/activate', body, env);
const deletedRouteError = () =>
  Object.assign(new Error('lookup_destination_revalidation_failed'), { cause: 'account_inactive' });

describe('TOTP sign-up activation: what is checked before the code', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-23T00:00:00Z'));
    resetHarness();
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    [{ code: '123456' }],
    [{ challenge_id: '   ', code: '123456' }],
    [{ challenge_id: 'signup-challenge', code: '  ' }],
    [{ challenge_id: 'signup-challenge' }],
  ])('requires a challenge and a code: %j', async (body) => {
    const res = await activate(body);
    expect(res.status).toBe(400);
    expect(res.body.error_code).toBe('AR130001');
    expect(m.rateLimiter.incrementRpc).not.toHaveBeenCalled();
  });

  it('refuses when sign-up is off, before counting the attempt', async () => {
    const res = await activate(
      { challenge_id: 'signup-challenge', code: '123456' },
      createEnv({ 'authentication-methods.totp.login_enabled': true })
    );
    expect(res.body.error_code).toBe('AR050006');
    expect(m.rateLimiter.incrementRpc).not.toHaveBeenCalled();
  });

  it('counts attempts per challenge and client and answers the retry time', async () => {
    m.rateLimiter.incrementRpc.mockResolvedValueOnce({ allowed: false, retryAfter: 42 });
    const res = await activate({ challenge_id: ' signup-challenge ', code: '123456' });
    expect(res.status).toBe(429);
    expect(res.body.error_code).toBe('AR110001');
    expect(res.body.error_description).toContain('42');
    expect(m.rateLimiter.incrementRpc).toHaveBeenCalledWith(
      expect.stringMatching(/^signup-activate:[0-9a-f]{64}:[0-9a-f]{64}$/),
      expect.objectContaining({ maxRequests: expect.any(Number) as number })
    );
    expect(m.challengeStore.getChallengeRpc).not.toHaveBeenCalled();
  });

  it('reads the challenge under its trimmed id', async () => {
    await activate({ challenge_id: ' signup-challenge ', code: '123456' });
    expect(m.challengeStore.getChallengeRpc).toHaveBeenCalledWith('totp_signup:signup-challenge');
  });

  it.each([
    ['no challenge', null],
    ['no user', { challenge: 'signup-challenge', metadata: { credential_id: 'c' } }],
    ['no credential', { userId: 'u', challenge: 'signup-challenge', metadata: {} }],
    ['another challenge', { userId: 'u', challenge: 'other', metadata: { credential_id: 'c' } }],
  ])('answers %s as an expired session', async (_label, stored) => {
    m.challengeStore.getChallengeRpc.mockResolvedValueOnce(stored);
    const res = await activate({ challenge_id: 'signup-challenge', code: '123456' });
    expect(res.status).toBe(401);
    expect(res.body.error_code).toBe('AR000001');
  });

  it.each([
    ['an invalid email', { email: 'nope' }],
    ['no email', { email: 7 }],
    ['no encrypted secret', { secret_encrypted: undefined }],
    ['no key version', { secret_key_version: undefined }],
    ['no algorithm', { algorithm: undefined }],
    ['no digits', { digits: undefined }],
    ['no period', { period: undefined }],
    ['no window', { window: undefined }],
  ])('answers metadata with %s as an expired session', async (_label, metadata) => {
    const { code } = await arrangeSignup(metadata);
    const res = await activate({ challenge_id: 'signup-challenge', code });
    expect(res.body.error_code).toBe('AR000001');
    expect(m.checkEmailRegistration).not.toHaveBeenCalled();
  });

  it('refuses without the HMAC secret before checking the address', async () => {
    const { code } = await arrangeSignup();
    const res = await activate(
      { challenge_id: 'signup-challenge', code },
      createEnv(ENABLED, { OTP_HMAC_SECRET: '' })
    );
    expect(res.status).toBe(500);
    expect(m.checkEmailRegistration).not.toHaveBeenCalled();
  });

  it('fails when the registration check is unavailable', async () => {
    const { code } = await arrangeSignup();
    m.checkEmailRegistration.mockResolvedValueOnce('unavailable');
    const res = await activate({ challenge_id: 'signup-challenge', code });
    expect(res.body.error_code).toBe('AR900001');
    expect(m.resolveEmailAccountRoute).not.toHaveBeenCalled();
  });

  it('refuses an address deleted since the sign-up started, after the code', async () => {
    const { code } = await arrangeSignup();
    m.checkEmailRegistration.mockResolvedValueOnce('blocked');
    m.resolveEmailAccountRoute.mockRejectedValueOnce(deletedRouteError());
    const res = await activate({ challenge_id: 'signup-challenge', code });
    expect(res.status).toBe(409);
    expect(res.body.error_code).toBe('AR060005');
    expect(m.runtimeUsers.findById).not.toHaveBeenCalled();
    expect(m.totpRepo.activate).not.toHaveBeenCalled();
  });

  it('does not pass over a deleted-destination route for an open address', async () => {
    const { code } = await arrangeSignup();
    m.resolveEmailAccountRoute.mockRejectedValueOnce(deletedRouteError());
    const res = await activate({ challenge_id: 'signup-challenge', code });
    expect(res.status).toBe(500);
    expect(m.totpRepo.activate).not.toHaveBeenCalled();
  });

  it('rejects a wrong code and reports the failure', async () => {
    await arrangeSignup();
    const { code } = await currentCode(undefined, 5);
    const res = await activate({ challenge_id: 'signup-challenge', code });
    expect(res.status).toBe(400);
    expect(res.body.error_code).toBe('AR000006');
    expect(m.publishEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        data: expect.objectContaining({
          method: 'totp',
          errorCode: 'signup_invalid_code',
        }) as unknown,
      })
    );
    expect(m.runtimeUsers.findByEmail).not.toHaveBeenCalled();
  });

  it('refuses an address another account took meanwhile, and allows its own', async () => {
    const { code } = await arrangeSignup();
    m.runtimeUsers.findByEmail.mockResolvedValueOnce({ id: 'someone-else', active: 1 });
    const res = await activate({ challenge_id: 'signup-challenge', code });
    expect(res.body.error_code).toBe('AR060005');
    expect(m.runtimeUsers.findByEmail).toHaveBeenCalledWith('new@example.com', {
      includeInactive: true,
    });
    expect(m.runtimeUsers.findById).toHaveBeenCalledWith('user-signup-001', {
      includeInactive: true,
    });
  });

  it('allows the address of the account the sign-up itself holds', async () => {
    const { code } = await arrangeSignup();
    m.runtimeUsers.findByEmail.mockResolvedValueOnce({ id: 'user-signup-001', active: 0 });
    const own = await activate({ challenge_id: 'signup-challenge', code });
    expect(own.body).toMatchObject({ success: true });
  });
});
