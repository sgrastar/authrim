/**
 * Token endpoint harness for the Native SSO and Client Credentials mutation tests: the same
 * ar-lib-core mocks client-auth.test.ts uses, shared by the mut-nativesso-* and mut-clientcreds-*
 * test files (each still declares its own vi.hoisted / vi.mock, which call into this module).
 */
import { vi } from 'vitest';
import { createMockEnv, type MockEnv } from './mocks';
import { settingsFromSystemSettings } from './effective-settings';

type ArLibCore = typeof import('@authrim/ar-lib-core');

export function createHarnessMocks() {
  const mockLoggerMethods = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const mockLogger = {
    module: vi.fn().mockReturnValue(mockLoggerMethods),
  };

  const coreDb = {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 }),
    transaction: vi.fn(async (fn: (adapter: unknown) => unknown) => fn(coreDb)),
    batch: vi.fn().mockResolvedValue([]),
    isHealthy: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 0, type: 'mock' }),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn().mockResolvedValue(undefined),
  };

  const mocks = {
    // The jtis the replay guard (DPoPJTIStore check-and-store) has recorded.
    replayJtis: new Set<string>(),
    // What each recordReplayJti call was asked to store (jti, issuedAt, ttlSeconds, ...).
    replayRecordInputs: [] as Array<Record<string, unknown>>,
    // The RATE_LIMITER Durable Object: fixed-window records per key.
    rateLimitRecords: new Map<string, { count: number; resetAt: number; firstRequestAt: number }>(),
    // The sub an app's identity mapping gives its ID tokens (unset: the mapping as configured).
    mappedIdTokenSub: { value: undefined as string | undefined },
    // Logging
    mockLoggerMethods,
    mockLogger,
    mockGetLogger: vi.fn().mockReturnValue(mockLogger),
    mockCreateLogger: vi.fn().mockReturnValue(mockLogger),

    // Validation
    mockValidateGrantType: vi.fn().mockReturnValue({ valid: true }),
    mockValidateAuthCode: vi.fn().mockReturnValue({ valid: true }),
    mockValidateClientId: vi.fn().mockReturnValue({ valid: true }),
    mockValidateRedirectUri: vi.fn().mockReturnValue({ valid: true }),

    // Caching
    mockGetClientCached: vi.fn().mockResolvedValue(null),
    mockLoadTenantProfileCached: vi.fn().mockResolvedValue(null),
    mockGetProtocolSettingsCached: vi.fn().mockResolvedValue(null),
    mockGetChallengeStoreByChallengeId: vi.fn().mockResolvedValue({
      consumeChallengeRpc: vi.fn().mockRejectedValue(new Error('Artifact not found')),
    }),

    // Token operations
    mockCreateAccessToken: vi
      .fn()
      .mockResolvedValue({ token: 'mock-access-token', jti: 'at-jti-001' }),
    mockCreateIDToken: vi.fn().mockResolvedValue('mock-id-token'),
    mockCreateRefreshToken: vi
      .fn()
      .mockResolvedValue({ token: 'mock-refresh-token', jti: 'rt-jti-001' }),
    mockVerifyToken: vi.fn().mockResolvedValue({ valid: true, payload: {} }),
    mockParseToken: vi.fn().mockReturnValue({}),
    mockParseTokenHeader: vi.fn().mockReturnValue({ alg: 'RS256', kid: 'test-kid' }),
    mockGetIssuedIDTokenKeys: vi.fn().mockResolvedValue([]),
    mockImportIssuedTokenKey: vi.fn(),
    mockCalculateAtHash: vi.fn().mockResolvedValue('at-hash-value'),
    mockCalculateDsHash: vi.fn().mockResolvedValue('presented-ds-hash'),

    mockGuestContract: vi.fn<() => unknown>(),

    // Client authentication
    mockValidateClientAssertion: vi
      .fn()
      .mockResolvedValue({ valid: true, client_id: 'test-client' }),
    mockValidateJWTBearerAssertion: vi.fn(),
    mockParseTrustedIssuers: vi.fn(),
    mockVerifyClientSecretHash: vi.fn().mockReturnValue(true),
    mockParseBasicAuth: vi.fn().mockReturnValue({ success: false }),

    // DPoP
    mockExtractDPoPProof: vi.fn().mockReturnValue(null),
    mockValidateDPoPProof: vi.fn().mockResolvedValue({ valid: true, jkt: 'test-jkt' }),

    // Sharding
    mockParseShardedAuthCode: vi.fn().mockReturnValue(null),
    mockGetShardCount: vi.fn().mockResolvedValue(1),
    mockRemapShardIndex: vi.fn().mockImplementation((idx: number) => idx),
    mockBuildAuthCodeShardInstanceName: vi.fn().mockReturnValue('auth-code-0'),
    mockGenerateRegionAwareJti: vi.fn().mockResolvedValue({ jti: 'jti-region-001' }),

    // Database
    // The account (core) database every D1Adapter of a test is: the same mock object.
    coreDb,
    mockD1Adapter: vi.fn(function D1AdapterMock() {
      return coreDb;
    }),
    mockAdminAdapter: {
      query: vi.fn().mockResolvedValue([]),
      queryOne: vi.fn().mockResolvedValue(null),
      execute: vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 }),
      transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
        fn({
          query: vi.fn().mockResolvedValue([]),
          queryOne: vi.fn().mockResolvedValue(null),
          execute: vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 }),
        })
      ),
      batch: vi.fn().mockResolvedValue([]),
      isHealthy: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 0, type: 'mock' }),
      getType: vi.fn().mockReturnValue('mock'),
      close: vi.fn().mockResolvedValue(undefined),
    },
    mockRequireDedicatedAdminDatabaseAdapter: vi.fn(),

    // User
    mockGetCachedUserCore: vi.fn().mockResolvedValue(null),
    mockFindCanonicalRuntimeUserProjection: vi.fn(),
    mockFindCanonicalRuntimeAccount: vi.fn(),
    mockEnsureAccountAuthenticationState: vi.fn().mockResolvedValue({ lifecycle: 'active' }),

    // Native SSO
    mockDeviceSecretRepository: {
      validateAndUse: vi.fn().mockResolvedValue({ ok: false, reason: 'not_found' }),
      findByRawSecret: vi.fn().mockResolvedValue(null),
      createSecret: vi.fn().mockResolvedValue({ ok: false, reason: 'limit_exceeded' }),
      findByUserId: vi.fn().mockResolvedValue([]),
      revoke: vi.fn().mockResolvedValue(false),
    },
    mockDeviceInstallationRepository: {
      ensureForDeviceSecret: vi.fn().mockResolvedValue(null),
      ensureForNativeSSOTokenExchange: vi.fn().mockResolvedValue(null),
    },
    mockIsNativeSSOEnabled: vi.fn().mockResolvedValue(false),
    mockGetNativeSSOConfig: vi.fn().mockResolvedValue({
      enabled: true,
      deviceSecretTTLDays: 30,
      maxDeviceSecretsPerUser: 10,
      maxUseCountPerSecret: 10,
      maxSecretsBehavior: 'revoke_oldest',
      deviceSecretRotationPolicy: 'disabled',
      deviceSecretRotationOverlapSeconds: 0,
      rateLimit: {
        maxAttemptsPerMinute: 10,
        blockDurationMinutes: 1,
      },
      allowCrossClientNativeSSO: false,
    }),
    mockRecordDeviceSecretRouteHint: vi.fn().mockResolvedValue(undefined),
    mockResolveDeviceSecretRouteHint: vi.fn().mockResolvedValue(null),
    mockGetTenantMetadataContextFromHono: vi.fn().mockReturnValue(null),
    mockResolveAccountDataContextFromHono: vi.fn().mockResolvedValue(undefined),

    // RBAC / Policy
    mockGetIDTokenRBACClaims: vi.fn().mockResolvedValue({}),
    mockGetAccessTokenRBACClaims: vi.fn().mockResolvedValue({}),
    mockIsPolicyEmbeddingEnabled: vi.fn().mockResolvedValue(false),
    mockIsCustomClaimsEnabled: vi.fn().mockResolvedValue(false),
    mockIsIdLevelPermissionsEnabled: vi.fn().mockResolvedValue(false),
    mockGetEmbeddingLimits: vi.fn().mockReturnValue({ maxClaims: 50, maxSize: 4096 }),

    // Configuration
    mockResolveEffectiveSettings: vi.fn().mockResolvedValue({
      'oauth.access_token_expiry': 3600,
      'oauth.refresh_token_expiry': 86400 * 30,
    }),

    // Events
    mockPublishEvent: vi.fn().mockResolvedValue(undefined),
  };
  return mocks;
}

export type HarnessMocks = ReturnType<typeof createHarnessMocks>;

export function arLibCoreMock(actual: ArLibCore, mocks: HarnessMocks) {
  return {
    ...actual,
    isReplayJtiRecorded: async (_env: unknown, input: { jti: string }) =>
      mocks.replayJtis.has(input.jti),
    recordReplayJti: async (_env: unknown, input: { jti: string }) => {
      mocks.replayRecordInputs.push(input);
      if (mocks.replayJtis.has(input.jti)) return 'replayed';
      mocks.replayJtis.add(input.jti);
      return 'recorded';
    },
    loadClientContractCached: (...args: Parameters<typeof actual.loadClientContractCached>) => {
      const override = mocks.mockGuestContract();
      return override === undefined
        ? actual.loadClientContractCached(...args)
        : Promise.resolve(override as Awaited<ReturnType<typeof actual.loadClientContractCached>>);
    },
    mapIDTokenClaims: async (...args: Parameters<typeof actual.mapIDTokenClaims>) => {
      const mapped = await actual.mapIDTokenClaims(...args);
      const sub = mocks.mappedIdTokenSub.value;
      return sub && mapped.ok ? { ok: true as const, claims: { ...mapped.claims, sub } } : mapped;
    },
    ensureAccountAuthenticationState: mocks.mockEnsureAccountAuthenticationState,
    findCanonicalAccountAuthenticationState: vi.fn(
      async (_adapter: unknown, _tenantId: string, userId: string) => ({
        userId,
        accountType: 'user',
        lifecycle: 'active',
        sourceVersionMs: 1_000,
      })
    ),
    getLogger: mocks.mockGetLogger,
    createLogger: mocks.mockCreateLogger,
    validateGrantType: mocks.mockValidateGrantType,
    validateAuthCode: mocks.mockValidateAuthCode,
    validateClientId: mocks.mockValidateClientId,
    validateRedirectUri: mocks.mockValidateRedirectUri,
    getClientCached: mocks.mockGetClientCached,
    loadTenantProfileCached: mocks.mockLoadTenantProfileCached,
    getProtocolSettingsCached: async (...args: unknown[]) => ({
      fapi: {},
      oidc: {},
      security: {},
      ...(((await mocks.mockGetProtocolSettingsCached(...args)) as Record<
        string,
        unknown
      > | null) ?? {}),
    }),
    getChallengeStoreByChallengeId: mocks.mockGetChallengeStoreByChallengeId,
    createAccessToken: mocks.mockCreateAccessToken,
    createIDToken: mocks.mockCreateIDToken,
    createRefreshToken: mocks.mockCreateRefreshToken,
    verifyToken: mocks.mockVerifyToken,
    parseToken: mocks.mockParseToken,
    parseTokenHeader: mocks.mockParseTokenHeader,
    getIssuedIDTokenKeys: mocks.mockGetIssuedIDTokenKeys,
    importIssuedTokenKey: mocks.mockImportIssuedTokenKey,
    calculateAtHash: mocks.mockCalculateAtHash,
    calculateDsHash: mocks.mockCalculateDsHash,
    validateJWTBearerAssertion: mocks.mockValidateJWTBearerAssertion,
    parseTrustedIssuers: mocks.mockParseTrustedIssuers,
    validateClientAssertion: mocks.mockValidateClientAssertion,
    verifyClientSecretHash: mocks.mockVerifyClientSecretHash,
    parseBasicAuth: mocks.mockParseBasicAuth,
    extractDPoPProof: mocks.mockExtractDPoPProof,
    validateDPoPProof: mocks.mockValidateDPoPProof,
    parseShardedAuthCode: mocks.mockParseShardedAuthCode,
    getShardCount: mocks.mockGetShardCount,
    remapShardIndex: mocks.mockRemapShardIndex,
    buildAuthCodeShardInstanceName: mocks.mockBuildAuthCodeShardInstanceName,
    generateRegionAwareJti: mocks.mockGenerateRegionAwareJti,
    D1Adapter: mocks.mockD1Adapter,
    CanonicalRuntimeUserProjectionRepository: vi.fn(
      function CanonicalRuntimeUserProjectionRepositoryMock() {
        return {
          findByLegacyUserId: mocks.mockFindCanonicalRuntimeUserProjection,
        };
      }
    ),
    CanonicalSensitiveValueResolver: vi.fn(function CanonicalSensitiveValueResolverMock() {
      return {};
    }),
    CanonicalIdentityRepository: vi.fn(function CanonicalIdentityRepositoryMock() {
      return {
        findAccountByLegacyUserId: mocks.mockFindCanonicalRuntimeAccount,
      };
    }),
    requireDedicatedAdminDatabaseAdapter: mocks.mockRequireDedicatedAdminDatabaseAdapter,
    getIDTokenRBACClaims: mocks.mockGetIDTokenRBACClaims,
    getAccessTokenRBACClaims: mocks.mockGetAccessTokenRBACClaims,
    isPolicyEmbeddingEnabled: mocks.mockIsPolicyEmbeddingEnabled,
    isCustomClaimsEnabled: mocks.mockIsCustomClaimsEnabled,
    isIdLevelPermissionsEnabled: mocks.mockIsIdLevelPermissionsEnabled,
    getEmbeddingLimits: mocks.mockGetEmbeddingLimits,
    getCachedUserCore: mocks.mockGetCachedUserCore,
    DeviceSecretRepository: vi.fn(function DeviceSecretRepositoryMock() {
      return mocks.mockDeviceSecretRepository;
    }),
    DeviceInstallationRepository: vi.fn(function DeviceInstallationRepositoryMock() {
      return mocks.mockDeviceInstallationRepository;
    }),
    isNativeSSOEnabled: mocks.mockIsNativeSSOEnabled,
    getNativeSSOConfig: mocks.mockGetNativeSSOConfig,
    recordDeviceSecretRouteHint: mocks.mockRecordDeviceSecretRouteHint,
    resolveDeviceSecretRouteHint: mocks.mockResolveDeviceSecretRouteHint,
    getTenantMetadataContextFromHono: mocks.mockGetTenantMetadataContextFromHono,
    resolveAccountDataContextFromHono: mocks.mockResolveAccountDataContextFromHono,
    resolveEffectiveSettings: mocks.mockResolveEffectiveSettings,
    publishEvent: mocks.mockPublishEvent,
    TOKEN_EVENTS: {
      ACCESS_ISSUED: 'token.access.issued',
      ID_ISSUED: 'token.id.issued',
      REFRESH_ISSUED: 'token.refresh.issued',
    },
  };
}

export function resetHarnessMocks(mocks: HarnessMocks): void {
  // Reset logging mocks
  mocks.mockLoggerMethods.info.mockReset();
  mocks.mockLoggerMethods.warn.mockReset();
  mocks.mockLoggerMethods.error.mockReset();
  mocks.mockLoggerMethods.debug.mockReset();
  mocks.mockLogger.module.mockClear();
  mocks.mockGetLogger.mockReset().mockReturnValue(mocks.mockLogger);
  mocks.mockCreateLogger.mockReset().mockReturnValue(mocks.mockLogger);

  // Reset validation mocks
  mocks.mockValidateGrantType.mockReset().mockReturnValue({ valid: true });
  mocks.mockValidateAuthCode.mockReset().mockReturnValue({ valid: true });
  mocks.mockValidateClientId.mockReset().mockReturnValue({ valid: true });
  mocks.mockValidateRedirectUri.mockReset().mockReturnValue({ valid: true });

  // Reset caching mocks
  mocks.mockGetClientCached.mockReset().mockResolvedValue(null);
  mocks.mockLoadTenantProfileCached.mockReset().mockResolvedValue(null);
  mocks.mockGetProtocolSettingsCached.mockReset().mockResolvedValue(null);
  mocks.mockGetChallengeStoreByChallengeId.mockReset().mockResolvedValue({
    consumeChallengeRpc: vi.fn().mockRejectedValue(new Error('Artifact not found')),
  });

  // Reset token operation mocks
  mocks.mockCreateAccessToken
    .mockReset()
    .mockResolvedValue({ token: 'mock-access-token', jti: 'at-jti-001' });
  mocks.mockCreateIDToken.mockReset().mockResolvedValue('mock-id-token');
  mocks.mockCreateRefreshToken
    .mockReset()
    .mockResolvedValue({ token: 'mock-refresh-token', jti: 'rt-jti-001' });
  mocks.mockVerifyToken.mockReset().mockResolvedValue({ valid: true, payload: {} });
  mocks.mockParseToken.mockReset().mockReturnValue({});
  mocks.mockParseTokenHeader.mockReset().mockReturnValue({ alg: 'RS256', kid: 'test-kid' });
  mocks.mockGetIssuedIDTokenKeys.mockReset().mockResolvedValue([]);
  mocks.mockImportIssuedTokenKey.mockReset();
  mocks.mockCalculateAtHash.mockReset().mockResolvedValue('at-hash-value');
  mocks.mockCalculateDsHash.mockReset().mockResolvedValue('presented-ds-hash');

  // Reset client auth mocks
  mocks.mockParseBasicAuth.mockReset().mockReturnValue({ success: false });
  mocks.mockVerifyClientSecretHash.mockReset().mockReturnValue(true);
  mocks.mockValidateClientAssertion.mockReset().mockResolvedValue({ valid: true });
  mocks.mockValidateJWTBearerAssertion.mockReset().mockResolvedValue({
    valid: true,
    claims: {
      iss: 'https://service.example.com',
      sub: 'service-account',
      aud: 'https://auth.example.com/token',
      scope: 'api:read',
      resource: 'svc://service-api',
      exp: Math.floor(Date.now() / 1000) + 300,
      iat: Math.floor(Date.now() / 1000),
    },
  });
  mocks.mockParseTrustedIssuers.mockReset().mockReturnValue(
    new Map([
      [
        'https://service.example.com',
        {
          issuer: 'https://service.example.com',
          jwks_uri: 'https://service.example.com/jwks',
          default_resource: 'svc://service-api',
          allowed_resources: ['svc://service-api', 'svc://service-admin-api'],
        },
      ],
    ])
  );
  mocks.mockAdminAdapter.query.mockReset().mockResolvedValue([]);
  mocks.mockAdminAdapter.queryOne.mockReset().mockResolvedValue(null);
  mocks.mockAdminAdapter.execute.mockReset().mockResolvedValue({ success: true, rowsAffected: 1 });
  mocks.mockAdminAdapter.transaction
    .mockReset()
    .mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        query: vi.fn().mockResolvedValue([]),
        queryOne: vi.fn().mockResolvedValue(null),
        execute: vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 }),
      })
    );
  mocks.mockAdminAdapter.batch.mockReset().mockResolvedValue([]);
  mocks.mockAdminAdapter.isHealthy
    .mockReset()
    .mockResolvedValue({ healthy: true, latencyMs: 0, type: 'mock' });
  mocks.mockAdminAdapter.getType.mockReset().mockReturnValue('mock');
  mocks.mockAdminAdapter.close.mockReset().mockResolvedValue(undefined);
  mocks.mockRequireDedicatedAdminDatabaseAdapter
    .mockReset()
    .mockReturnValue(mocks.mockAdminAdapter);

  // Reset DPoP mocks
  mocks.mockExtractDPoPProof.mockReset().mockReturnValue(null);
  mocks.mockValidateDPoPProof.mockReset().mockResolvedValue({ valid: true, jkt: 'test-jkt' });

  // Reset sharding mocks
  mocks.mockParseShardedAuthCode.mockReset().mockReturnValue(null);
  mocks.mockGetShardCount.mockReset().mockResolvedValue(1);
  mocks.mockGenerateRegionAwareJti.mockReset().mockResolvedValue({ jti: 'jti-region-001' });

  // Reset RBAC mocks
  mocks.mockGuestContract.mockReset();
  mocks.mockGetIDTokenRBACClaims.mockReset().mockResolvedValue({});
  mocks.mockGetAccessTokenRBACClaims.mockReset().mockResolvedValue({});
  mocks.mockIsPolicyEmbeddingEnabled.mockReset().mockResolvedValue(false);
  mocks.mockDeviceSecretRepository.validateAndUse
    .mockReset()
    .mockResolvedValue({ ok: false, reason: 'not_found' });
  mocks.mockDeviceSecretRepository.createSecret
    .mockReset()
    .mockResolvedValue({ ok: false, reason: 'limit_exceeded' });
  mocks.mockDeviceSecretRepository.findByUserId.mockReset().mockResolvedValue([]);
  mocks.mockDeviceSecretRepository.revoke.mockReset().mockResolvedValue(false);
  mocks.mockDeviceInstallationRepository.ensureForDeviceSecret.mockReset().mockResolvedValue(null);
  mocks.mockDeviceInstallationRepository.ensureForNativeSSOTokenExchange
    .mockReset()
    .mockResolvedValue(null);
  mocks.mockIsNativeSSOEnabled.mockReset().mockResolvedValue(false);
  mocks.mockGetNativeSSOConfig.mockReset().mockResolvedValue({
    enabled: true,
    deviceSecretTTLDays: 30,
    maxDeviceSecretsPerUser: 10,
    maxUseCountPerSecret: 10,
    maxSecretsBehavior: 'revoke_oldest',
    deviceSecretRotationPolicy: 'disabled',
    deviceSecretRotationOverlapSeconds: 0,
    rateLimit: {
      maxAttemptsPerMinute: 10,
      blockDurationMinutes: 1,
    },
    allowCrossClientNativeSSO: false,
  });
  mocks.mockRecordDeviceSecretRouteHint.mockReset().mockResolvedValue(undefined);
  mocks.mockResolveDeviceSecretRouteHint.mockReset().mockResolvedValue({
    tenantId: 'default',
    accountId: 'account:user-001',
    issuedAt: 1_700_000_000_000,
    expiresAt: 1_702_592_000_000,
  });
  mocks.mockGetTenantMetadataContextFromHono.mockReset().mockReturnValue(null);
  mocks.mockResolveAccountDataContextFromHono
    .mockReset()
    .mockImplementation(async (c: { set(key: string, value: unknown): void }, subject: string) => {
      const legacyUserId = subject.startsWith('account:')
        ? subject.slice('account:'.length)
        : subject;
      const accountId = subject.startsWith('account:') ? subject : `account:${subject}`;
      const coreDb = mocks.coreDb;
      const tenantMetadataContext = { tenantId: 'default', coreDb };
      const accountDataContext = {
        tenantId: 'default',
        accountId,
        legacyUserId,
        membership: {},
        coreDb,
        piiDb: coreDb,
        coreBindingRef: 'D1_USERS_001',
        piiBindingRef: 'D1_PII_001',
        coreResidencyPartition: 'global',
        piiResidencyPartition: 'global',
        accountRouteGeneration: 1,
        userCacheScope: `default:${accountId}:1`,
        piiCacheMode: 'disabled',
      };
      c.set('tenantMetadataContext', tenantMetadataContext);
      c.set('accountDataContext', accountDataContext);
      return accountDataContext;
    });
  mocks.mockIsCustomClaimsEnabled.mockReset().mockResolvedValue(false);
  mocks.mockIsIdLevelPermissionsEnabled.mockReset().mockResolvedValue(false);
  mocks.mockGetCachedUserCore.mockReset().mockResolvedValue(null);
  mocks.mockEnsureAccountAuthenticationState.mockReset().mockResolvedValue({ lifecycle: 'active' });
  mocks.mockFindCanonicalRuntimeUserProjection
    .mockReset()
    .mockImplementation(async (userId: string) => ({
      id: userId,
      tenant_id: 'default',
      subject_id: `subject-${userId}`,
      account_id: `account-${userId}`,
      account_type: 'end_user',
      lifecycle_state: 'active',
      email: 'user@example.com',
      email_verified: 1,
      name: 'Test User',
      given_name: 'Test',
      family_name: 'User',
      middle_name: null,
      nickname: null,
      preferred_username: null,
      profile: null,
      picture: null,
      website: null,
      gender: null,
      birthdate: null,
      zoneinfo: null,
      locale: null,
      phone_number: null,
      phone_number_verified: 0,
      address_json: null,
      password_hash: null,
      external_id: null,
      last_login_at: null,
      active: 1,
      custom_attributes_json: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }));
  mocks.mockFindCanonicalRuntimeAccount.mockReset().mockImplementation(async (userId: string) => ({
    id: `account-${userId}`,
    tenant_id: 'default',
    subject_id: `subject-${userId}`,
    legacy_user_id: userId,
    account_type: 'end_user',
    lifecycle_state: 'active',
    display_label: null,
    metadata_json: '{}',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }));
}

export interface Harness {
  mockEnv: MockEnv;
  setSystemSettings(value: Record<string, unknown> | null): void;
}

/** The client-auth.test.ts beforeEach: fresh env, rate limiter stub and default settings. */
export function setupHarness(mocks: HarnessMocks): Harness {
  resetHarnessMocks(mocks);
  const mockEnv = createMockEnv();
  let systemSettings: Record<string, unknown> | null = null;
  const setSystemSettings = (value: Record<string, unknown> | null) => {
    systemSettings = value;
    mocks.mockGetProtocolSettingsCached.mockResolvedValue(value);
  };
  mocks.replayJtis.clear();
  mocks.replayRecordInputs.length = 0;
  mocks.rateLimitRecords.clear();
  const rateLimiterStub = {
    getStatusRpc: async (key: string) => mocks.rateLimitRecords.get(key) ?? null,
    incrementRpc: async (key: string, config: { windowSeconds: number; maxRequests: number }) => {
      const now = Math.floor(Date.now() / 1000);
      const existing = mocks.rateLimitRecords.get(key);
      const record =
        existing && now < existing.resetAt
          ? { ...existing, count: existing.count + 1 }
          : { count: 1, resetAt: now + config.windowSeconds, firstRequestAt: now };
      mocks.rateLimitRecords.set(key, record);
      const allowed = record.count <= config.maxRequests;
      return {
        allowed,
        current: record.count,
        limit: config.maxRequests,
        resetAt: record.resetAt,
        retryAfter: allowed ? 0 : record.resetAt - now,
      };
    },
  };
  (mockEnv as unknown as { RATE_LIMITER: unknown }).RATE_LIMITER = {
    idFromName: (name: string) => name,
    get: () => rateLimiterStub,
  };

  // Setup default tenant profile
  mocks.mockLoadTenantProfileCached.mockResolvedValue({
    tenant_id: 'default',
    max_token_ttl_seconds: 3600,
    allows_refresh_token: true,
  });

  // Token lifetimes from the effective settings; other categories as the older system settings
  // the test describes resolve them. These tests are about client authentication and the
  // grants' state: refresh tokens without offline_access (oauth.offline_access_required) are
  // covered in security-critical.test.ts.
  setSystemSettings(null);
  mocks.mockResolveEffectiveSettings.mockImplementation(async (env: unknown, category: string) =>
    category === 'oauth'
      ? {
          'oauth.access_token_expiry': 3600,
          'oauth.refresh_token_expiry': 86400 * 30,
          'oauth.offline_access_required': false,
        }
      : settingsFromSystemSettings(env, systemSettings, category)
  );

  // Setup token creation mocks
  mocks.mockCreateAccessToken.mockResolvedValue({
    token: 'mock-access-token',
    jti: 'at-jti-001',
  });
  mocks.mockCreateIDToken.mockResolvedValue('mock-id-token');
  mocks.mockCreateRefreshToken.mockResolvedValue({
    token: 'mock-refresh-token',
    jti: 'rt-jti-001',
  });
  mocks.mockGenerateRegionAwareJti.mockResolvedValue({ jti: 'jti-region-001' });
  mocks.mockCalculateAtHash.mockResolvedValue('at-hash-value');
  return { mockEnv, setSystemSettings };
}
