/**
 * Shared harness for the mut-grants-* tests: the refresh_token, JWT bearer, device code and CIBA
 * grants driven through tokenHandler with ar-lib-core's token, storage and client boundaries
 * mocked. Import this module before '../token' so its module mocks are registered first.
 */
import { vi, type Mock } from 'vitest';
import { createMockContext, createMockEnv, parseJsonResponse, type MockEnv } from './mocks';
import { settingsFromSystemSettings } from './effective-settings';
import { canonicalAccount, canonicalProjection } from './mut-grants-stores';

const mocks = vi.hoisted(() => {
  type Claims = Record<string, unknown>;
  type Signed = Promise<{ token: string; jti: string }>;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const coreAdapter = {
    query: vi.fn<(sql: string, params?: unknown[]) => Promise<unknown[]>>(),
    queryOne: vi.fn<(sql: string, params?: unknown[]) => Promise<unknown>>(),
    execute: vi.fn(),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(),
    getType: vi.fn(),
    close: vi.fn(),
  };
  /** Settings per category over the catalog defaults. */
  const settings: Record<string, Record<string, unknown>> = {};
  /** Policy flags over the resolved ones. */
  const policyFlags: Record<string, unknown> = {};
  return {
    logger,
    coreAdapter,
    settings,
    policyFlags,
    getClientCached: vi.fn(),
    loadTenantProfileCached: vi.fn(),
    getProtocolSettingsCached:
      vi.fn<
        (
          c: unknown,
          env: unknown,
          options: { clientId: string; keys: string[] }
        ) => Promise<Claims | null>
      >(),
    createAccessToken:
      vi.fn<
        (claims: Claims, key: unknown, kid: string, expiresIn: number, jti: string) => Signed
      >(),
    createIDToken: vi.fn<(claims: Claims, ...rest: unknown[]) => Promise<string>>(),
    createRefreshToken:
      vi.fn<
        (
          claims: Claims,
          key: unknown,
          kid: string,
          expiresIn: number,
          jti?: string,
          v?: number
        ) => Signed
      >(),
    createSDJWTIDTokenFromClaims:
      vi.fn<
        (
          claims: Claims,
          key: unknown,
          kid: string,
          expiresIn: number,
          selective: string[]
        ) => Promise<string>
      >(),
    verifyToken: vi.fn(),
    parseToken: vi.fn(),
    calculateAtHash: vi.fn(),
    validateClientAssertion: vi.fn(),
    validateJWTBearerAssertion: vi.fn(),
    parseTrustedIssuers: vi.fn(),
    verifyClientSecretHash: vi.fn(),
    parseBasicAuth: vi.fn<(...args: unknown[]) => unknown>(),
    extractDPoPProof: vi.fn(),
    validateDPoPProof: vi.fn(),
    validateClientCertificateBinding: vi.fn(),
    generateRegionAwareJti: vi.fn(),
    getRefreshToken: vi.fn(),
    storeRefreshToken:
      vi.fn<
        (
          env: unknown,
          jti: string,
          data: Claims & { iat: number; exp: number },
          tenantId: string
        ) => Promise<void>
      >(),
    parseRefreshTokenJti: vi.fn<(...args: unknown[]) => unknown>(),
    createRefreshTokenFamily:
      vi.fn<
        (
          env: unknown,
          input: Claims
        ) => Promise<{ jti: string; resolution: { generation: number } }>
      >(),
    recordRefreshTokenFamilyIndex:
      vi.fn<(db: unknown, input: Claims & { expiresAt: number }) => Promise<void>>(),
    updateRefreshTokenFamilyIndexExpiry: vi.fn(),
    parseDeviceCodeId: vi.fn(),
    getDeviceCodeStoreById: vi.fn(),
    parseCIBARequestId: vi.fn(),
    getCIBARequestStoreById: vi.fn(),
    getAccessTokenRBACClaims: vi.fn(),
    getIDTokenRBACClaims: vi.fn(),
    isPolicyEmbeddingEnabled: vi.fn(),
    evaluatePermissionEmbeddingForScope: vi.fn(),
    getEmbeddingLimits: vi.fn(),
    findCanonicalRuntimeAccount: vi.fn(),
    findCanonicalRuntimeUserProjection: vi.fn(),
    resolveAccountDataContextFromHono: vi.fn(),
    publishEvent: vi.fn(),
    guestContract: vi.fn<() => unknown>(),
    assertGuestSessionAuthenticationAllowed: vi.fn<(...args: unknown[]) => unknown>(),
  };
});

export { mocks };

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const passthrough =
    <K extends keyof typeof actual>(key: K, mock: Mock<(...args: unknown[]) => unknown>) =>
    // A mock without an implementation runs the real function.
    (...args: unknown[]) =>
      mock.getMockImplementation()
        ? mock(...args)
        : (actual[key] as unknown as (...a: unknown[]) => unknown)(...args);
  return {
    ...actual,
    getLogger: () => ({ module: () => mocks.logger }),
    createLogger: () => ({ module: () => mocks.logger }),
    isReplayJtiRecorded: async () => false,
    recordReplayJti: async () => 'recorded',
    loadClientContractCached: (...args: Parameters<typeof actual.loadClientContractCached>) => {
      const override = mocks.guestContract();
      return override === undefined
        ? actual.loadClientContractCached(...args)
        : Promise.resolve(override as Awaited<ReturnType<typeof actual.loadClientContractCached>>);
    },
    ensureAccountAuthenticationState: vi.fn(async () => ({ lifecycle: 'active' })),
    assertGuestSessionAuthenticationAllowed: passthrough(
      'assertGuestSessionAuthenticationAllowed',
      mocks.assertGuestSessionAuthenticationAllowed
    ),
    findCanonicalAccountAuthenticationState: vi.fn(
      async (_a: unknown, _t: unknown, userId: string) => ({
        userId,
        accountType: 'user',
        lifecycle: 'active',
        sourceVersionMs: 1_000,
      })
    ),
    resolveEffectiveSettings: async (env: unknown, category: string) => ({
      ...(await settingsFromSystemSettings(env, null, category)),
      ...(mocks.settings[category] ?? {}),
    }),
    resolvePolicyFlags: async (...args: Parameters<typeof actual.resolvePolicyFlags>) => ({
      ...(await actual.resolvePolicyFlags(...args)),
      ...mocks.policyFlags,
    }),
    createSDJWTIDTokenFromClaims: mocks.createSDJWTIDTokenFromClaims,
    getClientCached: mocks.getClientCached,
    loadTenantProfileCached: mocks.loadTenantProfileCached,
    getProtocolSettingsCached: async (
      c: unknown,
      env: unknown,
      options: { clientId: string; keys: string[] }
    ) => ({
      fapi: {},
      oidc: {},
      security: {},
      ...((await mocks.getProtocolSettingsCached(c, env, options)) ?? {}),
    }),
    createAccessToken: mocks.createAccessToken,
    createIDToken: mocks.createIDToken,
    createRefreshToken: mocks.createRefreshToken,
    verifyToken: mocks.verifyToken,
    parseToken: mocks.parseToken,
    calculateAtHash: mocks.calculateAtHash,
    validateClientAssertion: mocks.validateClientAssertion,
    validateJWTBearerAssertion: mocks.validateJWTBearerAssertion,
    parseTrustedIssuers: mocks.parseTrustedIssuers,
    verifyClientSecretHash: mocks.verifyClientSecretHash,
    parseBasicAuth: passthrough('parseBasicAuth', mocks.parseBasicAuth),
    extractDPoPProof: mocks.extractDPoPProof,
    validateDPoPProof: mocks.validateDPoPProof,
    validateClientCertificateBinding: mocks.validateClientCertificateBinding,
    generateRegionAwareJti: mocks.generateRegionAwareJti,
    getRefreshToken: mocks.getRefreshToken,
    storeRefreshToken: mocks.storeRefreshToken,
    parseRefreshTokenJti: passthrough('parseRefreshTokenJti', mocks.parseRefreshTokenJti),
    createRefreshTokenFamily: mocks.createRefreshTokenFamily,
    recordRefreshTokenFamilyIndex: mocks.recordRefreshTokenFamilyIndex,
    updateRefreshTokenFamilyIndexExpiry: mocks.updateRefreshTokenFamilyIndexExpiry,
    parseDeviceCodeId: mocks.parseDeviceCodeId,
    getDeviceCodeStoreById: mocks.getDeviceCodeStoreById,
    parseCIBARequestId: mocks.parseCIBARequestId,
    getCIBARequestStoreById: mocks.getCIBARequestStoreById,
    D1Adapter: vi.fn(function D1AdapterMock() {
      return mocks.coreAdapter;
    }),
    CanonicalRuntimeUserProjectionRepository: vi.fn(function ProjectionRepositoryMock() {
      return { findByLegacyUserId: mocks.findCanonicalRuntimeUserProjection };
    }),
    CanonicalSensitiveValueResolver: vi.fn(function SensitiveValueResolverMock() {
      return {};
    }),
    CanonicalIdentityRepository: vi.fn(function IdentityRepositoryMock() {
      return { findAccountByLegacyUserId: mocks.findCanonicalRuntimeAccount };
    }),
    resolveAccountDataContextFromHono: mocks.resolveAccountDataContextFromHono,
    getAccessTokenRBACClaims: mocks.getAccessTokenRBACClaims,
    getIDTokenRBACClaims: mocks.getIDTokenRBACClaims,
    isPolicyEmbeddingEnabled: mocks.isPolicyEmbeddingEnabled,
    evaluatePermissionEmbeddingForScope: mocks.evaluatePermissionEmbeddingForScope,
    getEmbeddingLimits: mocks.getEmbeddingLimits,
    isCustomClaimsEnabled: async () => false,
    isIdLevelPermissionsEnabled: async () => false,
    publishEvent: mocks.publishEvent,
  };
});

vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  const key = { type: 'private', algorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } };
  return {
    ...actual,
    importPKCS8: vi.fn().mockResolvedValue(key),
    // Signature keys are stand-ins; a client's encryption key (use "enc") is imported for real.
    importJWK: vi.fn(async (jwk: { use?: string }, ...rest: unknown[]) =>
      jwk.use === 'enc'
        ? (actual.importJWK as (...a: unknown[]) => Promise<unknown>)(jwk, ...rest)
        : { ...key, type: 'public' }
    ),
  };
});

/** A client secret and its SHA-256 hash (as stored), for the grants that hash it for real. */
export const CLIENT_SECRET = 'ciba-secret';
export const CLIENT_SECRET_HASH =
  '3269ad7c6e3e2fe0a25f942328a6099e42978ee9c3d4f55bc222f7520a40d044';

export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
export const CIBA_GRANT = 'urn:openid:params:grant-type:ciba';
export const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

/** Resets every mock to its default behaviour and returns a fresh environment. */
export function resetHarness(): MockEnv {
  vi.clearAllMocks();
  for (const fn of Object.values(mocks)) {
    if (typeof fn === 'function' && 'mockReset' in fn) (fn as Mock).mockReset();
  }
  for (const fn of Object.values(mocks.coreAdapter)) fn.mockReset();
  mocks.coreAdapter.query.mockResolvedValue([]);
  mocks.coreAdapter.queryOne.mockResolvedValue(null);
  mocks.coreAdapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
  mocks.coreAdapter.transaction.mockImplementation(async (fn: (a: unknown) => unknown) =>
    fn(mocks.coreAdapter)
  );
  mocks.coreAdapter.batch.mockResolvedValue([]);
  mocks.coreAdapter.getType.mockReturnValue('mock');
  mocks.settings = {
    oauth: {
      'oauth.access_token_expiry': 3600,
      'oauth.refresh_token_expiry': 86400 * 30,
      'oauth.offline_access_required': false,
    },
  };
  mocks.policyFlags = {};
  mocks.createSDJWTIDTokenFromClaims.mockResolvedValue('mock-sd-jwt-id-token');
  mocks.getClientCached.mockResolvedValue(null);
  mocks.loadTenantProfileCached.mockResolvedValue({
    tenant_id: 'default',
    max_token_ttl_seconds: 3600,
    allows_refresh_token: true,
  });
  mocks.getProtocolSettingsCached.mockResolvedValue(null);
  mocks.createAccessToken.mockResolvedValue({ token: 'mock-access-token', jti: 'at-jti-001' });
  mocks.createIDToken.mockResolvedValue('mock-id-token');
  mocks.createRefreshToken.mockResolvedValue({ token: 'mock-refresh-token', jti: 'rt-jti-001' });
  mocks.verifyToken.mockResolvedValue({ valid: true, payload: {} });
  mocks.parseToken.mockReturnValue({});
  mocks.calculateAtHash.mockResolvedValue('at-hash-value');
  mocks.validateClientAssertion.mockResolvedValue({ valid: true });
  mocks.verifyClientSecretHash.mockResolvedValue(true);
  mocks.extractDPoPProof.mockReturnValue(null);
  mocks.validateDPoPProof.mockResolvedValue({ valid: true, jkt: 'proof-jkt' });
  mocks.validateClientCertificateBinding.mockResolvedValue({
    valid: false,
    error: 'certificate_required',
  });
  mocks.generateRegionAwareJti.mockResolvedValue({ jti: 'jti-region-001' });
  mocks.getRefreshToken.mockResolvedValue(null);
  mocks.storeRefreshToken.mockResolvedValue(undefined);
  mocks.createRefreshTokenFamily.mockResolvedValue({
    jti: 'v1_0_family-jti',
    resolution: { generation: 1 },
  });
  mocks.recordRefreshTokenFamilyIndex.mockResolvedValue(undefined);
  mocks.updateRefreshTokenFamilyIndexExpiry.mockResolvedValue(undefined);
  mocks.parseDeviceCodeId.mockReturnValue(null);
  mocks.parseCIBARequestId.mockReturnValue(null);
  mocks.getAccessTokenRBACClaims.mockResolvedValue({});
  mocks.getIDTokenRBACClaims.mockResolvedValue({});
  mocks.isPolicyEmbeddingEnabled.mockResolvedValue(false);
  mocks.evaluatePermissionEmbeddingForScope.mockResolvedValue({
    permissions: [],
    scopedPermissions: [],
  });
  mocks.getEmbeddingLimits.mockResolvedValue({ max_embedded_permissions: 50 });
  mocks.findCanonicalRuntimeAccount.mockImplementation(async (userId: string) =>
    canonicalAccount(userId)
  );
  mocks.findCanonicalRuntimeUserProjection.mockImplementation(async (userId: string) =>
    canonicalProjection(userId)
  );
  mocks.resolveAccountDataContextFromHono.mockImplementation(
    async (c: { set(key: string, value: unknown): void }, subject: string) => {
      const legacyUserId = subject.startsWith('account:') ? subject.slice(8) : subject;
      const accountId = `account:${legacyUserId}`;
      const context = {
        tenantId: 'default',
        accountId,
        legacyUserId,
        membership: {},
        coreDb: mocks.coreAdapter,
        piiDb: mocks.coreAdapter,
        coreBindingRef: 'D1_USERS_001',
        piiBindingRef: 'D1_PII_001',
        coreResidencyPartition: 'global',
        piiResidencyPartition: 'global',
        accountRouteGeneration: 1,
        userCacheScope: `default:${accountId}:1`,
        piiCacheMode: 'disabled',
      };
      c.set('tenantMetadataContext', { tenantId: 'default', coreDb: mocks.coreAdapter });
      c.set('accountDataContext', context);
      return context;
    }
  );
  mocks.publishEvent.mockResolvedValue(undefined);
  return createMockEnv();
}

export type TokenCall = Awaited<ReturnType<typeof callToken>>;

/** Calls the token endpoint; the response body, headers and the context it ran in. */
export async function callToken(
  handler: (c: ReturnType<typeof createMockContext>) => Promise<Response>,
  env: MockEnv,
  body: Record<string, string>,
  headers?: Record<string, string>
) {
  const ctx = createMockContext({ body, headers, env });
  const response = await handler(ctx);
  const headerCalls = new Map(
    vi.mocked(ctx.header).mock.calls.map(([name, value]) => [name, value] as [string, string])
  );
  return {
    ctx,
    response,
    status: response.status,
    body: await parseJsonResponse<Record<string, unknown>>(response),
    headers: headerCalls,
  };
}

/** The events the request published (type and data), after its waitUntil work settled. */
export async function publishedEvents(ctx: ReturnType<typeof createMockContext>) {
  await Promise.all(vi.mocked(ctx.executionCtx.waitUntil).mock.calls.map(([work]) => work));
  return mocks.publishEvent.mock.calls.map(
    ([, event]) => event as { type: string; tenantId: string; data: Record<string, unknown> }
  );
}

/**
 * Answers the account database's single-row reads by the table the SQL names (an Error is
 * thrown); any other read finds nothing.
 */
export function answerQueryOne(routes: Record<string, unknown>): void {
  mocks.coreAdapter.queryOne.mockImplementation(async (sql: string) => {
    for (const [table, answer] of Object.entries(routes)) {
      if (!sql.includes(table)) continue;
      if (answer instanceof Error) throw answer;
      return answer;
    }
    return null;
  });
}

export * from './mut-grants-stores';
