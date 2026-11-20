import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createContext,
  createMockKV,
  mocks,
  resetDirectAuthMocks,
  s256Challenge,
} from './helpers/mut-directauth-harness';

/**
 * Passkey sign-up finish: the switch is checked before the challenge is spent, the challenge is
 * found through its mapping and bound to PKCE and channel, and a verified registration stores the
 * passkey, settles the sign-up and makes an artifact of the account the start created.
 */
const VERIFIER = 'passkey-signup-code-verifier';
type Ctx = ReturnType<typeof createContext>;

async function signupChallenge(metadata: Record<string, unknown> = {}) {
  mocks.challengeStore.getChallengeRpc.mockResolvedValue({ userId: 'user_new' });
  mocks.challengeStore.consumeChallengeRpc.mockResolvedValue({
    challenge: 'passkey-signup-challenge',
    metadata: {
      code_challenge: await s256Challenge(VERIFIER),
      client_id: 'web-client',
      channel: 'browser',
      origin: 'https://app.example.com',
      rpID: 'app.example.com',
      ...metadata,
    },
  });
}

async function signupFinish(body: Record<string, unknown> = {}, prepare?: (c: Ctx) => void) {
  const { directPasskeySignupFinishHandler } = await import('../direct-auth');
  const context = createContext({
    challenge_id: 'challenge_1',
    credential: { id: 'new-credential', rawId: 'new-credential', response: {}, type: 'public-key' },
    code_verifier: VERIFIER,
    channel: 'browser',
    ...body,
  });
  prepare?.(context);
  const response = await directPasskeySignupFinishHandler(context as never);
  return { response, body: await response.json<Record<string, unknown>>() };
}

function artifactMetadata() {
  return (
    mocks.challengeStore.storeChallengeRpc.mock.calls[0]?.[0] as {
      metadata: Record<string, unknown>;
    }
  ).metadata;
}

function pendingFlowUpdates() {
  return mocks.coreAdapter.execute.mock.calls.filter(([sql]) =>
    String(sql).includes("SET flow = 'email_code'")
  );
}

describe('Direct Auth passkey sign-up finish (mutation hardening)', () => {
  beforeAll(async () => {
    await import('../direct-auth');
  }, 20_000);
  beforeEach(() => {
    resetDirectAuthMocks();
    mocks.userCore.findById.mockResolvedValue({
      id: 'user_new',
      is_active: true,
      created_at: Date.now(),
    });
  });

  it('does not spend the challenge while sign-up is off', async () => {
    await signupChallenge();
    const { body } = await signupFinish({}, (c) => {
      c.env.SETTINGS = createMockKV({
        'settings:tenant:tenant_test:authentication-methods': JSON.stringify({
          'authentication-methods.passkey.signup_enabled': false,
        }),
      }) as never;
    });
    expect(body.error_code).toBe('AR050006');
    expect(mocks.challengeStore.getChallengeRpc).not.toHaveBeenCalled();
    expect(mocks.challengeStore.consumeChallengeRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['no mapping', () => mocks.challengeStore.getChallengeRpc.mockResolvedValue(null)],
    ['a mapping without user', () => mocks.challengeStore.getChallengeRpc.mockResolvedValue({})],
    [
      'a mapping that cannot be read',
      () => mocks.challengeStore.getChallengeRpc.mockRejectedValue(new Error('x')),
    ],
    [
      'a used challenge',
      () => mocks.challengeStore.consumeChallengeRpc.mockRejectedValue(new Error('used')),
    ],
  ])('answers an expired session for %s', async (_n, arrange) => {
    await signupChallenge();
    arrange();
    const { body } = await signupFinish();
    expect(body.error_code).toBe('AR000001');
    expect(mocks.verifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it('finds the user by the mapping and consumes that user’s challenge', async () => {
    await signupChallenge();
    await signupFinish();
    expect(mocks.challengeStore.getChallengeRpc).toHaveBeenCalledWith(
      'direct_passkey_signup_map:challenge_1'
    );
    expect(mocks.challengeStore.consumeChallengeRpc).toHaveBeenCalledWith({
      id: 'direct_passkey_signup:user_new',
      tenantId: 'tenant_test',
      type: 'direct_passkey_signup',
    });
  });

  it.each([
    ['another verifier', { code_verifier: 'another' }, {}],
    ['another channel', { channel: 'native' }, {}],
    ['no code challenge', {}, { code_challenge: undefined }],
  ])('refuses %s before verifying the registration', async (_n, body, metadata) => {
    await signupChallenge(metadata);
    const result = await signupFinish(body);
    expect(result.body.error_code).toBe('AR000006');
    expect(mocks.verifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it.each([
    [
      'throws',
      () => mocks.verifyRegistrationResponse.mockRejectedValue(new Error('bad')),
      'AR000005',
    ],
    [
      'is not verified',
      () =>
        mocks.verifyRegistrationResponse.mockResolvedValue({
          verified: false,
          registrationInfo: {},
        }),
      'AR000005',
    ],
    [
      'has no registration info',
      () => mocks.verifyRegistrationResponse.mockResolvedValue({ verified: true }),
      'AR000005',
    ],
    [
      'has no public key',
      () =>
        mocks.verifyRegistrationResponse.mockResolvedValue({
          verified: true,
          registrationInfo: { credentialID: new Uint8Array([1]) },
        }),
      'AR900001',
    ],
  ])('stores no passkey when the registration %s', async (_n, arrange, code) => {
    await signupChallenge();
    arrange();
    const { body } = await signupFinish();
    expect(body.error_code).toBe(code);
    expect(mocks.passkey.create).not.toHaveBeenCalled();
  });

  it('verifies the registration against the challenge it was started with', async () => {
    await signupChallenge();
    await signupFinish();
    expect(mocks.verifyRegistrationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: 'passkey-signup-challenge',
        expectedOrigin: 'https://app.example.com',
        expectedRPID: 'app.example.com',
        requireUserVerification: true,
      })
    );
  });

  it('stores the passkey of newer registration info and settles the sign-up', async () => {
    await signupChallenge({ runtime_interaction_id: 'interaction_1', scope: 'openid' });
    mocks.verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: { id: new Uint8Array([1, 2, 3]), publicKey: new Uint8Array([9]), counter: 2 },
      },
    });
    const { response, body } = await signupFinish();
    expect(response.status).toBe(200);
    expect(body.is_new_user).toBe(true);
    expect(mocks.passkey.create).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user_new',
        credential_id: 'AQID',
        rp_id: 'app.example.com',
        public_key: 'CQ==',
        counter: 2,
        transports: [],
        device_name: 'Direct Auth Passkey',
        aaguid: null,
      })
    );
    expect(pendingFlowUpdates()).toHaveLength(0);
    expect(artifactMetadata()).toMatchObject({
      method: 'passkey_signup',
      client_id: 'web-client',
      scope: 'openid',
      transaction_id: 'challenge_1',
      is_new_user: true,
      runtime_interaction_id: 'interaction_1',
    });
  });

  it('leaves the sign-up to its email check when its Flow checks the address after', async () => {
    await signupChallenge({ settle_after_email_check: true });
    await signupFinish();
    expect(pendingFlowUpdates()).toEqual([
      [expect.stringContaining('account_registration_pending'), ['tenant_test', 'user_new']],
    ]);
    expect(artifactMetadata()).not.toHaveProperty('runtime_interaction_id');
  });

  it('counts an account it cannot find, or an old one, as not new', async () => {
    await signupChallenge();
    mocks.userCore.findById.mockResolvedValue(null);
    expect((await signupFinish()).body.is_new_user).toBe(false);
    await signupChallenge();
    mocks.userCore.findById.mockResolvedValue({
      id: 'user_new',
      is_active: true,
      created_at: Date.now() - 120_000,
    });
    expect((await signupFinish()).body.is_new_user).toBe(false);
  });

  it('keeps the registration fields of the start, and finishes when they cannot be kept', async () => {
    await signupChallenge({ custom_fields: { team: 'blue' } });
    mocks.persistRegistrationFieldValuesFromEnv.mockRejectedValue(new Error('store down'));
    const { response } = await signupFinish();
    expect(response.status).toBe(200);
    expect(mocks.persistRegistrationFieldValuesFromEnv).toHaveBeenCalledWith(
      expect.anything(),
      'tenant_test',
      'user_new',
      { team: 'blue' }
    );
  });

  it('applies the invitation use the start reserved, in seconds', async () => {
    await signupChallenge({ invite_id: 'inv_1', invite_reservation_id: 'res_1' });
    mocks.findInvitationById.mockResolvedValue({ id: 'inv_1', role_id: null, org_id: null });
    mocks.claimInvitationReservation.mockResolvedValue(true);
    mocks.applyInvitationAssignments.mockResolvedValue({});
    const before = Math.floor(Date.now() / 1000);
    await signupFinish();
    const claim = mocks.claimInvitationReservation.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(claim).toMatchObject({
      reservationId: 'res_1',
      invitationId: 'inv_1',
      userId: 'user_new',
    });
    expect(claim.now).toBeGreaterThanOrEqual(before);
    expect(claim.now).toBeLessThanOrEqual(before + 5);
  });
});
