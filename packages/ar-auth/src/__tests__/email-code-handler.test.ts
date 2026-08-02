import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findByEmail: vi.fn(),
  findById: vi.fn(),
  syncUser: vi.fn(),
  markEmailVerifiedAndTouchLastLogin: vi.fn(),
  validateRegistration: vi.fn(),
  buildCanonicalFields: vi.fn(),
  persistRegistrationFields: vi.fn(),
  generateCode: vi.fn(),
  hashCode: vi.fn(),
  verifyCode: vi.fn(),
  hashEmail: vi.fn(),
  storeChallengeRpc: vi.fn(),
  consumeChallengeRpc: vi.fn(),
  notifierSend: vi.fn(),
  getNotifier: vi.fn(),
  incrementRpc: vi.fn(),
  createSessionRpc: vi.fn(),
  getExistingSessionRpc: vi.fn(),
  updateExistingSessionRpc: vi.fn(),
  publishEvent: vi.fn(),
  createAuditLog: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  createAccountAuthContextFromHono: vi.fn(() => ({ coreAdapter: {} })),
  resolveAccountDataContextByIdentifierFromHono: vi.fn(),
  resolveAccountDataContextFromHono: vi.fn(),
  provisionTenantD1EmailAccount: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-1'),
    getTenantMetadataContextFromHono: vi.fn((c) =>
      c.env.__TENANT_D1
        ? { tenantId: 'tenant-1', storageProfileId: 'builtin:storage:tenant-d1' }
        : undefined
    ),
    resolveAccountDataContextByIdentifierFromHono:
      mocks.resolveAccountDataContextByIdentifierFromHono,
    resolveAccountDataContextFromHono: mocks.resolveAccountDataContextFromHono,
    createAccountAuthContextFromHono: mocks.createAccountAuthContextFromHono,
    createPIIContextFromHono: vi.fn(() => ({ defaultPiiAdapter: {} })),
    CanonicalRuntimeUserStore: class {
      findByEmail = mocks.findByEmail;
      findById = mocks.findById;
      syncUser = mocks.syncUser;
      markEmailVerifiedAndTouchLastLogin = mocks.markEmailVerifiedAndTouchLastLogin;
    },
    generateUserIdFromSettings: vi.fn(async () => 'new-user-1'),
    getChallengeStoreByChallengeId: vi.fn(async () => ({
      storeChallengeRpc: mocks.storeChallengeRpc,
      consumeChallengeRpc: mocks.consumeChallengeRpc,
    })),
    getRequiredPluginContext: vi.fn(() => ({
      registry: { getNotifier: mocks.getNotifier },
    })),
    produceNotificationDelivery: vi.fn(async (_env, input) => {
      const notifier = mocks.getNotifier('email');
      if (!notifier) throw new Error('notification_delivery_provider_order_unavailable');
      const result = await notifier.send(input.payload);
      return {
        reference: { intentId: input.intentId },
        bindingRef: 'TDB_SHARED_CORE',
        delivery: result.success ? 'delivered' : 'permanent_failure',
      };
    }),
    getSessionStoreForNewSession: vi.fn(async () => ({
      stub: { createSessionRpc: mocks.createSessionRpc },
      sessionId: 'session-1',
    })),
    getSessionStoreBySessionId: vi.fn(() => ({
      stub: {
        getSessionRpc: mocks.getExistingSessionRpc,
        updateSessionDataRpc: mocks.updateExistingSessionRpc,
      },
    })),
    generateBrowserState: vi.fn(async () => 'browser-state-1'),
    getSessionCookieSameSite: vi.fn(() => 'Lax'),
    getBrowserStateCookieSameSite: vi.fn(() => 'Lax'),
    publishEvent: mocks.publishEvent,
    createAuditLog: mocks.createAuditLog,
    getLogger: vi.fn(() => ({
      module: () => ({ error: mocks.error, warn: mocks.warn }),
    })),
  };
});

vi.mock('../utils/email-code-utils', () => ({
  generateEmailCode: mocks.generateCode,
  hashEmailCode: mocks.hashCode,
  verifyEmailCodeHash: mocks.verifyCode,
  hashEmail: mocks.hashEmail,
}));

vi.mock('../registration-field-utils', () => ({
  validateRegistrationFieldSubmissionFromEnv: mocks.validateRegistration,
  buildCanonicalProfileRuntimeUserFields: mocks.buildCanonicalFields,
  persistRegistrationFieldValuesFromEnv: mocks.persistRegistrationFields,
}));

vi.mock('../issuer', () => ({
  getRequestIssuer: vi.fn(() => 'https://auth.example.com'),
}));

vi.mock('../account-provisioning', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../account-provisioning')>();
  return {
    ...actual,
    provisionTenantD1EmailAccount: mocks.provisionTenantD1EmailAccount,
  };
});

import { emailCodeSendHandler, emailCodeVerifyHandler } from '../email-code';

function env(overrides: Record<string, unknown> = {}) {
  return {
    ISSUER_URL: 'https://auth.example.com',
    RATE_LIMITER: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ incrementRpc: mocks.incrementRpc })),
    },
    ...overrides,
  };
}

function app() {
  const instance = new Hono();
  instance.post('/send', emailCodeSendHandler);
  instance.post('/verify', emailCodeVerifyHandler);
  return instance;
}

async function post(
  path: '/send' | '/verify',
  body: unknown,
  bindings: Record<string, unknown> = {},
  cookie?: string
) {
  const executionCtx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  };
  const responsePromise = app().request(
    path,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        'CF-Connecting-IP': '192.0.2.20',
        'User-Agent': 'Authrim Email Test',
      },
      body: JSON.stringify(body),
    },
    env(bindings),
    executionCtx
  );
  await vi.runAllTimersAsync();
  return responsePromise;
}

const validChallenge = {
  challenge: 'hashed-code',
  userId: 'user-1',
  email: 'user@example.com',
  metadata: {
    email_hash: 'email-hash',
    otp_session_id: 'otp-session-1',
    issued_at: 1_900_000_000,
    purpose: 'login',
  },
};

describe('email code handlers through HTTP', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000000');
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.createAccountAuthContextFromHono.mockReturnValue({ coreAdapter: {} });
    mocks.incrementRpc.mockResolvedValue({ allowed: true, retryAfter: 0 });
    mocks.findByEmail.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      name: 'User',
    });
    mocks.findById.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      name: 'User',
      active: 1,
      email_verified: 0,
    });
    mocks.validateRegistration.mockResolvedValue({ ok: true, values: {} });
    mocks.buildCanonicalFields.mockReturnValue({ piiFields: {}, sensitiveValues: {} });
    mocks.generateCode.mockReturnValue('123456');
    mocks.hashCode.mockResolvedValue('hashed-code');
    mocks.hashEmail.mockResolvedValue('email-hash');
    mocks.storeChallengeRpc.mockResolvedValue(undefined);
    mocks.consumeChallengeRpc.mockResolvedValue(validChallenge);
    mocks.verifyCode.mockResolvedValue(true);
    mocks.getNotifier.mockReturnValue({ send: mocks.notifierSend });
    mocks.notifierSend.mockResolvedValue({ success: true, messageId: 'message-1' });
    mocks.createSessionRpc.mockResolvedValue(undefined);
    mocks.getExistingSessionRpc.mockResolvedValue(null);
    mocks.updateExistingSessionRpc.mockResolvedValue(undefined);
    mocks.syncUser.mockResolvedValue(undefined);
    mocks.markEmailVerifiedAndTouchLastLogin.mockResolvedValue(undefined);
    mocks.persistRegistrationFields.mockResolvedValue(undefined);
    mocks.publishEvent.mockResolvedValue(undefined);
    mocks.createAuditLog.mockResolvedValue(undefined);
    mocks.resolveAccountDataContextByIdentifierFromHono.mockResolvedValue({});
    mocks.resolveAccountDataContextFromHono.mockResolvedValue({});
    mocks.provisionTenantD1EmailAccount.mockResolvedValue({
      status: 'ready',
      accountId: 'account:new-user-1',
      userId: 'new-user-1',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('send', () => {
    it.each([{}, { email: 'invalid' }, { email: 'user @example.com' }])(
      'rejects malformed input before rate limiting: %j',
      async (body) => {
        const response = await post('/send', body);
        expect(response.status).toBe(400);
        expect(mocks.incrementRpc).not.toHaveBeenCalled();
      }
    );

    it('rate limits on normalized email without issuing a challenge', async () => {
      mocks.incrementRpc.mockResolvedValueOnce({ allowed: false, retryAfter: 120 });

      const response = await post('/send', { email: 'User@Example.com' });

      expect(response.status).toBe(429);
      expect(mocks.incrementRpc).toHaveBeenCalledWith('email_code:user@example.com', {
        windowSeconds: 900,
        maxRequests: 3,
      });
      expect(mocks.generateCode).not.toHaveBeenCalled();
    });

    it('rejects missing registration fields before creating a new user', async () => {
      mocks.findByEmail.mockResolvedValueOnce(null);
      mocks.validateRegistration.mockResolvedValueOnce({
        ok: false,
        error: 'required',
        missingRequiredFields: [{ fieldKey: 'department', label: 'Department', fieldType: 'text' }],
      });

      const response = await post('/send', { email: 'new@example.com' });

      expect(response.status).toBe(400);
      expect(mocks.syncUser).not.toHaveBeenCalled();
      expect(mocks.storeChallengeRpc).not.toHaveBeenCalled();
    });

    it('does not leak PII when canonical user creation fails', async () => {
      mocks.findByEmail.mockResolvedValueOnce(null);
      mocks.syncUser.mockRejectedValueOnce(new Error('sensitive database detail'));

      const response = await post('/send', { email: 'new@example.com', name: 'New User' });

      expect(response.status).toBe(500);
      expect(mocks.error).toHaveBeenCalledWith(
        'Failed to create canonical runtime user',
        { action: 'runtime_user_create' },
        expect.any(Error)
      );
      expect(mocks.storeChallengeRpc).not.toHaveBeenCalled();
    });

    it('fails closed before challenge storage when OTP secret is absent', async () => {
      const response = await post('/send', { email: 'user@example.com' });

      expect(response.status).toBe(500);
      expect(mocks.hashCode).not.toHaveBeenCalled();
      expect(mocks.storeChallengeRpc).not.toHaveBeenCalled();
    });

    it('stores only the hashed OTP and sends the plaintext through the notifier', async () => {
      const response = await post(
        '/send',
        { email: 'User@Example.com' },
        { OTP_HMAC_SECRET: 'private-secret', EMAIL_FROM: 'login@example.com' }
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        success: true,
        messageId: 'email-code:00000000-0000-4000-8000-000000000000',
      });
      expect(mocks.storeChallengeRpc).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          type: 'email_code',
          userId: 'user-1',
          challenge: 'hashed-code',
          ttl: 300,
          email: 'user@example.com',
        })
      );
      expect(JSON.stringify(mocks.storeChallengeRpc.mock.calls)).not.toContain('123456');
      expect(mocks.notifierSend).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'User@Example.com',
          from: 'login@example.com',
          body: expect.stringContaining('123456'),
        })
      );
      expect(response.headers.get('set-cookie')).toContain(
        'authrim_otp_session=00000000-0000-4000-8000-000000000000'
      );
    });

    it('creates a new canonical user with validated custom fields', async () => {
      mocks.findByEmail.mockResolvedValueOnce(null);
      mocks.validateRegistration.mockResolvedValueOnce({
        ok: true,
        values: { department: 'Security' },
      });

      const response = await post(
        '/send',
        {
          email: 'New@Example.com',
          name: 'New User',
          custom_fields: { department: 'Security' },
        },
        { OTP_HMAC_SECRET: 'private-secret' }
      );

      expect(response.status).toBe(200);
      expect(mocks.syncUser).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'new-user-1',
          email: 'new@example.com',
          name: 'New User',
          emailVerified: false,
          userType: 'end_user',
        })
      );
      expect(mocks.storeChallengeRpc).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ custom_fields: { department: 'Security' } }),
        })
      );
    });

    it('returns 202 and does not create an OTP while tenant-D1 publication is pending', async () => {
      mocks.resolveAccountDataContextByIdentifierFromHono.mockRejectedValueOnce(
        new Error('account_data_route_not_found')
      );
      mocks.provisionTenantD1EmailAccount.mockResolvedValueOnce({
        status: 'pending',
        response: Response.json(
          {
            status: 'provisioning',
            provisioning_token: 'A'.repeat(43),
            status_endpoint: '/api/v1/auth/account-provisioning/status',
            retry_after_ms: 500,
          },
          { status: 202 }
        ),
      });

      const response = await post(
        '/send',
        { email: 'new@example.com', name: 'New User' },
        { OTP_HMAC_SECRET: 'private-secret', __TENANT_D1: true }
      );

      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ status: 'provisioning' });
      expect(mocks.provisionTenantD1EmailAccount).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          tenantId: 'tenant-1',
          flow: 'email_code',
          email: 'new@example.com',
          runtimeUser: expect.objectContaining({
            sourceRef: 'auth:email_code',
            sensitiveValues: expect.objectContaining({
              email: 'new@example.com',
              name: 'New User',
            }),
          }),
        })
      );
      expect(mocks.syncUser).not.toHaveBeenCalled();
      expect(mocks.storeChallengeRpc).not.toHaveBeenCalled();
      expect(mocks.notifierSend).not.toHaveBeenCalled();
    });

    it('returns a generic error when no notifier is configured', async () => {
      mocks.getNotifier.mockReturnValueOnce(null);

      const response = await post(
        '/send',
        { email: 'user@example.com' },
        { OTP_HMAC_SECRET: 'private-secret' }
      );

      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain('123456');
    });

    it('returns a generic error when delivery fails', async () => {
      mocks.notifierSend.mockResolvedValueOnce({ success: false, error: 'provider rejected' });

      const response = await post(
        '/send',
        { email: 'user@example.com' },
        { OTP_HMAC_SECRET: 'private-secret' }
      );

      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain('provider rejected');
    });
  });

  describe('verify', () => {
    const cookie = 'authrim_otp_session=otp-session-1';

    it.each([
      [{ email: 'user@example.com' }, cookie, 400],
      [{ code: '123456' }, cookie, 400],
      [{ code: '12345', email: 'user@example.com' }, cookie, 400],
      [{ code: 'abcdef', email: 'user@example.com' }, cookie, 400],
      [{ code: '123456', email: 'user@example.com' }, undefined, 401],
    ])('rejects invalid or unbound verification input', async (body, requestCookie, status) => {
      const response = await post('/verify', body, {}, requestCookie);
      expect(response.status).toBe(status);
      expect(mocks.consumeChallengeRpc).not.toHaveBeenCalled();
    });

    it('maps missing, expired, and replayed challenges to the same error', async () => {
      mocks.consumeChallengeRpc.mockRejectedValueOnce(new Error('already consumed'));

      const response = await post(
        '/verify',
        { code: '123456', email: 'user@example.com' },
        {},
        cookie
      );

      expect(response.status).toBe(400);
      expect(mocks.verifyCode).not.toHaveBeenCalled();
      expect(mocks.publishEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ data: expect.objectContaining({ errorCode: 'challenge_error' }) })
      );
    });

    it.each([
      [
        { ...validChallenge, metadata: { ...validChallenge.metadata, otp_session_id: 'other' } },
        400,
      ],
      [{ ...validChallenge, email: 'other@example.com' }, 400],
    ])('rejects challenge binding mismatch', async (challenge, status) => {
      mocks.consumeChallengeRpc.mockResolvedValueOnce(challenge);

      const response = await post(
        '/verify',
        { code: '123456', email: 'user@example.com' },
        {},
        cookie
      );

      expect(response.status).toBe(status);
      expect(mocks.verifyCode).not.toHaveBeenCalled();
    });

    it('fails closed after consumption when the OTP secret is absent', async () => {
      const response = await post(
        '/verify',
        { code: '123456', email: 'user@example.com' },
        {},
        cookie
      );

      expect(response.status).toBe(500);
      expect(mocks.verifyCode).not.toHaveBeenCalled();
    });

    it('rejects an invalid code without creating a session', async () => {
      mocks.verifyCode.mockResolvedValueOnce(false);

      const response = await post(
        '/verify',
        { code: '123456', email: 'user@example.com' },
        { OTP_HMAC_SECRET: 'private-secret' },
        cookie
      );

      expect(response.status).toBe(400);
      expect(mocks.createSessionRpc).not.toHaveBeenCalled();
    });

    it.each([null, { ...validChallenge, active: 0 }])(
      'rejects a missing or inactive canonical user',
      async (runtimeUser) => {
        mocks.findById.mockResolvedValueOnce(runtimeUser);

        const response = await post(
          '/verify',
          { code: '123456', email: 'user@example.com' },
          { OTP_HMAC_SECRET: 'private-secret' },
          cookie
        );

        expect(response.status).toBe(400);
        expect(mocks.createSessionRpc).not.toHaveBeenCalled();
        expect(mocks.warn).toHaveBeenCalledWith(
          'Canonical runtime user unavailable after account route resolution',
          expect.objectContaining({
            action: 'email_code_verify_user_read',
            runtimeUserState: runtimeUser ? 'inactive' : 'missing',
          })
        );
      }
    );

    it('creates a session, clears the OTP cookie, and records observable side effects', async () => {
      const response = await post(
        '/verify',
        { code: '123456', email: 'USER@example.com' },
        { OTP_HMAC_SECRET: 'private-secret' },
        cookie
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        success: true,
        sessionId: 'session-1',
        userId: 'user-1',
      });
      expect(mocks.createSessionRpc).toHaveBeenCalledWith(
        'session-1',
        'user-1',
        86_400,
        expect.objectContaining({ email: 'user@example.com', amr: ['otp'] }),
        'tenant-1'
      );
      expect(response.headers.get('set-cookie')).toContain('authrim_otp_session=;');
      expect(response.headers.get('set-cookie')).toContain('authrim_session=session-1');
      expect(mocks.markEmailVerifiedAndTouchLastLogin).toHaveBeenCalledWith(
        'user-1',
        expect.any(Number)
      );
      expect(mocks.createAuditLog).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          tenantId: 'tenant-1',
          userId: 'user-1',
          resourceId: 'session-1',
          ipAddress: '192.0.2.20',
        })
      );
    });

    it('resolves the challenge account route before tenant-D1 user reads', async () => {
      const response = await post(
        '/verify',
        { code: '123456', email: 'user@example.com' },
        { OTP_HMAC_SECRET: 'private-secret', __TENANT_D1: true },
        cookie
      );

      expect(response.status).toBe(200);
      expect(mocks.resolveAccountDataContextFromHono).toHaveBeenCalledWith(
        expect.anything(),
        'account:user-1'
      );
      expect(mocks.createAccountAuthContextFromHono).toHaveBeenCalledWith(
        expect.anything(),
        'tenant-1'
      );
      expect(mocks.findById).toHaveBeenCalledWith('user-1', { includeInactive: true });
    });

    it('fails closed when the consumed challenge cannot resolve a tenant-D1 account route', async () => {
      mocks.resolveAccountDataContextFromHono.mockRejectedValueOnce(
        new Error('account_data_route_not_found')
      );

      const response = await post(
        '/verify',
        { code: '123456', email: 'user@example.com' },
        { OTP_HMAC_SECRET: 'private-secret', __TENANT_D1: true },
        cookie
      );

      expect(response.status).toBe(500);
      expect(mocks.findById).not.toHaveBeenCalled();
      expect(mocks.createSessionRpc).not.toHaveBeenCalled();
    });

    it('does not add account routing to the standard storage verification path', async () => {
      const response = await post(
        '/verify',
        { code: '123456', email: 'user@example.com' },
        { OTP_HMAC_SECRET: 'private-secret' },
        cookie
      );

      expect(response.status).toBe(200);
      expect(mocks.resolveAccountDataContextFromHono).not.toHaveBeenCalled();
    });

    it('continues login when optional custom-field persistence fails', async () => {
      mocks.consumeChallengeRpc.mockResolvedValueOnce({
        ...validChallenge,
        metadata: { ...validChallenge.metadata, custom_fields: { department: 'Security' } },
      });
      mocks.persistRegistrationFields.mockRejectedValueOnce(new Error('storage unavailable'));

      const response = await post(
        '/verify',
        { code: '123456', email: 'user@example.com' },
        { OTP_HMAC_SECRET: 'private-secret' },
        cookie
      );

      expect(response.status).toBe(200);
      expect(mocks.warn).toHaveBeenCalledWith(
        'Failed to persist registration field values',
        { action: 'registration_fields_persist' },
        expect.any(Error)
      );
    });

    it('upgrades an unverified anonymous session without creating a replacement session', async () => {
      mocks.getExistingSessionRpc.mockResolvedValueOnce({ data: { is_anonymous: true } });

      const response = await post(
        '/verify',
        { code: '123456', email: 'user@example.com' },
        { OTP_HMAC_SECRET: 'private-secret' },
        `${cookie}; authrim_session=anonymous-session-1`
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ sessionId: 'anonymous-session-1' });
      expect(mocks.updateExistingSessionRpc).toHaveBeenCalledWith(
        'anonymous-session-1',
        expect.objectContaining({
          verified_email: 'user@example.com',
          verified_email_user_id: 'user-1',
          upgrade_nonce: expect.any(String),
        })
      );
      expect(mocks.createSessionRpc).not.toHaveBeenCalled();
    });

    it('does not attach an already verified account to an anonymous session', async () => {
      mocks.findById.mockResolvedValueOnce({
        id: 'user-1',
        email: 'user@example.com',
        name: 'User',
        active: 1,
        email_verified: 1,
      });
      mocks.getExistingSessionRpc.mockResolvedValueOnce({ data: { is_anonymous: true } });

      const response = await post(
        '/verify',
        { code: '123456', email: 'user@example.com' },
        { OTP_HMAC_SECRET: 'private-secret' },
        `${cookie}; authrim_session=anonymous-session-1`
      );

      expect(response.status).toBe(200);
      expect(mocks.updateExistingSessionRpc).not.toHaveBeenCalled();
      expect(mocks.createSessionRpc).toHaveBeenCalled();
    });

    it('returns a stable session-store error when session creation fails', async () => {
      mocks.createSessionRpc.mockRejectedValueOnce(new Error('DO unavailable'));

      const response = await post(
        '/verify',
        { code: '123456', email: 'user@example.com' },
        { OTP_HMAC_SECRET: 'private-secret' },
        cookie
      );

      expect(response.status).toBe(500);
      expect(mocks.publishEvent).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ data: expect.objectContaining({ sessionId: 'session-1' }) })
      );
    });
  });
});
