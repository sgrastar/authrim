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
  overrides,
  postJson,
  resetHarness,
} from './helpers/mut-factor-totp-harness';
import { hex } from './helpers/mut-factor-call-arg';

const app = createTotpApp(totp);
const start = (body: unknown, env = createEnv()) => postJson(app, '/start', body, env);
const stored = () =>
  m.challengeStore.storeChallengeRpc.mock.calls[0]?.[0] as {
    id: string;
    userId: string;
    challenge: string;
    metadata: Record<string, unknown>;
  };
async function sha256(value: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return hex(hash);
}
const reauthChallenge = (extra: Record<string, unknown> = {}) => ({
  type: 'reauth',
  userId: 'user-001',
  tenantId: 'default',
  consumed: false,
  ...extra,
});

describe('TOTP login start: request shape and policy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHarness();
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    [{ identifier: 'a'.repeat(321) }],
    [{ identifier: 'person@example.com', authorization_challenge_id: 'ac-1' }],
    [{ authorization_challenge_id: 'a'.repeat(129) }],
    [{ authorization_challenge_id: '   ' }],
  ])('refuses %j as a required-field error', async (body) => {
    const res = await start(body);
    expect(res.status).toBe(400);
    expect(res.body.error_code).toBe('AR130001');
    expect(m.rateLimiter.incrementRpc).not.toHaveBeenCalled();
  });

  it('takes an identifier of 320 characters and lowercases it', async () => {
    const res = await start({ identifier: ` ${'A'.repeat(320)} ` });
    expect(res.status).toBe(200);
    expect(stored().challenge).toBe(await sha256('a'.repeat(320)));
  });

  it('takes an authorization challenge id of 128 characters', async () => {
    const id = 'c'.repeat(128);
    m.challengeStore.getChallengeRpc.mockResolvedValueOnce(reauthChallenge());
    const res = await start({ authorization_challenge_id: ` ${id} ` });
    expect(res.status).toBe(200);
    expect(m.challengeStore.getChallengeRpc).toHaveBeenCalledWith(id);
  });

  it('answers a disabled sign-in like a wrong code', async () => {
    const res = await start({ identifier: 'person@example.com' }, createEnv({}));
    expect(res.body.error_code).toBe('AR000006');
    expect(m.rateLimiter.incrementRpc).not.toHaveBeenCalled();
  });

  it('asks the reauth switch for a re-authentication', async () => {
    m.challengeStore.getChallengeRpc.mockResolvedValue(reauthChallenge());
    const loginOnly = createEnv({ 'authentication-methods.totp.login_enabled': true });
    const refused = await start({ authorization_challenge_id: 'ac-1' }, loginOnly);
    expect(refused.body.error_code).toBe('AR000006');
    const reauthOnly = createEnv({ 'authentication-methods.totp.reauth_enabled': true });
    const taken = await start({ authorization_challenge_id: 'ac-1' }, reauthOnly);
    expect(taken.status).toBe(200);
    expect(stored().metadata).toMatchObject({
      usage: 'reauth',
      authorization_challenge_id: 'ac-1',
    });
  });

  it.each([
    ['missing', null],
    ['not a reauth', reauthChallenge({ type: 'login' })],
    ['consumed', reauthChallenge({ consumed: true })],
    ['of another tenant', reauthChallenge({ tenantId: 'other' })],
    ['without a user', reauthChallenge({ userId: '' })],
    ['anonymous', reauthChallenge({ userId: 'anonymous' })],
    ['for an unknown user', reauthChallenge({ userId: 'unknown' })],
  ])('refuses a reauth challenge that is %s', async (_label, challenge) => {
    m.challengeStore.getChallengeRpc.mockResolvedValueOnce(challenge);
    const res = await start({ authorization_challenge_id: 'ac-1' });
    expect(res.body.error_code).toBe('AR000006');
    expect(m.rateLimiter.incrementRpc).not.toHaveBeenCalled();
  });

  it('binds a reauth start to the user of its challenge, read with inactive accounts', async () => {
    m.challengeStore.getChallengeRpc.mockResolvedValueOnce(
      reauthChallenge({ tenantId: undefined })
    );
    m.runtimeUsers.findById.mockResolvedValueOnce({ id: 'user-001', active: 1 });
    m.totpRepo.findActiveByUserId.mockResolvedValueOnce([{ id: 'totp-1' }, { id: 'totp-2' }]);
    const res = await start({ authorization_challenge_id: 'ac-1' });
    expect(res.status).toBe(200);
    expect(m.runtimeUsers.findById).toHaveBeenCalledWith('user-001', { includeInactive: true });
    expect(m.runtimeUsers.findByPreferredUsername).not.toHaveBeenCalled();
    expect(stored()).toMatchObject({
      userId: 'user-001',
      challenge: await sha256('reauth:ac-1'),
      metadata: { credential_count: 2, usage: 'reauth' },
    });
    expect(m.rateLimiter.incrementRpc).toHaveBeenCalledWith(
      `start:${await sha256('reauth:ac-1')}:${await sha256('203.0.113.10')}`,
      expect.anything()
    );
  });

  it('answers the retry time when rate limited', async () => {
    m.rateLimiter.incrementRpc.mockResolvedValueOnce({ allowed: false, retryAfter: 77 });
    const res = await start({ identifier: 'person@example.com' });
    expect(res.status).toBe(429);
    expect(res.body.error_description).toContain('77');
  });

  it('asks lite tenants for proof of work for the server-decided action', async () => {
    m.readLiteMode.mockResolvedValue('on');
    m.verifyHumanVerification.mockResolvedValueOnce(new Response('pow', { status: 403 }));
    const refused = await start({
      identifier: 'person@example.com',
      human_verification_response: 'p',
    });
    expect(refused.status).toBe(403);
    expect(m.verifyHumanVerification).toHaveBeenCalledWith(expect.anything(), 'login', 'p');
    expect(m.challengeStore.storeChallengeRpc).not.toHaveBeenCalled();
    const taken = await start({ identifier: 'person@example.com' });
    expect(taken.status).toBe(200);
  });

  it('skips proof of work outside lite mode', async () => {
    const res = await start({ identifier: 'person@example.com' });
    expect(res.status).toBe(200);
    expect(m.verifyHumanVerification).not.toHaveBeenCalled();
  });
});

describe('TOTP login start: who the challenge is for', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-23T00:00:00Z'));
    resetHarness();
  });
  afterEach(() => vi.useRealTimers());

  it('looks an address up as email, then username, then id', async () => {
    m.runtimeUsers.findById.mockResolvedValueOnce({ id: 'user-9', active: 1 });
    m.totpRepo.findActiveByUserId.mockResolvedValueOnce([{ id: 'totp-1' }]);
    const res = await start({ identifier: 'Person@Example.com' });
    expect(res.status).toBe(200);
    const opts = { includeInactive: true };
    expect(m.runtimeUsers.findByEmail).toHaveBeenCalledWith('person@example.com', opts);
    expect(m.runtimeUsers.findByPreferredUsername).toHaveBeenCalledWith('person@example.com', opts);
    expect(m.runtimeUsers.findById).toHaveBeenCalledWith('person@example.com', opts);
    expect(stored()).toMatchObject({
      id: `totp_login:${res.body.challenge_id as string}`,
      userId: 'user-9',
      metadata: {
        credential_count: 1,
        usage: 'login',
        issued_at: Date.now(),
        identifier_hash: await sha256('person@example.com'),
      },
    });
    expect(stored().metadata.authorization_challenge_id).toBeUndefined();
    expect(res.body.expires_in).toBe(300);
  });

  it('looks a username up as username, then id, never as email', async () => {
    m.runtimeUsers.findByPreferredUsername.mockResolvedValueOnce({ id: 'user-u', active: 1 });
    m.totpRepo.findActiveByUserId.mockResolvedValueOnce([{ id: 'totp-1' }]);
    await start({ identifier: 'Alice' });
    expect(m.runtimeUsers.findByEmail).not.toHaveBeenCalled();
    expect(m.runtimeUsers.findByPreferredUsername).toHaveBeenCalledWith('alice', {
      includeInactive: true,
    });
    expect(m.runtimeUsers.findById).not.toHaveBeenCalled();
    expect(stored().userId).toBe('user-u');

    resetHarness();
    m.runtimeUsers.findById.mockResolvedValueOnce({ id: 'user-id', active: 1 });
    m.totpRepo.findActiveByUserId.mockResolvedValueOnce([{ id: 'totp-1' }]);
    await start({ identifier: 'user-id' });
    expect(m.runtimeUsers.findById).toHaveBeenCalledWith('user-id', { includeInactive: true });
    expect(stored().userId).toBe('user-id');
  });

  it.each([
    ['an inactive account', { id: 'user-1', active: 0 }, [{ id: 't' }]],
    ['an account without an authenticator', { id: 'user-1', active: 1 }, []],
  ])('stores an unknown user for %s', async (_label, user, credentials) => {
    m.runtimeUsers.findByEmail.mockResolvedValueOnce(user);
    m.totpRepo.findActiveByUserId.mockResolvedValueOnce(credentials);
    const res = await start({ identifier: 'person@example.com' });
    expect(res.status).toBe(200);
    expect(stored().userId).toBe('unknown');
    if (user.active !== 1) expect(m.totpRepo.findActiveByUserId).not.toHaveBeenCalled();
  });

  it('stores an unknown user when the address has no account route', async () => {
    m.usesRoutedAccountStorage.mockReturnValue(true);
    m.resolveEmailAccountRoute.mockResolvedValueOnce('not_found');
    const res = await start({ identifier: 'person@example.com' });
    expect(res.status).toBe(200);
    expect(m.resolveEmailAccountRoute).toHaveBeenCalledWith(
      expect.anything(),
      'person@example.com'
    );
    expect(m.runtimeUsers.findByEmail).not.toHaveBeenCalled();
    expect(stored().userId).toBe('unknown');
  });

  it('looks a routed address up when it has a route', async () => {
    m.usesRoutedAccountStorage.mockReturnValue(true);
    m.resolveEmailAccountRoute.mockResolvedValueOnce('found');
    await start({ identifier: 'person@example.com' });
    expect(m.runtimeUsers.findByEmail).toHaveBeenCalled();
  });

  it('stores an unknown user for a reauth whose account route is gone', async () => {
    m.usesRoutedAccountStorage.mockReturnValue(true);
    m.challengeStore.getChallengeRpc.mockResolvedValueOnce(reauthChallenge());
    m.resolveAccountDataContext.mockRejectedValueOnce(new Error('account_data_route_not_found'));
    const res = await start({ authorization_challenge_id: 'ac-1' });
    expect(res.status).toBe(200);
    expect(m.resolveAccountDataContext).toHaveBeenCalledWith(expect.anything(), 'user-001');
    expect(m.runtimeUsers.findById).not.toHaveBeenCalled();
    expect(stored().userId).toBe('unknown');
  });

  it.each([[new Error('route store down')], ['account_data_route_not_found']])(
    'fails on any other route error for a reauth: %j',
    async (error) => {
      m.usesRoutedAccountStorage.mockReturnValue(true);
      m.challengeStore.getChallengeRpc.mockResolvedValueOnce(reauthChallenge());
      m.resolveAccountDataContext.mockRejectedValueOnce(error);
      const res = await start({ authorization_challenge_id: 'ac-1' });
      expect(res.status).toBe(500);
      expect(m.challengeStore.storeChallengeRpc).not.toHaveBeenCalled();
    }
  );

  it('reads a reauth account through its route when it has one', async () => {
    m.usesRoutedAccountStorage.mockReturnValue(true);
    m.challengeStore.getChallengeRpc.mockResolvedValueOnce(reauthChallenge());
    m.runtimeUsers.findById.mockResolvedValueOnce({ id: 'user-001', active: 1 });
    m.totpRepo.findActiveByUserId.mockResolvedValueOnce([{ id: 't' }]);
    await start({ authorization_challenge_id: 'ac-1' });
    expect(stored().userId).toBe('user-001');
  });

  it('answers 503 when the sign-in flow cannot be read', async () => {
    overrides.signInAttemptInteractionMetadata = async () => {
      throw new Error('flow down');
    };
    const res = await start({ identifier: 'person@example.com' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'The sign-in flow is unavailable.',
    });
    expect(m.challengeStore.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('answers a write fence as retryable and other failures as internal', async () => {
    m.challengeStore.storeChallengeRpc.mockRejectedValueOnce(
      new Error('tenant_placement_migration_write_fenced')
    );
    const fenced = await start({ identifier: 'person@example.com' }, createEnv(ENABLED));
    expect(fenced.status).toBe(503);
    expect(fenced.headers.get('Retry-After')).toBe('1');
    m.challengeStore.storeChallengeRpc.mockRejectedValueOnce(new Error('boom'));
    const failed = await start({ identifier: 'person@example.com' });
    expect(failed.body.error_code).toBe('AR900001');
  });
});
