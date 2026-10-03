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
    getTenantSettingsDocument: vi.fn(),
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

vi.mock('../human-verification', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../human-verification')>()),
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
    withGroupInputWrite: <T>(
      db: import('@authrim/ar-lib-core').DatabaseAdapter,
      tenant: string,
      user: string,
      operation: string,
      write: () => Promise<T>
    ) =>
      actual.withGroupInputWrite(
        typeof db.execute === 'function'
          ? db
          : { ...db, execute: async () => ({ success: true, rowsAffected: 1 }) },
        tenant,
        user,
        operation,
        write
      ),

    assertGuestCredentialAuthenticationAllowed: vi.fn(async () => undefined),
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
    getTenantSettingsDocument: mocks.getTenantSettingsDocument,
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
    createAccountAuthContextFromHono: mocks.createAccountAuthContextFromHono.mockImplementation(
      () => ({
        coreAdapter: mocks.coreAdapter,
        repositories: {
          userCore: mocks.userCore,
          passkey: mocks.passkey,
        },
      })
    ),
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

/** Challenge consumptions apart from looking up a resumed email-code send. */
function consumesOtherThanSendResume() {
  return mocks.challengeStore.consumeChallengeRpc.mock.calls.filter(
    ([request]) => (request as { type?: string })?.type !== 'direct_email_send_resume'
  );
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
    mocks.getTenantSettingsDocument.mockResolvedValue(null);
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
    // As the store does, an unknown record cannot be consumed (a send not resumed after provisioning).
    mocks.challengeStore.consumeChallengeRpc.mockImplementation(
      async (request: { type?: string }) => {
        if (request?.type === 'direct_email_send_resume') throw new Error('Challenge not found');
        return undefined;
      }
    );
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
      userId: 'user_existing',
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

  it('binds a passkey re-authentication to the user it was asked of', async () => {
    mocks.challengeStore.getChallengeRpc.mockResolvedValue({
      id: 'reauth_challenge',
      tenantId: 'tenant_test',
      type: 'reauth',
      userId: 'anonymous',
      metadata: { sessionUserId: 'user_existing' },
      challenge: 'reauth_challenge',
    });
    const { directPasskeyLoginStartHandler } = await import('../direct-auth');

    const response = await directPasskeyLoginStartHandler(
      createContext(
        {
          client_id: 'web-client',
          code_challenge: 'challenge',
          code_challenge_method: 'S256',
          channel: 'browser',
          authorization_challenge_id: 'reauth_challenge',
        },
        webHeaders(),
        'https://app.example.com/api/v1/auth/direct/passkey/login/start'
      ) as never
    );

    expect(response.status).toBe(200);
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'direct_passkey_login',
        metadata: expect.objectContaining({ usage: 'reauth', reauth_user_id: 'user_existing' }),
      })
    );
  });

  it('refuses a re-authentication challenge that names no user', async () => {
    mocks.challengeStore.getChallengeRpc.mockResolvedValue({
      id: 'reauth_challenge',
      tenantId: 'tenant_test',
      type: 'reauth',
      userId: 'anonymous',
      challenge: 'reauth_challenge',
    });
    const { directPasskeyLoginStartHandler } = await import('../direct-auth');

    const response = await directPasskeyLoginStartHandler(
      createContext(
        {
          client_id: 'web-client',
          code_challenge: 'challenge',
          code_challenge_method: 'S256',
          channel: 'browser',
          authorization_challenge_id: 'reauth_challenge',
        },
        webHeaders(),
        'https://app.example.com/api/v1/auth/direct/passkey/login/start'
      ) as never
    );

    expect(response.status).toBe(400);
    expect(mocks.challengeStore.storeChallengeRpc).not.toHaveBeenCalled();
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
          usage: 'login',
        }),
      })
    );
  }, 10_000);

  it.each([
    ['login', 'authentication-methods.passkey.login_enabled'],
    ['reauth', 'authentication-methods.passkey.reauth_enabled'],
  ])(
    'refuses to finish a passkey %s turned off since its challenge was issued',
    async (usage, setting) => {
      const codeVerifier = 'passkey-login-code-verifier';
      mocks.challengeStore.consumeChallengeRpc.mockResolvedValue({
        challenge: 'passkey-login-challenge',
        metadata: {
          code_challenge: await s256Challenge(codeVerifier),
          client_id: 'web-client',
          channel: 'browser',
          origin: 'https://app.example.com',
          rpID: 'app.example.com',
          usage,
        },
      });
      const { directPasskeyLoginFinishHandler } = await import('../direct-auth');
      const context = createContext({
        challenge_id: 'challenge_1',
        credential: {
          id: 'credential-id',
          rawId: 'credential-id',
          response: {},
          type: 'public-key',
        },
        code_verifier: codeVerifier,
        channel: 'browser',
      });
      context.env.SETTINGS = createMockKV({
        'settings:tenant:tenant_test:authentication-methods': JSON.stringify({ [setting]: false }),
      }) as never;

      const response = await directPasskeyLoginFinishHandler(context as never);

      expect(response.status).toBe(403);
      expect(mocks.authCodeStore.storeCodeRpc).not.toHaveBeenCalled();
    }
  );

  it("refuses a passkey re-authentication finished with another user's passkey", async () => {
    const codeVerifier = 'passkey-login-code-verifier';
    mocks.challengeStore.consumeChallengeRpc.mockResolvedValue({
      challenge: 'passkey-login-challenge',
      metadata: {
        code_challenge: await s256Challenge(codeVerifier),
        client_id: 'web-client',
        channel: 'browser',
        origin: 'https://app.example.com',
        rpID: 'app.example.com',
        usage: 'reauth',
        reauth_user_id: 'user_someone_else',
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

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mocks.authCodeStore.storeCodeRpc).not.toHaveBeenCalled();
  });

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
          // When the assertion was verified, for the session redeemed from it.
          proven_at: expect.any(Number),
        }),
      })
    );
  });

  it('gives the code, its challenge and the response the configured code lifetime', async () => {
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
    const context = createContext({
      challenge_id: 'challenge_1',
      credential: { id: 'credential-id', rawId: 'credential-id', response: {}, type: 'public-key' },
      code_verifier: codeVerifier,
      channel: 'browser',
    });
    context.env.SETTINGS = createMockKV({
      'settings:tenant:tenant_test:oauth': JSON.stringify({ 'oauth.auth_code_ttl': 120 }),
    }) as never;

    const response = await directPasskeyLoginFinishHandler(context as never);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.expires_in).toBe(120);
    expect(mocks.authCodeStore.storeCodeRpc).toHaveBeenCalledWith(
      expect.objectContaining({ ttlSeconds: 120 })
    );
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'direct_auth_code', ttl: 120 })
    );
  });

  it.each([
    [
      'off',
      {},
      { acr: 'urn:mace:incommon:iap:bronze' },
      ['aal', 'amr', 'assuranceAcr', 'assuranceAmr'],
    ],
    [
      'on, with the acr in ID tokens',
      { 'assurance.enabled': true },
      {
        acr: 'urn:authrim:aal:2',
        aal: 'AAL2',
        amr: ['passkey'],
        assuranceAcr: 'urn:authrim:aal:2',
      },
      [],
    ],
    [
      'on, without it',
      { 'assurance.enabled': true, 'assurance.include_in_id_token': false },
      {
        acr: 'urn:mace:incommon:iap:bronze',
        aal: 'AAL2',
        amr: ['passkey'],
        assuranceAcr: 'urn:authrim:aal:2',
      },
      [],
    ],
  ])(
    'records how a passkey login authenticated on its code with assurance %s',
    async (_label, assurance, recorded, absent) => {
      const codeVerifier = 'passkey-login-code-verifier';
      mocks.challengeStore.consumeChallengeRpc.mockResolvedValue({
        challenge: 'passkey-login-challenge',
        metadata: {
          code_challenge: await s256Challenge(codeVerifier),
          client_id: 'web-client',
          channel: 'browser',
          scope: 'openid profile',
          transaction_id: 'transaction_1',
          origin: 'https://app.example.com',
          rpID: 'app.example.com',
        },
      });
      const { directPasskeyLoginFinishHandler } = await import('../direct-auth');
      const context = createContext({
        challenge_id: 'challenge_1',
        credential: {
          id: 'credential-id',
          rawId: 'credential-id',
          response: {},
          type: 'public-key',
        },
        code_verifier: codeVerifier,
        channel: 'browser',
      });
      context.env.SETTINGS = createMockKV({
        'settings:tenant:tenant_test:assurance': JSON.stringify(assurance),
      }) as never;

      expect((await directPasskeyLoginFinishHandler(context as never)).status).toBe(200);

      const stored = mocks.authCodeStore.storeCodeRpc.mock.calls.at(-1)?.[0] as Record<
        string,
        unknown
      >;
      expect(stored).toMatchObject(recorded);
      for (const field of absent) expect(stored).not.toHaveProperty(field);
    }
  );

  it('spends no passkey login challenge while the assurance settings cannot be read', async () => {
    const { directPasskeyLoginFinishHandler } = await import('../direct-auth');
    const context = createContext({
      challenge_id: 'challenge_1',
      credential: { id: 'credential-id', rawId: 'credential-id', response: {}, type: 'public-key' },
      code_verifier: 'passkey-login-code-verifier',
      channel: 'browser',
    });
    context.env.SETTINGS = {
      get: vi.fn(async (key: string) => {
        if (key === 'settings:tenant:tenant_test:assurance') throw new Error('KV unavailable');
        return null;
      }),
    } as never;

    const response = await directPasskeyLoginFinishHandler(context as never);

    expect(response.status).toBe(503);
    expect(mocks.challengeStore.consumeChallengeRpc).not.toHaveBeenCalled();
    expect(mocks.authCodeStore.storeCodeRpc).not.toHaveBeenCalled();
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

  it.each([
    ['refuses a sign-up carried by a re-authentication challenge', 'reauth', {}, 400],
    [
      'checks the sign-up switch for a sign-up carried by a login challenge',
      'login',
      { 'authentication-methods.passkey.signup_enabled': false },
      403,
    ],
  ])('%s', async (_label, type, settings, status) => {
    mocks.challengeStore.getChallengeRpc.mockResolvedValue({
      id: 'authorization_challenge',
      tenantId: 'tenant_test',
      type,
      userId: 'user_existing',
      challenge: 'authorization_challenge',
    });
    const { directPasskeySignupStartHandler } = await import('../direct-auth');
    const context = createContext(
      {
        client_id: 'web-client',
        email: 'new@example.com',
        code_challenge: 'signup-pkce-challenge',
        code_challenge_method: 'S256',
        channel: 'browser',
        authorization_challenge_id: 'authorization_challenge',
      },
      webHeaders()
    );
    context.env.SETTINGS = createMockKV({
      'settings:tenant:tenant_test:authentication-methods': JSON.stringify(settings),
    }) as never;

    const response = await directPasskeySignupStartHandler(context as never);

    expect(response.status).toBe(status);
    expect(mocks.generateRegistrationOptions).not.toHaveBeenCalled();
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

  it('provisions a routed account before passkey signup in a shared pool', async () => {
    mocks.getWebOriginRegistry.mockResolvedValueOnce({
      origins: [{ origin: 'https://login.test.authrim.com', handoff_allowed: true }],
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
        return {
          tenantId: 'tenant_test',
          route: { allocationScope: 'shared_pool' },
        };
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
      })
    );
    expect(mocks.resolveAccountDataContextFromHono).toHaveBeenCalledWith(
      context,
      'account:user_new'
    );
    expect(mocks.createAccountAuthContextFromHono).toHaveBeenCalled();
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

  it("uses the tenant's email code lifetime, for a code sent and for a send that sends nothing", async () => {
    const { directEmailCodeSendHandler } = await import('../direct-auth');
    const lifetime = {
      'settings:tenant:tenant_test:credentials': JSON.stringify({
        'credentials.email_code_ttl': 600,
      }),
    };
    const send = (email: string, overrides: Record<string, boolean | string> = {}) =>
      directEmailCodeSendHandler(
        enableEmailOtp(
          createContext(
            {
              client_id: 'web-client',
              email,
              code_challenge: 'email-pkce-challenge',
              code_challenge_method: 'S256',
              channel: 'browser',
            },
            webHeaders()
          ),
          lifetime,
          overrides
        ) as never
      );

    const sent = (await (await send('new@example.com')).json()) as Record<string, unknown>;
    expect(sent).toMatchObject({ expires_in: 600 });
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'direct_email_code', ttl: 600 })
    );

    // Signing up by email turned off: nothing is sent, and the answer looks the same.
    const suppressed = (await (
      await send('other@example.com', { 'authentication-methods.email_otp.signup_enabled': false })
    ).json()) as Record<string, unknown>;
    expect(suppressed).toMatchObject({ expires_in: 600 });
    expect(
      mocks.challengeStore.storeChallengeRpc.mock.calls.filter(
        ([request]) => (request as { type?: string }).type === 'direct_email_code'
      )
    ).toHaveLength(1);
  });

  it('never lets a code outlast the sign-in challenge it continues', async () => {
    mocks.challengeStore.getChallengeRpc.mockResolvedValue({
      tenantId: 'tenant_test',
      type: 'login',
      challenge: 'login_challenge',
      expiresAt: Date.now() + 120_000,
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
            authorization_challenge_id: 'login_challenge',
          },
          webHeaders()
        ),
        {
          'settings:tenant:tenant_test:credentials': JSON.stringify({
            'credentials.email_code_ttl': 600,
          }),
        }
      ) as never
    );
    const body = (await response.json()) as { expires_in: number };

    expect(body.expires_in).toBeGreaterThan(110);
    expect(body.expires_in).toBeLessThanOrEqual(120);
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'direct_email_code', ttl: body.expires_in })
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

  const emailSendBody = (extra: Record<string, unknown> = {}) => ({
    client_id: 'web-client',
    email: 'same@example.com',
    code_challenge: 'email-pkce-challenge',
    code_challenge_method: 'S256',
    channel: 'browser',
    scope: 'openid email',
    ...extra,
  });
  const reauthChallenge = (userId: string) => ({
    id: 'reauth_challenge',
    tenantId: 'tenant_test',
    type: 'reauth',
    userId,
    challenge: 'reauth_challenge',
  });
  const storedEmailCodes = () =>
    mocks.challengeStore.storeChallengeRpc.mock.calls.filter(
      ([request]) => (request as { type?: string }).type === 'direct_email_code'
    );

  it('sends a re-authentication code only to the user the challenge names', async () => {
    mocks.userPII.findByTenantAndEmail.mockResolvedValue({
      id: 'user_existing',
      email: 'same@example.com',
      name: 'Existing User',
    });
    mocks.challengeStore.getChallengeRpc.mockResolvedValue(reauthChallenge('user_existing'));
    const { directEmailCodeSendHandler } = await import('../direct-auth');

    const response = await directEmailCodeSendHandler(
      enableEmailOtp(
        createContext(
          emailSendBody({ authorization_challenge_id: 'reauth_challenge' }),
          webHeaders()
        )
      ) as never
    );

    expect(response.status).toBe(200);
    expect(storedEmailCodes()).toHaveLength(1);
    expect(storedEmailCodes()[0][0]).toMatchObject({
      metadata: expect.objectContaining({ usage: 'reauth', reauth_user_id: 'user_existing' }),
    });
  });

  it('answers but sends nothing for a re-authentication challenge naming someone else', async () => {
    mocks.userPII.findByTenantAndEmail.mockResolvedValue({
      id: 'user_existing',
      email: 'same@example.com',
      name: 'Existing User',
    });
    mocks.challengeStore.getChallengeRpc.mockResolvedValue(reauthChallenge('user_other'));
    const { directEmailCodeSendHandler } = await import('../direct-auth');

    const response = await directEmailCodeSendHandler(
      enableEmailOtp(
        createContext(
          emailSendBody({ authorization_challenge_id: 'reauth_challenge' }),
          webHeaders()
        ),
        {},
        { 'authentication-methods.email_otp.login_enabled': false }
      ) as never
    );

    expect(response.status).toBe(200);
    expect(storedEmailCodes()).toHaveLength(0);
    expect(mocks.emailNotifier.send).not.toHaveBeenCalled();
    // Nothing else about the address is looked at, human verification included.
    expect(mocks.verifyHumanVerificationForAction).not.toHaveBeenCalled();
  });

  it('judges a new address as a sign-up whatever challenge it comes with', async () => {
    mocks.challengeStore.getChallengeRpc.mockResolvedValue({
      id: 'login_challenge',
      tenantId: 'tenant_test',
      type: 'login',
      challenge: 'login_challenge',
    });
    const { directEmailCodeSendHandler } = await import('../direct-auth');

    const response = await directEmailCodeSendHandler(
      enableEmailOtp(
        createContext(
          emailSendBody({
            email: 'brand-new@example.com',
            authorization_challenge_id: 'login_challenge',
          }),
          webHeaders()
        ),
        {},
        { 'authentication-methods.email_otp.signup_enabled': false }
      ) as never
    );

    expect(response.status).toBe(200);
    expect(storedEmailCodes()).toHaveLength(0);
  });

  it('keeps the accepted response indistinguishable when delivery fails or the account is absent', async () => {
    mocks.userPII.findByTenantAndEmail.mockResolvedValueOnce({
      id: 'user_existing',
      email: 'same@example.com',
      name: 'Existing User',
    });
    mocks.emailNotifier.send.mockResolvedValueOnce({ success: false });
    const { directEmailCodeSendHandler } = await import('../direct-auth');
    const request = () =>
      enableEmailOtp(
        createContext(
          {
            client_id: 'web-client',
            email: 'same@example.com',
            code_challenge: 'email-pkce-challenge',
            code_challenge_method: 'S256',
            channel: 'browser',
          },
          webHeaders()
        ),
        {},
        { 'authentication-methods.email_otp.signup_enabled': false }
      );

    const deliveryFailureResponse = await directEmailCodeSendHandler(request() as never);
    const deliveryFailureBody = (await deliveryFailureResponse.json()) as Record<string, unknown>;

    mocks.userPII.findByTenantAndEmail.mockResolvedValueOnce(null);
    const absentAccountResponse = await directEmailCodeSendHandler(request() as never);
    const absentAccountBody = (await absentAccountResponse.json()) as Record<string, unknown>;

    expect(deliveryFailureResponse.status).toBe(200);
    expect(absentAccountResponse.status).toBe(200);
    expect(deliveryFailureBody).toMatchObject({
      attempt_id: expect.any(String),
      expires_in: 300,
      masked_email: 's***e@example.com',
    });
    expect(absentAccountBody).toMatchObject({
      attempt_id: expect.any(String),
      expires_in: 300,
      masked_email: 's***e@example.com',
    });
    expect(Object.keys(deliveryFailureBody).sort()).toEqual(Object.keys(absentAccountBody).sort());
    expect(mocks.challengeStore.deleteChallengeRpc).toHaveBeenCalledWith(
      expect.stringMatching(/^direct_email_code:/)
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
    // No code yet: only the record that resumes this send, as the sign-up it is.
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledTimes(1);
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'direct_email_send_resume',
        ttl: 300,
        metadata: { usage: 'signup' },
      })
    );
    expect(mocks.emailNotifier.send).not.toHaveBeenCalled();
  });

  it('resumes a provisioned send as the sign-up it was, without checking it again', async () => {
    mocks.challengeStore.consumeChallengeRpc.mockImplementationOnce(
      async (request: { type?: string; id?: string }) => {
        expect(request).toMatchObject({
          type: 'direct_email_send_resume',
          id: expect.stringMatching(/^direct_email_send_resume:[0-9a-f]{64}$/),
        });
        return { metadata: { usage: 'signup' } };
      }
    );
    mocks.userPII.findByTenantAndEmail.mockResolvedValue({
      id: 'user_existing',
      email: 'user@example.com',
    });
    const { directEmailCodeSendHandler } = await import('../direct-auth');

    const response = await directEmailCodeSendHandler(
      enableEmailOtp(
        createContext(
          {
            client_id: 'web-client',
            email: 'user@example.com',
            code_challenge: 'email-pkce-challenge',
            code_challenge_method: 'S256',
            channel: 'browser',
            human_verification_response: 'spent-token',
          },
          { ...webHeaders(), 'X-Authrim-Human-Verification-Action': 'signup' }
        )
      ) as never
    );

    expect(response.status).toBe(200);
    // Its single-use token was spent when it was first sent.
    expect(mocks.verifyHumanVerificationForAction).not.toHaveBeenCalled();
    expect(mocks.emailNotifier.send).toHaveBeenCalled();
    // The code is issued for what the send was: the sign-up.
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'direct_email_code',
        metadata: expect.objectContaining({ usage: 'signup' }),
      })
    );
  });

  it('keys a resume record by the whole send, a screen named or not', async () => {
    mocks.userPII.findByTenantAndEmail.mockResolvedValue({
      id: 'user_existing',
      email: 'user@example.com',
    });
    mocks.challengeStore.getChallengeRpc.mockResolvedValue({
      tenantId: 'tenant_test',
      type: 'login',
      challenge: 'login_challenge',
    });
    const { directEmailCodeSendHandler } = await import('../direct-auth');
    const send = (extra: Record<string, unknown>, headers: Record<string, string> = {}) =>
      directEmailCodeSendHandler(
        enableEmailOtp(
          createContext(
            {
              client_id: 'web-client',
              email: 'user@example.com',
              code_challenge: 'email-pkce-challenge',
              code_challenge_method: 'S256',
              channel: 'browser',
              ...extra,
            },
            { ...webHeaders(), ...headers }
          )
        ) as never
      );

    await send({});
    await send({});
    await send({ authorization_challenge_id: 'login_challenge' });
    await send({}, { 'X-Authrim-Human-Verification-Action': 'login' });

    const ids = mocks.challengeStore.consumeChallengeRpc.mock.calls
      .map(([request]) => request as { type?: string; id?: string })
      .filter((request) => request.type === 'direct_email_send_resume')
      .map((request) => request.id);
    expect(ids).toHaveLength(4);
    // The same send, sent again without naming a screen, keeps its key.
    expect(ids[1]).toBe(ids[0]);
    // Another challenge or screen is another send.
    expect(new Set(ids).size).toBe(3);
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
          // When the email was proven, for the session redeemed from it.
          proven_at: expect.any(Number),
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
    expect(consumesOtherThanSendResume()).toHaveLength(1);
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
    expect(consumesOtherThanSendResume()).toHaveLength(0);
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
    expect(consumesOtherThanSendResume()).toHaveLength(0);
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
    expect(consumesOtherThanSendResume()).toHaveLength(0);
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
    expect(consumesOtherThanSendResume()).toHaveLength(0);
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
    // Another request consumed the EVP challenge first (no send to resume either).
    mocks.challengeStore.consumeChallengeRpc.mockImplementation(async () => {
      throw new Error('already consumed');
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

  it.each([
    // The sign-up screen, carrying the login challenge it was linked from, signs up a new address.
    ['signup', 'new@example.com', 'login_challenge', 'signup', []],
    // The shared login form signs up a new address: its token, plus the sign-up setting.
    ['login', 'new@example.com', undefined, 'login', ['signup']],
    ['login', 'user@example.com', 'login_challenge', 'login', []],
    // A client that does not name its screen keeps the earlier inference.
    [undefined, 'new@example.com', undefined, 'signup', []],
  ] as const)(
    'checks a %s-screen token for %s (challenge %s) as %s, also requiring %j',
    async (screen, email, challengeId, action, alsoRequiredFor) => {
      if (challengeId) {
        mocks.challengeStore.getChallengeRpc.mockResolvedValue({
          tenantId: 'tenant_test',
          type: 'login',
          challenge: challengeId,
        });
      }
      if (email === 'user@example.com') {
        mocks.userPII.findByTenantAndEmail.mockResolvedValue({ id: 'user_existing', email });
      }
      const { directEmailCodeSendHandler } = await import('../direct-auth');

      const response = await directEmailCodeSendHandler(
        enableEmailOtp(
          createContext(
            {
              client_id: 'web-client',
              email,
              code_challenge: 'email-pkce-challenge',
              code_challenge_method: 'S256',
              channel: 'browser',
              ...(challengeId ? { authorization_challenge_id: challengeId } : {}),
              human_verification_response: 'human-token',
            },
            {
              ...webHeaders(),
              ...(screen ? { 'X-Authrim-Human-Verification-Action': screen } : {}),
            }
          )
        ) as never
      );

      expect(response.status).toBe(200);
      expect(mocks.verifyHumanVerificationForAction).toHaveBeenCalledWith(
        expect.anything(),
        action,
        'human-token',
        alsoRequiredFor
      );
    }
  );

  it('checks a re-authentication email code against its own screen whatever the client names', async () => {
    mocks.challengeStore.getChallengeRpc.mockResolvedValue({
      tenantId: 'tenant_test',
      type: 'reauth',
      userId: 'user_existing',
      challenge: 'reauth_challenge',
    });
    mocks.userPII.findByTenantAndEmail.mockResolvedValue({
      id: 'user_existing',
      email: 'user@example.com',
    });
    const { directEmailCodeSendHandler } = await import('../direct-auth');

    await directEmailCodeSendHandler(
      enableEmailOtp(
        createContext(
          {
            client_id: 'web-client',
            email: 'user@example.com',
            code_challenge: 'email-pkce-challenge',
            code_challenge_method: 'S256',
            channel: 'browser',
            authorization_challenge_id: 'reauth_challenge',
            human_verification_response: 'human-token',
          },
          { ...webHeaders(), 'X-Authrim-Human-Verification-Action': 'signup' }
        )
      ) as never
    );

    expect(mocks.verifyHumanVerificationForAction).toHaveBeenCalledWith(
      expect.anything(),
      'reauth',
      'human-token',
      []
    );
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

  it('returns the generic accepted envelope when no email notifier is configured', async () => {
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

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      attempt_id: expect.any(String),
      expires_in: 300,
      masked_email: 'n***w@example.com',
    });
    expect(body).not.toHaveProperty('_dev_code');
    expect(body).not.toHaveProperty('code');
    expect(body).not.toHaveProperty('error');
    expect(mocks.challengeStore.deleteChallengeRpc).toHaveBeenCalledWith(
      expect.stringMatching(/^direct_email_code:/)
    );
  });

  it('returns the generic accepted envelope without provider details when delivery is rejected', async () => {
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

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      attempt_id: expect.any(String),
      expires_in: 300,
      masked_email: 'n***w@example.com',
    });
    expect(body).not.toHaveProperty('error');
    expect(JSON.stringify(body)).not.toContain('provider secret detail');
  });

  it('keeps the accepted email-code response generic when OTP_HMAC_SECRET is missing', async () => {
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

    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      attempt_id: expect.any(String),
      expires_in: 300,
      masked_email: 'n***w@example.com',
    });
    expect(body).not.toHaveProperty('error');
    expect(mocks.hashEmailCode).not.toHaveBeenCalled();
  });

  it('keeps the accepted email-code response generic when challenge persistence fails', async () => {
    mocks.challengeStore.storeChallengeRpc.mockRejectedValueOnce(new Error('storage unavailable'));
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
    expect(mocks.emailNotifier.send).not.toHaveBeenCalled();
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

  it.each([
    ['with a presentation, refuses it before the send limit is counted', true],
    ['without one, sends a code as before', false],
  ])(
    'while the assurance settings cannot be read, an email code send %s',
    async (_label, presented) => {
      const { directEmailCodeSendHandler } = await import('../direct-auth');
      const context = enableEmailOtp(
        createContext(
          {
            client_id: 'web-client',
            email: 'existing@example.com',
            code_challenge: 'email-pkce-challenge',
            code_challenge_method: 'S256',
            channel: 'browser',
            scope: 'openid email',
            ...(presented
              ? {
                  email_verification_token: 'presentation-token',
                  email_verification_challenge_id: 'challenge_1',
                  runtime_interaction_id: 'interaction_1',
                }
              : {}),
          },
          webHeaders()
        )
      ) as { env: { SETTINGS: { get: (key: string) => Promise<string | null> } } };
      const settings = context.env.SETTINGS;
      context.env.SETTINGS = {
        ...settings,
        get: async (key: string) => {
          if (key === 'settings:tenant:tenant_test:assurance') throw new Error('KV unavailable');
          return settings.get(key);
        },
      };

      const response = await directEmailCodeSendHandler(context as never);

      if (presented) {
        expect(response.status).toBe(503);
        expect(mocks.rateLimiter.incrementRpc).not.toHaveBeenCalled();
      } else {
        expect(response.status).toBe(200);
        expect(mocks.rateLimiter.incrementRpc).toHaveBeenCalled();
      }
    }
  );

  it('spends no email code while the assurance settings cannot be read', async () => {
    const challengeData = {
      challenge: 'hashed-email-code',
      userId: 'user_existing',
      email: 'user@example.com',
      metadata: {
        code_challenge: await s256Challenge('email-code-verifier'),
        client_id: 'web-client',
        channel: 'browser',
        scope: 'openid email',
        transaction_id: 'attempt_1',
        issued_at: Date.now() - 10_000,
      },
    };
    mocks.challengeStore.getChallengeRpc.mockResolvedValue(challengeData);
    const { directEmailCodeVerifyHandler } = await import('../direct-auth');
    const context = createContext({
      attempt_id: 'attempt_1',
      code: '123456',
      code_verifier: 'email-code-verifier',
      channel: 'browser',
    });
    context.env.SETTINGS = {
      get: vi.fn(async (key: string) => {
        if (key === 'settings:tenant:tenant_test:assurance') throw new Error('KV unavailable');
        return null;
      }),
    } as never;

    const response = await directEmailCodeVerifyHandler(context as never);

    expect(response.status).toBe(503);
    expect(mocks.challengeStore.consumeChallengeRpc).not.toHaveBeenCalled();
    // No attempt is counted either: the same code still works once the settings can be read.
    expect(mocks.rateLimiter.incrementRpc).not.toHaveBeenCalled();
  });

  it.each([
    [
      'for another user than the re-authentication',
      { usage: 'reauth', reauth_user_id: 'user_other' },
      {},
    ],
    [
      'once its usage has been turned off',
      { usage: 'login' },
      { 'authentication-methods.email_otp.login_enabled': false },
    ],
  ])('issues nothing for a code sent %s', async (_label, extra, overrides) => {
    const codeVerifier = 'email-code-verifier';
    const challengeData = {
      challenge: 'hashed-email-code',
      userId: 'user_existing',
      email: 'user@example.com',
      metadata: {
        code_challenge: await s256Challenge(codeVerifier),
        client_id: 'web-client',
        channel: 'browser',
        scope: 'openid email',
        transaction_id: 'attempt_1',
        issued_at: Date.now() - 10_000,
        ...extra,
      },
    };
    mocks.challengeStore.getChallengeRpc.mockResolvedValue(challengeData);
    mocks.challengeStore.consumeChallengeRpc.mockResolvedValue(challengeData);
    const { directEmailCodeVerifyHandler } = await import('../direct-auth');

    const response = await directEmailCodeVerifyHandler(
      enableEmailOtp(
        createContext({
          attempt_id: 'attempt_1',
          code: '123456',
          code_verifier: codeVerifier,
          channel: 'browser',
        }),
        {},
        overrides
      ) as never
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mocks.authCodeStore.storeCodeRpc).not.toHaveBeenCalled();
    expect(mocks.coreAdapter.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('email_verified = 1'),
      expect.anything()
    );
  });

  it.each([
    ['refuses a re-authentication by an unknown method', undefined, true],
    ['lets a directory password complete a re-authentication', 'directory_password', false],
  ] as const)('%s', async (_label, method, refused) => {
    mocks.challengeStore.consumeChallengeRpc
      .mockRejectedValueOnce(new Error('not a login challenge'))
      .mockResolvedValueOnce({
        userId: 'user_existing',
        metadata: { sessionUserId: 'user_existing' },
      });
    const { consumeAuthorizationChallengeContinuation } = await import('../direct-auth');
    const context = createContext({});
    (context as unknown as { header: unknown }).header = vi.fn();

    const result = await consumeAuthorizationChallengeContinuation(
      context as never,
      'tenant_test',
      'reauth_challenge',
      'user_existing',
      1_000,
      'https://op.example.com',
      method
    );

    expect('error' in result).toBe(refused);
  });

  it.each([
    ['refuses a proof made before the re-authentication was asked for', 999, 999_000, true],
    ['accepts a proof made after it', 1_001, 1_001_000, false],
    // A proof the server did not date cannot show it came after the request, however late.
    ['refuses a proof of unknown time', 1_001, undefined, true],
    // Within the same second, the proof time in milliseconds decides.
    ['refuses a proof made just before it in the same second', 1_000, 999_999, true],
    ['accepts a proof made just after it in the same second', 1_000, 1_000_001, false],
  ])('%s', async (_label, authTime, provenAtMs, refused) => {
    mocks.challengeStore.consumeChallengeRpc
      .mockRejectedValueOnce(new Error('not a login challenge'))
      .mockResolvedValueOnce({
        userId: 'user_existing',
        metadata: { sessionUserId: 'user_existing', reauth_issued_at: 1_000_000 },
      });
    const { consumeAuthorizationChallengeContinuation } = await import('../direct-auth');
    const context = createContext({});
    (context as unknown as { header: unknown }).header = vi.fn();

    const result = await consumeAuthorizationChallengeContinuation(
      context as never,
      'tenant_test',
      'reauth_challenge',
      'user_existing',
      authTime,
      'https://op.example.com',
      'directory_password',
      provenAtMs
    );

    expect('error' in result).toBe(refused);
  });

  it('reads a re-authentication proof with the time of the method it takes', async () => {
    const { reauthProofFromRecord } = await import('../direct-auth');

    // A directory fallback: its email code (taken) was proven after its password (the oldest).
    expect(
      reauthProofFromRecord(
        { proven_at: 1_000, reauth_proven_amr: ['otp'], reauth_proven_at: 2_000 },
        ['pwd', 'directory', 'otp']
      )
    ).toEqual({ method: 'email_otp', provenAtMs: 2_000 });
    // A TOTP merged in later never borrows the email code's time.
    expect(
      reauthProofFromRecord(
        { proven_at: 500, reauth_proven_amr: ['otp'], reauth_proven_at: 2_000 },
        ['pwd', 'directory', 'otp', 'totp']
      )
    ).toEqual({ method: 'email_otp', provenAtMs: 2_000 });
    // A time without its method is not used.
    expect(reauthProofFromRecord({ reauth_proven_at: 2_000 }, ['totp'])).toEqual({
      method: 'totp',
    });
    expect(reauthProofFromRecord({ proven_at: 1_000 }, ['passkey'])).toEqual({
      method: 'passkey',
      provenAtMs: 1_000,
    });
    // An unknown proof time (0 records it as unknown) leaves only the method.
    expect(reauthProofFromRecord({ proven_at: 0 }, ['passkey'])).toEqual({ method: 'passkey' });
    expect(reauthProofFromRecord({ proven_at: 1_000 }, ['passkey_signup'])).toEqual({});
    // An external IdP or SAML login only with a verified new upstream login, paired with its time.
    expect(reauthProofFromRecord({ proven_at: 1_000 }, ['external_idp'])).toEqual({});
    expect(reauthProofFromRecord({ reauth_proven_at: 3_000 }, ['saml'])).toEqual({});
    expect(
      reauthProofFromRecord({ reauth_proven_amr: ['external_idp'], reauth_proven_at: 3_000 }, [
        'external_idp',
      ])
    ).toEqual({ method: 'other', provenAtMs: 3_000 });
  });

  it('reads the proving method from what the session recorded', async () => {
    const { reauthProvenMethodFromAmr } = await import('../direct-auth');

    expect(reauthProvenMethodFromAmr(['passkey'])).toBe('passkey');
    expect(reauthProvenMethodFromAmr(['otp', 'totp'])).toBe('totp');
    expect(reauthProvenMethodFromAmr(['otp'])).toBe('email_otp');
    expect(reauthProvenMethodFromAmr(['email_code'])).toBe('email_otp');
    expect(reauthProvenMethodFromAmr(['pwd', 'directory'])).toBe('directory_password');
    expect(reauthProvenMethodFromAmr(['did'])).toBe('other');
    expect(reauthProvenMethodFromAmr(['external_idp'])).toBe('other');
    expect(reauthProvenMethodFromAmr(['saml'])).toBe('other');
    expect(reauthProvenMethodFromAmr(['anon'])).toBeUndefined();
    // A passkey only just registered proves nothing yet.
    expect(reauthProvenMethodFromAmr(['passkey'], ['passkey'])).toBeUndefined();
    expect(reauthProvenMethodFromAmr(['passkey_signup'])).toBeUndefined();
    expect(reauthProvenMethodFromAmr(undefined)).toBeUndefined();
  });

  it('asks for a new code when the code carries no usage', async () => {
    const codeVerifier = 'email-code-verifier';
    const challengeData = {
      challenge: 'hashed-email-code',
      userId: 'user_existing',
      email: 'user@example.com',
      metadata: {
        code_challenge: await s256Challenge(codeVerifier),
        client_id: 'web-client',
        channel: 'browser',
        transaction_id: 'attempt_1',
        issued_at: Date.now() - 10_000,
      },
    };
    mocks.challengeStore.getChallengeRpc.mockResolvedValue(challengeData);
    mocks.challengeStore.consumeChallengeRpc.mockResolvedValue(challengeData);
    const { directEmailCodeVerifyHandler } = await import('../direct-auth');

    const response = await directEmailCodeVerifyHandler(
      enableEmailOtp(
        createContext({
          attempt_id: 'attempt_1',
          code: '123456',
          code_verifier: codeVerifier,
          channel: 'browser',
        })
      ) as never
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mocks.authCodeStore.storeCodeRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['refuses', false, 403],
    ['continues', true, 200],
  ])(
    '%s a re-authentication by a method whose re-authentication switch is %s',
    async (_label, enabled, status) => {
      mocks.challengeStore.consumeChallengeRpc
        .mockRejectedValueOnce(new Error('not a login challenge'))
        .mockResolvedValueOnce({
          userId: 'user_existing',
          metadata: { sessionUserId: 'user_existing' },
        });
      const { consumeAuthorizationChallengeContinuation } = await import('../direct-auth');
      const context = enableEmailOtp(
        createContext({}),
        {},
        {
          'authentication-methods.email_otp.reauth_enabled': enabled,
        }
      );
      (context as unknown as { header: unknown }).header = vi.fn();

      const result = await consumeAuthorizationChallengeContinuation(
        context as never,
        'tenant_test',
        'reauth_challenge',
        'user_existing',
        1_000,
        'https://op.example.com',
        'email_otp'
      );

      if (status === 403) {
        expect('error' in result && result.error.status).toBe(403);
      } else {
        expect('error' in result).toBe(false);
      }
    }
  );

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
        usage: 'login',
        transaction_id: 'attempt_1',
        issued_at: issuedAt,
      },
    };
    mocks.challengeStore.getChallengeRpc.mockResolvedValue(challengeData);
    mocks.challengeStore.consumeChallengeRpc.mockResolvedValue(challengeData);
    const { directEmailCodeVerifyHandler } = await import('../direct-auth');

    const response = await directEmailCodeVerifyHandler(
      enableEmailOtp(
        createContext({
          attempt_id: 'attempt_1',
          code: '123456',
          code_verifier: codeVerifier,
          channel: 'browser',
        })
      ) as never
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
        usage: 'login',
        transaction_id: 'attempt_tenant_d1',
        issued_at: Date.now() - 10_000,
      },
    };
    mocks.challengeStore.getChallengeRpc.mockResolvedValue(challengeData);
    mocks.challengeStore.consumeChallengeRpc.mockResolvedValue(challengeData);
    const context = enableEmailOtp(
      createContext({
        attempt_id: 'attempt_tenant_d1',
        code: '123456',
        code_verifier: codeVerifier,
        channel: 'browser',
      })
    );
    context.get = vi.fn((key: string) => {
      if (key === 'tenantId') return 'tenant_test';
      if (key === 'tenantMetadataContext') {
        return { tenantId: 'tenant_test', storageProfileId: 'builtin:storage:tenant-d1' };
      }
      return undefined;
    }) as never;
    const { directEmailCodeVerifyHandler } = await import('../direct-auth');

    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pendingWrite = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.markOtpLoginEmailVerified.mockImplementationOnce(async () => {
      started();
      await pendingWrite;
      return true;
    });
    const responsePromise = directEmailCodeVerifyHandler(context as never);
    await entered;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.authCodeStore.storeCodeRpc).not.toHaveBeenCalled();
    release();
    const response = await responsePromise;

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
    expect(context.executionCtx.waitUntil).not.toHaveBeenCalled();
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
        usage: 'login',
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

    const invalidResponse = await directEmailCodeVerifyHandler(
      enableEmailOtp(createContext(request)) as never
    );

    expect(invalidResponse.ok).toBe(false);
    expect(mocks.challengeStore.consumeChallengeRpc).not.toHaveBeenCalled();

    const validResponse = await directEmailCodeVerifyHandler(
      enableEmailOtp(createContext(request)) as never
    );

    expect(validResponse.status).toBe(200);
    expect(mocks.challengeStore.getChallengeRpc).toHaveBeenCalledTimes(2);
    expect(mocks.challengeStore.consumeChallengeRpc).toHaveBeenCalledTimes(1);
  });
});
