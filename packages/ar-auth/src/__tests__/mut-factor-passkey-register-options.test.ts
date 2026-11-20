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
vi.mock('../signup-screen-check', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../signup-screen-check')>()),
  checkSignUpScreen: (await import('./helpers/mut-factor-passkey-harness')).pm.screenCheck,
}));
vi.mock('../registration-policy-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../registration-policy-gate')>();
  return { ...actual, signUpPolicyFor: vi.fn(async () => actual.NO_POLICY) };
});
vi.mock('../registration-field-utils', async (importOriginal) => {
  const { pm } = await import('./helpers/mut-factor-passkey-harness');
  return {
    ...(await importOriginal<typeof import('../registration-field-utils')>()),
    validateRegistrationFieldSubmissionFromEnv: pm.validateFields,
    buildCanonicalProfileRuntimeUserFields: pm.buildProfileFields,
  };
});
vi.mock('../flow-session-profile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../flow-session-profile')>();
  const { pm } = await import('./helpers/mut-factor-passkey-harness');
  return {
    ...actual,
    sessionTtlForProfile: (...args: Parameters<typeof actual.sessionTtlForProfile>) =>
      pm.sessionTtlForProfile.getMockImplementation()
        ? (pm.sessionTtlForProfile(...args) as ReturnType<typeof actual.sessionTtlForProfile>)
        : actual.sessionTtlForProfile(...args),
  };
});

import * as passkey from '../passkey';
import { NO_POLICY, signUpPolicyFor } from '../registration-policy-gate';
import { callArg } from './helpers/mut-factor-call-arg';
import {
  passkeyApp,
  passkeyEnv,
  pm,
  resetPasskeyHarness,
  send,
} from './helpers/mut-factor-passkey-harness';

const app = passkeyApp(passkey);
const METHODS_KEY = 'settings:tenant:default:authentication-methods';
const ORIGIN = { origin: 'https://login.example.com' };
const options = (body: unknown = {}, env = passkeyEnv(), headers = ORIGIN) =>
  send(app, 'https://login.example.com/register/options', body, env, headers);
const signupOff = () =>
  passkeyEnv({
    [METHODS_KEY]: JSON.stringify({ 'authentication-methods.passkey.signup_enabled': false }),
  });

describe('passkey registration options', () => {
  beforeEach(() => resetPasskeyHarness());

  it('sends a signed-in user elsewhere', async () => {
    const res = await options({ userId: 'user-1' });
    expect(res.status).toBe(401);
    expect(pm.webauthn.generateRegistrationOptions).not.toHaveBeenCalled();
  });

  it('refuses when passkey sign-up is off, naming the method and usage', async () => {
    const res = await options({}, signupOff());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error_code: 'AR050006',
      authentication_method: 'passkey',
      usage: 'signup',
    });
  });

  it('answers 503 when the sign-up switch cannot be read', async () => {
    const res = await options({}, passkeyEnv({ [METHODS_KEY]: '{broken' }));
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'Authentication settings are unavailable.',
    });
  });

  it.each([[{ provisioning_token: 'tok' }], [{ resume_user_id: 'user-r' }]])(
    'refuses half of a provisioning resume: %j',
    async (body) => {
      const res = await options(body);
      expect(res.body.error_code).toBe('AR130003');
      expect(pm.resumeUserId).not.toHaveBeenCalled();
    }
  );

  it('refuses a provisioning resume its token does not name', async () => {
    const res = await options({ provisioning_token: 'tok', resume_user_id: 'user-r' });
    expect(res.body.error_code).toBe('AR130003');
    expect(pm.resumeUserId).toHaveBeenCalledWith(expect.anything(), 'tok', 'user-r');
    expect(pm.screenCheck).not.toHaveBeenCalled();
  });

  it('resumes the account a provisioning token names', async () => {
    pm.resumeUserId.mockResolvedValueOnce('user-r');
    const res = await options({ provisioning_token: 'tok', resume_user_id: 'user-r' });
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('user-r');
    expect(pm.checkEmailRegistration).not.toHaveBeenCalled();
  });

  it('refuses an address here: it has no mailbox proof', async () => {
    const res = await options({ email: ' New@Example.com ' });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain('signup_email_check_required');
    expect(pm.checkEmailRegistration).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'default',
      email: 'new@example.com',
    });
    expect(pm.runtimeUsers.syncUser).not.toHaveBeenCalled();
  });

  it('refuses an address in use as a conflict', async () => {
    pm.runtimeUsers.findByEmail.mockResolvedValueOnce({ id: 'user-x' });
    const res = await options({ email: 'new@example.com' });
    expect(res.body.error_code).toBe('AR060005');
  });

  it('refuses a Flow that checks addresses first before any lookup', async () => {
    vi.mocked(signUpPolicyFor).mockResolvedValueOnce({
      ...NO_POLICY,
      fromFlow: true,
      source: 'tenant',
      policy: { ...NO_POLICY.policy, email_check: 'before' },
    });
    const res = await options({ email: 'new@example.com' });
    expect(res.status).toBe(403);
    expect(pm.validateFields).not.toHaveBeenCalled();
  });

  it('fails every address alike when the registration check is unavailable', async () => {
    pm.checkEmailRegistration.mockResolvedValueOnce('unavailable');
    const res = await options({ email: 'new@example.com' });
    expect(res.status).toBe(500);
  });

  it('creates an account without an address and asks for a resident, verified key', async () => {
    pm.passkeyRepo.findByUserId.mockResolvedValueOnce([
      { credential_id: 'Y3JlZC0x', transports: ['usb'] },
      { credential_id: 'Y3JlZC0y', transports: [] },
      { credential_id: '', transports: ['nfc'] },
    ]);
    const res = await options({ name: 'Pat' });
    expect(res.status).toBe(200);
    expect(callArg(pm.runtimeUsers.syncUser, 0, 0)).toMatchObject({
      userId: 'user-new',
      email: null,
      name: 'Pat',
      sourceRef: 'passkey',
      customAttributesJson: JSON.stringify({ preferred_username: 'user-new' }),
      registrationPending: { mark: 'pending' },
    });
    expect(pm.webauthn.generateRegistrationOptions).toHaveBeenCalledWith({
      rpName: 'Authrim',
      rpID: 'login.example.com',
      userID: new TextEncoder().encode('user-new'),
      userName: 'user-new',
      userDisplayName: 'Pat',
      excludeCredentials: [
        { id: 'Y3JlZC0x', type: 'public-key', transports: ['usb'] },
        { id: 'Y3JlZC0y', type: 'public-key', transports: undefined },
      ],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      attestationType: 'none',
    });
    expect(pm.challengeStore.storeChallengeRpc).toHaveBeenCalledWith({
      id: 'passkey_reg:user-new',
      tenantId: 'default',
      type: 'passkey_registration',
      userId: 'user-new',
      challenge: 'reg-challenge',
      ttl: 300,
      email: undefined,
      metadata: {},
    });
  });

  it('keeps validated fields and the Flow session profile with the challenge', async () => {
    vi.mocked(signUpPolicyFor).mockResolvedValueOnce({ ...NO_POLICY, sessionProfileRef: 'strict' });
    pm.validateFields.mockResolvedValueOnce({ ok: true, values: { team: 'blue' } });
    await options({ custom_fields: { team: 'blue' } });
    expect(
      callArg<{ metadata: unknown }>(pm.challengeStore.storeChallengeRpc, 0, 0).metadata
    ).toEqual({
      custom_fields: { team: 'blue' },
      session_profile_ref: 'strict',
    });
    expect(callArg(pm.webauthn.generateRegistrationOptions, 0, 0)).toMatchObject({
      userDisplayName: 'user-new',
    });
  });

  it('provisions a routed account and names it after its id without a name', async () => {
    pm.usesRoutedAccountStorage.mockReturnValue(true);
    pm.provisionAccount.mockResolvedValueOnce({
      status: 'created',
      userId: 'user-routed',
      accountId: 'account:routed',
    });
    const res = await options({});
    expect(res.body.userId).toBe('user-routed');
    expect(pm.resolveAccountData).toHaveBeenCalledWith(expect.anything(), 'account:routed');
    expect(callArg(pm.provisionAccount, 0, 1)).toMatchObject({
      candidateUserId: 'user-new',
      flow: 'passkey',
      email: null,
      runtimeUser: { piiFields: {}, sensitiveValues: {}, sourceRef: 'auth:passkey' },
    });
    expect(callArg(pm.webauthn.generateRegistrationOptions, 0, 0)).toMatchObject({
      userDisplayName: 'user-routed',
    });
  });

  it('returns the pending answer of a routed account still being made', async () => {
    pm.usesRoutedAccountStorage.mockReturnValue(true);
    pm.provisionAccount.mockResolvedValueOnce({
      status: 'pending',
      response: new Response('{"pending":true}', { status: 202 }),
    });
    const res = await options({ name: 'Pat' });
    expect(res.status).toBe(202);
    expect(
      callArg<{ runtimeUser: { piiFields: unknown } }>(pm.provisionAccount, 0, 1).runtimeUser
        .piiFields
    ).toEqual({
      name: true,
    });
    expect(pm.webauthn.generateRegistrationOptions).not.toHaveBeenCalled();
  });

  it.each([
    ['a write fence', 'tenant_placement_migration_write_fenced', 503],
    ['another failure', 'boom', 500],
  ])('answers %s while creating the account', async (_label, message, status) => {
    pm.runtimeUsers.syncUser.mockRejectedValueOnce(new Error(message));
    const res = await options({});
    expect(res.status).toBe(status);
    expect(pm.webauthn.generateRegistrationOptions).not.toHaveBeenCalled();
  });
});
