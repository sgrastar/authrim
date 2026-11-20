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
import {
  passkeyApp,
  passkeyEnv,
  pm,
  resetPasskeyHarness,
  send,
} from './helpers/mut-factor-passkey-harness';

const app = passkeyApp(passkey);
const METHODS_KEY = 'settings:tenant:default:authentication-methods';
const body = { userId: 'user-1', credential: { id: 'Y3JlZC0x', response: {} } };
const register = (
  payload: unknown = body,
  env = passkeyEnv(),
  headers: Record<string, string> = { origin: 'https://login.example.com' }
) => send(app, 'https://login.example.com/register/verify', payload, env, headers);
const registered = (info: Record<string, unknown> | undefined, verified = true) =>
  pm.webauthn.verifyRegistrationResponse.mockResolvedValueOnce({
    verified,
    registrationInfo: info,
  });

describe('passkey registration verify: before anything is stored', () => {
  beforeEach(() => {
    resetPasskeyHarness();
    pm.challengeStore.consumeChallengeRpc.mockResolvedValue({
      userId: 'user-1',
      challenge: 'reg-challenge',
      metadata: { session_profile_ref: 'strict' },
    });
  });

  it.each([[{ credential: body.credential }], [{ userId: 'user-1' }]])(
    'requires a user and a credential: %j',
    async (payload) => {
      const res = await register(payload);
      expect(res.body.error_code).toBe('AR130001');
      expect(pm.challengeStore.consumeChallengeRpc).not.toHaveBeenCalled();
    }
  );

  it('refuses once sign-up has been switched off', async () => {
    const res = await register(
      body,
      passkeyEnv({
        [METHODS_KEY]: JSON.stringify({ 'authentication-methods.passkey.signup_enabled': false }),
      })
    );
    expect(res.body).toMatchObject({ error_code: 'AR050006', usage: 'signup' });
    expect(pm.challengeStore.consumeChallengeRpc).not.toHaveBeenCalled();
  });

  it('consumes the registration challenge of the user', async () => {
    registered(undefined, false);
    await register();
    expect(pm.challengeStore.consumeChallengeRpc).toHaveBeenCalledWith({
      id: 'passkey_reg:user-1',
      tenantId: 'default',
      type: 'passkey_registration',
    });
  });

  it.each([
    [
      'that cannot be consumed',
      () => pm.challengeStore.consumeChallengeRpc.mockRejectedValueOnce(new Error('gone')),
    ],
    [
      'of another user',
      () =>
        pm.challengeStore.consumeChallengeRpc.mockResolvedValueOnce({
          userId: 'user-2',
          challenge: 'reg-challenge',
        }),
    ],
  ])('answers a challenge %s as an expired session', async (_label, arrange) => {
    arrange();
    const res = await register();
    expect(res.body.error_code).toBe('AR000001');
    expect(pm.webauthn.verifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it('refuses an origin that is not allowed', async () => {
    const res = await register(body, passkeyEnv(), { origin: 'https://evil.example' });
    expect(res.body.error_code).toBe('AR050006');
    expect(pm.webauthn.verifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it('verifies against the consumed challenge with user verification', async () => {
    registered(undefined, false);
    await register();
    expect(pm.webauthn.verifyRegistrationResponse).toHaveBeenCalledWith({
      response: body.credential,
      expectedChallenge: 'reg-challenge',
      expectedOrigin: 'https://login.example.com',
      expectedRPID: 'login.example.com',
      requireUserVerification: true,
    });
  });

  it('tells the browser the credential is unknown when verification throws', async () => {
    pm.webauthn.verifyRegistrationResponse.mockRejectedValueOnce(new Error('bad attestation'));
    const res = await register();
    expect(res.body).toMatchObject({
      error_code: 'AR000005',
      webauthn_signal: { unknown_credential: true },
    });
  });

  it.each([
    [
      'not verified',
      { credential: { id: new Uint8Array([1]), publicKey: new Uint8Array([2]) } },
      false,
    ],
    ['without registration info', undefined, true],
  ])('refuses a registration %s without the signal', async (_label, info, verified) => {
    registered(info, verified);
    const res = await register();
    expect(res.body.error_code).toBe('AR000005');
    expect(res.body).not.toHaveProperty('webauthn_signal');
  });

  it('fails on registration info without a credential', async () => {
    registered({ counter: 0 });
    const res = await register();
    expect(res.status).toBe(500);
    expect(pm.sessionStore.createSessionRpc).not.toHaveBeenCalled();
  });

  it('answers 503 when the session settings cannot be read', async () => {
    registered({
      credential: { id: new Uint8Array([1]), publicKey: new Uint8Array([2]), counter: 0 },
    });
    pm.sessionTtlForProfile.mockRejectedValue(new Error('settings down'));
    const res = await register();
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'Session settings are unavailable.',
    });
    expect(pm.sessionTtlForProfile).toHaveBeenCalledWith(
      expect.anything(),
      'default',
      'passkey_registration',
      'strict'
    );
    expect(pm.sessionStore.createSessionRpc).not.toHaveBeenCalled();
  });
});
