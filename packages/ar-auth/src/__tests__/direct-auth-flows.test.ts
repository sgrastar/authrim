import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const authCodeStore = {
    storeCodeRpc: vi.fn(),
  };
  const challengeStore = {
    storeChallengeRpc: vi.fn(),
    consumeChallengeRpc: vi.fn(),
    getChallengeRpc: vi.fn(),
    deleteChallengeRpc: vi.fn(),
  };
  const rateLimiter = {
    incrementRpc: vi.fn(),
  };
  const sessionStore = {
    getSessionRpc: vi.fn(),
  };
  const coreAdapter = {
    execute: vi.fn(),
    queryOne: vi.fn(),
  };
  const userCore = {
    findById: vi.fn(),
    createUser: vi.fn(),
    updatePIIStatus: vi.fn(),
    updateLastLogin: vi.fn(),
  };
  const passkey = {
    findByUserId: vi.fn(),
    findByCredentialId: vi.fn(),
    updateCounterAfterAuth: vi.fn(),
    create: vi.fn(),
  };
  const emailNotifier = {
    send: vi.fn(),
  };
  const userPII = {
    findById: vi.fn(),
    findByTenantAndEmail: vi.fn(),
    createPII: vi.fn(),
  };

  return {
    authCodeStore,
    challengeStore,
    rateLimiter,
    sessionStore,
    coreAdapter,
    userCore,
    passkey,
    emailNotifier,
    getNotifier: vi.fn(),
    userPII,
    getClient: vi.fn(),
    getWebOriginRegistry: vi.fn(),
    getTenantSettings: vi.fn(),
    getDefaultTenantId: vi.fn(),
    resolveTenantFromEmailDomain: vi.fn(),
    generateUserIdFromSettings: vi.fn(),
    publishEvent: vi.fn(),
    generateAuthenticationOptions: vi.fn(),
    verifyAuthenticationResponse: vi.fn(),
    generateRegistrationOptions: vi.fn(),
    verifyRegistrationResponse: vi.fn(),
    generateEmailCode: vi.fn(),
    hashEmailCode: vi.fn(),
    verifyEmailCodeHash: vi.fn(),
    hashEmail: vi.fn(),
    validateRegistrationFieldSubmissionFromEnv: vi.fn(),
    persistRegistrationFieldValuesFromEnv: vi.fn(),
    verifyHumanVerificationForAction: vi.fn(),
    verifyEmailVerificationProtocol: vi.fn(),
    findActiveInvitationByToken: vi.fn(),
    getCookie: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
});

vi.mock('hono/cookie', () => ({
  getCookie: mocks.getCookie,
  setCookie: vi.fn(),
  deleteCookie: vi.fn(),
}));

vi.mock('@simplewebauthn/server', () => ({
  generateAuthenticationOptions: mocks.generateAuthenticationOptions,
  verifyAuthenticationResponse: mocks.verifyAuthenticationResponse,
  generateRegistrationOptions: mocks.generateRegistrationOptions,
  verifyRegistrationResponse: mocks.verifyRegistrationResponse,
}));

vi.mock('../utils/email-code-utils', () => ({
  generateEmailCode: mocks.generateEmailCode,
  hashEmailCode: mocks.hashEmailCode,
  verifyEmailCodeHash: mocks.verifyEmailCodeHash,
  hashEmail: mocks.hashEmail,
}));

vi.mock('../registration-field-utils', () => ({
  buildCanonicalProfileRuntimeUserFields: () => ({ piiFields: {}, sensitiveValues: {} }),
  validateRegistrationFieldSubmissionFromEnv: mocks.validateRegistrationFieldSubmissionFromEnv,
  persistRegistrationFieldValuesFromEnv: mocks.persistRegistrationFieldValuesFromEnv,
}));

vi.mock('../human-verification', () => ({
  verifyHumanVerificationForAction: mocks.verifyHumanVerificationForAction,
}));

vi.mock('../email-verification-protocol', () => ({
  verifyEmailVerificationProtocol: mocks.verifyEmailVerificationProtocol,
}));

vi.mock('@authrim/ar-lib-core/services/invitation-auth-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@authrim/ar-lib-core/services/invitation-auth-core')>();
  return {
    ...actual,
    findActiveInvitationByToken: mocks.findActiveInvitationByToken,
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    CanonicalRuntimeUserStore: class {
      async findById(userId: string) {
        const core = await mocks.userCore.findById(userId);
        if (!core?.is_active) return null;
        const pii = await mocks.userPII.findById(userId);
        return {
          id: core.id,
          account_type: core.user_type === 'admin' ? 'admin' : 'user',
          active: core.is_active ? 1 : 0,
          email: pii?.email ?? null,
          name: pii?.name ?? null,
          email_verified: core.email_verified ? 1 : 0,
          phone_number_verified: core.phone_number_verified ? 1 : 0,
          created_at: new Date(core.created_at ?? Date.now()).toISOString(),
          updated_at: new Date(core.updated_at ?? Date.now()).toISOString(),
          last_login_at: core.last_login_at ?? null,
        };
      }
      async findByEmail(email: string) {
        const pii = await mocks.userPII.findByTenantAndEmail('tenant_test', email);
        if (!pii) return null;
        return this.findById(pii.id);
      }
      async syncUser(input: { userId: string; email?: string | null; name?: string | null }) {
        await mocks.userCore.createUser({
          id: input.userId,
          tenant_id: 'tenant_test',
          email_verified: false,
          user_type: 'end_user',
        });
        await mocks.userPII.createPII({
          id: input.userId,
          tenant_id: 'tenant_test',
          email: input.email,
          name: input.name,
          preferred_username: input.email?.split('@')[0],
        });
        await mocks.userCore.updatePIIStatus(input.userId, 'active');
        return { created: true, graph: null, profileAttributeCount: 0, contactPointCount: 0 };
      }
      async markEmailVerified(userId: string) {
        await mocks.coreAdapter.execute(
          'UPDATE users_core SET email_verified = 1, updated_at = ? WHERE id = ? AND tenant_id = ?',
          [Date.now(), userId, 'tenant_test']
        );
        return true;
      }
      async markEmailVerifiedAndTouchLastLogin(userId: string) {
        await mocks.coreAdapter.execute(
          'UPDATE users_core SET email_verified = 1, last_login_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
          [Date.now(), Date.now(), userId, 'tenant_test']
        );
        return true;
      }
      async touchLastLogin(userId: string) {
        await mocks.userCore.updateLastLogin(userId);
        return true;
      }
      async deleteUser() {
        return true;
      }
    },
    getTenantIdFromContext: vi.fn(() => 'tenant_test'),
    getDefaultTenantId: mocks.getDefaultTenantId,
    getTenantSettings: mocks.getTenantSettings,
    getClient: mocks.getClient,
    getWebOriginRegistry: mocks.getWebOriginRegistry,
    resolveTenantFromEmailDomain: mocks.resolveTenantFromEmailDomain,
    createAuthContextFromHono: vi.fn(() => ({
      coreAdapter: mocks.coreAdapter,
      repositories: {
        userCore: mocks.userCore,
        passkey: mocks.passkey,
      },
    })),
    createPIIContextFromHono: vi.fn(() => ({
      piiRepositories: {
        userPII: mocks.userPII,
      },
    })),
    hasPIIDatabase: vi.fn(() => true),
    isShardedSessionId: vi.fn((sessionId: string) => /^\d+_session_/.test(sessionId)),
    getSessionStoreBySessionId: vi.fn(() => ({ stub: mocks.sessionStore })),
    generateUserIdFromSettings: mocks.generateUserIdFromSettings,
    getChallengeStoreByChallengeId: vi.fn(async () => mocks.challengeStore),
    getChallengeStoreByUserId: vi.fn(async () => mocks.challengeStore),
    getRequiredPluginContext: vi.fn(() => ({
      registry: {
        getNotifier: mocks.getNotifier,
      },
    })),
    publishEvent: mocks.publishEvent,
    getLogger: vi.fn(() => ({
      module: () => ({
        warn: mocks.warn,
        error: mocks.error,
        info: vi.fn(),
        debug: vi.fn(),
      }),
    })),
  };
});

async function s256Challenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function createEnv() {
  return {
    ISSUER_URL: 'https://issuer.example.com',
    OTP_HMAC_SECRET: 'otp-test-secret',
    ALLOWED_ORIGINS: 'https://app.example.com',
    AUTHRIM_CONFIG: {
      get: vi.fn().mockResolvedValue(null),
    },
    SETTINGS: undefined as KVNamespace | undefined,
    RATE_LIMITER: {
      idFromName: vi.fn(() => 'rate-limit-id'),
      get: vi.fn(() => mocks.rateLimiter),
    },
    AUTH_CODE_STORE: {
      idFromName: vi.fn(() => 'auth-code-id'),
      get: vi.fn(() => mocks.authCodeStore),
    },
  };
}

function createMockKV(data: Record<string, string> = {}) {
  return {
    get: vi.fn(async (key: string) => data[key] ?? null),
    put: vi.fn(),
    delete: vi.fn(),
  };
}

function createContext(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  url = 'https://app.example.com/api/v1/auth/direct'
) {
  const lowerHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );

  return {
    req: {
      url,
      json: vi.fn(async () => body),
      header: vi.fn((name: string) => lowerHeaders[name.toLowerCase()]),
    },
    env: createEnv(),
    get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant_test' : undefined)),
    json: (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  };
}

function createEmailOtpEnabledSettings(
  extraRecords: Record<string, string> = {},
  overrides: Record<string, boolean | string> = {}
) {
  return createMockKV({
    'settings:tenant:tenant_test:authentication-methods': JSON.stringify({
      'authentication-methods.email_otp.login_enabled': true,
      'authentication-methods.email_otp.signup_enabled': true,
      'authentication-methods.email_otp.reauth_enabled': true,
      'authentication-methods.email_otp.account_link_enabled': true,
      ...overrides,
    }),
    ...extraRecords,
  });
}

function enableEmailOtp(
  context: ReturnType<typeof createContext>,
  extraRecords: Record<string, string> = {},
  overrides: Record<string, boolean | string> = {}
) {
  context.env.SETTINGS = createEmailOtpEnabledSettings(extraRecords, overrides) as never;
  return context;
}

function webHeaders() {
  return {
    origin: 'https://app.example.com',
    host: 'app.example.com',
  };
}

function tenantProxyHeaders() {
  return {
    origin: 'https://first.test.authrim.com',
    host: 'test.authrim.com',
    'x-authrim-browser-origin': 'https://login.test.authrim.com',
    'x-authrim-forwarded-host': 'first.test.authrim.com',
    'x-authrim-ui-proxy': 'login-ui',
  };
}

describe('Direct Auth primary passkey and email-code flows', () => {
  beforeAll(async () => {
    await import('../direct-auth');
  }, 20_000);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTenantSettings.mockResolvedValue(null);
    mocks.getDefaultTenantId.mockReturnValue('default');
    mocks.resolveTenantFromEmailDomain.mockResolvedValue(null);
    mocks.getClient.mockResolvedValue({
      client_id: 'web-client',
      application_type: 'web',
      allowed_redirect_origins: ['https://app.example.com'],
    });
    mocks.getWebOriginRegistry.mockResolvedValue({
      origins: [{ origin: 'https://app.example.com', handoff_allowed: true }],
    });
    mocks.generateUserIdFromSettings.mockResolvedValue('user_new');
    mocks.publishEvent.mockResolvedValue(undefined);
    mocks.authCodeStore.storeCodeRpc.mockResolvedValue(undefined);
    mocks.challengeStore.storeChallengeRpc.mockResolvedValue(undefined);
    mocks.challengeStore.deleteChallengeRpc.mockResolvedValue(undefined);
    mocks.challengeStore.getChallengeRpc.mockReset();
    mocks.challengeStore.consumeChallengeRpc.mockReset();
    mocks.rateLimiter.incrementRpc.mockResolvedValue({ allowed: true });
    mocks.sessionStore.getSessionRpc.mockResolvedValue({
      id: '0_session_existing',
      userId: 'user_existing',
      createdAt: Date.now() - 120_000,
      expiresAt: Date.now() + 60_000,
      data: { amr: ['passkey'] },
    });
    mocks.coreAdapter.execute.mockResolvedValue(undefined);
    mocks.coreAdapter.queryOne.mockResolvedValue({
      state: 'active',
      current_step_id: 'auth:step',
      contract_hash: 'contract_hash',
      expires_at: Math.floor(Date.now() / 1000) + 300,
    });
    mocks.userCore.findById.mockResolvedValue({
      id: 'user_existing',
      is_active: true,
      created_at: Date.now() - 120_000,
    });
    mocks.userCore.createUser.mockResolvedValue(undefined);
    mocks.userCore.updatePIIStatus.mockResolvedValue(undefined);
    mocks.userCore.updateLastLogin.mockResolvedValue(undefined);
    mocks.passkey.findByUserId.mockResolvedValue([]);
    mocks.passkey.findByCredentialId.mockResolvedValue({
      id: 'passkey_1',
      user_id: 'user_existing',
      credential_id: 'credential-id',
      public_key: Buffer.from([1, 2, 3, 4]).toString('base64'),
      counter: 4,
    });
    mocks.passkey.updateCounterAfterAuth.mockResolvedValue(undefined);
    mocks.passkey.create.mockResolvedValue(undefined);
    mocks.emailNotifier.send.mockResolvedValue({ success: true, messageId: 'message_1' });
    mocks.getNotifier.mockReturnValue(mocks.emailNotifier);
    mocks.userPII.findByTenantAndEmail.mockResolvedValue(null);
    mocks.userPII.findById.mockResolvedValue({
      id: 'user_existing',
      email: 'user@example.com',
      name: 'Example User',
    });
    mocks.userPII.createPII.mockResolvedValue(undefined);
    mocks.generateAuthenticationOptions.mockResolvedValue({
      challenge: 'passkey-login-challenge',
      timeout: 60_000,
      rpId: 'app.example.com',
      allowCredentials: [],
      userVerification: 'required',
      extensions: undefined,
    });
    mocks.verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 5 },
    });
    mocks.generateRegistrationOptions.mockResolvedValue({
      rp: { id: 'app.example.com', name: 'Authrim' },
      user: { id: 'user_new', name: 'new@example.com', displayName: 'New User' },
      challenge: 'passkey-signup-challenge',
      pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
      timeout: 60_000,
      excludeCredentials: [],
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
      attestation: 'none',
      extensions: undefined,
    });
    mocks.verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credentialID: new Uint8Array([9, 8, 7]),
        credentialPublicKey: new Uint8Array([6, 5, 4, 3]),
        counter: 0,
        aaguid: '08987058-cadc-4b81-b6e1-30de50dcbe96',
      },
    });
    mocks.generateEmailCode.mockReturnValue('123456');
    mocks.hashEmailCode.mockResolvedValue('hashed-email-code');
    mocks.verifyEmailCodeHash.mockResolvedValue(true);
    mocks.hashEmail.mockResolvedValue('hashed-email');
    mocks.validateRegistrationFieldSubmissionFromEnv.mockResolvedValue({
      ok: true,
      values: {},
    });
    mocks.persistRegistrationFieldValuesFromEnv.mockResolvedValue(undefined);
    mocks.verifyEmailVerificationProtocol.mockResolvedValue({
      verified: false,
      reason: 'verification_failed',
    });
    mocks.findActiveInvitationByToken.mockReset();
    mocks.findActiveInvitationByToken.mockResolvedValue(null);
    mocks.verifyHumanVerificationForAction.mockImplementation(
      async (
        c: { env: { SETTINGS?: { get: (key: string) => Promise<string | null> } } },
        action: string,
        responseToken: unknown
      ) => {
        const raw = await c.env.SETTINGS?.get('settings:tenant:tenant_test:authentication-methods');
        const settings = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        const enabled =
          settings['authentication-methods.human_verification.provider'] &&
          settings[`authentication-methods.human_verification.${action}_enabled`] === true;
        if (!enabled || responseToken) return null;
        return new Response(JSON.stringify({ error: 'human_verification_required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    );
  });

  it('rejects passkey login start when Turnstile is required and token is missing', async () => {
    const { directPasskeyLoginStartHandler } = await import('../direct-auth');
    const context = createContext(
      {
        client_id: 'web-client',
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        channel: 'browser',
      },
      webHeaders(),
      'https://app.example.com/api/v1/auth/direct/passkey/login/start'
    );
    context.env.SETTINGS = createMockKV({
      'settings:tenant:tenant_test:authentication-methods': JSON.stringify({
        'authentication-methods.human_verification.provider':
          'human-verification-cloudflare-turnstile',
        'authentication-methods.human_verification.login_enabled': true,
      }),
      'plugins:enabled:human-verification-cloudflare-turnstile:tenant:tenant_test': 'true',
      'plugins:config:human-verification-cloudflare-turnstile:tenant:tenant_test': JSON.stringify({
        siteKey: '0x4AAAAAA_site_key',
        secretKey: '0x4AAAAAA_secret_key',
        failurePolicy: 'fail_closed',
      }),
    }) as never;

    const response = await directPasskeyLoginStartHandler(context as never);
    const body = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBeDefined();
    expect(mocks.generateAuthenticationOptions).not.toHaveBeenCalled();
  });

  it('does not let the client downgrade login Turnstile to the reauth policy', async () => {
    const { directPasskeyLoginStartHandler } = await import('../direct-auth');
    const context = createContext(
      {
        client_id: 'web-client',
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        channel: 'browser',
        human_verification_action: 'reauth',
      },
      webHeaders(),
      'https://app.example.com/api/v1/auth/direct/passkey/login/start'
    );
    context.env.SETTINGS = createMockKV({
      'settings:tenant:tenant_test:authentication-methods': JSON.stringify({
        'authentication-methods.human_verification.provider':
          'human-verification-cloudflare-turnstile',
        'authentication-methods.human_verification.login_enabled': true,
        'authentication-methods.human_verification.reauth_enabled': false,
      }),
      'plugins:enabled:human-verification-cloudflare-turnstile:tenant:tenant_test': 'true',
      'plugins:config:human-verification-cloudflare-turnstile:tenant:tenant_test': JSON.stringify({
        siteKey: '0x4AAAAAA_site_key',
        secretKey: '0x4AAAAAA_secret_key',
        failurePolicy: 'fail_closed',
      }),
    }) as never;

    const response = await directPasskeyLoginStartHandler(context as never);

    expect(response.status).toBe(400);
    expect(mocks.generateAuthenticationOptions).not.toHaveBeenCalled();
  });

  it('uses the authorization challenge type for reauth Turnstile start checks', async () => {
    mocks.challengeStore.getChallengeRpc.mockResolvedValue({
      id: 'reauth_challenge',
      tenantId: 'tenant_test',
      type: 'reauth',
      challenge: 'reauth_challenge',
    });
    const { directPasskeyLoginStartHandler } = await import('../direct-auth');
    const context = createContext(
      {
        client_id: 'web-client',
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        channel: 'browser',
        authorization_challenge_id: 'reauth_challenge',
      },
      webHeaders(),
      'https://app.example.com/api/v1/auth/direct/passkey/login/start'
    );
    context.env.SETTINGS = createMockKV({
      'settings:tenant:tenant_test:authentication-methods': JSON.stringify({
        'authentication-methods.human_verification.provider':
          'human-verification-cloudflare-turnstile',
        'authentication-methods.human_verification.login_enabled': false,
        'authentication-methods.human_verification.reauth_enabled': true,
      }),
      'plugins:enabled:human-verification-cloudflare-turnstile:tenant:tenant_test': 'true',
      'plugins:config:human-verification-cloudflare-turnstile:tenant:tenant_test': JSON.stringify({
        siteKey: '0x4AAAAAA_site_key',
        secretKey: '0x4AAAAAA_secret_key',
        failurePolicy: 'fail_closed',
      }),
    }) as never;

    const response = await directPasskeyLoginStartHandler(context as never);

    expect(response.status).toBe(400);
    expect(mocks.generateAuthenticationOptions).not.toHaveBeenCalled();
  });

  it('rejects passkey login start when the login usage is disabled', async () => {
    const { directPasskeyLoginStartHandler } = await import('../direct-auth');
    const context = createContext(
      {
        client_id: 'web-client',
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        channel: 'browser',
      },
      webHeaders()
    );
    context.env.SETTINGS = createMockKV({
      'settings:tenant:tenant_test:authentication-methods': JSON.stringify({
        'authentication-methods.passkey.login_enabled': false,
        'authentication-methods.passkey.signup_enabled': true,
        'authentication-methods.passkey.reauth_enabled': true,
      }),
    }) as never;

    const response = await directPasskeyLoginStartHandler(context as never);

    expect(response.status).toBe(403);
    expect(mocks.generateAuthenticationOptions).not.toHaveBeenCalled();
    expect(mocks.challengeStore.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('ignores email during passkey login start and uses discoverable credentials', async () => {
    mocks.userPII.findByTenantAndEmail.mockResolvedValue({
      id: 'user_existing',
      email: 'user@example.com',
      name: 'Example User',
    });
    mocks.passkey.findByUserId.mockResolvedValue([
      {
        credential_id: 'credential-id',
        transports: ['internal'],
      },
    ]);
    const { directPasskeyLoginStartHandler } = await import('../direct-auth');

    const response = await directPasskeyLoginStartHandler(
      createContext(
        {
          client_id: 'web-client',
          code_challenge: 'pkce-challenge',
          code_challenge_method: 'S256',
          channel: 'browser',
          scope: 'openid profile',
          email: 'user@example.com',
        },
        webHeaders()
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      challenge_id: expect.any(String),
      options: expect.objectContaining({
        challenge: 'passkey-login-challenge',
        rpId: 'app.example.com',
      }),
    });
    expect(mocks.generateAuthenticationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: 'app.example.com',
        userVerification: 'required',
        allowCredentials: [],
      })
    );
    expect(mocks.userPII.findByTenantAndEmail).not.toHaveBeenCalled();
    expect(mocks.passkey.findByUserId).not.toHaveBeenCalled();
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'direct_passkey_login',
        userId: 'unknown',
        metadata: expect.objectContaining({
          client_id: 'web-client',
          channel: 'browser',
          code_challenge: 'pkce-challenge',
          origin: 'https://app.example.com',
          rpID: 'app.example.com',
        }),
      })
    );
  }, 10_000);

  it('finishes passkey login and stores a direct-auth authorization code artifact', async () => {
    const codeVerifier = 'passkey-login-code-verifier';
    const codeChallenge = await s256Challenge(codeVerifier);
    mocks.challengeStore.consumeChallengeRpc.mockResolvedValue({
      challenge: 'passkey-login-challenge',
      metadata: {
        code_challenge: codeChallenge,
        client_id: 'web-client',
        channel: 'browser',
        scope: 'openid profile',
        transaction_id: 'transaction_1',
        origin: 'https://app.example.com',
        rpID: 'app.example.com',
      },
    });
    const { directPasskeyLoginFinishHandler } = await import('../direct-auth');

    const response = await directPasskeyLoginFinishHandler(
      createContext({
        challenge_id: 'challenge_1',
        credential: {
          id: 'credential-id',
          rawId: 'credential-id',
          response: {},
          type: 'public-key',
        },
        code_verifier: codeVerifier,
        channel: 'browser',
      }) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      direct_auth_artifact: expect.any(String),
      expires_in: 60,
    });
    expect(mocks.passkey.updateCounterAfterAuth).toHaveBeenCalledWith('passkey_1', 5);
    expect(mocks.userCore.updateLastLogin).toHaveBeenCalledWith('user_existing');
    expect(mocks.authCodeStore.storeCodeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_test',
        clientId: 'web-client',
        userId: 'user_existing',
        scope: 'openid profile',
        codeChallenge,
      })
    );
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'direct_auth_code',
        userId: 'user_existing',
        metadata: expect.objectContaining({
          method: 'passkey',
          passkey_id: 'passkey_1',
          transaction_id: 'transaction_1',
        }),
      })
    );
  });

  it('marks passkey login credential misses as safe for signalUnknownCredential', async () => {
    const codeVerifier = 'passkey-login-code-verifier';
    const codeChallenge = await s256Challenge(codeVerifier);
    mocks.challengeStore.consumeChallengeRpc.mockResolvedValue({
      challenge: 'passkey-login-challenge',
      metadata: {
        code_challenge: codeChallenge,
        client_id: 'web-client',
        channel: 'browser',
        origin: 'https://app.example.com',
        rpID: 'app.example.com',
      },
    });
    mocks.passkey.findByCredentialId.mockResolvedValue(null);
    const { directPasskeyLoginFinishHandler } = await import('../direct-auth');

    const response = await directPasskeyLoginFinishHandler(
      createContext({
        challenge_id: 'challenge_1',
        credential: {
          id: 'missing-credential-id',
          rawId: 'missing-credential-id',
          response: {},
          type: 'public-key',
        },
        code_verifier: codeVerifier,
        channel: 'browser',
      }) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body.webauthn_signal).toEqual({ unknown_credential: true });
    expect(mocks.verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it('uses the browser origin for passkey login through the Login UI proxy', async () => {
    mocks.getWebOriginRegistry.mockResolvedValue({
      origins: [{ origin: 'https://login.test.authrim.com', handoff_allowed: true }],
    });
    mocks.userPII.findByTenantAndEmail.mockResolvedValue({
      id: 'user_existing',
      email: 'user@example.com',
      name: 'Example User',
    });
    mocks.passkey.findByUserId.mockResolvedValue([
      {
        credential_id: 'credential-id',
        transports: ['internal'],
      },
    ]);
    const { directPasskeyLoginStartHandler } = await import('../direct-auth');
    const context = createContext(
      {
        client_id: 'web-client',
        code_challenge: 'pkce-challenge',
        code_challenge_method: 'S256',
        channel: 'browser',
        email: 'user@example.com',
      },
      tenantProxyHeaders(),
      'https://test.authrim.com/api/v1/auth/direct/passkey/login/start'
    );
    context.env.ALLOWED_ORIGINS = 'https://login.test.authrim.com';

    const response = await directPasskeyLoginStartHandler(context as never);

    expect(response.status).toBe(200);
    expect(mocks.generateAuthenticationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: 'login.test.authrim.com',
      })
    );
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          origin: 'https://login.test.authrim.com',
          rpID: 'login.test.authrim.com',
        }),
      })
    );
  });

  it('starts passkey signup by creating a new user and storing challenge mapping', async () => {
    mocks.validateRegistrationFieldSubmissionFromEnv.mockResolvedValueOnce({
      ok: true,
      values: { affiliation: 'Faculty' },
    });
    const { directPasskeySignupStartHandler } = await import('../direct-auth');

    const response = await directPasskeySignupStartHandler(
      createContext(
        {
          client_id: 'web-client',
          email: 'new@example.com',
          display_name: 'New User',
          code_challenge: 'signup-pkce-challenge',
          code_challenge_method: 'S256',
          channel: 'browser',
          scope: 'openid email',
          authenticator_type: 'platform',
          custom_fields: { affiliation: 'Faculty' },
        },
        webHeaders()
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      challenge_id: expect.any(String),
      options: expect.objectContaining({
        challenge: 'passkey-signup-challenge',
      }),
    });
    expect(mocks.userCore.createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'user_new',
        tenant_id: 'tenant_test',
        email_verified: false,
      })
    );
    expect(mocks.userPII.createPII).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'user_new',
        email: 'new@example.com',
        preferred_username: 'new',
      })
    );
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'direct_passkey_signup:user_new',
        type: 'direct_passkey_signup',
        userId: 'user_new',
        metadata: expect.objectContaining({
          client_id: 'web-client',
          channel: 'browser',
          code_challenge: 'signup-pkce-challenge',
          origin: 'https://app.example.com',
          custom_fields: { affiliation: 'Faculty' },
        }),
      })
    );
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^direct_passkey_signup_map:/),
        type: 'direct_passkey_signup_map',
        userId: 'user_new',
      })
    );
  });

  it('rejects passkey signup start when the signup usage is disabled', async () => {
    const { directPasskeySignupStartHandler } = await import('../direct-auth');
    const context = createContext(
      {
        client_id: 'web-client',
        email: 'new@example.com',
        code_challenge: 'signup-pkce-challenge',
        code_challenge_method: 'S256',
        channel: 'browser',
      },
      webHeaders()
    );
    context.env.SETTINGS = createMockKV({
      'settings:tenant:tenant_test:authentication-methods': JSON.stringify({
        'authentication-methods.passkey.login_enabled': true,
        'authentication-methods.passkey.signup_enabled': false,
      }),
    }) as never;

    const response = await directPasskeySignupStartHandler(context as never);

    expect(response.status).toBe(403);
    expect(mocks.userCore.createUser).not.toHaveBeenCalled();
    expect(mocks.generateRegistrationOptions).not.toHaveBeenCalled();
  });

  it('rejects passkey signup for an existing user', async () => {
    mocks.userPII.findByTenantAndEmail.mockResolvedValue({
      id: 'user_existing',
      email: 'existing@example.com',
      name: 'Existing User',
    });
    const { directPasskeySignupStartHandler } = await import('../direct-auth');

    const response = await directPasskeySignupStartHandler(
      createContext(
        {
          client_id: 'web-client',
          email: 'existing@example.com',
          code_challenge: 'signup-pkce-challenge',
          code_challenge_method: 'S256',
          channel: 'browser',
        },
        webHeaders()
      ) as never
    );

    expect(response.status).toBe(409);
    expect(mocks.generateRegistrationOptions).not.toHaveBeenCalled();
    expect(mocks.challengeStore.storeChallengeRpc).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'direct_passkey_signup' })
    );
  });

  it('uses the browser origin for passkey signup through the Login UI proxy', async () => {
    mocks.getWebOriginRegistry.mockResolvedValue({
      origins: [{ origin: 'https://login.test.authrim.com', handoff_allowed: true }],
    });
    const { directPasskeySignupStartHandler } = await import('../direct-auth');
    const context = createContext(
      {
        client_id: 'web-client',
        email: 'new@example.com',
        display_name: 'New User',
        code_challenge: 'signup-pkce-challenge',
        code_challenge_method: 'S256',
        channel: 'browser',
        authenticator_type: 'platform',
      },
      tenantProxyHeaders(),
      'https://test.authrim.com/api/v1/auth/direct/passkey/signup/start'
    );
    context.env.ALLOWED_ORIGINS = 'https://login.test.authrim.com';

    const response = await directPasskeySignupStartHandler(context as never);

    expect(response.status).toBe(200);
    expect(mocks.generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: 'login.test.authrim.com',
      })
    );
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          origin: 'https://login.test.authrim.com',
          rpID: 'login.test.authrim.com',
        }),
      })
    );
  });

  it('finishes passkey signup and binds the resulting artifact to the original PKCE challenge', async () => {
    const codeVerifier = 'passkey-signup-code-verifier';
    const codeChallenge = await s256Challenge(codeVerifier);
    mocks.challengeStore.getChallengeRpc.mockResolvedValue({
      userId: 'user_new',
    });
    mocks.challengeStore.consumeChallengeRpc.mockResolvedValue({
      challenge: 'passkey-signup-challenge',
      email: 'new@example.com',
      metadata: {
        code_challenge: codeChallenge,
        client_id: 'web-client',
        channel: 'browser',
        scope: 'openid email',
        origin: 'https://app.example.com',
        rpID: 'app.example.com',
        custom_fields: { affiliation: 'Faculty' },
      },
    });
    mocks.userCore.findById.mockResolvedValue({
      id: 'user_new',
      is_active: true,
      created_at: Date.now(),
    });
    const { directPasskeySignupFinishHandler } = await import('../direct-auth');

    const response = await directPasskeySignupFinishHandler(
      createContext({
        challenge_id: 'signup_challenge',
        credential: {
          id: 'new-credential',
          rawId: 'new-credential',
          response: {
            transports: ['internal'],
          },
          type: 'public-key',
        },
        code_verifier: codeVerifier,
        channel: 'browser',
      }) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      direct_auth_artifact: expect.any(String),
      expires_in: 60,
      is_new_user: true,
    });
    expect(mocks.passkey.create).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user_new',
        public_key: Buffer.from([6, 5, 4, 3]).toString('base64'),
        transports: ['internal'],
        device_name: 'Direct Auth Passkey',
        aaguid: '08987058-cadc-4b81-b6e1-30de50dcbe96',
      })
    );
    expect(mocks.coreAdapter.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('email_verified = 1'),
      expect.any(Array)
    );
    expect(mocks.persistRegistrationFieldValuesFromEnv).toHaveBeenCalledWith(
      expect.any(Object),
      'tenant_test',
      'user_new',
      { affiliation: 'Faculty' }
    );
    expect(mocks.authCodeStore.storeCodeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'web-client',
        userId: 'user_new',
        scope: 'openid email',
        codeChallenge,
      })
    );
  });

  it('starts authenticated passkey registration with existing credentials excluded', async () => {
    mocks.passkey.findByUserId.mockResolvedValue([
      {
        credential_id: 'existing-credential',
        transports: ['internal'],
      },
    ]);
    const { directPasskeyRegisterStartHandler } = await import('../direct-auth');

    const response = await directPasskeyRegisterStartHandler(
      createContext(
        {
          display_name: 'Work laptop',
          authenticator_type: 'platform',
        },
        {
          ...webHeaders(),
          authorization: 'Bearer 0_session_existing',
        }
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      challenge_id: expect.any(String),
      options: expect.objectContaining({
        challenge: 'passkey-signup-challenge',
      }),
    });
    expect(mocks.generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: 'app.example.com',
        userName: 'user@example.com',
        userDisplayName: 'Work laptop',
        excludeCredentials: [
          expect.objectContaining({
            type: 'public-key',
            transports: ['internal'],
          }),
        ],
        authenticatorSelection: expect.objectContaining({
          authenticatorAttachment: 'platform',
        }),
      })
    );
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'direct_passkey_register:user_existing',
        type: 'direct_passkey_register',
        userId: 'user_existing',
        metadata: expect.objectContaining({
          session_id: '0_session_existing',
          display_name: 'Work laptop',
          origin: 'https://app.example.com',
          rpID: 'app.example.com',
        }),
      })
    );
  });

  it('uses the browser origin for authenticated passkey registration through the Login UI proxy', async () => {
    const { directPasskeyRegisterStartHandler } = await import('../direct-auth');
    const context = createContext(
      {
        display_name: 'Work laptop',
        authenticator_type: 'platform',
      },
      {
        ...tenantProxyHeaders(),
        authorization: 'Bearer 0_session_existing',
      },
      'https://test.authrim.com/api/v1/auth/direct/passkey/register/start'
    );
    context.env.ALLOWED_ORIGINS = 'https://login.test.authrim.com';

    const response = await directPasskeyRegisterStartHandler(context as never);

    expect(response.status).toBe(200);
    expect(mocks.generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: 'login.test.authrim.com',
      })
    );
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          origin: 'https://login.test.authrim.com',
          rpID: 'login.test.authrim.com',
        }),
      })
    );
  });

  it('finishes authenticated passkey registration and removes the challenge mapping', async () => {
    mocks.challengeStore.getChallengeRpc.mockResolvedValue({
      userId: 'user_existing',
    });
    mocks.challengeStore.consumeChallengeRpc.mockResolvedValue({
      challenge: 'passkey-register-challenge',
      metadata: {
        origin: 'https://app.example.com',
        rpID: 'app.example.com',
        session_id: '0_session_existing',
        display_name: 'Work laptop',
        authenticator_type: 'platform',
      },
    });
    const { directPasskeyRegisterFinishHandler } = await import('../direct-auth');

    const response = await directPasskeyRegisterFinishHandler(
      createContext({
        challenge_id: 'register_challenge',
        credential: {
          id: 'registered-credential',
          rawId: 'registered-credential',
          response: {
            transports: ['internal'],
          },
          type: 'public-key',
        },
        device_name: 'Work laptop',
      }) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      credential_id: expect.any(String),
      public_key: Buffer.from([6, 5, 4, 3]).toString('base64'),
      authenticator_type: 'platform',
      transports: ['internal'],
    });
    expect(mocks.passkey.create).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user_existing',
        device_name: 'Work laptop',
        transports: ['internal'],
        aaguid: '08987058-cadc-4b81-b6e1-30de50dcbe96',
      })
    );
    expect(mocks.challengeStore.deleteChallengeRpc).toHaveBeenCalledWith(
      'direct_passkey_register_map:register_challenge'
    );
  });

  it('sends an email code for a new user and stores a hashed one-time challenge', async () => {
    const { directEmailCodeSendHandler } = await import('../direct-auth');

    const response = await directEmailCodeSendHandler(
      enableEmailOtp(
        createContext(
          {
            client_id: 'web-client',
            email: 'new@example.com',
            code_challenge: 'email-pkce-challenge',
            code_challenge_method: 'S256',
            channel: 'browser',
            scope: 'openid email',
          },
          webHeaders()
        )
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      attempt_id: expect.any(String),
      expires_in: 300,
      masked_email: 'n***w@example.com',
    });
    expect(body).not.toHaveProperty('_dev_code');
    expect(mocks.rateLimiter.incrementRpc).toHaveBeenCalledWith(
      'direct_email_code:new@example.com',
      {
        windowSeconds: 900,
        maxRequests: 3,
      }
    );
    expect(mocks.hashEmailCode).toHaveBeenCalledWith(
      '123456',
      'new@example.com',
      expect.any(String),
      expect.any(Number),
      'otp-test-secret'
    );
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'direct_email_code',
        userId: 'user_new',
        challenge: 'hashed-email-code',
        email: 'new@example.com',
        metadata: expect.objectContaining({
          client_id: 'web-client',
          channel: 'browser',
          code_challenge: 'email-pkce-challenge',
          email_hash: 'hashed-email',
        }),
      })
    );
  });

  it('accepts a valid email verification presentation without sending an OTP', async () => {
    mocks.userPII.findByTenantAndEmail.mockResolvedValue({
      id: 'user_existing',
      email: 'existing@example.com',
      name: 'Existing User',
    });
    const protocolMetadata = {
      interaction_id: 'interaction_1',
      expected_origin: 'https://app.example.com',
      source_step_id: 'auth:step',
      verification_step_id: 'email-verify:step',
      contract_hash: 'contract_hash',
    };
    mocks.challengeStore.getChallengeRpc.mockResolvedValue({
      challenge: 'protocol-nonce',
      tenantId: 'tenant_test',
      type: 'email_verification_protocol',
      metadata: protocolMetadata,
    });
    mocks.challengeStore.consumeChallengeRpc.mockResolvedValue({
      challenge: 'protocol-nonce',
      metadata: protocolMetadata,
    });
    mocks.verifyEmailVerificationProtocol.mockResolvedValue({
      verified: true,
      issuer: 'https://mail.example.com',
    });
    const { directEmailCodeSendHandler } = await import('../direct-auth');

    const response = await directEmailCodeSendHandler(
      enableEmailOtp(
        createContext(
          {
            client_id: 'web-client',
            email: 'existing@example.com',
            code_challenge: 'email-pkce-challenge',
            code_challenge_method: 'S256',
            channel: 'browser',
            scope: 'openid email',
            email_verification_token: 'presentation-token',
            email_verification_challenge_id: 'challenge_1',
            runtime_interaction_id: 'interaction_1',
          },
          webHeaders()
        )
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      direct_auth_artifact: expect.any(String),
      expires_in: 60,
      is_new_user: false,
    });
    expect(body).not.toHaveProperty('attempt_id');
    expect(mocks.verifyEmailVerificationProtocol).toHaveBeenCalledWith({
      presentationToken: 'presentation-token',
      expectedEmail: 'existing@example.com',
      expectedNonce: 'protocol-nonce',
      expectedAudience: 'https://app.example.com',
    });
    expect(mocks.challengeStore.getChallengeRpc).toHaveBeenCalledWith(
      'email_verification_protocol:challenge_1'
    );
    expect(mocks.coreAdapter.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('FROM flow_interactions'),
      ['tenant_test', 'interaction_1']
    );
    expect(mocks.challengeStore.consumeChallengeRpc).toHaveBeenCalledWith({
      id: 'email_verification_protocol:challenge_1',
      tenantId: 'tenant_test',
      type: 'email_verification_protocol',
      challenge: 'protocol-nonce',
    });
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'direct_auth_code',
        metadata: expect.objectContaining({
          method: 'email_verification_protocol',
          runtime_interaction_id: 'interaction_1',
        }),
      })
    );
    expect(mocks.generateEmailCode).not.toHaveBeenCalled();
    expect(mocks.hashEmailCode).not.toHaveBeenCalled();
    expect(mocks.emailNotifier.send).not.toHaveBeenCalled();
    expect(mocks.publishEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'auth.email_verification_protocol.succeeded',
        data: expect.objectContaining({
          userId: 'user_existing',
          method: 'email_verification_protocol',
        }),
      })
    );
  });

  it('keeps a runtime-bound EVP request in the Flow tenant instead of email-domain routing', async () => {
    mocks.getDefaultTenantId.mockReturnValue('tenant_test');
    mocks.resolveTenantFromEmailDomain.mockResolvedValue('tenant_other');
    mocks.userPII.findByTenantAndEmail.mockResolvedValue({
      id: 'user_existing',
      email: 'existing@other.example',
      name: 'Existing User',
    });
    const protocolMetadata = {
      interaction_id: 'interaction_1',
      expected_origin: 'https://app.example.com',
      source_step_id: 'auth:step',
      verification_step_id: 'email-verify:step',
      contract_hash: 'contract_hash',
    };
    mocks.challengeStore.getChallengeRpc.mockResolvedValue({
      challenge: 'protocol-nonce',
      tenantId: 'tenant_test',
      type: 'email_verification_protocol',
      metadata: protocolMetadata,
    });
    mocks.challengeStore.consumeChallengeRpc.mockResolvedValue({
      challenge: 'protocol-nonce',
      metadata: protocolMetadata,
    });
    mocks.verifyEmailVerificationProtocol.mockResolvedValue({
      verified: true,
      issuer: 'https://mail.example.com',
    });
    const { directEmailCodeSendHandler } = await import('../direct-auth');

    const response = await directEmailCodeSendHandler(
      enableEmailOtp(
        createContext(
          {
            client_id: 'web-client',
            email: 'existing@other.example',
            code_challenge: 'email-pkce-challenge',
            code_challenge_method: 'S256',
            channel: 'browser',
            email_verification_token: 'presentation-token',
            email_verification_challenge_id: 'challenge_1',
            runtime_interaction_id: 'interaction_1',
          },
          webHeaders()
        )
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toHaveProperty('direct_auth_artifact');
    expect(body).not.toHaveProperty('attempt_id');
    expect(mocks.resolveTenantFromEmailDomain).not.toHaveBeenCalled();
    expect(mocks.verifyEmailVerificationProtocol).toHaveBeenCalledTimes(1);
    expect(mocks.challengeStore.consumeChallengeRpc).toHaveBeenCalledTimes(1);
    expect(mocks.authCodeStore.storeCodeRpc).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant_test', userId: 'user_existing' })
    );
    expect(mocks.emailNotifier.send).not.toHaveBeenCalled();
  });

  it('rejects a runtime-bound invitation that would cross the Flow tenant boundary', async () => {
    mocks.findActiveInvitationByToken.mockResolvedValueOnce({
      id: 'invite_1',
      token: 'invite-token',
      tenant_id: 'tenant_other',
      invited_email: 'existing@other.example',
      role_id: null,
      org_id: null,
      max_uses: 1,
      use_count: 0,
      expires_at: Math.floor(Date.now() / 1000) + 300,
    });
    const { directEmailCodeSendHandler } = await import('../direct-auth');

    const response = await directEmailCodeSendHandler(
      enableEmailOtp(
        createContext(
          {
            client_id: 'web-client',
            email: 'existing@other.example',
            code_challenge: 'email-pkce-challenge',
            code_challenge_method: 'S256',
            channel: 'browser',
            invite_token: 'invite-token',
            email_verification_token: 'presentation-token',
            email_verification_challenge_id: 'challenge_1',
            runtime_interaction_id: 'interaction_1',
          },
          webHeaders()
        )
      ) as never
    );

    expect(response.status).toBe(400);
    expect(mocks.rateLimiter.incrementRpc).not.toHaveBeenCalled();
    expect(mocks.userPII.findByTenantAndEmail).not.toHaveBeenCalled();
    expect(mocks.verifyEmailVerificationProtocol).not.toHaveBeenCalled();
    expect(mocks.challengeStore.consumeChallengeRpc).not.toHaveBeenCalled();
    expect(mocks.authCodeStore.storeCodeRpc).not.toHaveBeenCalled();
    expect(mocks.emailNotifier.send).not.toHaveBeenCalled();
  });

  it('falls back to OTP without consuming the challenge when EVP validation fails', async () => {
    mocks.userPII.findByTenantAndEmail.mockResolvedValue({
      id: 'user_existing',
      email: 'existing@example.com',
      name: 'Existing User',
    });
    mocks.challengeStore.getChallengeRpc.mockResolvedValue({
      challenge: 'protocol-nonce',
      tenantId: 'tenant_test',
      type: 'email_verification_protocol',
      metadata: {
        interaction_id: 'interaction_1',
        expected_origin: 'https://app.example.com',
        source_step_id: 'auth:step',
        verification_step_id: 'email-verify:step',
        contract_hash: 'contract_hash',
      },
    });
    const { directEmailCodeSendHandler } = await import('../direct-auth');

    const response = await directEmailCodeSendHandler(
      enableEmailOtp(
        createContext(
          {
            client_id: 'web-client',
            email: 'existing@example.com',
            code_challenge: 'email-pkce-challenge',
            code_challenge_method: 'S256',
            channel: 'browser',
            email_verification_token: 'invalid-presentation-token',
            email_verification_challenge_id: 'challenge_1',
            runtime_interaction_id: 'interaction_1',
          },
          webHeaders()
        )
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      attempt_id: expect.any(String),
      expires_in: 300,
    });
    expect(mocks.verifyEmailVerificationProtocol).toHaveBeenCalledTimes(1);
    expect(mocks.challengeStore.consumeChallengeRpc).not.toHaveBeenCalled();
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'direct_email_code',
        metadata: expect.objectContaining({ runtime_interaction_id: 'interaction_1' }),
      })
    );
    expect(mocks.emailNotifier.send).toHaveBeenCalledTimes(1);
  });

  it('checks the external origin before validating an EVP presentation', async () => {
    mocks.userPII.findByTenantAndEmail.mockResolvedValue({
      id: 'user_existing',
      email: 'existing@example.com',
      name: 'Existing User',
    });
    mocks.challengeStore.getChallengeRpc.mockResolvedValue({
      challenge: 'protocol-nonce',
      tenantId: 'tenant_test',
      type: 'email_verification_protocol',
      metadata: {
        interaction_id: 'interaction_1',
        expected_origin: 'https://different.example.com',
        source_step_id: 'auth:step',
        verification_step_id: 'email-verify:step',
        contract_hash: 'contract_hash',
      },
    });
    const { directEmailCodeSendHandler } = await import('../direct-auth');

    const response = await directEmailCodeSendHandler(
      enableEmailOtp(
        createContext(
          {
            client_id: 'web-client',
            email: 'existing@example.com',
            code_challenge: 'email-pkce-challenge',
            code_challenge_method: 'S256',
            channel: 'browser',
            email_verification_token: 'presentation-token',
            email_verification_challenge_id: 'challenge_1',
            runtime_interaction_id: 'interaction_1',
          },
          webHeaders()
        )
      ) as never
    );

    expect(response.status).toBe(200);
    expect(mocks.verifyEmailVerificationProtocol).not.toHaveBeenCalled();
    expect(mocks.challengeStore.consumeChallengeRpc).not.toHaveBeenCalled();
    expect(mocks.emailNotifier.send).toHaveBeenCalledTimes(1);
  });

  it('falls back to OTP when the EVP challenge no longer matches the active Flow step', async () => {
    mocks.userPII.findByTenantAndEmail.mockResolvedValue({
      id: 'user_existing',
      email: 'existing@example.com',
      name: 'Existing User',
    });
    mocks.challengeStore.getChallengeRpc.mockResolvedValue({
      challenge: 'protocol-nonce',
      tenantId: 'tenant_test',
      type: 'email_verification_protocol',
      metadata: {
        interaction_id: 'interaction_1',
        expected_origin: 'https://app.example.com',
        source_step_id: 'auth:step',
        verification_step_id: 'email-verify:step',
        contract_hash: 'contract_hash',
      },
    });
    mocks.coreAdapter.queryOne.mockResolvedValueOnce({
      state: 'active',
      current_step_id: 'complete:step',
      contract_hash: 'contract_hash',
      expires_at: Math.floor(Date.now() / 1000) + 300,
    });
    const { directEmailCodeSendHandler } = await import('../direct-auth');

    const response = await directEmailCodeSendHandler(
      enableEmailOtp(
        createContext(
          {
            client_id: 'web-client',
            email: 'existing@example.com',
            code_challenge: 'email-pkce-challenge',
            code_challenge_method: 'S256',
            channel: 'browser',
            email_verification_token: 'presentation-token',
            email_verification_challenge_id: 'challenge_1',
            runtime_interaction_id: 'interaction_1',
          },
          webHeaders()
        )
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toHaveProperty('attempt_id');
    expect(mocks.verifyEmailVerificationProtocol).not.toHaveBeenCalled();
    expect(mocks.challengeStore.consumeChallengeRpc).not.toHaveBeenCalled();
    expect(mocks.emailNotifier.send).toHaveBeenCalledTimes(1);
  });

  it('falls back to OTP when a verified EVP challenge loses the atomic consume race', async () => {
    mocks.userPII.findByTenantAndEmail.mockResolvedValue({
      id: 'user_existing',
      email: 'existing@example.com',
      name: 'Existing User',
    });
    mocks.challengeStore.getChallengeRpc.mockResolvedValue({
      challenge: 'protocol-nonce',
      tenantId: 'tenant_test',
      type: 'email_verification_protocol',
      metadata: {
        interaction_id: 'interaction_1',
        expected_origin: 'https://app.example.com',
        source_step_id: 'auth:step',
        verification_step_id: 'email-verify:step',
        contract_hash: 'contract_hash',
      },
    });
    mocks.challengeStore.consumeChallengeRpc.mockRejectedValueOnce(new Error('already consumed'));
    mocks.verifyEmailVerificationProtocol.mockResolvedValue({
      verified: true,
      issuer: 'https://mail.example.com',
    });
    const { directEmailCodeSendHandler } = await import('../direct-auth');

    const response = await directEmailCodeSendHandler(
      enableEmailOtp(
        createContext(
          {
            client_id: 'web-client',
            email: 'existing@example.com',
            code_challenge: 'email-pkce-challenge',
            code_challenge_method: 'S256',
            channel: 'browser',
            email_verification_token: 'presentation-token',
            email_verification_challenge_id: 'challenge_1',
            runtime_interaction_id: 'interaction_1',
          },
          webHeaders()
        )
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toHaveProperty('attempt_id');
    expect(body).not.toHaveProperty('direct_auth_artifact');
    expect(mocks.verifyEmailVerificationProtocol).toHaveBeenCalledTimes(1);
    expect(mocks.authCodeStore.storeCodeRpc).not.toHaveBeenCalled();
    expect(mocks.emailNotifier.send).toHaveBeenCalledTimes(1);
  });

  it('returns an accepted email-code response when Email OTP is disabled by default', async () => {
    const { directEmailCodeSendHandler } = await import('../direct-auth');

    const response = await directEmailCodeSendHandler(
      createContext(
        {
          client_id: 'web-client',
          email: 'new@example.com',
          code_challenge: 'email-pkce-challenge',
          code_challenge_method: 'S256',
          channel: 'browser',
          scope: 'openid email',
          email_verification_token: 'presentation-token',
          email_verification_challenge_id: 'challenge_1',
          runtime_interaction_id: 'interaction_1',
        },
        webHeaders()
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      attempt_id: expect.any(String),
      expires_in: 300,
      masked_email: 'n***w@example.com',
    });
    expect(mocks.hashEmailCode).not.toHaveBeenCalled();
    expect(mocks.verifyEmailVerificationProtocol).not.toHaveBeenCalled();
    expect(mocks.challengeStore.storeChallengeRpc).not.toHaveBeenCalled();
    expect(mocks.emailNotifier.send).not.toHaveBeenCalled();
  });

  it('does not validate signup registration fields for existing email-code users', async () => {
    mocks.userPII.findByTenantAndEmail.mockResolvedValue({
      id: 'user_existing',
      email: 'existing@example.com',
      name: 'Existing User',
    });
    const { directEmailCodeSendHandler } = await import('../direct-auth');

    const response = await directEmailCodeSendHandler(
      enableEmailOtp(
        createContext(
          {
            client_id: 'web-client',
            email: 'existing@example.com',
            code_challenge: 'email-pkce-challenge',
            code_challenge_method: 'S256',
            channel: 'browser',
          },
          webHeaders()
        )
      ) as never
    );

    expect(response.status).toBe(200);
    expect(mocks.validateRegistrationFieldSubmissionFromEnv).not.toHaveBeenCalled();
  });

  it('returns an accepted email-code response when login usage is disabled', async () => {
    mocks.userPII.findByTenantAndEmail.mockResolvedValue({
      id: 'user_existing',
      email: 'existing@example.com',
      name: 'Existing User',
    });
    const { directEmailCodeSendHandler } = await import('../direct-auth');
    const context = createContext(
      {
        client_id: 'web-client',
        email: 'existing@example.com',
        code_challenge: 'email-pkce-challenge',
        code_challenge_method: 'S256',
        channel: 'browser',
      },
      webHeaders()
    );
    context.env.SETTINGS = createMockKV({
      'settings:tenant:tenant_test:authentication-methods': JSON.stringify({
        'authentication-methods.email_otp.login_enabled': false,
        'authentication-methods.email_otp.signup_enabled': true,
      }),
    }) as never;

    const response = await directEmailCodeSendHandler(context as never);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      attempt_id: expect.any(String),
      expires_in: 300,
      masked_email: 'e***g@example.com',
    });
    expect(body).not.toHaveProperty('error');
    expect(mocks.hashEmailCode).not.toHaveBeenCalled();
    expect(mocks.challengeStore.storeChallengeRpc).not.toHaveBeenCalled();
    expect(mocks.emailNotifier.send).not.toHaveBeenCalled();
  });

  it('returns an accepted email-code response when signup usage is disabled', async () => {
    const { directEmailCodeSendHandler } = await import('../direct-auth');
    const context = createContext(
      {
        client_id: 'web-client',
        email: 'new@example.com',
        code_challenge: 'email-pkce-challenge',
        code_challenge_method: 'S256',
        channel: 'browser',
      },
      webHeaders()
    );
    context.env.SETTINGS = createMockKV({
      'settings:tenant:tenant_test:authentication-methods': JSON.stringify({
        'authentication-methods.email_otp.login_enabled': true,
        'authentication-methods.email_otp.signup_enabled': false,
      }),
    }) as never;

    const response = await directEmailCodeSendHandler(context as never);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      attempt_id: expect.any(String),
      expires_in: 300,
      masked_email: 'n***w@example.com',
    });
    expect(body).not.toHaveProperty('error');
    expect(mocks.userCore.createUser).not.toHaveBeenCalled();
    expect(mocks.hashEmailCode).not.toHaveBeenCalled();
    expect(mocks.challengeStore.storeChallengeRpc).not.toHaveBeenCalled();
    expect(mocks.emailNotifier.send).not.toHaveBeenCalled();
  });

  it('returns an accepted email-code response when signup Turnstile is missing', async () => {
    const { directEmailCodeSendHandler } = await import('../direct-auth');
    const context = createContext(
      {
        client_id: 'web-client',
        email: 'new@example.com',
        code_challenge: 'email-pkce-challenge',
        code_challenge_method: 'S256',
        channel: 'browser',
      },
      webHeaders()
    );
    context.env.SETTINGS = createEmailOtpEnabledSettings(
      {
        'plugins:enabled:human-verification-cloudflare-turnstile:tenant:tenant_test': 'true',
        'plugins:config:human-verification-cloudflare-turnstile:tenant:tenant_test': JSON.stringify(
          {
            siteKey: '0x4AAAAAA_site_key',
            secretKey: '0x4AAAAAA_secret_key',
            failurePolicy: 'fail_closed',
          }
        ),
      },
      {
        'authentication-methods.human_verification.provider':
          'human-verification-cloudflare-turnstile',
        'authentication-methods.human_verification.login_enabled': false,
        'authentication-methods.human_verification.signup_enabled': true,
      }
    ) as never;

    const response = await directEmailCodeSendHandler(context as never);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      attempt_id: expect.any(String),
      expires_in: 300,
      masked_email: 'n***w@example.com',
    });
    expect(body).not.toHaveProperty('error');
    expect(mocks.userCore.createUser).not.toHaveBeenCalled();
    expect(mocks.hashEmailCode).not.toHaveBeenCalled();
    expect(mocks.challengeStore.storeChallengeRpc).not.toHaveBeenCalled();
    expect(mocks.emailNotifier.send).not.toHaveBeenCalled();
  });

  it('returns an accepted email-code response when signup field validation fails', async () => {
    mocks.validateRegistrationFieldSubmissionFromEnv.mockResolvedValueOnce({
      ok: false,
      error: 'Missing required registration fields',
      missingRequiredFields: [
        {
          fieldKey: 'company',
          label: 'Company',
          fieldType: 'text',
        },
      ],
    });
    const { directEmailCodeSendHandler } = await import('../direct-auth');

    const response = await directEmailCodeSendHandler(
      enableEmailOtp(
        createContext(
          {
            client_id: 'web-client',
            email: 'new@example.com',
            code_challenge: 'email-pkce-challenge',
            code_challenge_method: 'S256',
            channel: 'browser',
          },
          webHeaders()
        )
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      attempt_id: expect.any(String),
      expires_in: 300,
      masked_email: 'n***w@example.com',
    });
    expect(body).not.toHaveProperty('error');
    expect(body).not.toHaveProperty('extensions');
    expect(mocks.userCore.createUser).not.toHaveBeenCalled();
    expect(mocks.hashEmailCode).not.toHaveBeenCalled();
    expect(mocks.challengeStore.storeChallengeRpc).not.toHaveBeenCalled();
    expect(mocks.emailNotifier.send).not.toHaveBeenCalled();
  });

  it('does not return email codes when no email notifier is configured', async () => {
    mocks.getNotifier.mockReturnValue(null);
    const { directEmailCodeSendHandler } = await import('../direct-auth');

    const response = await directEmailCodeSendHandler(
      enableEmailOtp(
        createContext(
          {
            client_id: 'web-client',
            email: 'new@example.com',
            code_challenge: 'email-pkce-challenge',
            code_challenge_method: 'S256',
            channel: 'browser',
          },
          webHeaders()
        )
      ) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(body).not.toHaveProperty('_dev_code');
    expect(body).not.toHaveProperty('code');
  });

  it('rejects email-code send when OTP_HMAC_SECRET is missing', async () => {
    const { directEmailCodeSendHandler } = await import('../direct-auth');
    const ctx = enableEmailOtp(
      createContext(
        {
          client_id: 'web-client',
          email: 'new@example.com',
          code_challenge: 'email-pkce-challenge',
          code_challenge_method: 'S256',
          channel: 'browser',
        },
        webHeaders()
      )
    );
    delete (ctx.env as { OTP_HMAC_SECRET?: string }).OTP_HMAC_SECRET;

    const response = await directEmailCodeSendHandler(ctx as never);

    expect(response.status).toBe(500);
    expect(mocks.hashEmailCode).not.toHaveBeenCalled();
  });

  it('allows email-code signup from a tenant Login UI proxy origin not present in registry', async () => {
    mocks.getWebOriginRegistry.mockResolvedValue({
      origins: [{ origin: 'https://login.test.authrim.com', handoff_allowed: true }],
    });
    const { directEmailCodeSendHandler } = await import('../direct-auth');

    const response = await directEmailCodeSendHandler(
      enableEmailOtp(
        createContext(
          {
            client_id: 'web-client',
            email: 'new@example.com',
            code_challenge: 'email-pkce-challenge',
            code_challenge_method: 'S256',
            channel: 'browser',
          },
          tenantProxyHeaders(),
          'https://test.authrim.com/api/v1/auth/direct/email-code/send'
        )
      ) as never
    );

    expect(response.status).toBe(200);
  });

  it('verifies an email code and returns a direct-auth artifact bound to PKCE', async () => {
    const codeVerifier = 'email-code-verifier';
    const codeChallenge = await s256Challenge(codeVerifier);
    const issuedAt = Date.now() - 10_000;
    const challengeData = {
      challenge: 'hashed-email-code',
      userId: 'user_existing',
      email: 'user@example.com',
      metadata: {
        code_challenge: codeChallenge,
        client_id: 'web-client',
        channel: 'browser',
        scope: 'openid email',
        transaction_id: 'attempt_1',
        issued_at: issuedAt,
      },
    };
    mocks.challengeStore.getChallengeRpc.mockResolvedValue(challengeData);
    mocks.challengeStore.consumeChallengeRpc.mockResolvedValue(challengeData);
    const { directEmailCodeVerifyHandler } = await import('../direct-auth');

    const response = await directEmailCodeVerifyHandler(
      createContext({
        attempt_id: 'attempt_1',
        code: '123456',
        code_verifier: codeVerifier,
        channel: 'browser',
      }) as never
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      direct_auth_artifact: expect.any(String),
      expires_in: 60,
      is_new_user: false,
    });
    expect(mocks.verifyEmailCodeHash).toHaveBeenCalledWith(
      '123456',
      'user@example.com',
      'attempt_1',
      issuedAt,
      'hashed-email-code',
      'otp-test-secret'
    );
    expect(mocks.challengeStore.getChallengeRpc).toHaveBeenCalledWith(
      'direct_email_code:attempt_1'
    );
    expect(mocks.challengeStore.consumeChallengeRpc).toHaveBeenCalledTimes(1);
    expect(mocks.coreAdapter.execute).toHaveBeenCalledWith(
      'UPDATE users_core SET email_verified = 1, last_login_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
      [expect.any(Number), expect.any(Number), 'user_existing', 'tenant_test']
    );
    expect(mocks.authCodeStore.storeCodeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'web-client',
        userId: 'user_existing',
        scope: 'openid email',
        codeChallenge,
      })
    );
  });

  it('keeps an email-code challenge available after an invalid code', async () => {
    const codeVerifier = 'email-code-retry-verifier';
    const codeChallenge = await s256Challenge(codeVerifier);
    const challengeData = {
      challenge: 'hashed-email-code',
      userId: 'user_existing',
      email: 'user@example.com',
      metadata: {
        code_challenge: codeChallenge,
        client_id: 'web-client',
        channel: 'browser',
        scope: 'openid email',
        transaction_id: 'attempt_retry',
        issued_at: Date.now() - 10_000,
      },
    };
    mocks.challengeStore.getChallengeRpc.mockResolvedValue(challengeData);
    mocks.challengeStore.consumeChallengeRpc.mockResolvedValue(challengeData);
    mocks.verifyEmailCodeHash.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { directEmailCodeVerifyHandler } = await import('../direct-auth');
    const request = {
      attempt_id: 'attempt_retry',
      code: '123456',
      code_verifier: codeVerifier,
      channel: 'browser',
    };

    const invalidResponse = await directEmailCodeVerifyHandler(createContext(request) as never);

    expect(invalidResponse.ok).toBe(false);
    expect(mocks.challengeStore.consumeChallengeRpc).not.toHaveBeenCalled();

    const validResponse = await directEmailCodeVerifyHandler(createContext(request) as never);

    expect(validResponse.status).toBe(200);
    expect(mocks.challengeStore.getChallengeRpc).toHaveBeenCalledTimes(2);
    expect(mocks.challengeStore.consumeChallengeRpc).toHaveBeenCalledTimes(1);
  });

  it('consumes an authenticated consent challenge through the shared authorization continuation', async () => {
    mocks.challengeStore.consumeChallengeRpc
      .mockRejectedValueOnce(new Error('not login'))
      .mockRejectedValueOnce(new Error('not reauth'))
      .mockResolvedValueOnce({
        userId: 'user_existing',
        metadata: {
          client_id: 'web-client',
          redirect_uri: 'https://app.example.com/callback',
          response_type: 'code',
          scope: 'openid profile',
          state: 'state_1',
          issuer: 'https://tenant.example.com',
          sessionUserId: 'user_existing',
        },
      });
    const { consumeAuthorizationChallengeContinuation } = await import('../direct-auth');

    const result = await consumeAuthorizationChallengeContinuation(
      {} as never,
      'tenant_test',
      'consent_challenge_1',
      'user_existing',
      1_700_000_123,
      'https://tenant.example.com'
    );

    expect(result).toMatchObject({
      type: 'consent',
      redirectUrl: expect.stringContaining('_consent_confirmation_challenge='),
    });
    expect(mocks.challengeStore.consumeChallengeRpc).toHaveBeenNthCalledWith(3, {
      id: 'consent_challenge_1',
      tenantId: 'tenant_test',
      type: 'consent',
      challenge: 'consent_challenge_1',
    });
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'consent',
        userId: 'user_existing',
        metadata: expect.objectContaining({ purpose: 'authorize_consent_confirmation' }),
      })
    );
  });

  it('turns a login continuation with a Flow consent receipt into a consent confirmation', async () => {
    mocks.challengeStore.consumeChallengeRpc.mockResolvedValueOnce({
      userId: 'user_existing',
      metadata: {
        client_id: 'web-client',
        redirect_uri: 'https://app.example.com/callback',
        response_type: 'code',
        scope: 'openid profile',
        state: 'state_1',
        issuer: 'https://tenant.example.com',
      },
    });
    const { consumeAuthorizationChallengeContinuation } = await import('../direct-auth');

    const result = await consumeAuthorizationChallengeContinuation(
      {} as never,
      'tenant_test',
      'login_challenge_1',
      'user_existing',
      1_700_000_123,
      'https://tenant.example.com',
      'cgr_0123456789abcdef0123456789abcdef'
    );

    expect(result).toMatchObject({
      type: 'login',
      redirectUrl: expect.stringContaining('_consent_confirmation_challenge='),
    });
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'consent',
        metadata: expect.objectContaining({
          purpose: 'authorize_consent_confirmation',
          consent_gate_receipt_id: 'cgr_0123456789abcdef0123456789abcdef',
          consent_gate_protocol_request_id: 'login_challenge_1',
        }),
      })
    );
  });
});
