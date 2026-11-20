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
import { NO_POLICY, type SignUpPolicy } from '../registration-policy-gate';
import {
  createEnv,
  createTotpApp,
  m,
  overrides,
  postJson,
} from './helpers/mut-factor-totp-harness';
import { resetHarness } from './helpers/mut-factor-totp-harness';

const app = createTotpApp(totp);
const options = (body: unknown, env = createEnv(), headers: Record<string, string> = {}) =>
  postJson(app, '/options', body, env, headers);
const stored = () =>
  m.challengeStore.storeChallengeRpc.mock.calls[0]?.[0] as {
    id: string;
    challenge: string;
    metadata: Record<string, unknown>;
  };
const flowPolicy = (
  policy: Partial<SignUpPolicy['policy']>,
  extra: Partial<SignUpPolicy> = {}
): SignUpPolicy => ({
  ...NO_POLICY,
  policy: { ...NO_POLICY.policy, ...policy },
  fromFlow: true,
  source: 'tenant',
  ...extra,
});

describe('TOTP sign-up options: request validation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHarness();
  });
  afterEach(() => vi.useRealTimers());

  it.each([[''], [42], [null]])(
    'refuses an invite_token of %j as an invalid value',
    async (tok) => {
      const res = await options({ email: 'a@example.com', invite_token: tok });
      expect(res.status).toBe(400);
      expect(res.body.error_code).toBe('AR130003');
      expect(m.challengeStore.storeChallengeRpc).not.toHaveBeenCalled();
    }
  );

  it.each([['not-an-email'], ['a b@example.com'], [17]])(
    'refuses the email %j as an invalid format',
    async (email) => {
      const res = await options({ email });
      expect(res.body.error_code).toBe('AR130002');
      expect(m.challengeStore.storeChallengeRpc).not.toHaveBeenCalled();
    }
  );

  it('takes a label of exactly 100 characters and refuses 101', async () => {
    const ok = await options({ email: 'a@example.com', label: 'x'.repeat(100) });
    expect(ok.status).toBe(201);
    expect(stored().metadata.label).toBe('x'.repeat(100));
    const tooLong = await options({ email: 'a@example.com', label: 'y'.repeat(101) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error_code).toBe('AR130003');
  });

  it('collapses whitespace in the label and the display name', async () => {
    const res = await options({
      email: '  Mixed@Example.com ',
      label: '  Work \n\t phone  ',
      name: '  New \t  User ',
    });
    expect(res.status).toBe(201);
    expect(stored().metadata).toMatchObject({
      email: 'mixed@example.com',
      label: 'Work phone',
      name: 'New User',
    });
    expect((res.body.credential as { label: string }).label).toBe('Work phone');
    expect(m.validateFields).toHaveBeenCalledWith(expect.anything(), 'default', {
      email: 'mixed@example.com',
      'field.canonical.email': 'mixed@example.com',
      name: 'New User',
      'field.canonical.name': 'New User',
    });
  });

  it.each([[undefined], [null], [7], ['   ']])(
    'labels the credential "Authenticator app" for a label of %j',
    async (label) => {
      const res = await options({ email: 'a@example.com', label, name: '   ' });
      expect(res.status).toBe(201);
      expect(stored().metadata.label).toBe('Authenticator app');
      expect(stored().metadata.name).toBeNull();
      expect(m.validateFields.mock.calls[0][2]).toEqual({
        email: 'a@example.com',
        'field.canonical.email': 'a@example.com',
      });
    }
  );

  it('passes object custom fields on and drops arrays and scalars', async () => {
    await options({ email: 'a@example.com', custom_fields: { team: 'blue' } });
    expect(m.validateFields.mock.calls[0][2]).toMatchObject({ team: 'blue' });
    for (const custom of [['team'], 'team', null]) {
      m.validateFields.mockClear();
      await options({ email: 'a@example.com', custom_fields: custom });
      expect(Object.keys(m.validateFields.mock.calls[0][2] as object).sort()).toEqual([
        'email',
        'field.canonical.email',
      ]);
    }
  });
});

describe('TOTP sign-up options: settings and gates', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHarness();
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    ['nothing stored', null],
    ['a JSON array', '[true]'],
    ['unparseable JSON', '{not json'],
    [
      'signup switched off by a string',
      { 'authentication-methods.totp.signup_enabled': ' FALSE ' },
    ],
    [
      'signup off while the legacy switch is on',
      {
        'authentication-methods.totp.enabled': true,
        'authentication-methods.totp.signup_enabled': 'false',
      },
    ],
    ['an unrecognised string', { 'authentication-methods.totp.signup_enabled': 'yes' }],
  ])('refuses sign-up when %s', async (_label, methods) => {
    const res = await options({ email: 'a@example.com' }, createEnv(methods));
    expect(res.status).toBe(403);
    expect(res.body.error_code).toBe('AR050006');
    expect(m.verifyHumanVerification).not.toHaveBeenCalled();
  });

  it.each([
    ['a string true', { 'authentication-methods.totp.signup_enabled': ' True ' }],
    ['the legacy switch alone', { 'authentication-methods.totp.enabled': 'true' }],
  ])('allows sign-up when %s', async (_label, methods) => {
    const res = await options({ email: 'a@example.com' }, createEnv(methods));
    expect(res.status).toBe(201);
  });

  it('checks the human-verification token it was given, preferring the generic field', async () => {
    await options({
      email: 'a@example.com',
      human_verification_response: 'hv-token',
      cf_turnstile_response: 'cf-token',
    });
    expect(m.verifyHumanVerification).toHaveBeenLastCalledWith(
      expect.anything(),
      'signup',
      'hv-token'
    );
    await options({ email: 'a@example.com', cf_turnstile_response: 'cf-token' });
    expect(m.verifyHumanVerification).toHaveBeenLastCalledWith(
      expect.anything(),
      'signup',
      'cf-token'
    );
    await options({ email: 'a@example.com', human_verification_response: 5 });
    expect(m.verifyHumanVerification).toHaveBeenLastCalledWith(
      expect.anything(),
      'signup',
      undefined
    );
  });

  it('returns the human-verification refusal before generating a seed', async () => {
    m.verifyHumanVerification.mockResolvedValueOnce(new Response('hv', { status: 418 }));
    const res = await options({ email: 'a@example.com' });
    expect(res.status).toBe(418);
    expect(m.challengeStore.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('returns the refusal for a named interaction that was not started for it', async () => {
    const seen: unknown[] = [];
    overrides.namedInteractionChallengeRefusal = async (...args: unknown[]) => {
      seen.push(args[3]);
      return new Response('mismatch', { status: 409 });
    };
    const res = await options({ email: 'a@example.com', authorization_challenge_id: 'ac-1' });
    expect(res.status).toBe(409);
    expect(seen).toEqual(['ac-1']);
    await options({ email: 'a@example.com', authorization_challenge_id: 3 });
    expect(seen).toEqual(['ac-1', null]);
    expect(m.challengeStore.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('asks for an invitation under an invite-only Flow and takes one that is given', async () => {
    overrides.signUpPolicyFor = async () => flowPolicy({ eligibility: 'invite' });
    const refused = await options({ email: 'a@example.com' });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(m.startSignupInvitation).not.toHaveBeenCalled();
    m.startSignupInvitation.mockResolvedValueOnce({
      ok: true,
      reservation: { invite_id: 'inv-1', invite_reservation_id: 'res-1' },
      emailVerified: true,
    });
    const taken = await options({ email: 'a@example.com', invite_token: 'tok' });
    expect(taken.status).toBe(201);
    expect(stored().metadata).toMatchObject({
      invite_id: 'inv-1',
      invite_reservation_id: 'res-1',
      email_verified_by_invitation: true,
    });
  });

  it('refuses when the Flow profile does not take TOTP sign-up', async () => {
    overrides.profileAllowsSignUp = async () => false;
    const res = await options({ email: 'a@example.com' });
    expect(res.status).toBe(403);
    expect(res.body.error_code).toBe('AR050006');
    expect(m.validateFields).not.toHaveBeenCalled();
  });

  it('refuses a Flow that checks the address first', async () => {
    overrides.signUpPolicyFor = async () => flowPolicy({ email_check: 'before' });
    const res = await options({ email: 'a@example.com' });
    expect(res.status).toBe(403);
    expect(res.body.error_code).toBe('AR050006');
    expect(JSON.stringify(res.body)).toContain('signup_email_check_required');
    expect(m.validateFields).not.toHaveBeenCalled();
  });

  it('does not refuse email_check before outside a Flow', async () => {
    overrides.signUpPolicyFor = async () => ({
      ...flowPolicy({ email_check: 'before' }),
      fromFlow: false,
    });
    const res = await options({ email: 'a@example.com' });
    expect(res.status).toBe(201);
  });

  it('stores the Flow session profile and interaction it was started in', async () => {
    overrides.signUpPolicyFor = async () =>
      flowPolicy({}, { source: 'interaction', sessionProfileRef: 'strict' });
    const res = await options(
      { email: 'a@example.com', authorization_challenge_id: 'ac-9' },
      createEnv(),
      { 'X-Authrim-Interaction': 'int-1' }
    );
    expect(res.status).toBe(201);
    expect(stored().id).toBe(`totp_signup:${res.body.challenge_id as string}`);
    expect(stored().challenge).toBe(res.body.challenge_id);
    expect(stored().metadata).toMatchObject({
      session_profile_ref: 'strict',
      authorization_challenge_id: 'ac-9',
    });
    expect('runtime_interaction_id' in stored().metadata).toBe(true);
  });

  it('stores neither for the tenant default', async () => {
    const res = await options({ email: 'a@example.com', authorization_challenge_id: 9 });
    expect(res.status).toBe(201);
    expect(stored().metadata).not.toHaveProperty('session_profile_ref');
    expect(stored().metadata).not.toHaveProperty('runtime_interaction_id');
    expect(stored().metadata.authorization_challenge_id).toBeUndefined();
  });
});
