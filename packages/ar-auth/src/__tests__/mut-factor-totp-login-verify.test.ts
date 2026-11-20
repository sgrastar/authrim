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
import { credentialRow, currentCode, encryptedSecret } from './helpers/mut-factor-totp-fixtures';

const app = createTotpApp(totp);
const verify = (body: unknown, env = createEnv()) => postJson(app, '/verify', body, env);
const failureCodes = () =>
  m.publishEvent.mock.calls.map(
    (call) => (call[1] as { data: { errorCode?: string } }).data.errorCode
  );
function challenge(metadata: Record<string, unknown> = {}, userId = 'user-001') {
  m.challengeStore.consumeChallengeRpc.mockResolvedValueOnce({ userId, metadata });
}

describe('TOTP login verify: before the code is checked', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-23T00:00:00Z'));
    resetHarness();
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    [{ code: '123456' }],
    [{ challenge_id: 7, code: '123456' }],
    [{ challenge_id: 'c', code: 123456 }],
    [{ challenge_id: '  ', code: '123456' }],
  ])('requires a challenge and a code: %j', async (body) => {
    const res = await verify(body);
    expect(res.status).toBe(400);
    expect(res.body.error_code).toBe('AR130001');
    expect(m.challengeStore.consumeChallengeRpc).not.toHaveBeenCalled();
  });

  it.each([['12345'], ['1234567'], ['abcdef'], ['123456789']])(
    'answers the code %j as wrong without consuming the challenge',
    async (code) => {
      const res = await verify({ challenge_id: 'c', code });
      expect(res.body.error_code).toBe('AR000006');
      expect(m.challengeStore.consumeChallengeRpc).not.toHaveBeenCalled();
    }
  );

  it('consumes the challenge under its trimmed id', async () => {
    await verify({ challenge_id: ' c-1 ', code: '12345678' });
    expect(m.challengeStore.consumeChallengeRpc).toHaveBeenCalledWith({
      id: 'totp_login:c-1',
      tenantId: 'default',
      type: 'totp_login',
    });
  });

  it('answers a challenge store failure as a wrong code', async () => {
    m.challengeStore.consumeChallengeRpc.mockRejectedValueOnce(new Error('down'));
    const res = await verify({ challenge_id: 'c', code: '123456' });
    expect(res.body.error_code).toBe('AR000006');
    expect(failureCodes()).toEqual(['challenge_error']);
  });

  it('refuses a reauth challenge once re-authentication is switched off', async () => {
    challenge({ usage: 'reauth' });
    const res = await verify(
      { challenge_id: 'c', code: '123456' },
      createEnv({ 'authentication-methods.totp.login_enabled': true })
    );
    expect(res.body.error_code).toBe('AR000006');
    expect(m.totpRepo.findActiveByUserId).not.toHaveBeenCalled();
  });

  it('refuses a login challenge once sign-in is switched off', async () => {
    challenge({ usage: 'login' });
    const res = await verify(
      { challenge_id: 'c', code: '123456' },
      createEnv({ 'authentication-methods.totp.reauth_enabled': true })
    );
    expect(res.body.error_code).toBe('AR000006');
    expect(m.totpRepo.findActiveByUserId).not.toHaveBeenCalled();
  });

  it('refuses a code presented for another authorization challenge', async () => {
    challenge({ authorization_challenge_id: 'ac-1' });
    const res = await verify({
      challenge_id: 'c',
      code: '123456',
      authorization_challenge_id: 'ac-2',
    });
    expect(res.body.error_code).toBe('AR000006');
    expect(failureCodes()).toEqual(['authorization_challenge_mismatch']);
    expect(m.totpRepo.findActiveByUserId).not.toHaveBeenCalled();
  });

  it('accepts the bound authorization challenge presented with spaces', async () => {
    challenge({ authorization_challenge_id: 'ac-1' });
    await verify({ challenge_id: 'c', code: '123456', authorization_challenge_id: ' ac-1 ' });
    expect(failureCodes()).not.toContain('authorization_challenge_mismatch');
    expect(m.totpRepo.findActiveByUserId).toHaveBeenCalledWith('user-001');
  });

  it.each([['unknown'], [undefined]])('answers user %j as no credential', async (userId) => {
    m.challengeStore.consumeChallengeRpc.mockResolvedValueOnce({ userId, metadata: {} });
    const res = await verify({ challenge_id: 'c', code: '123456' });
    expect(res.body.error_code).toBe('AR000006');
    expect(failureCodes()).toEqual(['credential_not_found']);
  });

  it('fails closed without the encryption key', async () => {
    challenge();
    const res = await verify(
      { challenge_id: 'c', code: '123456' },
      createEnv(ENABLED, { PII_ENCRYPTION_KEY: '' })
    );
    expect(res.status).toBe(500);
    expect(m.totpRepo.findActiveByUserId).not.toHaveBeenCalled();
  });

  it('answers a routed account without a route as no credential', async () => {
    m.usesRoutedAccountStorage.mockReturnValue(true);
    challenge();
    m.resolveAccountDataContext.mockRejectedValueOnce(new Error('account_data_route_not_found'));
    const res = await verify({ challenge_id: 'c', code: '123456' });
    expect(res.body.error_code).toBe('AR000006');
    expect(failureCodes()).toEqual(['credential_not_found']);
  });

  it.each([[new Error('route store down')], [{ message: 'account_data_route_not_found' }]])(
    'fails on any other route error: %j',
    async (error) => {
      m.usesRoutedAccountStorage.mockReturnValue(true);
      challenge();
      m.resolveAccountDataContext.mockRejectedValueOnce(error);
      const res = await verify({ challenge_id: 'c', code: '123456' });
      expect(res.status).toBe(500);
      expect(failureCodes()).toEqual([]);
    }
  );

  it.each([
    ['no account state', null, [{ id: 'x' }]],
    ['no active authenticator', { lifecycle: 'active' }, []],
  ])('answers %s as no credential', async (_label, state, credentials) => {
    challenge();
    m.runtimeUsers.findAccountAuthenticationState.mockResolvedValueOnce(state);
    m.totpRepo.findActiveByUserId.mockResolvedValueOnce(credentials);
    const res = await verify({ challenge_id: 'c', code: '123456' });
    expect(res.body.error_code).toBe('AR000006');
    expect(failureCodes()).toEqual(['credential_not_found']);
  });
});

describe('TOTP login verify: the code and its time step', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-23T00:00:00Z'));
    resetHarness();
  });
  afterEach(() => vi.useRealTimers());

  it('tries each authenticator and takes the one the code is for', async () => {
    const mine = await encryptedSecret();
    const other = await encryptedSecret('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
    const { code, timeStep } = await currentCode();
    challenge();
    m.totpRepo.findActiveByUserId.mockResolvedValueOnce([
      credentialRow(other, { id: 'totp-other' }),
      credentialRow(mine, { id: 'totp-mine', last_used_time_step: timeStep - 3 }),
    ]);
    const res = await verify({ challenge_id: 'c', code });
    expect(res.status).toBe(200);
    expect(m.consumeTimeStep).toHaveBeenCalledTimes(1);
    expect(m.consumeTimeStep).toHaveBeenCalledWith({
      tenantId: 'default',
      userId: 'user-001',
      credentialId: 'totp-mine',
      storedLastUsedTimeStep: timeStep - 3,
      observedTimeStep: timeStep,
      observedAtMs: Date.now(),
    });
    expect(m.sessionStore.createSessionRpc.mock.calls[0][3]).toMatchObject({
      totp_credential_id: 'totp-mine',
      proven_at: Date.now(),
    });
    await Promise.all(res.waitUntil.mock.calls.map((call) => call[0] as unknown));
    expect(m.totpRepo.markUsed).toHaveBeenCalledWith('totp-mine', 'user-001', timeStep);
    expect(m.runtimeUsers.touchLastLogin).toHaveBeenCalledWith('user-001');
  });

  it('rejects a code already used for its time step', async () => {
    const { code, timeStep } = await currentCode();
    challenge();
    m.totpRepo.findActiveByUserId.mockResolvedValueOnce([
      credentialRow(await encryptedSecret(), { last_used_time_step: timeStep }),
    ]);
    const res = await verify({ challenge_id: 'c', code });
    expect(res.body.error_code).toBe('AR000006');
    expect(failureCodes()).toEqual(['invalid_code']);
    expect(m.consumeTimeStep).not.toHaveBeenCalled();
    expect(m.sessionStore.createSessionRpc).not.toHaveBeenCalled();
  });

  it('answers a replay the account state refuses as a wrong code', async () => {
    const { code } = await currentCode();
    challenge();
    m.totpRepo.findActiveByUserId.mockResolvedValueOnce([credentialRow(await encryptedSecret())]);
    m.consumeTimeStep.mockRejectedValueOnce(new Error('totp_time_step_replay'));
    const res = await verify({ challenge_id: 'c', code });
    expect(res.body.error_code).toBe('AR000006');
    expect(failureCodes()).toEqual(['replay_detected']);
    expect(m.sessionStore.createSessionRpc).not.toHaveBeenCalled();
  });

  it('refuses an account that is no longer active', async () => {
    const { code } = await currentCode();
    challenge();
    m.runtimeUsers.findAccountAuthenticationState.mockResolvedValueOnce({ lifecycle: 'suspended' });
    m.totpRepo.findActiveByUserId.mockResolvedValueOnce([credentialRow(await encryptedSecret())]);
    const res = await verify({ challenge_id: 'c', code });
    expect(res.body.error_code).toBe('AR000006');
    expect(failureCodes()).toEqual(['replay_detected']);
  });

  it('answers 503 when the authentication state cannot be written', async () => {
    const { code } = await currentCode();
    challenge();
    m.totpRepo.findActiveByUserId.mockResolvedValueOnce([credentialRow(await encryptedSecret())]);
    m.consumeTimeStep.mockRejectedValueOnce(new Error('do unavailable'));
    const res = await verify({ challenge_id: 'c', code });
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('1');
    expect(res.body).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'Authentication state unavailable.',
    });
    expect(failureCodes()).toEqual([]);
  });
});
