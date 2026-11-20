import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  attemptRecording,
  createContext,
  enableEmailOtp,
  mocks,
  resetDirectAuthMocks,
  s256Challenge,
} from './helpers/mut-directauth-harness';

/**
 * Email code verify: the per-code attempt limit, the checks of the code's challenge (each failure
 * recorded with its own reason against the challenge's interaction and user), and what a verified
 * code completes.
 */
const VERIFIER = 'email-code-verifier';
type Ctx = ReturnType<typeof createContext>;

async function codeChallenge(
  metadata: Record<string, unknown> = {},
  extra: Record<string, unknown> = {}
) {
  const record = {
    challenge: 'stored-code-hash',
    userId: 'user_existing',
    email: 'User@Example.com',
    metadata: {
      code_challenge: await s256Challenge(VERIFIER),
      channel: 'browser',
      client_id: 'web-client',
      usage: 'login',
      issued_at: 1234,
      attempt_interaction_id: 'int-1',
      ...metadata,
    },
    ...extra,
  };
  mocks.challengeStore.getChallengeRpc.mockResolvedValue(record);
  mocks.challengeStore.consumeChallengeRpc.mockResolvedValue(record);
  return record;
}

async function verify(body: Record<string, unknown> = {}, prepare?: (c: Ctx) => void) {
  const { directEmailCodeVerifyHandler } = await import('../direct-auth');
  const context = enableEmailOtp(
    createContext({
      attempt_id: 'attempt_1',
      code: '123456',
      code_verifier: VERIFIER,
      channel: 'browser',
      ...body,
    })
  );
  prepare?.(context);
  const response = await directEmailCodeVerifyHandler(context as never);
  return { response, body: await response.json<Record<string, unknown>>(), context };
}

function reasons() {
  return attemptRecording.record.mock.calls.map((call) => {
    const input = call[3] as { reasonCode: string; userId: string | null };
    return [input.reasonCode, input.userId];
  });
}

function routed(c: Ctx) {
  c.get = ((key: string) => {
    if (key === 'tenantId') return 'tenant_test';
    if (key === 'tenantMetadataContext') {
      return { tenantId: 'tenant_test', route: { allocationScope: 'tenant_exclusive' } };
    }
    return undefined;
  }) as never;
}

describe('Direct Auth email code verify (mutation hardening)', () => {
  beforeAll(async () => {
    await import('../direct-auth');
  }, 20_000);
  beforeEach(() => resetDirectAuthMocks());

  it('counts five attempts per code and drops the code past them', async () => {
    mocks.rateLimiter.incrementRpc.mockResolvedValue({ allowed: false, retryAfter: 30 });
    const { response, body } = await verify();
    expect(response.status).toBe(429);
    expect(body.error_code).toBe('AR110001');
    expect(body.error_description).toContain('retry after 30 seconds');
    expect(mocks.rateLimiter.incrementRpc).toHaveBeenCalledWith('verify:attempt_1', {
      windowSeconds: expect.any(Number) as unknown,
      maxRequests: 5,
    });
    expect(mocks.challengeStore.deleteChallengeRpc).toHaveBeenCalledWith(
      'direct_email_code:attempt_1'
    );
    expect(mocks.challengeStore.getChallengeRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['is gone', () => mocks.challengeStore.getChallengeRpc.mockResolvedValue(null)],
    [
      'cannot be read',
      () => mocks.challengeStore.getChallengeRpc.mockRejectedValue(new Error('x')),
    ],
  ])('refuses a code whose challenge %s, recording nothing', async (_n, arrange) => {
    arrange();
    const { body } = await verify();
    expect(body.error_code).toBe('AR000006');
    expect(mocks.challengeStore.getChallengeRpc).toHaveBeenCalledWith(
      'direct_email_code:attempt_1'
    );
    expect(attemptRecording.record).not.toHaveBeenCalled();
  });

  it.each([
    ['another verifier', { code_verifier: 'another-verifier' }, {}],
    ['another channel', { channel: 'native' }, {}],
    ['no code challenge', {}, { code_challenge: undefined }],
  ])('records %s as a challenge mismatch of the code’s user', async (_n, body, metadata) => {
    await codeChallenge(metadata);
    const result = await verify(body);
    expect(result.body.error_code).toBe('AR000006');
    expect(reasons()).toEqual([['challenge_mismatch', 'user_existing']]);
    expect(mocks.verifyEmailCodeHash).not.toHaveBeenCalled();
  });

  it('records a missing OTP secret as the service being unavailable', async () => {
    await codeChallenge();
    const { response, body } = await verify({}, (c) => {
      c.env.OTP_HMAC_SECRET = '';
    });
    // An internal error code, masked as one.
    expect(response.status).toBe(500);
    expect(body.error_code).toBe('AR900001');
    expect(mocks.verifyEmailCodeHash).not.toHaveBeenCalled();
    expect(reasons()).toEqual([['service_unavailable', 'user_existing']]);
  });

  it('checks the code against the lower-cased address, attempt, issue time and stored hash', async () => {
    await codeChallenge();
    mocks.verifyEmailCodeHash.mockResolvedValue(false);
    const { body } = await verify();
    expect(mocks.verifyEmailCodeHash).toHaveBeenCalledWith(
      '123456',
      'user@example.com',
      'attempt_1',
      1234,
      'stored-code-hash',
      'otp-test-secret'
    );
    expect(body.error_code).toBe('AR000006');
    expect(reasons()).toEqual([['invalid_code', 'user_existing']]);
    expect(mocks.challengeStore.consumeChallengeRpc).not.toHaveBeenCalled();
  });

  it('checks a code without address or issue time against empty values', async () => {
    await codeChallenge({ issued_at: undefined }, { email: undefined });
    mocks.verifyEmailCodeHash.mockResolvedValue(false);
    await verify();
    expect(mocks.verifyEmailCodeHash.mock.calls[0]?.slice(1, 4)).toEqual(['', 'attempt_1', 0]);
  });

  it('records a code used meanwhile as an expired challenge', async () => {
    await codeChallenge();
    mocks.challengeStore.consumeChallengeRpc.mockRejectedValue(new Error('consumed'));
    const { body } = await verify();
    expect(body.error_code).toBe('AR000006');
    expect(mocks.challengeStore.consumeChallengeRpc).toHaveBeenCalledWith({
      id: 'direct_email_code:attempt_1',
      tenantId: 'tenant_test',
      type: 'direct_email_code',
    });
    expect(reasons()).toEqual([['challenge_expired', 'user_existing']]);
  });

  it.each([
    ['no usage', { usage: undefined }, 'AR000001', 'challenge_expired'],
    ['a usage it does not know', { usage: 'admin' }, 'AR000001', 'challenge_expired'],
    [
      'a re-authentication of another user',
      { usage: 'reauth', reauth_user_id: 'user_other' },
      'AR000006',
      'account_mismatch',
    ],
  ])('refuses a verified code with %s', async (_n, metadata, code, reason) => {
    await codeChallenge(metadata);
    const { body } = await verify();
    expect(body.error_code).toBe(code);
    expect(reasons()).toEqual([[reason, 'user_existing']]);
    expect(mocks.authCodeStore.storeCodeRpc).not.toHaveBeenCalled();
  });

  it('refuses a verified code once its method was turned off for that usage', async () => {
    await codeChallenge({ usage: 'signup' });
    const { body } = await verify({}, (c) =>
      enableEmailOtp(c, {}, { 'authentication-methods.email_otp.signup_enabled': false })
    );
    expect(body.error_code).toBe('AR050006');
    expect(reasons()).toEqual([['method_disabled', 'user_existing']]);
  });

  it('records an account that may no longer sign in', async () => {
    await codeChallenge();
    mocks.userCore.findById.mockResolvedValue(null);
    const { body } = await verify();
    expect(body.error_code).toBe('AR030001');
    expect(reasons()).toEqual([['account_unavailable', 'user_existing']]);
  });

  it('records a guest that may not sign in', async () => {
    await codeChallenge();
    const core = await import('@authrim/ar-lib-core');
    (
      core.assertGuestCredentialAuthenticationAllowed as unknown as {
        mockRejectedValueOnce: (e: Error) => void;
      }
    ).mockRejectedValueOnce(new Error('account_authentication_not_allowed'));
    const { body } = await verify();
    expect(body.error_code).toBe('AR030001');
    expect(reasons()).toEqual([['guest_denied', 'user_existing']]);
  });

  it('makes an artifact of the code’s challenge and marks the address verified', async () => {
    await codeChallenge({ custom_fields: { department: 'sales' } });
    const { response, body } = await verify();
    expect(response.status).toBe(200);
    expect(body.is_new_user).toBe(false);
    const stored = mocks.challengeStore.storeChallengeRpc.mock.calls[0]?.[0] as {
      metadata: Record<string, unknown>;
    };
    expect(stored.metadata).toMatchObject({
      method: 'email_code',
      client_id: 'web-client',
      channel: 'browser',
      transaction_id: 'attempt_1',
      usage: 'login',
      is_new_user: false,
      attempt_interaction_id: 'int-1',
    });
    expect(mocks.coreAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('last_login_at'),
      expect.arrayContaining(['user_existing'])
    );
    expect(mocks.persistRegistrationFieldValuesFromEnv).toHaveBeenCalledWith(
      expect.anything(),
      'tenant_test',
      'user_existing',
      { department: 'sales' }
    );
    expect(mocks.publishEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        data: { userId: 'user_existing', method: 'email_code', clientId: 'web-client' },
      })
    );
    expect(attemptRecording.record).not.toHaveBeenCalled();
  });

  it('keeps no registration fields that are not an object, and counts a just-made account as new', async () => {
    await codeChallenge({ custom_fields: ['x'], transaction_id: 'tx_1' });
    mocks.userCore.findById.mockResolvedValue({
      id: 'user_existing',
      is_active: true,
      created_at: Date.now(),
    });
    const { body } = await verify();
    expect(body.is_new_user).toBe(true);
    expect(mocks.persistRegistrationFieldValuesFromEnv).not.toHaveBeenCalled();
    const stored = mocks.challengeStore.storeChallengeRpc.mock.calls[0]?.[0] as {
      metadata: Record<string, unknown>;
    };
    expect(stored.metadata.transaction_id).toBe('tx_1');
  });

  it('applies the invitation use the send reserved to the code’s user, in seconds', async () => {
    await codeChallenge({ invite_id: 'inv_1', invite_reservation_id: 'res_1' });
    mocks.findInvitationById.mockResolvedValue({ id: 'inv_1', role_id: null, org_id: null });
    mocks.claimInvitationReservation.mockResolvedValue(true);
    mocks.applyInvitationAssignments.mockResolvedValue({});
    const before = Math.floor(Date.now() / 1000);
    await verify();
    const claim = mocks.claimInvitationReservation.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(claim).toMatchObject({ reservationId: 'res_1', userId: 'user_existing' });
    expect(claim.now).toBeGreaterThanOrEqual(before);
    expect(claim.now).toBeLessThanOrEqual(before + 5);
  });

  it.each([
    [0, true],
    [1, false],
  ])('reads a routed account from its own core (email_verified %s)', async (verified, marks) => {
    await codeChallenge();
    const accountData = (await mocks.resolveOtpAccountCoreDataContextByIdentifierFromHono()) as {
      user: Record<string, unknown>;
      coreDb: unknown;
    };
    mocks.resolveOtpAccountCoreDataContextByIdentifierFromHono.mockClear();
    mocks.resolveOtpAccountCoreDataContextByIdentifierFromHono.mockResolvedValue({
      ...accountData,
      user: { ...accountData.user, email_verified: verified },
    });
    const { response } = await verify({}, routed);
    expect(response.status).toBe(200);
    expect(mocks.resolveOtpAccountCoreDataContextByIdentifierFromHono).toHaveBeenCalledWith(
      expect.anything(),
      {
        indexKind: 'account_id',
        identifier: 'account:user_existing',
        expectedAccountId: 'account:user_existing',
        expectedLegacyUserId: 'user_existing',
        trustedEmail: 'User@Example.com',
      }
    );
    expect(mocks.ensureDatabaseAdapter).toHaveBeenCalledWith(
      accountData.coreDb,
      'otp-account-core'
    );
    expect(mocks.markOtpLoginEmailVerified).toHaveBeenCalledTimes(marks ? 1 : 0);
  });
});
