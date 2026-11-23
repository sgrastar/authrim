/**
 * Shared mock setup for the mut-authcode-* tests of the authorization code and Direct Auth finish
 * grants in src/token.ts.
 *
 * Mirrors the module mocks of security-critical.test.ts (ar-lib-core with importOriginal, jose key
 * import), and additionally lets a test fail the account, consent and guest reads that the
 * authorization code grant performs after the code is spent. Import this module before
 * `../token` in the test file.
 */
import { vi, expect } from 'vitest';
import {
  createMockContext,
  createMockEnv,
  createMockKV,
  parseJsonResponse,
  type MockEnv,
} from './mocks';
import { createConfidentialClient, type TestClientMetadata } from './fixtures';

function createMocks() {
  const loggerMethods = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const logger = { module: vi.fn(() => loggerMethods) };
  return {
    logger,
    getLogger: vi.fn(() => logger),
    validateGrantType: vi.fn(),
    validateAuthCode: vi.fn(),
    validateClientId: vi.fn(),
    validateRedirectUri: vi.fn(),
    getClientCached: vi.fn(),
    loadTenantProfileCached: vi.fn(),
    getProtocolSettingsCached: vi.fn(),
    getChallengeStoreByChallengeId: vi.fn(),
    createAccessToken: vi.fn(),
    createIDToken: vi.fn(),
    createRefreshToken: vi.fn(),
    parseToken: vi.fn(),
    calculateAtHash: vi.fn(),
    calculateDsHash: vi.fn(),
    revokeToken: vi.fn(),
    validateClientAssertion: vi.fn(),
    verifyClientSecretHash: vi.fn(),
    parseBasicAuth: vi.fn(),
    extractDPoPProof: vi.fn(),
    validateDPoPProof: vi.fn(),
    validateClientCertificateBinding: vi.fn(),
    parseShardedAuthCode: vi.fn(),
    getShardCount: vi.fn(),
    remapShardIndex: vi.fn(),
    buildAuthCodeShardInstanceName: vi.fn(),
    generateRegionAwareJti: vi.fn(),
    findRuntimeUser: vi.fn(),
    findAccount: vi.fn(),
    resolveAccountDataContext: vi.fn(),
    ensureAccountAuthenticationState: vi.fn(),
    assertGuestSessionAuthenticationAllowed: vi.fn(),
    findConsentRevocation: vi.fn(),
    guestContract: vi.fn<() => unknown>(),
    getAccessTokenRBACClaims: vi.fn(),
    getIDTokenRBACClaims: vi.fn(),
    isPolicyEmbeddingEnabled: vi.fn(),
    evaluatePermissionEmbeddingForScope: vi.fn(),
    isIdLevelPermissionsEnabled: vi.fn(),
    evaluateIdLevelPermissions: vi.fn(),
    isCustomClaimsEnabled: vi.fn(),
    createTokenClaimEvaluator: vi.fn(),
    getEmbeddingLimits: vi.fn(),
    isNativeSSOEnabled: vi.fn(),
    getNativeSSOConfig: vi.fn(),
    deviceSecretRepo: {
      findByUserId: vi.fn(),
      revoke: vi.fn(),
      createSecret: vi.fn(),
    },
    ensureForDeviceSecret: vi.fn(),
    recordDeviceSecretRouteHint: vi.fn(),
    publishEvent: vi.fn(),
  };
}

// Created when this module is evaluated, before ../token (and so ar-lib-core) is imported: the
// mock factories below read it only then.
export const mocks = createMocks();

/** The wallet attestation authenticator, replaceable per test (wallet clients, HAIP). */
export const walletAuth = { authenticate: vi.fn() };

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    loadClientContractCached: (...args: Parameters<typeof actual.loadClientContractCached>) => {
      const override = mocks.guestContract();
      return override === undefined
        ? actual.loadClientContractCached(...args)
        : Promise.resolve(override as Awaited<ReturnType<typeof actual.loadClientContractCached>>);
    },
    authenticateWalletClient: (...args: unknown[]): unknown => walletAuth.authenticate(...args),
    ensureAccountAuthenticationState: mocks.ensureAccountAuthenticationState,
    findCanonicalAccountAuthenticationState: vi.fn(
      async (_a: unknown, _t: string, userId: string) => ({
        userId,
        accountType: 'user',
        lifecycle: 'active',
        sourceVersionMs: 1_000,
      })
    ),
    assertGuestSessionAuthenticationAllowed: mocks.assertGuestSessionAuthenticationAllowed,
    findOAuthClientConsentRevocation: mocks.findConsentRevocation,
    getLogger: mocks.getLogger,
    createLogger: mocks.getLogger,
    validateGrantType: mocks.validateGrantType,
    validateAuthCode: mocks.validateAuthCode,
    validateClientId: mocks.validateClientId,
    validateRedirectUri: mocks.validateRedirectUri,
    getClientCached: mocks.getClientCached,
    loadTenantProfileCached: mocks.loadTenantProfileCached,
    getProtocolSettingsCached: async (...args: unknown[]) => ({
      fapi: {},
      oidc: {},
      security: {},
      ...(((await mocks.getProtocolSettingsCached(...args)) as Record<string, unknown> | null) ??
        {}),
    }),
    getChallengeStoreByChallengeId: mocks.getChallengeStoreByChallengeId,
    createAccessToken: mocks.createAccessToken,
    createIDToken: mocks.createIDToken,
    createRefreshToken: mocks.createRefreshToken,
    parseToken: mocks.parseToken,
    calculateAtHash: mocks.calculateAtHash,
    calculateDsHash: mocks.calculateDsHash,
    revokeToken: mocks.revokeToken,
    validateClientAssertion: mocks.validateClientAssertion,
    verifyClientSecretHash: mocks.verifyClientSecretHash,
    parseBasicAuth: mocks.parseBasicAuth,
    extractDPoPProof: mocks.extractDPoPProof,
    validateDPoPProof: mocks.validateDPoPProof,
    validateClientCertificateBinding: mocks.validateClientCertificateBinding,
    parseShardedAuthCode: mocks.parseShardedAuthCode,
    getShardCount: mocks.getShardCount,
    remapShardIndex: mocks.remapShardIndex,
    buildAuthCodeShardInstanceName: mocks.buildAuthCodeShardInstanceName,
    generateRegionAwareJti: mocks.generateRegionAwareJti,
    D1Adapter: vi.fn(() => ({
      query: vi.fn().mockResolvedValue([]),
      queryOne: vi.fn().mockResolvedValue(null),
      execute: vi.fn().mockResolvedValue({ success: true }),
    })),
    CanonicalRuntimeUserProjectionRepository: vi.fn(function RuntimeUserRepositoryMock() {
      return { findByLegacyUserId: mocks.findRuntimeUser };
    }),
    CanonicalSensitiveValueResolver: vi.fn(function SensitiveValueResolverMock() {
      return {};
    }),
    CanonicalIdentityRepository: vi.fn(function IdentityRepositoryMock() {
      return { findAccountByLegacyUserId: mocks.findAccount };
    }),
    resolveAccountDataContextFromHono: mocks.resolveAccountDataContext,
    getAccessTokenRBACClaims: mocks.getAccessTokenRBACClaims,
    getIDTokenRBACClaims: mocks.getIDTokenRBACClaims,
    isPolicyEmbeddingEnabled: mocks.isPolicyEmbeddingEnabled,
    evaluatePermissionEmbeddingForScope: mocks.evaluatePermissionEmbeddingForScope,
    isIdLevelPermissionsEnabled: mocks.isIdLevelPermissionsEnabled,
    evaluateIdLevelPermissions: mocks.evaluateIdLevelPermissions,
    isCustomClaimsEnabled: mocks.isCustomClaimsEnabled,
    createTokenClaimEvaluator: mocks.createTokenClaimEvaluator,
    getEmbeddingLimits: mocks.getEmbeddingLimits,
    isNativeSSOEnabled: mocks.isNativeSSOEnabled,
    getNativeSSOConfig: mocks.getNativeSSOConfig,
    DeviceSecretRepository: vi.fn(function DeviceSecretRepositoryMock() {
      return mocks.deviceSecretRepo;
    }),
    DeviceInstallationRepository: vi.fn(function DeviceInstallationRepositoryMock() {
      return { ensureForDeviceSecret: mocks.ensureForDeviceSecret };
    }),
    recordDeviceSecretRouteHint: mocks.recordDeviceSecretRouteHint,
    publishEvent: mocks.publishEvent,
  };
});

vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    importPKCS8: vi.fn().mockResolvedValue({
      type: 'private',
      algorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    }),
  };
});

export const DIRECT_AUTH_GRANT_TYPE = 'urn:authrim:params:oauth:grant-type:direct-auth-finish';
export const DIRECT_AUTH_REDIRECT_URI = 'https://authrim.local/direct-auth/callback';
export const VERIFIER = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';

export async function pkceChallenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const base64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function runtimeUser(userId: string) {
  return {
    id: userId,
    tenant_id: 'default',
    subject_id: `subject-${userId}`,
    account_id: `account-${userId}`,
    account_type: 'end_user',
    lifecycle_state: 'active',
    email: 'user@example.com',
    email_verified: 1,
    name: 'Test User',
    phone_number_verified: 0,
    active: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

export function account(userId: string, overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

/** Reset every mock to a passing default and return a fresh environment. */
export function resetHarness(): MockEnv {
  vi.clearAllMocks();
  mocks.getLogger.mockImplementation(() => mocks.logger);
  mocks.validateGrantType.mockReset().mockReturnValue({ valid: true });
  mocks.validateAuthCode.mockReset().mockReturnValue({ valid: true });
  mocks.validateClientId.mockReset().mockReturnValue({ valid: true });
  mocks.validateRedirectUri.mockReset().mockReturnValue({ valid: true });
  mocks.getClientCached.mockReset().mockResolvedValue(null);
  mocks.loadTenantProfileCached.mockReset().mockResolvedValue({
    tenant_id: 'default',
    max_token_ttl_seconds: 3600,
    allows_refresh_token: true,
  });
  mocks.getProtocolSettingsCached.mockReset().mockResolvedValue(null);
  mocks.getChallengeStoreByChallengeId.mockReset().mockResolvedValue({
    consumeChallengeRpc: vi.fn().mockRejectedValue(new Error('Artifact not found')),
  });
  mocks.createAccessToken
    .mockReset()
    .mockResolvedValue({ token: 'mock-access-token', jti: 'at-jti-001' });
  mocks.createIDToken.mockReset().mockResolvedValue('mock-id-token');
  mocks.createRefreshToken
    .mockReset()
    .mockResolvedValue({ token: 'mock-refresh-token', jti: 'rt-jti-001' });
  mocks.parseToken.mockReset().mockReturnValue({});
  mocks.calculateAtHash.mockReset().mockResolvedValue('at-hash-value');
  mocks.calculateDsHash.mockReset().mockResolvedValue('ds-hash-value');
  mocks.revokeToken.mockReset().mockResolvedValue(undefined);
  mocks.validateClientAssertion.mockReset().mockResolvedValue({ valid: true });
  mocks.verifyClientSecretHash.mockReset().mockReturnValue(true);
  mocks.parseBasicAuth.mockReset().mockReturnValue({ success: false });
  mocks.extractDPoPProof.mockReset().mockReturnValue(null);
  mocks.validateDPoPProof.mockReset().mockResolvedValue({ valid: true, jkt: 'test-jkt' });
  mocks.validateClientCertificateBinding
    .mockReset()
    .mockResolvedValue({ valid: false, error: 'certificate_required' });
  mocks.parseShardedAuthCode.mockReset().mockReturnValue(null);
  mocks.getShardCount.mockReset().mockResolvedValue(1);
  mocks.remapShardIndex.mockReset().mockImplementation((idx: number) => idx);
  mocks.buildAuthCodeShardInstanceName.mockReset().mockReturnValue('auth-code-0');
  mocks.generateRegionAwareJti.mockReset().mockResolvedValue({ jti: 'jti-region-001' });
  mocks.findRuntimeUser.mockReset().mockImplementation(async (id: string) => runtimeUser(id));
  mocks.findAccount.mockReset().mockImplementation(async (id: string) => account(id));
  mocks.resolveAccountDataContext
    .mockReset()
    .mockImplementation(
      async (
        c: { env: MockEnv; get: (k: string) => unknown; set: (k: string, v: unknown) => void },
        subject: string
      ) => {
        const existing = c.get('accountDataContext');
        if (existing) return existing;
        const context = {
          tenantId: 'default',
          accountId: `account:${subject}`,
          legacyUserId: subject,
          coreDb: c.env.TDB_TEST_CORE,
          piiDb: c.env.TDB_TEST_CORE,
        };
        c.set('accountDataContext', context);
        return context;
      }
    );
  mocks.ensureAccountAuthenticationState.mockReset().mockResolvedValue({ lifecycle: 'active' });
  mocks.assertGuestSessionAuthenticationAllowed.mockReset().mockResolvedValue(undefined);
  mocks.findConsentRevocation.mockReset().mockResolvedValue({ generation: 0, revokedAt: null });
  mocks.guestContract.mockReset();
  mocks.getAccessTokenRBACClaims.mockReset().mockResolvedValue({});
  mocks.getIDTokenRBACClaims.mockReset().mockResolvedValue({});
  mocks.isPolicyEmbeddingEnabled.mockReset().mockResolvedValue(false);
  mocks.evaluatePermissionEmbeddingForScope
    .mockReset()
    .mockResolvedValue({ permissions: [], scopedPermissions: [] });
  mocks.isIdLevelPermissionsEnabled.mockReset().mockResolvedValue(false);
  mocks.evaluateIdLevelPermissions.mockReset().mockResolvedValue([]);
  mocks.isCustomClaimsEnabled.mockReset().mockResolvedValue(false);
  mocks.createTokenClaimEvaluator.mockReset().mockReturnValue({
    evaluate: vi.fn().mockResolvedValue({ claims_to_add: {}, claim_overrides: [] }),
  });
  mocks.getEmbeddingLimits.mockReset().mockResolvedValue({
    max_embedded_permissions: 50,
    max_resource_permissions: 100,
    max_custom_claims: 20,
  });
  mocks.isNativeSSOEnabled.mockReset().mockResolvedValue(false);
  mocks.getNativeSSOConfig.mockReset().mockResolvedValue({
    enabled: true,
    deviceSecretTTLDays: 30,
    maxDeviceSecretsPerUser: 10,
    maxSecretsBehavior: 'revoke_oldest',
    deviceSecretRotationPolicy: 'disabled',
    deviceSecretRotationOverlapSeconds: 0,
  });
  mocks.deviceSecretRepo.findByUserId.mockReset().mockResolvedValue([]);
  mocks.deviceSecretRepo.revoke.mockReset().mockResolvedValue(true);
  mocks.deviceSecretRepo.createSecret
    .mockReset()
    .mockResolvedValue({ ok: false, reason: 'limit_exceeded' });
  mocks.ensureForDeviceSecret.mockReset().mockResolvedValue(null);
  mocks.recordDeviceSecretRouteHint.mockReset().mockResolvedValue(undefined);
  mocks.publishEvent.mockReset().mockResolvedValue(undefined);
  return createMockEnv();
}

/** Tenant settings by category (settings:tenant:default:<category>), read from KV. */
export function useTenantSettings(
  env: MockEnv,
  byCategory: Record<string, Record<string, unknown>>
) {
  const kv = createMockKV();
  for (const [category, values] of Object.entries(byCategory)) {
    void kv.put(`settings:tenant:default:${category}`, JSON.stringify(values));
  }
  (env as unknown as { SETTINGS: unknown }).SETTINGS = kv;
}

export interface CodeStore {
  consumeCodeRpc: ReturnType<typeof vi.fn>;
  registerIssuedTokensRpc: ReturnType<typeof vi.fn>;
}

/** The AuthorizationCodeStore DO: consumes to `data` (or rejects with an Error of that message). */
export function useCodeStore(
  env: MockEnv,
  data: object | Error,
  registered: unknown = true
): CodeStore {
  const store = {
    consumeCodeRpc:
      data instanceof Error ? vi.fn().mockRejectedValue(data) : vi.fn().mockResolvedValue(data),
    registerIssuedTokensRpc:
      registered instanceof Error
        ? vi.fn().mockRejectedValue(registered)
        : vi.fn().mockResolvedValue(registered),
  };
  env.AUTH_CODE_STORE.get = vi.fn().mockReturnValue(store);
  return store;
}

/** A confidential client_secret_post client the code grant authenticates. */
export function postClient(overrides?: Partial<TestClientMetadata>): TestClientMetadata {
  return createConfidentialClient({
    token_endpoint_auth_method: 'client_secret_post',
    require_pkce: false,
    ...overrides,
  });
}

export async function postToken(
  env: MockEnv,
  body: Record<string, string>,
  headers: Record<string, string> = {}
) {
  const ctx = createMockContext({ method: 'POST', body, headers, env });
  const { tokenHandler } = await import('../../token');
  const response = await tokenHandler(ctx);
  const json = await parseJsonResponse<Record<string, unknown>>(response.clone());
  return { ctx, response, body: json };
}

/** A code exchange for `client` with the code's redirect_uri and the client's secret. */
export function codeRequest(
  client: TestClientMetadata,
  data: { redirectUri: string },
  extra: Record<string, string> = {}
): Record<string, string> {
  return {
    grant_type: 'authorization_code',
    code: 'valid-auth-code',
    redirect_uri: data.redirectUri,
    client_id: client.client_id,
    client_secret: 'valid-secret',
    ...extra,
  };
}

export function expectOAuthError(
  result: { response: Response; body: Record<string, unknown> },
  status: number,
  error: string,
  description?: string
) {
  expect(result.response.status).toBe(status);
  expect(result.body.error).toBe(error);
  if (description !== undefined) expect(result.body.error_description).toBe(description);
}

/** The claims the access token was signed with. */
export function accessTokenClaims(): Record<string, unknown> {
  expect(mocks.createAccessToken).toHaveBeenCalled();
  return (mocks.createAccessToken.mock.calls.at(-1) ?? [])[0] as Record<string, unknown>;
}
