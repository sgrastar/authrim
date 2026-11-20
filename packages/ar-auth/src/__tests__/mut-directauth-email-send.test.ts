import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createContext,
  enableEmailOtp,
  mocks,
  resetDirectAuthMocks,
  webHeaders,
} from './helpers/mut-directauth-harness';

/**
 * Email code send: what is stored and sent for an address with an account, how a failure to
 * store, deliver or provision is answered (like a send, without revealing the address), and the
 * routed account lookup.
 */
type Ctx = ReturnType<typeof createContext>;

async function send(body: Record<string, unknown> = {}, prepare?: (c: Ctx) => void) {
  const { directEmailCodeSendHandler } = await import('../direct-auth');
  const context = enableEmailOtp(
    createContext(
      {
        client_id: 'web-client',
        email: 'user@example.com',
        code_challenge: 'email-pkce-challenge',
        code_challenge_method: 'S256',
        channel: 'browser',
        ...body,
      },
      webHeaders()
    )
  );
  prepare?.(context);
  const response = await directEmailCodeSendHandler(context as never);
  return { response, body: await response.json<Record<string, unknown>>() };
}

function storedCodes() {
  return mocks.challengeStore.storeChallengeRpc.mock.calls
    .map(([request]) => request as { id: string; type: string; [key: string]: unknown })
    .filter((request) => request.type === 'direct_email_code');
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

describe('Direct Auth email code send (mutation hardening)', () => {
  beforeAll(async () => {
    await import('../direct-auth');
  }, 20_000);
  beforeEach(() => resetDirectAuthMocks());

  describe('to an address with an account', () => {
    beforeEach(() => {
      mocks.userPII.findByTenantAndEmail.mockResolvedValue({
        id: 'user_existing',
        email: 'user@example.com',
        name: 'Example User',
      });
      mocks.userCore.findById.mockResolvedValue({
        id: 'user_existing',
        is_active: true,
        email_verified: true,
        created_at: Date.now() - 120_000,
      });
    });

    it('stores the code under the attempt it answers and sends it', async () => {
      const { response, body } = await send({
        email: 'User@Example.com',
        scope: 'openid',
        runtime_interaction_id: 'interaction_1',
      });
      expect(response.status).toBe(200);
      const [stored] = storedCodes();
      expect(stored).toMatchObject({
        id: `direct_email_code:${String(body.attempt_id)}`,
        tenantId: 'tenant_test',
        userId: 'user_existing',
        challenge: 'hashed-email-code',
        email: 'user@example.com',
        ttl: body.expires_in,
        metadata: {
          code_challenge: 'email-pkce-challenge',
          client_id: 'web-client',
          channel: 'browser',
          scope: 'openid',
          usage: 'login',
          runtime_interaction_id: 'interaction_1',
          transaction_id: body.attempt_id,
          email_hash: 'hashed-email',
          issued_at: expect.any(Number) as unknown,
        },
      });
      expect(stored?.metadata).not.toHaveProperty('reauth_user_id');
      expect(stored?.metadata).not.toHaveProperty('custom_fields');
      expect(mocks.hashEmailCode).toHaveBeenCalledWith(
        '123456',
        'user@example.com',
        body.attempt_id,
        expect.any(Number),
        'otp-test-secret'
      );
      expect(mocks.emailNotifier.send).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'email',
          to: 'user@example.com',
          from: 'noreply@authrim.dev',
          subject: 'Your verification code',
        })
      );
      expect(body.masked_email).toBe('u***r@example.com');
    });

    it('lasts no longer than the authorization challenge it continues', async () => {
      const expiresAt = Date.now() + 30_000;
      mocks.challengeStore.getChallengeRpc.mockResolvedValue({
        tenantId: 'tenant_test',
        type: 'login',
        userId: 'anonymous',
        expiresAt,
      });
      const { body } = await send({ authorization_challenge_id: 'authz_1' });
      expect(body.expires_in).toBeGreaterThanOrEqual(28);
      expect(body.expires_in).toBeLessThanOrEqual(30);
      expect(storedCodes()[0]).toMatchObject({
        ttl: body.expires_in,
        notAfterMs: expiresAt,
        metadata: { authorization_challenge_id: 'authz_1', usage: 'login' },
      });
    });

    it('refuses a send for an authorization challenge it cannot read', async () => {
      mocks.challengeStore.getChallengeRpc.mockRejectedValue(new Error('store down'));
      const { body } = await send({ authorization_challenge_id: 'authz_1' });
      expect(body.error_code).toBe('AR130003');
      expect(storedCodes()).toHaveLength(0);
    });

    it.each([
      ['ab@example.com', 'a***@example.com'],
      ['a@example.com', 'a***@example.com'],
      ['abc@example.com', 'a***c@example.com'],
    ])('masks %s as %s', async (email, masked) => {
      mocks.userPII.findByTenantAndEmail.mockResolvedValue({
        id: 'user_existing',
        email,
        name: null,
      });
      const { body } = await send({ email });
      expect(body.masked_email).toBe(masked);
    });

    it('answers like a send, storing and sending nothing, without an OTP secret', async () => {
      const { response, body } = await send({}, (c) => {
        c.env.OTP_HMAC_SECRET = '';
      });
      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        attempt_id: expect.any(String) as unknown,
        masked_email: 'u***r@example.com',
      });
      expect(storedCodes()).toHaveLength(0);
      expect(mocks.emailNotifier.send).not.toHaveBeenCalled();
    });

    it('drops the stored code when the delivery fails for good, answering like a send', async () => {
      mocks.emailNotifier.send.mockResolvedValue({ success: false });
      const { response, body } = await send();
      expect(response.status).toBe(200);
      expect(body.attempt_id).toEqual(expect.any(String));
      const [stored] = storedCodes();
      expect(mocks.challengeStore.deleteChallengeRpc).toHaveBeenCalledWith(stored?.id);
    });
  });

  describe('to a new address', () => {
    it.each([
      'account_creation_previous_account_deleting',
      'account_creation_generations_exhausted',
    ])('answers a provisioning refusal (%s) like a send', async (message) => {
      mocks.userCore.createUser.mockRejectedValue(new Error(message));
      const { response, body } = await send({ email: 'new@example.com' });
      expect(response.status).toBe(200);
      expect(body.masked_email).toBe('n***w@example.com');
      expect(storedCodes()).toHaveLength(0);
      expect(mocks.emailNotifier.send).not.toHaveBeenCalled();
    });

    it('answers an internal error when the account cannot be made otherwise', async () => {
      mocks.userCore.createUser.mockRejectedValue(new Error('database down'));
      const { response, body } = await send({ email: 'new@example.com' });
      expect(response.status).toBe(500);
      expect(body.error_code).toBe('AR900001');
      expect(mocks.emailNotifier.send).not.toHaveBeenCalled();
    });
  });

  describe('where accounts are routed', () => {
    it('looks the address up exactly and fails a lookup that is not a missing route', async () => {
      mocks.resolveOtpAccountCoreDataContextByIdentifierFromHono.mockRejectedValue(
        new Error('route store down')
      );
      const { response, body } = await send({ email: 'User@Example.com' }, routed);
      expect(response.status).toBe(500);
      expect(body.error_code).toBe('AR900001');
      expect(mocks.resolveOtpAccountCoreDataContextByIdentifierFromHono).toHaveBeenCalledWith(
        expect.anything(),
        {
          indexKind: 'email_exact',
          identifier: 'user@example.com',
          trustedEmail: 'user@example.com',
        }
      );
      expect(mocks.emailNotifier.send).not.toHaveBeenCalled();
    });

    it('treats an address without a route as new, and an inactive account as none', async () => {
      mocks.resolveOtpAccountCoreDataContextByIdentifierFromHono.mockRejectedValueOnce(
        new Error('account_data_route_not_found')
      );
      await send({}, routed);
      expect(mocks.provisionTenantD1EmailAccount).toHaveBeenCalledTimes(1);

      const accountData = (await mocks.resolveOtpAccountCoreDataContextByIdentifierFromHono()) as {
        user: Record<string, unknown>;
        coreDb: unknown;
      };
      mocks.resolveOtpAccountCoreDataContextByIdentifierFromHono.mockResolvedValueOnce({
        ...accountData,
        user: { ...accountData.user, active: 0 },
      });
      await send({}, routed);
      expect(mocks.provisionTenantD1EmailAccount).toHaveBeenCalledTimes(2);
    });

    it('sends to a routed account without making another', async () => {
      const { response } = await send({}, routed);
      expect(response.status).toBe(200);
      expect(mocks.provisionTenantD1EmailAccount).not.toHaveBeenCalled();
      expect(storedCodes()[0]).toMatchObject({ userId: 'user_existing' });
    });
  });
});
