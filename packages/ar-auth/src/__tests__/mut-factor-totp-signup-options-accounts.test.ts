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
  ENABLED,
  createEnv,
  createTotpApp,
  m,
  overrides,
  postJson,
  resetHarness,
} from './helpers/mut-factor-totp-harness';
import { callArg } from './helpers/mut-factor-call-arg';

const app = createTotpApp(totp);
const options = (body: unknown, env = createEnv()) => postJson(app, '/options', body, env);
const deletedRouteError = () =>
  Object.assign(new Error('lookup_destination_revalidation_failed'), { cause: 'account_inactive' });
const flowPolicy = (policy: Partial<SignUpPolicy['policy']>): SignUpPolicy => ({
  ...NO_POLICY,
  policy: { ...NO_POLICY.policy, ...policy },
  fromFlow: true,
  source: 'tenant',
});

describe('TOTP sign-up options: addresses already in use', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHarness();
  });
  afterEach(() => vi.useRealTimers());

  it('fails every address alike when the registration check cannot be made', async () => {
    m.checkEmailRegistration.mockResolvedValueOnce('unavailable');
    const res = await options({ email: 'a@example.com' });
    expect(res.status).toBe(500);
    expect(res.body.error_code).toBe('AR900001');
    expect(m.resolveEmailAccountRoute).not.toHaveBeenCalled();
  });

  it('looks the address up among inactive accounts too and refuses one in use', async () => {
    m.runtimeUsers.findByEmail.mockResolvedValueOnce({ id: 'user-x', active: 0 });
    const res = await options({ email: 'a@example.com' });
    expect(res.status).toBe(409);
    expect(res.body.error_code).toBe('AR060005');
    expect(JSON.stringify(res.body)).not.toContain('account_exists');
    expect(m.runtimeUsers.findByEmail).toHaveBeenCalledWith('a@example.com', {
      includeInactive: true,
    });
    expect(m.challengeStore.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('answers a blocked (recently deleted) address as one in use', async () => {
    m.checkEmailRegistration.mockResolvedValueOnce('blocked');
    const res = await options({ email: 'a@example.com' });
    expect(res.body.error_code).toBe('AR060005');
  });

  it('passes over a deleted-destination route only for a blocked address', async () => {
    m.checkEmailRegistration.mockResolvedValueOnce('blocked');
    m.resolveEmailAccountRoute.mockRejectedValueOnce(deletedRouteError());
    const blocked = await options({ email: 'a@example.com' });
    expect(blocked.body.error_code).toBe('AR060005');
    expect(m.runtimeUsers.findByEmail).not.toHaveBeenCalled();

    m.resolveEmailAccountRoute.mockRejectedValueOnce(deletedRouteError());
    const open = await options({ email: 'a@example.com' });
    expect(open.status).toBe(500);
    expect(open.body.error_code).toBe('AR900001');

    m.checkEmailRegistration.mockResolvedValueOnce('blocked');
    m.resolveEmailAccountRoute.mockRejectedValueOnce(new Error('other'));
    const other = await options({ email: 'a@example.com' });
    expect(other.body.error_code).toBe('AR900001');
  });

  it('skips the lookup for an address with no account route', async () => {
    m.resolveEmailAccountRoute.mockResolvedValueOnce('not_found');
    const res = await options({ email: 'a@example.com' });
    expect(res.status).toBe(201);
    expect(m.runtimeUsers.findByEmail).not.toHaveBeenCalled();
  });

  it('mails the owner under a Flow that says so and answers generically', async () => {
    overrides.signUpPolicyFor = async () =>
      flowPolicy({ duplicate: 'mail', denied_response: 'reason' });
    m.runtimeUsers.findByEmail.mockResolvedValueOnce({ id: 'user-owner', active: 1 });
    const res = await options({ email: 'a@example.com' });
    expect(m.notifyExistingAccountSignUp).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'default',
      userId: 'user-owner',
      email: 'a@example.com',
    });
    expect(res.body.error_code).toBe('AR050006');
    expect(JSON.stringify(res.body)).toContain('signup_not_allowed');
    expect(m.challengeStore.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('does not mail for a blocked address or another duplicate policy', async () => {
    overrides.signUpPolicyFor = async () => flowPolicy({ duplicate: 'mail' });
    m.checkEmailRegistration.mockResolvedValueOnce('blocked');
    m.runtimeUsers.findByEmail.mockResolvedValueOnce({ id: 'user-owner', active: 1 });
    const blocked = await options({ email: 'a@example.com' });
    expect(blocked.body.error_code).toBe('AR060005');
    expect(JSON.stringify(blocked.body)).toContain('account_exists');

    overrides.signUpPolicyFor = async () => flowPolicy({ duplicate: 'reject' });
    m.runtimeUsers.findByEmail.mockResolvedValueOnce({ id: 'user-owner', active: 1 });
    const refused = await options({ email: 'a@example.com' });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.body.error_code).toBe('AR060005');
    expect(JSON.stringify(refused.body)).toContain('account_exists');
    expect(m.notifyExistingAccountSignUp).not.toHaveBeenCalled();
  });

  it('answers the policy refusal under a Flow for a blocked address alone', async () => {
    overrides.signUpPolicyFor = async () => flowPolicy({ duplicate: 'mail' });
    m.checkEmailRegistration.mockResolvedValueOnce('blocked');
    const res = await options({ email: 'a@example.com' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(m.notifyExistingAccountSignUp).not.toHaveBeenCalled();
    expect(m.challengeStore.storeChallengeRpc).not.toHaveBeenCalled();
  });
});

describe('TOTP sign-up options: the seed and its URI', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHarness();
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    [{}, 'issuer=op.example.com'],
    [{ ISSUER_URL: undefined }, 'issuer=Authrim'],
    [{ ISSUER_URL: 'not a url' }, 'issuer=Authrim'],
  ])('names the issuer in the URI for %j', async (extra, issuer) => {
    const res = await options({ email: 'a@example.com' }, createEnv(ENABLED, extra));
    expect(res.status).toBe(201);
    expect(res.body.otpauth_uri).toContain(issuer);
  });

  it.each([
    ['3', 3],
    [undefined, 1],
    ['abc', 1],
    ['0', 1],
  ])('encrypts the seed under key version %j as %d', async (version, expected) => {
    const res = await options(
      { email: 'a@example.com' },
      createEnv(ENABLED, { PII_ENCRYPTION_KEY_VERSION: version })
    );
    expect(res.status).toBe(201);
    const { metadata } = callArg<{ metadata: Record<string, unknown> }>(
      m.challengeStore.storeChallengeRpc,
      0,
      0
    );
    expect(metadata.secret_key_version).toBe(expected);
  });

  it.each([['PII_ENCRYPTION_KEY'], ['OTP_HMAC_SECRET']])('refuses without %s', async (key) => {
    const res = await options({ email: 'a@example.com' }, createEnv(ENABLED, { [key]: '' }));
    expect(res.status).toBe(500);
    expect(m.validateFields).not.toHaveBeenCalled();
  });

  it('answers a tenant placement write fence as retryable', async () => {
    m.challengeStore.storeChallengeRpc.mockRejectedValueOnce(
      new Error('tenant_placement_migration_write_fenced')
    );
    const res = await options({ email: 'a@example.com' });
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('1');
    m.challengeStore.storeChallengeRpc.mockRejectedValueOnce(new Error('boom'));
    const other = await options({ email: 'a@example.com' });
    expect(other.status).toBe(500);
    expect(other.body.error_code).toBe('AR900001');
  });
});
