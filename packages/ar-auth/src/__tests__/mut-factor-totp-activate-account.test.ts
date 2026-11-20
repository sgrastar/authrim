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
import { arrangeSignup } from './helpers/mut-factor-totp-fixtures';
import { callArg } from './helpers/mut-factor-call-arg';

const app = createTotpApp(totp);
const activate = (body: unknown, env = createEnv()) => postJson(app, '/activate', body, env);
const sync = () => m.runtimeUsers.syncUser.mock.calls[0]?.[0] as Record<string, unknown>;

describe('TOTP sign-up activation: the account it makes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-23T00:00:00Z'));
    resetHarness();
  });
  afterEach(() => vi.useRealTimers());

  it('creates the account with the sign-up name and an unverified address', async () => {
    const { code } = await arrangeSignup({ name: '  New   User ' });
    const res = await activate({ challenge_id: 'signup-challenge', code });
    expect(res.status).toBe(200);
    expect(sync()).toMatchObject({
      userId: 'user-signup-001',
      email: 'new@example.com',
      name: 'New User',
      active: true,
      emailVerified: false,
      userType: 'end_user',
      sourceRef: 'direct_auth_totp',
      customAttributesJson: JSON.stringify({ preferred_username: 'new' }),
    });
    expect(m.buildProfileFields).toHaveBeenCalledWith({
      email: 'new@example.com',
      'field.canonical.email': 'new@example.com',
      name: 'New User',
      'field.canonical.name': 'New User',
    });
  });

  it('leaves the name out when the sign-up had none', async () => {
    const { code } = await arrangeSignup({ name: null });
    await activate({ challenge_id: 'signup-challenge', code });
    expect(sync().name).toBeNull();
    expect(m.buildProfileFields).toHaveBeenCalledWith({
      email: 'new@example.com',
      'field.canonical.email': 'new@example.com',
    });
  });

  it('marks the address verified by an invitation or an earlier proof', async () => {
    const first = await arrangeSignup({ email_verified_by_invitation: true });
    await activate({ challenge_id: 'signup-challenge', code: first.code });
    expect(sync().emailVerified).toBe(true);

    resetHarness();
    const second = await arrangeSignup();
    m.runtimeUsers.findById.mockReset();
    m.runtimeUsers.findById
      .mockResolvedValueOnce({
        id: 'user-signup-001',
        active: 0,
        email_verified: 1,
        custom_attributes_json: '{"kept":true}',
      })
      .mockResolvedValue({ id: 'user-signup-001', email: 'new@example.com', active: 1 });
    await activate({ challenge_id: 'signup-challenge', code: second.code });
    expect(sync()).toMatchObject({ emailVerified: true, customAttributesJson: '{"kept":true}' });
  });

  it('does not sync an account that is already active', async () => {
    const { code } = await arrangeSignup();
    m.runtimeUsers.findById.mockReset();
    m.runtimeUsers.findById.mockResolvedValue({
      id: 'user-signup-001',
      email: 'new@example.com',
      active: 1,
    });
    const res = await activate({ challenge_id: 'signup-challenge', code });
    expect(res.status).toBe(200);
    expect(m.runtimeUsers.syncUser).not.toHaveBeenCalled();
  });

  it('answers an account that stays inactive as an expired session', async () => {
    const { code } = await arrangeSignup();
    m.runtimeUsers.findById.mockReset();
    m.runtimeUsers.findById.mockResolvedValue({ id: 'user-signup-001', active: 0 });
    const res = await activate({ challenge_id: 'signup-challenge', code });
    expect(res.body.error_code).toBe('AR000001');
    expect(m.totpRepo.activate).not.toHaveBeenCalled();
  });

  it('provisions a routed account and continues as the account it made', async () => {
    m.usesRoutedAccountStorage.mockReturnValue(true);
    const { code } = await arrangeSignup({ name: 'New User' });
    m.provisionAccount.mockResolvedValueOnce({
      status: 'created',
      userId: 'user-routed',
      accountId: 'account:routed',
    });
    m.runtimeUsers.findById.mockReset();
    m.runtimeUsers.findById
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: 'user-routed', email: 'new@example.com', active: 1 });
    const res = await activate({ challenge_id: 'signup-challenge', code });
    expect(res.status).toBe(200);
    expect(m.provisionAccount).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'default',
      candidateUserId: 'user-signup-001',
      flow: 'totp',
      email: 'new@example.com',
      runtimeUser: {
        active: true,
        emailVerified: false,
        userType: 'end_user',
        displayName: 'New User',
        sourceRef: 'auth:totp',
        piiFields: { email: true, name: true },
        sensitiveValues: { email: 'new@example.com', name: 'New User' },
        customAttributesJson: JSON.stringify({ preferred_username: 'new' }),
      },
    });
    expect(m.resolveAccountDataContext).toHaveBeenCalledWith(expect.anything(), 'account:routed');
    expect(m.runtimeUsers.syncUser).not.toHaveBeenCalled();
    expect(m.totpRepo.activate).toHaveBeenCalledWith(
      'cred-signup',
      'user-routed',
      expect.any(Number)
    );
  });

  it('leaves the name out of a routed account without one', async () => {
    m.usesRoutedAccountStorage.mockReturnValue(true);
    const { code } = await arrangeSignup({ name: undefined });
    m.provisionAccount.mockResolvedValueOnce({
      status: 'created',
      userId: 'user-signup-001',
      accountId: 'account:x',
    });
    await activate({ challenge_id: 'signup-challenge', code });
    const { runtimeUser } = callArg<{ runtimeUser: Record<string, unknown> }>(
      m.provisionAccount,
      0,
      1
    );
    expect(runtimeUser.piiFields).toEqual({ email: true });
    expect(runtimeUser.sensitiveValues).toEqual({ email: 'new@example.com' });
  });

  it('returns the pending answer of a routed account still being made', async () => {
    m.usesRoutedAccountStorage.mockReturnValue(true);
    const { code } = await arrangeSignup();
    m.provisionAccount.mockResolvedValueOnce({
      status: 'pending',
      response: new Response('pending', { status: 202 }),
    });
    const res = await activate({ challenge_id: 'signup-challenge', code });
    expect(res.status).toBe(202);
    expect(m.totpRepo.activate).not.toHaveBeenCalled();
  });
});

describe('TOTP sign-up activation: the credential', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-23T00:00:00Z'));
    resetHarness();
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    ['  Work phone  ', 'Work phone'],
    ['   ', 'Authenticator app'],
    [undefined, 'Authenticator app'],
  ])('creates the credential labelled %j as %j', async (label, expected) => {
    const { code } = await arrangeSignup({ label });
    await activate({ challenge_id: 'signup-challenge', code });
    expect(m.totpRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cred-signup', label: expected, status: 'pending' })
    );
  });

  it('reuses a pending credential that already exists', async () => {
    const { code, pending, timeStep } = await arrangeSignup();
    m.totpRepo.findById.mockResolvedValueOnce(pending);
    const res = await activate({ challenge_id: 'signup-challenge', code });
    expect(res.status).toBe(200);
    expect(m.totpRepo.create).not.toHaveBeenCalled();
    expect(m.totpRepo.activate).toHaveBeenCalledWith('cred-signup', 'user-signup-001', timeStep);
  });

  it.each([
    ['of another user', { user_id: 'someone-else' }],
    ['already active', { status: 'active' }],
  ])('refuses a stored credential %s', async (_label, change) => {
    const { code, pending } = await arrangeSignup();
    m.totpRepo.findById.mockResolvedValueOnce({ ...pending, ...change });
    const res = await activate({ challenge_id: 'signup-challenge', code });
    expect(res.status).toBe(400);
    expect(res.body.error_code).toBe('AR130003');
    expect(m.totpRepo.activate).not.toHaveBeenCalled();
  });

  it.each([
    ['nothing', null],
    ['a credential that is not active', { id: 'cred-signup', status: 'pending' }],
  ])('refuses when activation returns %s', async (_label, activated) => {
    const { code } = await arrangeSignup();
    m.totpRepo.activate.mockReset();
    m.totpRepo.activate.mockResolvedValueOnce(activated);
    const res = await activate({ challenge_id: 'signup-challenge', code });
    expect(res.body.error_code).toBe('AR130003');
    expect(m.challengeStore.deleteChallengeRpc).not.toHaveBeenCalled();
    expect(m.totpRepo.replaceBackupCodes).not.toHaveBeenCalled();
  });

  it('persists custom fields only when there are some', async () => {
    const first = await arrangeSignup({ custom_fields: { team: 'blue' } });
    await activate({ challenge_id: 'signup-challenge', code: first.code });
    expect(m.persistFields).toHaveBeenCalledWith(expect.anything(), 'default', 'user-signup-001', {
      team: 'blue',
    });
    resetHarness();
    const second = await arrangeSignup({ custom_fields: {} });
    await activate({ challenge_id: 'signup-challenge', code: second.code });
    expect(m.persistFields).not.toHaveBeenCalled();
  });

  it('applies the reserved invitation use to the new account', async () => {
    const { code } = await arrangeSignup({ invite_id: 'inv-1', invite_reservation_id: 'res-1' });
    const res = await activate({ challenge_id: 'signup-challenge', code });
    expect(res.status).toBe(200);
    const [deps, , input] = m.completeSignupInvitation.mock.calls[0] as [
      { invitations: () => unknown },
      unknown,
      unknown,
    ];
    expect(input).toEqual({
      reservation: { invite_id: 'inv-1', invite_reservation_id: 'res-1' },
      tenantId: 'default',
      userId: 'user-signup-001',
    });
    expect(typeof deps.invitations).toBe('function');
    expect(deps.invitations()).toBeDefined();
  });

  it('answers 503 when the session settings cannot be read', async () => {
    const { code } = await arrangeSignup({ session_profile_ref: 'strict' });
    const refs: unknown[] = [];
    overrides.sessionTtlForProfile = async (...args: unknown[]) => {
      refs.push(args[3]);
      throw new Error('settings down');
    };
    const res = await activate({ challenge_id: 'signup-challenge', code });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'Session settings are unavailable.',
    });
    expect(refs).toEqual(['strict']);
    expect(m.sessionStore.createSessionRpc).not.toHaveBeenCalled();
  });

  it('answers a write fence on the credential as retryable', async () => {
    const { code } = await arrangeSignup();
    m.totpRepo.create.mockReset();
    m.totpRepo.create.mockRejectedValueOnce(new Error('tenant_placement_migration_write_fenced'));
    const res = await activate({ challenge_id: 'signup-challenge', code }, createEnv(ENABLED));
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('1');
  });
});
