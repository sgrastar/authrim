import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const {
  mockChallengeStore,
  mockSessionStore,
  mockRateLimiter,
  mockTotpRepo,
  mockRuntimeUserStore,
  mockGetChallengeStoreByChallengeId,
  mockGetSessionStoreForNewSession,
  mockGetTenantIdFromContext,
  mockCreateAuthContextFromHono,
  mockCreatePIIContextFromHono,
  mockPublishEvent,
  mockCreateAuditLog,
  mockResolvePostLoginRedirectUrl,
  mockConsumeAuthorizationChallengeContinuation,
  mockValidateRegistrationFieldSubmissionFromEnv,
  mockPersistRegistrationFieldValuesFromEnv,
  mockBuildCanonicalProfileRuntimeUserFields,
} = vi.hoisted(() => {
  const challengeStore = {
    storeChallengeRpc: vi.fn(),
    getChallengeRpc: vi.fn(),
    consumeChallengeRpc: vi.fn(),
    deleteChallengeRpc: vi.fn(),
  };
  const sessionStore = {
    createSessionRpc: vi.fn(),
  };
  const rateLimiter = {
    incrementRpc: vi.fn(),
  };
  const totpRepo = {
    create: vi.fn(),
    findById: vi.fn(),
    findActiveByUserId: vi.fn(),
    activate: vi.fn(),
    markUsed: vi.fn(),
    replaceBackupCodes: vi.fn(),
  };
  return {
    mockChallengeStore: challengeStore,
    mockSessionStore: sessionStore,
    mockRateLimiter: rateLimiter,
    mockTotpRepo: totpRepo,
    mockRuntimeUserStore: {
      findByEmail: vi.fn(),
      findByPreferredUsername: vi.fn(),
      findById: vi.fn(),
      syncUser: vi.fn(),
      touchLastLogin: vi.fn(),
    },
    mockGetChallengeStoreByChallengeId: vi.fn().mockResolvedValue(challengeStore),
    mockGetSessionStoreForNewSession: vi.fn().mockResolvedValue({
      stub: sessionStore,
      sessionId: 'g1:apac:3:session_new',
    }),
    mockGetTenantIdFromContext: vi.fn().mockReturnValue('default'),
    mockCreateAuthContextFromHono: vi.fn().mockReturnValue({
      repositories: { totp: totpRepo },
      coreAdapter: {},
    }),
    mockCreatePIIContextFromHono: vi.fn().mockReturnValue({ defaultPiiAdapter: {} }),
    mockPublishEvent: vi.fn().mockResolvedValue(undefined),
    mockCreateAuditLog: vi.fn().mockResolvedValue(undefined),
    mockResolvePostLoginRedirectUrl: vi.fn().mockResolvedValue({ redirectUrl: '/' }),
    mockConsumeAuthorizationChallengeContinuation: vi.fn(),
    mockValidateRegistrationFieldSubmissionFromEnv: vi.fn().mockResolvedValue({
      ok: true,
      values: {},
      schemas: [],
    }),
    mockPersistRegistrationFieldValuesFromEnv: vi.fn().mockResolvedValue(undefined),
    mockBuildCanonicalProfileRuntimeUserFields: vi.fn().mockReturnValue({
      piiFields: {},
      sensitiveValues: {},
    }),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getChallengeStoreByChallengeId: mockGetChallengeStoreByChallengeId,
    getSessionStoreForNewSession: mockGetSessionStoreForNewSession,
    getTenantIdFromContext: mockGetTenantIdFromContext,
    createAuthContextFromHono: mockCreateAuthContextFromHono,
    createPIIContextFromHono: mockCreatePIIContextFromHono,
    CanonicalRuntimeUserStore: vi.fn(function CanonicalRuntimeUserStoreMock() {
      return mockRuntimeUserStore;
    }),
    publishEvent: mockPublishEvent,
    createAuditLog: mockCreateAuditLog,
    resolvePostLoginRedirectUrl: mockResolvePostLoginRedirectUrl,
    getLogger: () => ({
      module: () => ({
        error: vi.fn(),
      }),
    }),
  };
});

vi.mock('../direct-auth', () => ({
  consumeAuthorizationChallengeContinuation: mockConsumeAuthorizationChallengeContinuation,
}));

vi.mock('../registration-field-utils', () => ({
  validateRegistrationFieldSubmissionFromEnv: mockValidateRegistrationFieldSubmissionFromEnv,
  persistRegistrationFieldValuesFromEnv: mockPersistRegistrationFieldValuesFromEnv,
  buildCanonicalProfileRuntimeUserFields: mockBuildCanonicalProfileRuntimeUserFields,
}));

import {
  encryptValue,
  generateTotpCode,
  getTotpTimeStep,
  type TotpProfile,
} from '@authrim/ar-lib-core';
import {
  totpLoginStartHandler,
  totpLoginVerifyHandler,
  totpSignupActivateHandler,
  totpSignupOptionsHandler,
} from '../totp';

const encryptionKey = '11'.repeat(32);

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/api/auth/totp/login/start', totpLoginStartHandler);
  app.post('/api/auth/totp/login/verify', totpLoginVerifyHandler);
  app.post('/api/auth/totp/signup/options', totpSignupOptionsHandler);
  app.post('/api/auth/totp/signup/activate', totpSignupActivateHandler);
  return app;
}

function createEnv(settings: Record<string, unknown> = {}): Env {
  return {
    ISSUER_URL: 'https://op.example.com',
    PII_ENCRYPTION_KEY: encryptionKey,
    OTP_HMAC_SECRET: 'test-hmac-secret',
    SETTINGS: {
      get: vi.fn(async (key: string) => {
        const value = settings[key];
        return value === undefined ? null : JSON.stringify(value);
      }),
    },
    RATE_LIMITER: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => mockRateLimiter),
    },
  } as unknown as Env;
}

async function resolveConstantTimeResponse<T>(promise: T | Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(700);
  return promise;
}

describe('TOTP login handlers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-23T00:00:00Z'));
    vi.clearAllMocks();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    mockRateLimiter.incrementRpc.mockResolvedValue({ allowed: true });
    mockChallengeStore.storeChallengeRpc.mockResolvedValue({ success: true });
    mockChallengeStore.getChallengeRpc.mockResolvedValue(null);
    mockSessionStore.createSessionRpc.mockResolvedValue({ success: true });
    mockChallengeStore.deleteChallengeRpc.mockResolvedValue({ deleted: true });
    mockTotpRepo.findActiveByUserId.mockResolvedValue([]);
    mockTotpRepo.findById.mockResolvedValue(null);
    mockTotpRepo.activate.mockResolvedValue(null);
    mockTotpRepo.markUsed.mockResolvedValue(true);
    mockTotpRepo.replaceBackupCodes.mockResolvedValue([]);
    mockRuntimeUserStore.findByEmail.mockResolvedValue(null);
    mockRuntimeUserStore.findByPreferredUsername.mockResolvedValue(null);
    mockRuntimeUserStore.findById.mockResolvedValue(null);
    mockRuntimeUserStore.syncUser.mockResolvedValue(undefined);
    mockRuntimeUserStore.touchLastLogin.mockResolvedValue(true);
    mockResolvePostLoginRedirectUrl.mockResolvedValue({ redirectUrl: '/' });
    mockConsumeAuthorizationChallengeContinuation.mockResolvedValue({
      type: 'login',
      redirectUrl: 'https://rp.example.com/callback?code=abc&state=xyz',
    });
    mockValidateRegistrationFieldSubmissionFromEnv.mockResolvedValue({
      ok: true,
      values: {},
      schemas: [],
    });
    mockPersistRegistrationFieldValuesFromEnv.mockResolvedValue(undefined);
    mockBuildCanonicalProfileRuntimeUserFields.mockReturnValue({
      piiFields: {},
      sensitiveValues: {},
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const enabledSettings = {
    'settings:tenant:default:authentication-methods': {
      'authentication-methods.totp.login_enabled': true,
      'authentication-methods.totp.signup_enabled': true,
    },
  };

  async function post(
    path: string,
    body: Record<string, unknown>,
    env = createEnv(enabledSettings),
    constantTime = false
  ) {
    const responsePromise = createApp().request(
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
        body: JSON.stringify(body),
      },
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext
    );
    return constantTime ? resolveConstantTimeResponse(responsePromise) : responsePromise;
  }

  describe('rejection and enumeration-resistance boundaries', () => {
    it.each([
      [{}, 'missing identifier'],
      [{ identifier: '   ' }, 'blank identifier'],
      [{ identifier: 42 }, 'non-string identifier'],
    ])('rejects login start with %s', async (body, _case) => {
      const response = await post('/api/auth/totp/login/start', body, undefined, true);

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(mockChallengeStore.storeChallengeRpc).not.toHaveBeenCalled();
    });

    it('does not issue a login challenge when TOTP login is disabled', async () => {
      const response = await post(
        '/api/auth/totp/login/start',
        { identifier: 'person@example.com' },
        createEnv(),
        true
      );

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(mockRuntimeUserStore.findByEmail).not.toHaveBeenCalled();
    });

    it('rate limits login challenge creation before user lookup', async () => {
      mockRateLimiter.incrementRpc.mockResolvedValueOnce({ allowed: false, retryAfter: 30 });

      const response = await post(
        '/api/auth/totp/login/start',
        { identifier: 'person@example.com' },
        undefined,
        true
      );

      expect(response.status).toBe(429);
      expect(mockRuntimeUserStore.findByEmail).not.toHaveBeenCalled();
      expect(mockChallengeStore.storeChallengeRpc).not.toHaveBeenCalled();
    });

    it.each([
      [{}, 'missing challenge and code'],
      [{ challenge_id: 'challenge' }, 'missing code'],
      [{ challenge_id: 'challenge', code: '12ab56' }, 'non-numeric code'],
      [{ challenge_id: 'challenge', code: '12345' }, 'wrong-length code'],
    ])('rejects login verification with %s', async (body, _case) => {
      const response = await post('/api/auth/totp/login/verify', body, undefined, true);

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(mockChallengeStore.consumeChallengeRpc).not.toHaveBeenCalled();
    });

    it('normalizes challenge-store failures to the same invalid-code response', async () => {
      mockChallengeStore.consumeChallengeRpc.mockRejectedValueOnce(
        new Error('storage unavailable')
      );

      const response = await post(
        '/api/auth/totp/login/verify',
        { challenge_id: 'challenge', code: '123456' },
        undefined,
        true
      );

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(mockPublishEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ data: expect.objectContaining({ errorCode: 'challenge_error' }) })
      );
    });

    it.each([
      [undefined, 'missing user identity'],
      ['unknown', 'enumeration-resistant unknown identity'],
    ])('does not reveal %s from a consumed challenge', async (userId, _case) => {
      mockChallengeStore.consumeChallengeRpc.mockResolvedValueOnce({ userId });

      const response = await post(
        '/api/auth/totp/login/verify',
        { challenge_id: 'challenge', code: '123456' },
        undefined,
        true
      );

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(mockRuntimeUserStore.findById).not.toHaveBeenCalled();
    });

    it('fails closed when the TOTP encryption key is absent', async () => {
      mockChallengeStore.consumeChallengeRpc.mockResolvedValueOnce({ userId: 'user-1' });
      const env = createEnv(enabledSettings);
      delete (env as unknown as Record<string, unknown>).PII_ENCRYPTION_KEY;

      const response = await post(
        '/api/auth/totp/login/verify',
        { challenge_id: 'challenge', code: '123456' },
        env,
        true
      );

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(mockTotpRepo.findActiveByUserId).not.toHaveBeenCalled();
    });

    it.each([
      [null, [], 'missing user'],
      [{ id: 'user-1', active: 0 }, [], 'inactive user'],
      [{ id: 'user-1', active: 1 }, [], 'no active credential'],
    ])('returns one generic failure for %s', async (user, credentials, _case) => {
      mockChallengeStore.consumeChallengeRpc.mockResolvedValueOnce({ userId: 'user-1' });
      mockRuntimeUserStore.findById.mockResolvedValueOnce(user);
      mockTotpRepo.findActiveByUserId.mockResolvedValueOnce(credentials);

      const response = await post(
        '/api/auth/totp/login/verify',
        { challenge_id: 'challenge', code: '123456' },
        undefined,
        true
      );

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(mockSessionStore.createSessionRpc).not.toHaveBeenCalled();
    });

    it.each([
      [{}, 'missing email'],
      [{ email: 'not-an-email' }, 'invalid email'],
      [{ email: 'person@example.com', label: 'x'.repeat(129) }, 'oversized label'],
    ])('rejects signup options with %s', async (body, _case) => {
      const response = await post('/api/auth/totp/signup/options', body);

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(mockChallengeStore.storeChallengeRpc).not.toHaveBeenCalled();
    });

    it('requires both encryption and HMAC secrets before generating a TOTP seed', async () => {
      const env = createEnv(enabledSettings);
      delete (env as unknown as Record<string, unknown>).OTP_HMAC_SECRET;

      const response = await post(
        '/api/auth/totp/signup/options',
        { email: 'person@example.com' },
        env
      );

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(mockRuntimeUserStore.findByEmail).not.toHaveBeenCalled();
    });

    it('returns registration schema details when required custom fields are missing', async () => {
      mockValidateRegistrationFieldSubmissionFromEnv.mockResolvedValueOnce({
        ok: false,
        error: 'Department is required',
        missingRequiredFields: [
          { fieldKey: 'department', label: 'Department', fieldType: 'string' },
        ],
      });

      const response = await post('/api/auth/totp/signup/options', {
        email: 'person@example.com',
        custom_fields: [],
      });
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(body)).toContain('department');
      expect(mockChallengeStore.storeChallengeRpc).not.toHaveBeenCalled();
    });

    it('does not allow TOTP signup to claim an existing email address', async () => {
      mockRuntimeUserStore.findByEmail.mockResolvedValueOnce({ id: 'existing-user', active: 1 });

      const response = await post('/api/auth/totp/signup/options', {
        email: 'person@example.com',
      });

      expect(response.status).toBe(409);
      expect(mockChallengeStore.storeChallengeRpc).not.toHaveBeenCalled();
    });

    it.each([
      [{}, 'missing challenge and code'],
      [{ challenge_id: 'challenge' }, 'missing activation code'],
    ])('rejects signup activation with %s', async (body, _case) => {
      const response = await post('/api/auth/totp/signup/activate', body);

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(mockChallengeStore.getChallengeRpc).not.toHaveBeenCalled();
    });

    it('rejects missing or mismatched signup challenge metadata', async () => {
      mockChallengeStore.getChallengeRpc.mockResolvedValueOnce({
        userId: 'user-1',
        challenge: 'different',
        metadata: { credential_id: 'credential-1' },
      });

      const response = await post('/api/auth/totp/signup/activate', {
        challenge_id: 'challenge',
        code: '123456',
      });

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(mockTotpRepo.findById).not.toHaveBeenCalled();
    });
  });

  it('starts a login challenge without exposing unknown identifiers', async () => {
    const app = createApp();
    const responsePromise = app.request(
      '/api/auth/totp/login/start',
      {
        method: 'POST',
        body: JSON.stringify({ identifier: 'unknown@example.com' }),
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
      },
      createEnv({
        'settings:tenant:default:authentication-methods': {
          'authentication-methods.totp.login_enabled': true,
        },
      })
    );

    const response = await resolveConstantTimeResponse(responsePromise);
    const body = (await response.json()) as { challenge_id: string; expires_in: number };

    expect(response.status).toBe(200);
    expect(body.challenge_id).toEqual(expect.any(String));
    expect(body.expires_in).toBe(300);
    expect(mockChallengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'totp_login',
        userId: 'unknown',
      })
    );
  });

  it('verifies a TOTP code and creates an otp/totp session', async () => {
    const app = createApp();
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const encrypted = await encryptValue(secret, encryptionKey, 'AES-256-GCM', 1);
    const profile: TotpProfile = { algorithm: 'SHA1', digits: 6, period: 30, window: 1 };
    const timeStep = getTotpTimeStep(Date.now(), profile.period);
    const code = await generateTotpCode(secret, profile, timeStep);
    mockChallengeStore.consumeChallengeRpc.mockResolvedValue({
      userId: 'user-001',
      challenge: 'identifier-hash',
    });
    mockRuntimeUserStore.findById.mockResolvedValue({
      id: 'user-001',
      email: 'person@example.com',
      name: 'Person',
      active: 1,
    });
    mockTotpRepo.findActiveByUserId.mockResolvedValue([
      {
        id: 'totp-001',
        tenant_id: 'default',
        user_id: 'user-001',
        secret_encrypted: encrypted.encrypted,
        secret_key_version: 1,
        label: 'Authenticator app',
        ...profile,
        status: 'active',
        last_used_time_step: null,
        created_at: Date.now(),
        activated_at: Date.now(),
        last_used_at: null,
      },
    ]);

    const responsePromise = app.request(
      '/api/auth/totp/login/verify',
      {
        method: 'POST',
        body: JSON.stringify({ challenge_id: 'challenge-001', code }),
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
      },
      createEnv({
        'settings:tenant:default:authentication-methods': {
          'authentication-methods.totp.login_enabled': true,
          'authentication-methods.totp.default_acr': 'urn:authrim:aal:2',
        },
      }),
      { waitUntil: vi.fn() } as unknown as ExecutionContext
    );

    const response = await resolveConstantTimeResponse(responsePromise);
    const body = (await response.json()) as {
      success: boolean;
      sessionId: string;
      redirect_url: string;
      session: { authTime: number };
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      sessionId: 'g1:apac:3:session_new',
      redirect_url: '/',
      session: {
        authTime: Math.floor(Date.now() / 1000),
      },
    });
    expect(mockTotpRepo.markUsed).toHaveBeenCalledWith('totp-001', 'user-001', timeStep);
    expect(mockSessionStore.createSessionRpc).toHaveBeenCalledWith(
      'g1:apac:3:session_new',
      'user-001',
      expect.any(Number),
      expect.objectContaining({
        email: 'person@example.com',
        amr: ['otp', 'totp'],
        acr: 'urn:authrim:aal:2',
        authTime: Math.floor(Date.now() / 1000),
        totp_credential_id: 'totp-001',
      }),
      'default'
    );
    expect(response.headers.get('Set-Cookie')).toContain('authrim_session=');
  });

  it('continues an authorization challenge after a successful TOTP login', async () => {
    const app = createApp();
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const encrypted = await encryptValue(secret, encryptionKey, 'AES-256-GCM', 1);
    const profile: TotpProfile = { algorithm: 'SHA1', digits: 6, period: 30, window: 1 };
    const timeStep = getTotpTimeStep(Date.now(), profile.period);
    const code = await generateTotpCode(secret, profile, timeStep);
    mockChallengeStore.consumeChallengeRpc.mockResolvedValue({
      userId: 'user-001',
      challenge: 'identifier-hash',
    });
    mockRuntimeUserStore.findById.mockResolvedValue({
      id: 'user-001',
      email: 'person@example.com',
      name: 'Person',
      active: 1,
    });
    mockTotpRepo.findActiveByUserId.mockResolvedValue([
      {
        id: 'totp-001',
        tenant_id: 'default',
        user_id: 'user-001',
        secret_encrypted: encrypted.encrypted,
        secret_key_version: 1,
        label: 'Authenticator app',
        ...profile,
        status: 'active',
        last_used_time_step: null,
        created_at: Date.now(),
        activated_at: Date.now(),
        last_used_at: null,
      },
    ]);

    const responsePromise = app.request(
      '/api/auth/totp/login/verify',
      {
        method: 'POST',
        body: JSON.stringify({
          challenge_id: 'challenge-001',
          code,
          authorization_challenge_id: 'login_challenge',
        }),
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
      },
      createEnv({
        'settings:tenant:default:authentication-methods': {
          'authentication-methods.totp.login_enabled': true,
        },
      }),
      { waitUntil: vi.fn() } as unknown as ExecutionContext
    );

    const response = await resolveConstantTimeResponse(responsePromise);
    const body = (await response.json()) as {
      redirect_url: string;
      authorization?: { challenge_id?: string; type?: string };
    };

    expect(response.status).toBe(200);
    expect(mockConsumeAuthorizationChallengeContinuation).toHaveBeenCalledWith(
      expect.any(Object),
      'default',
      'login_challenge',
      'user-001',
      Math.floor(Date.now() / 1000),
      'http://localhost'
    );
    expect(body.redirect_url).toBe('https://rp.example.com/callback?code=abc&state=xyz');
    expect(body.authorization).toEqual({
      challenge_id: 'login_challenge',
      type: 'login',
    });
  });

  it('defers authorization continuation while a runtime flow is still active', async () => {
    const app = createApp();
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const encrypted = await encryptValue(secret, encryptionKey, 'AES-256-GCM', 1);
    const profile: TotpProfile = { algorithm: 'SHA1', digits: 6, period: 30, window: 1 };
    const code = await generateTotpCode(
      secret,
      profile,
      getTotpTimeStep(Date.now(), profile.period)
    );
    mockChallengeStore.consumeChallengeRpc.mockResolvedValue({
      userId: 'user-001',
      challenge: 'identifier-hash',
    });
    mockRuntimeUserStore.findById.mockResolvedValue({
      id: 'user-001',
      email: 'person@example.com',
      name: 'Person',
      active: 1,
    });
    mockTotpRepo.findActiveByUserId.mockResolvedValue([
      {
        id: 'totp-001',
        tenant_id: 'default',
        user_id: 'user-001',
        secret_encrypted: encrypted.encrypted,
        secret_key_version: 1,
        label: 'Authenticator app',
        ...profile,
        status: 'active',
        last_used_time_step: null,
        created_at: Date.now(),
        activated_at: Date.now(),
        last_used_at: null,
      },
    ]);

    const responsePromise = app.request(
      '/api/auth/totp/login/verify',
      {
        method: 'POST',
        body: JSON.stringify({
          challenge_id: 'challenge-001',
          code,
          authorization_challenge_id: 'login_challenge',
          defer_authorization_continuation: true,
        }),
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
      },
      createEnv({
        'settings:tenant:default:authentication-methods': {
          'authentication-methods.totp.login_enabled': true,
        },
      }),
      { waitUntil: vi.fn() } as unknown as ExecutionContext
    );

    const response = await resolveConstantTimeResponse(responsePromise);
    const body = (await response.json()) as { redirect_url: string; authorization?: unknown };

    expect(response.status).toBe(200);
    expect(mockConsumeAuthorizationChallengeContinuation).not.toHaveBeenCalled();
    expect(body.redirect_url).toBe('/');
    expect(body.authorization).toBeUndefined();
  });

  it('starts TOTP signup without persisting a user or credential before first-code activation', async () => {
    const app = createApp();
    const response = await app.request(
      '/api/auth/totp/signup/options',
      {
        method: 'POST',
        body: JSON.stringify({
          email: 'New.User@Example.COM',
          name: 'New User',
          label: 'Work phone',
        }),
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
      },
      createEnv({
        'settings:tenant:default:authentication-methods': {
          'authentication-methods.totp.signup_enabled': true,
        },
      }),
      { waitUntil: vi.fn() } as unknown as ExecutionContext
    );
    const body = (await response.json()) as {
      credential: { id: string; status: string; label: string };
      secret: string;
      otpauth_uri: string;
    };

    expect(response.status).toBe(201);
    expect(body.credential).toMatchObject({ status: 'pending', label: 'Work phone' });
    expect(body.otpauth_uri).toContain('new.user%40example.com');
    expect(mockRuntimeUserStore.syncUser).not.toHaveBeenCalled();
    expect(mockTotpRepo.create).not.toHaveBeenCalled();
    expect(mockChallengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'totp_signup',
        userId: expect.any(String),
        metadata: expect.objectContaining({
          credential_id: body.credential.id,
          email: 'new.user@example.com',
          name: 'New User',
          label: 'Work phone',
          secret_encrypted: expect.stringMatching(/^enc:v1:gcm:/),
          secret_key_version: 1,
          algorithm: 'SHA1',
          digits: 6,
          period: 30,
          window: 1,
        }),
      })
    );
    const storedMetadata = mockChallengeStore.storeChallengeRpc.mock.calls[0][0].metadata;
    expect(storedMetadata.secret_encrypted).not.toContain(body.secret);
  });

  it('rate limits TOTP signup activation attempts before reading the challenge', async () => {
    const app = createApp();
    mockRateLimiter.incrementRpc.mockResolvedValueOnce({ allowed: false, retryAfter: 120 });

    const response = await app.request(
      '/api/auth/totp/signup/activate',
      {
        method: 'POST',
        body: JSON.stringify({ challenge_id: 'signup-challenge', code: '123456' }),
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
      },
      createEnv({
        'settings:tenant:default:authentication-methods': {
          'authentication-methods.totp.signup_enabled': true,
        },
      }),
      { waitUntil: vi.fn() } as unknown as ExecutionContext
    );

    expect(response.status).toBe(429);
    expect(mockChallengeStore.getChallengeRpc).not.toHaveBeenCalled();
    expect(mockTotpRepo.create).not.toHaveBeenCalled();
  });

  it('activates a TOTP signup credential and creates a session with backup codes', async () => {
    const app = createApp();
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const encrypted = await encryptValue(secret, encryptionKey, 'AES-256-GCM', 1);
    const profile: TotpProfile = { algorithm: 'SHA1', digits: 6, period: 30, window: 1 };
    const timeStep = getTotpTimeStep(Date.now(), profile.period);
    const code = await generateTotpCode(secret, profile, timeStep);
    const pendingCredential = {
      id: 'totp-signup-001',
      tenant_id: 'default',
      user_id: 'user-signup-001',
      secret_encrypted: encrypted.encrypted,
      secret_key_version: 1,
      label: 'Authenticator app',
      ...profile,
      status: 'pending',
      last_used_time_step: null,
      created_at: Date.now(),
      activated_at: null,
      last_used_at: null,
    };
    mockChallengeStore.getChallengeRpc.mockResolvedValue({
      userId: 'user-signup-001',
      challenge: 'signup-challenge',
      metadata: {
        credential_id: 'totp-signup-001',
        email: 'new@example.com',
        name: 'New User',
        label: 'Authenticator app',
        secret_encrypted: encrypted.encrypted,
        secret_key_version: 1,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        window: 1,
        custom_fields: {},
      },
    });
    mockRuntimeUserStore.findById.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'user-signup-001',
      email: 'new@example.com',
      name: 'New User',
      active: 1,
    });
    mockRuntimeUserStore.findByEmail.mockResolvedValue(null);
    mockTotpRepo.findById.mockResolvedValue(null);
    mockTotpRepo.create.mockResolvedValue(pendingCredential);
    mockTotpRepo.activate.mockResolvedValue({
      ...pendingCredential,
      status: 'active',
      activated_at: Date.now(),
      last_used_at: Date.now(),
      last_used_time_step: timeStep,
    });

    const responsePromise = app.request(
      '/api/auth/totp/signup/activate',
      {
        method: 'POST',
        body: JSON.stringify({ challenge_id: 'signup-challenge', code }),
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
      },
      createEnv({
        'settings:tenant:default:authentication-methods': {
          'authentication-methods.totp.signup_enabled': true,
          'authentication-methods.totp.default_acr': 'urn:authrim:aal:2',
        },
      }),
      { waitUntil: vi.fn() } as unknown as ExecutionContext
    );

    const response = await resolveConstantTimeResponse(responsePromise);
    const body = (await response.json()) as {
      success: boolean;
      backup_codes: string[];
      sessionId: string;
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.sessionId).toBe('g1:apac:3:session_new');
    expect(body.backup_codes).toHaveLength(10);
    expect(mockTotpRepo.activate).toHaveBeenCalledWith(
      'totp-signup-001',
      'user-signup-001',
      timeStep
    );
    expect(mockTotpRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'totp-signup-001',
        user_id: 'user-signup-001',
        secret_encrypted: encrypted.encrypted,
        secret_key_version: 1,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        window: 1,
        status: 'pending',
      })
    );
    expect(mockTotpRepo.replaceBackupCodes).toHaveBeenCalledWith(
      'user-signup-001',
      'totp-signup-001',
      expect.arrayContaining([
        expect.objectContaining({
          user_id: 'user-signup-001',
          credential_id: 'totp-signup-001',
        }),
      ])
    );
    expect(mockRuntimeUserStore.syncUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-signup-001',
        email: 'new@example.com',
        name: 'New User',
        active: true,
        sourceRef: 'direct_auth_totp',
      })
    );
    expect(mockChallengeStore.deleteChallengeRpc).toHaveBeenCalledWith(
      'totp_signup:signup-challenge'
    );
    expect(response.headers.get('Set-Cookie')).toContain('authrim_session=');
  });
});
