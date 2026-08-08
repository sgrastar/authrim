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
    mirrorCounterAfterAuth: vi.fn(),
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
    markOtpLoginEmailVerified: vi.fn(),
    ensureDatabaseAdapter: vi.fn((source) => source),
    resolveOtpAccountCoreDataContextByIdentifierFromHono: vi.fn(),
    resolveAccountDataContextByIdentifierFromHono: vi.fn(),
    resolveAccountDataContextFromHono: vi.fn(),
    resolvePasskeyProvisioningResumeUserId: vi.fn(),
    provisionTenantD1EmailAccount: vi.fn(),
    publishTenantD1PasskeyRoute: vi.fn(),
    findActiveInvitationByToken: vi.fn(),
    getCookie: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    advancePasskeyCounterRpc: vi.fn(),
    createPIIContextFromHono: vi.fn(() => ({
      piiRepositories: {
        userPII,
      },
    })),
    createAccountAuthContextFromHono: vi.fn(),
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

vi.mock('../account-provisioning', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../account-provisioning')>();
  return {
    ...actual,
    resolvePasskeyProvisioningResumeUserId: mocks.resolvePasskeyProvisioningResumeUserId,
    provisionTenantD1EmailAccount: mocks.provisionTenantD1EmailAccount,
    publishTenantD1PasskeyRoute: mocks.publishTenantD1PasskeyRoute,
  };
});

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
      async findForOtpLogin(userId: string, trustedEmail: string) {
        const core = await mocks.userCore.findById(userId);
        if (!core?.is_active) return null;
        return {
          id: core.id,
          account_type: core.user_type === 'admin' ? 'admin' : 'end_user',
          active: 1,
          email: trustedEmail.toLowerCase(),
          name: null,
          email_verified: core.email_verified ? 1 : 0,
          created_at: new Date(core.created_at ?? Date.now()).toISOString(),
        };
      }
      async findAccountAuthenticationState(userId: string) {
        const core = await mocks.userCore.findById(userId);
        if (!core) return null;
        return {
          userId,
          accountType: core.user_type === 'admin' ? 'admin' : 'user',
          lifecycle: core.is_active ? 'active' : 'inactive',
          sourceVersionMs: 1_000,
        };
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
    resolveAccountDataContextByIdentifierFromHono:
      mocks.resolveAccountDataContextByIdentifierFromHono,
    resolveOtpAccountCoreDataContextByIdentifierFromHono:
      mocks.resolveOtpAccountCoreDataContextByIdentifierFromHono,
    markOtpLoginEmailVerified: mocks.markOtpLoginEmailVerified,
    ensureDatabaseAdapter: mocks.ensureDatabaseAdapter,
    resolveAccountDataContextFromHono: mocks.resolveAccountDataContextFromHono,
    ensureAccountAuthenticationState: vi.fn(async (_env, _tenant, _user, loader) => loader()),
    advancePasskeyAuthenticationState: vi.fn(async (_env, input, loader) => {
      const account = await loader();
      if (!account || account.lifecycle !== 'active') {
        throw new Error('account_authentication_not_allowed');
      }
      return mocks.advancePasskeyCounterRpc(
        input.tenantId,
        input.userId,
        `account:${input.userId}`,
        input.credentialId,
        input.storedCounter,
        input.observedCounter,
        input.observedAtMs
      );
    }),
    getSessionRevocationStore: vi.fn(() => ({
      advancePasskeyCounterRpc: mocks.advancePasskeyCounterRpc,
    })),
    createAuthContextFromHono: vi.fn(() => ({
      coreAdapter: mocks.coreAdapter,
      repositories: {
        userCore: mocks.userCore,
        passkey: mocks.passkey,
      },
    })),
    createAccountAuthContextFromHono: mocks.createAccountAuthContextFromHono.mockImplementation(() => ({
      coreAdapter: mocks.coreAdapter,
      repositories: {
        userCore: mocks.userCore,
        passkey: mocks.passkey,
      },
    })),
    createPIIContextFromHono: mocks.createPIIContextFromHono,
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
    executionCtx: {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    },
    json: (payload: unknown, status = 200, responseHeaders: Record<string, string> = {}) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json', ...responseHeaders },
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
    mocks.passkey.mirrorCounterAfterAuth.mockResolvedValue(true);
    mocks.advancePasskeyCounterRpc.mockResolvedValue({ counter: 5, advanced: true });
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
    mocks.resolveAccountDataContextByIdentifierFromHono.mockResolvedValue({});
    mocks.resolveAccountDataContextFromHono.mockResolvedValue({});
    mocks.resolveOtpAccountCoreDataContextByIdentifierFromHono.mockResolvedValue({
      tenantId: 'tenant_test',
      accountId: 'account:user_existing',
      legacyUserId: 'user_existing',
      storageProfileId: 'builtin:storage:tenant-d1',
      coreDb: { adapter: 'tenant-core' },
      coreBindingRef: 'TDB_USERS',
      coreResidencyPartition: 'default',
      accountRouteGeneration: 1,
      membership: {},
      user: {
        id: 'user_existing',
        email: 'user@example.com',
        name: 'Example User',
        active: 1,
        email_verified: 0,
        account_type: 'end_user',
        created_at: new Date(Date.now() - 120_000).toISOString(),
      },
    });
    mocks.markOtpLoginEmailVerified.mockResolvedValue(true);
    mocks.provisionTenantD1EmailAccount.mockResolvedValue({
      status: 'ready',
      accountId: 'account:user_new',
      userId: 'user_new',
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
    expect(mocks.advancePasskeyCounterRpc).toHaveBeenCalledWith(
      'tenant_test',
      'user_existing',
      'account:user_existing',
      'passkey_1',
      4,
      5,
      expect.any(Number)
    );
    expect(mocks.passkey.mirrorCounterAfterAuth).toHaveBeenCalledWith('passkey_1', 5);
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

  it('keeps login successful when the asynchronous Passkey D1 mirror is write-fenced', async () => {
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
    mocks.passkey.mirrorCounterAfterAuth.mockRejectedValue(
      new Error('D1_ERROR: tenant_placement_migration_write_fenced private-row')
    );
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
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ direct_auth_artifact: expect.any(String) });
    expect(JSON.stringify(body)).not.toContain('private-row');
    expect(mocks.authCodeStore.storeCodeRpc).toHaveBeenCalled();
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

  it('starts passkey signup without email for a tenant-exclusive account', async () => {
    mocks.getWebOriginRegistry.mockResolvedValueOnce({
      origins: [{ origin: 'https://login.test.authrim.com', handoff_allowed: true }],
    });
    mocks.provisionTenantD1EmailAccount.mockResolvedValueOnce({
      status: 'ready',
      accountId: 'account:user_new',
      userId: 'user_new',
    });
    const { directPasskeySignupStartHandler } = await import('../direct-auth');

    const context = createContext(
      {
        client_id: 'web-client',
        code_challenge: 'signup-pkce-challenge',
        code_challenge_method: 'S256',
        channel: 'browser',
      },
      tenantProxyHeaders(),
      'https://test.authrim.com/api/v1/auth/direct/passkey/signup/start'
    );
    context.get = vi.fn((key: string) => {
      if (key === 'tenantId') return 'tenant_test';
      if (key === 'tenantMetadataContext') {
        return { tenantId: 'tenant_test', storageProfileId: 'builtin:storage:tenant-d1' };
      }
      return undefined;
    }) as never;
    context.env.ALLOWED_ORIGINS = 'https://login.test.authrim.com';

    const response = await directPasskeySignupStartHandler(context as never);

    expect(response.status).toBe(200);
    expect(mocks.provisionTenantD1EmailAccount).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        flow: 'passkey',
        email: null,
        runtimeUser: expect.objectContaining({
          piiFields: expect.not.objectContaining({ email: true }),
          sensitiveValues: expect.not.objectContaining({ email: expect.anything() }),
        }),
      })
    );
    const provisioningCallOrder =
      mocks.provisionTenantD1EmailAccount.mock.invocationCallOrder.at(-1);
    const piiStoreCallOrder = mocks.createPIIContextFromHono.mock.invocationCallOrder.at(-1);
    expect(provisioningCallOrder).toBeDefined();
    expect(piiStoreCallOrder).toBeDefined();
    expect(piiStoreCallOrder).toBeGreaterThan(provisioningCallOrder!);
    expect(mocks.generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        userName: 'user_new',
        userDisplayName: 'user_new',
      })
    );
  });

  it('reuses the same candidate user when an email-less tenant account resumes after 202', async () => {
    mocks.generateUserIdFromSettings
      .mockReset()
      .mockResolvedValue('user_new')
      .mockResolvedValueOnce('user_first')
      .mockResolvedValueOnce('user_second');
    mocks.getWebOriginRegistry.mockResolvedValue({
      origins: [{ origin: 'https://login.test.authrim.com', handoff_allowed: true }],
    });
    mocks.provisionTenantD1EmailAccount
      .mockReset()
      .mockResolvedValue({
        status: 'ready',
        accountId: 'account:user_new',
        userId: 'user_new',
      })
      .mockResolvedValueOnce({
        status: 'pending',
        response: Response.json(
          {
            status: 'provisioning',
            provisioning_token: 'A'.repeat(43),
            status_endpoint: '/api/v1/auth/account-provisioning/status',
            retry_after_ms: 500,
            resume_user_id: 'user_first',
          },
          { status: 202 }
        ),
      })
      .mockResolvedValueOnce({
        status: 'ready',
        accountId: 'account:user_first',
        userId: 'user_first',
      });
    mocks.resolvePasskeyProvisioningResumeUserId.mockResolvedValueOnce('user_first');
    const { directPasskeySignupStartHandler } = await import('../direct-auth');
    const request = {
      client_id: 'web-client',
      code_challenge: 'signup-pkce-challenge',
      code_challenge_method: 'S256',
      channel: 'browser',
    };

    const createContextForRequest = (body: Record<string, unknown>) => {
      const context = createContext(
        body,
        tenantProxyHeaders(),
        'https://test.authrim.com/api/v1/auth/direct/passkey/signup/start'
      );
      context.get = vi.fn((key: string) => {
        if (key === 'tenantId') return 'tenant_test';
        if (key === 'tenantMetadataContext') {
          return { tenantId: 'tenant_test', storageProfileId: 'builtin:storage:tenant-d1' };
        }
        return undefined;
      }) as never;
      context.env.ALLOWED_ORIGINS = 'https://login.test.authrim.com';
      return context;
    };

    const firstResponse = await directPasskeySignupStartHandler(
      createContextForRequest(request) as never
    );
    expect(firstResponse.status).toBe(202);

    const resumedResponse = await directPasskeySignupStartHandler(
      createContextForRequest({
        ...request,
        provisioning_token: 'A'.repeat(43),
        resume_user_id: 'user_first',
      }) as never
    );
    expect(resumedResponse.status).toBe(200);
    expect(mocks.generateUserIdFromSettings).toHaveBeenCalledOnce();
    expect(mocks.provisionTenantD1EmailAccount).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ candidateUserId: 'user_first' })
    );
    expect(mocks.provisionTenantD1EmailAccount).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ candidateUserId: 'user_first' })
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
    mocks.publishTenantD1PasskeyRoute.mockResolvedValue(201);
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

  it('finishes tenant-exclusive passkey signup using the routed account database context', async () => {
    const codeVerifier = 'tenant-passkey-signup-code-verifier';
    const codeChallenge = await s256Challenge(codeVerifier);
    mocks.challengeStore.getChallengeRpc.mockResolvedValue({ userId: 'user_new' });
    mocks.challengeStore.consumeChallengeRpc.mockResolvedValue({
      challenge: 'tenant-passkey-signup-challenge',
      metadata: {
        code_challenge: codeChallenge,
        client_id: 'web-client',
        channel: 'browser',
        origin: 'https://app.example.com',
        rpID: 'app.example.com',
      },
    });
    mocks.publishTenantD1PasskeyRoute.mockResolvedValue(201);
    mocks.userCore.findById.mockResolvedValue({
      id: 'user_new',
      is_active: true,
      created_at: Date.now(),
    });
    const context = createContext({
      challenge_id: 'tenant_signup_challenge',
      credential: {
        id: 'tenant-new-credential',
        rawId: 'tenant-new-credential',
        response: { transports: ['internal'] },
        type: 'public-key',
      },
      code_verifier: codeVerifier,
      channel: 'browser',
    });
    context.get = vi.fn((key: string) => {
      if (key === 'tenantId') return 'tenant_test';
      if (key === 'tenantMetadataContext') {
        return { tenantId: 'tenant_test', storageProfileId: 'builtin:storage:tenant-d1' };
      }
      return undefined;
    }) as never;

    const { directPasskeySignupFinishHandler } = await import('../direct-auth');
    const response = await directPasskeySignupFinishHandler(context as never);

    expect(response.status).toBe(200);
    expect(mocks.resolveAccountDataContextFromHono).toHaveBeenCalledWith(context, 'user_new');
    expect(mocks.createAccountAuthContextFromHono).toHaveBeenCalled();
    expect(mocks.passkey.create).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'user_new' })
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

  it('returns 202 without sending an OTP while a tenant-D1 account route is pending', async () => {
    mocks.resolveOtpAccountCoreDataContextByIdentifierFromHono.mockRejectedValueOnce(
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
    const context = enableEmailOtp(
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
    context.get = vi.fn((key: string) => {
      if (key === 'tenantId') return 'tenant_test';
      if (key === 'tenantMetadataContext') {
        return { tenantId: 'tenant_test', storageProfileId: 'builtin:storage:tenant-d1' };
      }
      return undefined;
    }) as never;
    const { directEmailCodeSendHandler } = await import('../direct-auth');

    const response = await directEmailCodeSendHandler(context as never);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: 'provisioning' });
    expect(mocks.provisionTenantD1EmailAccount).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        tenantId: 'tenant_test',
        candidateUserId: 'user_new',
        flow: 'email_code',
        email: 'new@example.com',
        runtimeUser: expect.objectContaining({
          sourceRef: 'auth:email_code',
          sensitiveValues: expect.objectContaining({ email: 'new@example.com' }),
        }),
      })
    );
    expect(mocks.challengeStore.storeChallengeRpc).not.toHaveBeenCalled();
    expect(mocks.emailNotifier.send).not.toHaveBeenCalled();
  });

  it('uses the routed Core-only OTP read for an existing tenant-D1 account', async () => {
    const context = enableEmailOtp(
      createContext(
        {
          client_id: 'web-client',
          email: 'USER@example.com',
          code_challenge: 'email-pkce-challenge',
          code_challenge_method: 'S256',
          channel: 'browser',
        },
        webHeaders()
      )
    );
    context.get = vi.fn((key: string) => {
      if (key === 'tenantId') return 'tenant_test';
      if (key === 'tenantMetadataContext') {
        return { tenantId: 'tenant_test', storageProfileId: 'builtin:storage:tenant-d1' };
      }
      return undefined;
    }) as never;
    const { directEmailCodeSendHandler } = await import('../direct-auth');

    const response = await directEmailCodeSendHandler(context as never);

    expect(response.status).toBe(200);
    expect(mocks.resolveOtpAccountCoreDataContextByIdentifierFromHono).toHaveBeenCalledWith(
      context,
      {
        indexKind: 'email_exact',
        identifier: 'user@example.com',
        trustedEmail: 'user@example.com',
      }
    );
    expect(mocks.userCore.findById).not.toHaveBeenCalled();
    expect(mocks.userPII.findByTenantAndEmail).not.toHaveBeenCalled();
    expect(mocks.userPII.createPII).not.toHaveBeenCalled();
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user_existing',
        email: 'user@example.com',
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
    mocks.resolveTenantFromEmailDomain.mockResolvedValue('tenant_other');
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
    expect(mocks.resolveTenantFromEmailDomain).not.toHaveBeenCalled();
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

  it('does not return an accepted response when the email provider rejects delivery', async () => {
    mocks.emailNotifier.send.mockResolvedValueOnce({
      success: false,
      error: 'provider secret detail',
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

    expect(response.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('provider secret detail');
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

  it('verifies tenant-D1 email OTP with the routed Core projection and one focused update', async () => {
    const codeVerifier = 'tenant-d1-email-code-verifier';
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
        transaction_id: 'attempt_tenant_d1',
        issued_at: Date.now() - 10_000,
      },
    };
    mocks.challengeStore.getChallengeRpc.mockResolvedValue(challengeData);
    mocks.challengeStore.consumeChallengeRpc.mockResolvedValue(challengeData);
    const context = createContext({
      attempt_id: 'attempt_tenant_d1',
      code: '123456',
      code_verifier: codeVerifier,
      channel: 'browser',
    });
    context.get = vi.fn((key: string) => {
      if (key === 'tenantId') return 'tenant_test';
      if (key === 'tenantMetadataContext') {
        return { tenantId: 'tenant_test', storageProfileId: 'builtin:storage:tenant-d1' };
      }
      return undefined;
    }) as never;
    const { directEmailCodeVerifyHandler } = await import('../direct-auth');

    const response = await directEmailCodeVerifyHandler(context as never);

    expect(response.status).toBe(200);
    expect(mocks.resolveOtpAccountCoreDataContextByIdentifierFromHono).toHaveBeenCalledWith(
      context,
      {
        indexKind: 'account_id',
        identifier: 'account:user_existing',
        expectedAccountId: 'account:user_existing',
        expectedLegacyUserId: 'user_existing',
        trustedEmail: 'user@example.com',
      }
    );
    expect(mocks.userCore.findById).not.toHaveBeenCalled();
    expect(mocks.userPII.findById).not.toHaveBeenCalled();
    expect(mocks.markOtpLoginEmailVerified).toHaveBeenCalledWith(
      { adapter: 'tenant-core' },
      'tenant_test',
      'user_existing',
      expect.any(Number)
    );
    expect(context.executionCtx.waitUntil).toHaveBeenCalledOnce();
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
});
