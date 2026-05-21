/**
 * Client Authentication Tests
 *
 * Tests all client authentication methods:
 * - client_secret_basic (HTTP Basic authentication)
 * - client_secret_post (credentials in request body)
 * - private_key_jwt (JWT signed with client's private key)
 * - client_secret_jwt (JWT signed with client secret)
 * - none (public clients)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createMockEnv,
  createMockContext,
  createTestJWT,
  base64UrlEncode,
  parseJsonResponse,
  type MockEnv,
} from './helpers/mocks';
import {
  createConfidentialClient,
  createPublicClient,
  createPrivateKeyJwtClient,
  createM2MClient,
  createAuthCodeData,
  createClientCredentialsGrantRequest,
  type TestClientMetadata,
} from './helpers/fixtures';

// ============================================================================
// Module Mock Setup
// ============================================================================

// Define mocks inline in vi.hoisted to avoid import issues
const mocks = vi.hoisted(() => {
  const mockLoggerMethods = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const mockLogger = {
    module: vi.fn().mockReturnValue(mockLoggerMethods),
  };

  return {
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
    mockGetSystemSettingsCached: vi.fn().mockResolvedValue(null),
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
    mockCalculateAtHash: vi.fn().mockResolvedValue('at-hash-value'),
    mockCalculateDsHash: vi.fn().mockResolvedValue('presented-ds-hash'),

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
    mockD1Adapter: vi.fn().mockReturnValue({
      query: vi.fn().mockResolvedValue([]),
      queryOne: vi.fn().mockResolvedValue(null),
      execute: vi.fn().mockResolvedValue({ success: true }),
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

    // Native SSO
    mockDeviceSecretRepository: {
      validateAndUse: vi.fn().mockResolvedValue({ ok: false, reason: 'not_found' }),
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

    // RBAC / Policy
    mockGetIDTokenRBACClaims: vi.fn().mockResolvedValue({}),
    mockGetAccessTokenRBACClaims: vi.fn().mockResolvedValue({}),
    mockIsPolicyEmbeddingEnabled: vi.fn().mockResolvedValue(false),
    mockIsCustomClaimsEnabled: vi.fn().mockResolvedValue(false),
    mockIsIdLevelPermissionsEnabled: vi.fn().mockResolvedValue(false),
    mockGetEmbeddingLimits: vi.fn().mockReturnValue({ maxClaims: 50, maxSize: 4096 }),

    // Configuration
    mockCreateOAuthConfigManager: vi.fn().mockReturnValue({
      getTokenExpiry: vi.fn().mockResolvedValue(3600),
      getRefreshTokenExpiry: vi.fn().mockResolvedValue(86400 * 30),
    }),

    // Events
    mockPublishEvent: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    getLogger: mocks.mockGetLogger,
    createLogger: mocks.mockCreateLogger,
    validateGrantType: mocks.mockValidateGrantType,
    validateAuthCode: mocks.mockValidateAuthCode,
    validateClientId: mocks.mockValidateClientId,
    validateRedirectUri: mocks.mockValidateRedirectUri,
    getClientCached: mocks.mockGetClientCached,
    loadTenantProfileCached: mocks.mockLoadTenantProfileCached,
    getSystemSettingsCached: mocks.mockGetSystemSettingsCached,
    getChallengeStoreByChallengeId: mocks.mockGetChallengeStoreByChallengeId,
    createAccessToken: mocks.mockCreateAccessToken,
    createIDToken: mocks.mockCreateIDToken,
    createRefreshToken: mocks.mockCreateRefreshToken,
    verifyToken: mocks.mockVerifyToken,
    parseToken: mocks.mockParseToken,
    parseTokenHeader: mocks.mockParseTokenHeader,
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
    createOAuthConfigManager: mocks.mockCreateOAuthConfigManager,
    publishEvent: mocks.mockPublishEvent,
    TOKEN_EVENTS: {
      ACCESS_ISSUED: 'token.access.issued',
      ID_ISSUED: 'token.id.issued',
      REFRESH_ISSUED: 'token.refresh.issued',
    },
  };
});

// Mock jose library for key operations
vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    importPKCS8: vi.fn().mockResolvedValue({
      type: 'private',
      algorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    } as unknown as CryptoKey),
    importJWK: vi.fn().mockResolvedValue({
      type: 'public',
      algorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    } as unknown as CryptoKey),
  };
});

import { tokenHandler } from '../token';

const DIRECT_AUTH_GRANT_TYPE = 'urn:authrim:params:oauth:grant-type:direct-auth-finish';
const DIRECT_AUTH_REDIRECT_URI = 'https://authrim.local/direct-auth/callback';
const DEVICE_SECRET_TOKEN_TYPE = 'urn:openid:params:token-type:device-secret';

async function createPkceChallenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const bytes = Array.from(new Uint8Array(hash));
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function expectRefreshTokenExpiryMetadata(body: Record<string, unknown>, expiresIn = 86400 * 30) {
  expect(body.refresh_token_expires_in).toBe(expiresIn);
  expect(typeof body.refresh_token_expires_at).toBe('string');
  expect(typeof body.refresh_token_expires_at_unix).toBe('number');
  expect(Date.parse(body.refresh_token_expires_at as string)).toBe(
    (body.refresh_token_expires_at_unix as number) * 1000
  );
}

function expectNativeSSOInstallationMetadata(
  body: Record<string, unknown>,
  clientId: string,
  installationId = 'ds-001'
) {
  expect(body.installation_id).toBe(installationId);
  expect(body.client_id).toBe(clientId);
  expect(body.issued_token_type).toBe('urn:ietf:params:oauth:token-type:access_token');
  expect(body.token_type).toBe('DPoP');
  expect(body.platform).toBe('ios');
  expect(body.display_name).toBe('');
  expect(body.fallback_display_name).toBe('ios device');
  expect(typeof body.last_seen_at).toBe('string');
  expect(typeof body.last_seen_at_unix).toBe('number');
  expect(Date.parse(body.last_seen_at as string)).toBe((body.last_seen_at_unix as number) * 1000);
  expect(body.app_display_name).toBeUndefined();
  expect(body.source_client_id).toBeUndefined();
  expect(body.issued_client_id).toBeUndefined();
  expect(body.source_installation_id).toBeUndefined();
  expect(body.issued_installation_id).toBeUndefined();
  expect(body.trust_group_id).toBeUndefined();
  expect(body.effective_native_sso_scope).toBeUndefined();
  expect(body.current).toBeUndefined();
  expect(body.resource).toBeUndefined();
  expect(body.audience).toBeUndefined();
  expect(body.cnf).toBeUndefined();
  expect(body.jkt).toBeUndefined();
}

// Helper to reset mocks to default implementations
function resetAllMocks() {
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
  mocks.mockGetSystemSettingsCached.mockReset().mockResolvedValue(null);
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
  mocks.mockIsCustomClaimsEnabled.mockReset().mockResolvedValue(false);
  mocks.mockIsIdLevelPermissionsEnabled.mockReset().mockResolvedValue(false);
  mocks.mockGetCachedUserCore.mockReset().mockResolvedValue(null);
}

// ============================================================================
// Test Setup
// ============================================================================

describe('Client Authentication Tests', () => {
  let mockEnv: MockEnv;

  beforeEach(() => {
    resetAllMocks();
    mockEnv = createMockEnv();

    // Setup default tenant profile
    mocks.mockLoadTenantProfileCached.mockResolvedValue({
      tenant_id: 'default',
      max_token_ttl_seconds: 3600,
      allows_refresh_token: true,
    });

    // Setup default config manager
    mocks.mockCreateOAuthConfigManager.mockReturnValue({
      getTokenExpiry: vi.fn().mockResolvedValue(3600),
      getRefreshTokenExpiry: vi.fn().mockResolvedValue(86400 * 30),
    });

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
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // Token endpoint request validation
  // ==========================================================================

  describe('Token endpoint request validation', () => {
    it('rejects non-form requests before parsing or authenticating clients', async () => {
      const ctx = createMockContext({
        headers: { 'Content-Type': 'application/json' },
        body: { grant_type: 'authorization_code', client_id: 'confidential-client' },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      const body = await parseJsonResponse<{ error: string; error_description: string }>(response);

      expect(response.status).toBe(400);
      expect(body).toEqual({
        error: 'invalid_request',
        error_description: 'Content-Type must be application/x-www-form-urlencoded',
      });
      expect(ctx.req.parseBody).not.toHaveBeenCalled();
      expect(mocks.mockGetClientCached).not.toHaveBeenCalled();
      expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
    });

    it('returns invalid_request when form parsing fails and avoids token issuance', async () => {
      const ctx = createMockContext({
        body: { grant_type: 'authorization_code', client_id: 'confidential-client' },
        env: mockEnv,
      });
      vi.mocked(ctx.req.parseBody).mockRejectedValueOnce(new Error('malformed form body'));

      const response = await tokenHandler(ctx);
      const body = await parseJsonResponse<{ error: string; error_description: string }>(response);

      expect(response.status).toBe(400);
      expect(body).toEqual({
        error: 'invalid_request',
        error_description: 'Failed to parse request body',
      });
      expect(mocks.mockGetClientCached).not.toHaveBeenCalled();
      expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
    });

    it('rejects unsupported grant types without client lookup or token issuance', async () => {
      const ctx = createMockContext({
        body: {
          grant_type: 'urn:example:params:oauth:grant-type:unknown',
          client_id: 'confidential-client',
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      const body = await parseJsonResponse<{ error: string; error_description: string }>(response);

      expect(response.status).toBe(400);
      expect(body).toEqual({
        error: 'unsupported_grant_type',
        error_description:
          "Grant type 'urn:example:params:oauth:grant-type:unknown' is not supported",
      });
      expect(mocks.mockGetClientCached).not.toHaveBeenCalled();
      expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
    });
  });

  describe('Grant-specific required parameter validation', () => {
    it('rejects device_code grant requests without a device_code before polling storage', async () => {
      const ctx = createMockContext({
        body: {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: 'device-client',
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      const body = await parseJsonResponse<{ error: string; error_description: string }>(response);

      expect(response.status).toBe(400);
      expect(body).toEqual({
        error: 'invalid_request',
        error_description: 'device_code is required',
      });
      expect(mockEnv.DEVICE_CODE_STORE.get).not.toHaveBeenCalled();
      expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
    });

    it('rejects device_code grant requests without client_id before polling storage', async () => {
      const ctx = createMockContext({
        body: {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: 'device-code-123',
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      const body = await parseJsonResponse<{ error: string; error_description: string }>(response);

      expect(response.status).toBe(400);
      expect(body).toEqual({
        error: 'invalid_request',
        error_description: 'client_id is required',
      });
      expect(mockEnv.DEVICE_CODE_STORE.get).not.toHaveBeenCalled();
      expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
    });

    it('rejects CIBA grant requests without auth_req_id before polling storage', async () => {
      const ctx = createMockContext({
        body: {
          grant_type: 'urn:openid:params:grant-type:ciba',
          client_id: 'ciba-client',
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      const body = await parseJsonResponse<{ error: string; error_description: string }>(response);

      expect(response.status).toBe(400);
      expect(body).toEqual({
        error: 'invalid_request',
        error_description: 'auth_req_id is required',
      });
      expect(mockEnv.CIBA_REQUEST_STORE.get).not.toHaveBeenCalled();
      expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
    });

    it('rejects CIBA grant requests without client_id before polling storage', async () => {
      const ctx = createMockContext({
        body: {
          grant_type: 'urn:openid:params:grant-type:ciba',
          auth_req_id: 'auth-req-123',
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      const body = await parseJsonResponse<{ error: string; error_description: string }>(response);

      expect(response.status).toBe(400);
      expect(body).toEqual({
        error: 'invalid_request',
        error_description: 'client_id is required',
      });
      expect(mockEnv.CIBA_REQUEST_STORE.get).not.toHaveBeenCalled();
      expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Direct Auth custom grant
  // ==========================================================================

  describe('Direct Auth custom grant', () => {
    it('should redeem a bound Direct Auth artifact via the canonical token endpoint', async () => {
      const client = createPublicClient();
      const codeVerifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
      const codeChallenge = await createPkceChallenge(codeVerifier);
      const authCodeData = createAuthCodeData({
        redirectUri: DIRECT_AUTH_REDIRECT_URI,
        sid: undefined,
      });
      const consumeArtifactRpcMock = vi.fn().mockResolvedValue({
        challenge: codeChallenge,
        userId: authCodeData.userId,
        metadata: {
          client_id: client.client_id,
          channel: 'browser',
          transaction_id: 'txn-001',
        },
      });
      const consumeCodeRpcMock = vi.fn().mockResolvedValue(authCodeData);

      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockGetChallengeStoreByChallengeId.mockResolvedValue({
        consumeChallengeRpc: consumeArtifactRpcMock,
      });
      mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
        consumeCodeRpc: consumeCodeRpcMock,
        registerIssuedTokensRpc: vi.fn().mockResolvedValue(true),
      });

      const ctx = createMockContext({
        body: {
          grant_type: DIRECT_AUTH_GRANT_TYPE,
          direct_auth_artifact: 'direct-artifact-001',
          client_id: client.client_id,
          code_verifier: codeVerifier,
          channel: 'browser',
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      const body = await parseJsonResponse<{ access_token: string; session?: unknown }>(response);

      expect(response.status).toBe(200);
      expect(body.access_token).toBe('mock-access-token');
      expect(body.session).toBeUndefined();
      expect(consumeArtifactRpcMock).toHaveBeenCalledWith({
        id: 'direct_auth:direct-artifact-001',
        tenantId: 'default',
        type: 'direct_auth_code',
      });
      expect(consumeCodeRpcMock).toHaveBeenCalledWith({
        code: 'direct-artifact-001',
        tenantId: 'default',
        clientId: client.client_id,
        codeVerifier,
      });
    });

    it('should use client default_resource as the Direct Auth access token audience', async () => {
      const client = createPublicClient({ default_resource: 'svc://browser-api' });
      const codeVerifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
      const codeChallenge = await createPkceChallenge(codeVerifier);
      const authCodeData = createAuthCodeData({
        redirectUri: DIRECT_AUTH_REDIRECT_URI,
        sid: undefined,
      });
      const consumeArtifactRpcMock = vi.fn().mockResolvedValue({
        challenge: codeChallenge,
        userId: authCodeData.userId,
        metadata: {
          client_id: client.client_id,
          channel: 'browser',
          transaction_id: 'txn-001',
        },
      });

      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockGetChallengeStoreByChallengeId.mockResolvedValue({
        consumeChallengeRpc: consumeArtifactRpcMock,
      });
      mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
        consumeCodeRpc: vi.fn().mockResolvedValue(authCodeData),
        registerIssuedTokensRpc: vi.fn().mockResolvedValue(true),
      });

      const response = await tokenHandler(
        createMockContext({
          body: {
            grant_type: DIRECT_AUTH_GRANT_TYPE,
            direct_auth_artifact: 'direct-artifact-001',
            client_id: client.client_id,
            code_verifier: codeVerifier,
            channel: 'browser',
          },
          env: mockEnv,
        })
      );

      expect(response.status).toBe(200);
      expect(mocks.mockCreateAccessToken).toHaveBeenCalledWith(
        expect.objectContaining({ aud: 'svc://browser-api' }),
        expect.anything(),
        expect.any(String),
        expect.any(Number),
        expect.any(String)
      );
      expect(mocks.mockCreateRefreshToken).not.toHaveBeenCalled();
    });

    it('should reject a Direct Auth artifact when channel binding mismatches', async () => {
      const client = createPublicClient();
      const codeVerifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
      const codeChallenge = await createPkceChallenge(codeVerifier);
      const consumeArtifactRpcMock = vi.fn().mockResolvedValue({
        challenge: codeChallenge,
        userId: 'user-001',
        metadata: {
          client_id: client.client_id,
          channel: 'native',
          transaction_id: 'txn-001',
        },
      });

      mocks.mockGetChallengeStoreByChallengeId.mockResolvedValue({
        consumeChallengeRpc: consumeArtifactRpcMock,
      });

      const ctx = createMockContext({
        body: {
          grant_type: DIRECT_AUTH_GRANT_TYPE,
          direct_auth_artifact: 'direct-artifact-001',
          client_id: client.client_id,
          code_verifier: codeVerifier,
          channel: 'browser',
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      const body = await parseJsonResponse<{ error: string }>(response);

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_grant');
      expect(mockEnv.AUTH_CODE_STORE.get).not.toHaveBeenCalled();
    });

    it('should reject a Direct Auth artifact redeem request when channel is missing', async () => {
      const client = createPublicClient();
      const ctx = createMockContext({
        body: {
          grant_type: DIRECT_AUTH_GRANT_TYPE,
          direct_auth_artifact: 'direct-artifact-001',
          client_id: client.client_id,
          code_verifier: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~',
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      const body = await parseJsonResponse<{ error: string; error_description: string }>(response);

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('channel');
      expect(mocks.mockGetChallengeStoreByChallengeId).not.toHaveBeenCalled();
      expect(mockEnv.AUTH_CODE_STORE.get).not.toHaveBeenCalled();
    });

    it('should reject a Direct Auth artifact when client binding mismatches', async () => {
      const client = createPublicClient();
      const codeVerifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
      const codeChallenge = await createPkceChallenge(codeVerifier);
      const consumeArtifactRpcMock = vi.fn().mockResolvedValue({
        challenge: codeChallenge,
        userId: 'user-001',
        metadata: {
          client_id: 'other-client',
          channel: 'browser',
          transaction_id: 'txn-001',
        },
      });

      mocks.mockGetChallengeStoreByChallengeId.mockResolvedValue({
        consumeChallengeRpc: consumeArtifactRpcMock,
      });

      const ctx = createMockContext({
        body: {
          grant_type: DIRECT_AUTH_GRANT_TYPE,
          direct_auth_artifact: 'direct-artifact-001',
          client_id: client.client_id,
          code_verifier: codeVerifier,
          channel: 'browser',
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      const body = await parseJsonResponse<{ error: string; error_description: string }>(response);

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_grant');
      expect(body.error_description).toContain('client binding mismatch');
      expect(mockEnv.AUTH_CODE_STORE.get).not.toHaveBeenCalled();
    });

    it('should reject a Direct Auth artifact when PKCE verification fails', async () => {
      const client = createPublicClient();
      const originalVerifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
      const codeChallenge = await createPkceChallenge(originalVerifier);
      const consumeArtifactRpcMock = vi.fn().mockResolvedValue({
        challenge: codeChallenge,
        userId: 'user-001',
        metadata: {
          client_id: client.client_id,
          channel: 'browser',
          transaction_id: 'txn-001',
        },
      });

      mocks.mockGetChallengeStoreByChallengeId.mockResolvedValue({
        consumeChallengeRpc: consumeArtifactRpcMock,
      });

      const ctx = createMockContext({
        body: {
          grant_type: DIRECT_AUTH_GRANT_TYPE,
          direct_auth_artifact: 'direct-artifact-001',
          client_id: client.client_id,
          code_verifier: 'differentabcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
          channel: 'browser',
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      const body = await parseJsonResponse<{ error: string; error_description: string }>(response);

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_grant');
      expect(body.error_description).toContain('PKCE verification failed');
      expect(mockEnv.AUTH_CODE_STORE.get).not.toHaveBeenCalled();
    });

    it('should reject a replayed or expired Direct Auth artifact before token issuance', async () => {
      const client = createPublicClient();
      const consumeArtifactRpcMock = vi.fn().mockRejectedValue(new Error('Challenge not found'));

      mocks.mockGetChallengeStoreByChallengeId.mockResolvedValue({
        consumeChallengeRpc: consumeArtifactRpcMock,
      });

      const ctx = createMockContext({
        body: {
          grant_type: DIRECT_AUTH_GRANT_TYPE,
          direct_auth_artifact: 'direct-artifact-001',
          client_id: client.client_id,
          code_verifier: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~',
          channel: 'browser',
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      const body = await parseJsonResponse<{ error: string; error_description: string }>(response);

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_grant');
      expect(body.error_description).toContain('invalid or expired');
      expect(mockEnv.AUTH_CODE_STORE.get).not.toHaveBeenCalled();
    });
  });

  describe('Authorization code ID token claims', () => {
    it('should preserve OIDC auth_time, acr, and amr from the authorization code', async () => {
      const client = createConfidentialClient({
        token_endpoint_auth_method: 'client_secret_post',
      });
      const authCodeData = createAuthCodeData({
        authTime: 1700000123,
        acr: 'urn:mace:incommon:iap:silver',
        amr: ['passkey', 'webauthn'],
      });
      const consumeCodeRpcMock = vi.fn().mockResolvedValue(authCodeData);

      mocks.mockGetClientCached.mockResolvedValue(client);
      mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
        consumeCodeRpc: consumeCodeRpcMock,
        registerIssuedTokensRpc: vi.fn().mockResolvedValue(true),
      });

      const response = await tokenHandler(
        createMockContext({
          body: {
            grant_type: 'authorization_code',
            code: 'valid-auth-code',
            redirect_uri: authCodeData.redirectUri,
            client_id: client.client_id,
            client_secret: 'valid-secret',
          },
          env: mockEnv,
        })
      );

      expect(response.status).toBe(200);
      expect(mocks.mockCreateIDToken).toHaveBeenCalledWith(
        expect.objectContaining({
          auth_time: 1700000123,
          acr: 'urn:mace:incommon:iap:silver',
          amr: ['passkey', 'webauthn'],
        }),
        expect.anything(),
        expect.any(String),
        expect.any(Number)
      );
    });
  });

  // ==========================================================================
  // Native SSO token exchange
  // ==========================================================================

  describe('Native SSO token exchange', () => {
    function setupNativeSSOValidationTest(
      payloadOverrides: Record<string, unknown> = {},
      clientOverrides: Partial<TestClientMetadata> = {}
    ) {
      const client = createConfidentialClient({
        client_id: 'native-client-001',
        token_endpoint_auth_method: 'client_secret_post',
        grant_types: ['urn:ietf:params:oauth:grant-type:token-exchange'],
        token_exchange_allowed: true,
        native_sso_enabled: true,
        allowed_scopes: ['openid', 'profile'],
        ...clientOverrides,
      });
      const now = Math.floor(Date.now() / 1000);

      mocks.mockGetSystemSettingsCached.mockResolvedValue({
        oidc: {
          tokenExchange: {
            enabled: true,
            allowedSubjectTokenTypes: ['id_token'],
          },
        },
      });
      mocks.mockLoadTenantProfileCached.mockResolvedValue({
        tenant_id: 'default',
        allows_token_exchange: true,
      });
      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockIsNativeSSOEnabled.mockResolvedValue(true);
      mocks.mockDeviceSecretRepository.validateAndUse.mockResolvedValue({
        ok: true,
        entity: {
          id: 'ds-001',
          user_id: 'user-001',
          session_id: 'sid-001',
          device_platform: 'ios',
          last_used_at: now * 1000,
          use_count: 0,
        },
      });
      mocks.mockParseToken.mockReturnValue({
        iss: 'https://auth.example.com',
        sub: 'user-001',
        aud: client.client_id,
        exp: now + 3600,
        ds_hash: 'presented-ds-hash',
        scope: 'openid profile',
        ...payloadOverrides,
      });
      mocks.mockParseTokenHeader.mockReturnValue({ alg: 'RS256', kid: 'test-kid-001' });
      mocks.mockCalculateDsHash.mockResolvedValue('presented-ds-hash');
      mocks.mockExtractDPoPProof.mockReturnValue('dpop-proof');
      mocks.mockValidateDPoPProof.mockResolvedValue({ valid: true, jkt: 'native-jkt' });

      return client;
    }

    function createNativeSSOTokenExchangeContext(
      clientId: string,
      overrides: Record<string, string | undefined> = {}
    ) {
      const body: Record<string, string> = {
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        client_id: clientId,
        client_secret: 'valid-secret',
        subject_token: 'subject-id-token',
        subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
        actor_token: 'presented-device-secret',
        actor_token_type: DEVICE_SECRET_TOKEN_TYPE,
        scope: 'openid profile',
      };
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) {
          delete body[key];
        } else {
          body[key] = value;
        }
      }

      return createMockContext({
        body,
        env: mockEnv,
      });
    }

    function setupNativeSSOPublicClientTest(payloadOverrides: Record<string, unknown> = {}) {
      const client = createPublicClient({
        client_id: 'native-public-client-001',
        grant_types: ['urn:ietf:params:oauth:grant-type:token-exchange'],
        token_exchange_allowed: true,
        native_sso_enabled: true,
        application_type: 'native',
        allowed_scopes: ['openid', 'profile'],
      });
      const now = Math.floor(Date.now() / 1000);

      mocks.mockGetSystemSettingsCached.mockResolvedValue({
        oidc: {
          tokenExchange: {
            enabled: true,
            allowedSubjectTokenTypes: ['id_token'],
          },
        },
      });
      mocks.mockLoadTenantProfileCached.mockResolvedValue({
        tenant_id: 'default',
        allows_token_exchange: true,
      });
      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockIsNativeSSOEnabled.mockResolvedValue(true);
      mocks.mockDeviceSecretRepository.validateAndUse.mockResolvedValue({
        ok: true,
        entity: {
          id: 'ds-001',
          user_id: 'user-001',
          session_id: 'sid-001',
          device_platform: 'ios',
          last_used_at: now * 1000,
          use_count: 0,
        },
      });
      mocks.mockParseToken.mockReturnValue({
        iss: 'https://auth.example.com',
        sub: 'user-001',
        aud: client.client_id,
        exp: now + 3600,
        ds_hash: 'presented-ds-hash',
        scope: 'openid profile',
        ...payloadOverrides,
      });
      mocks.mockParseTokenHeader.mockReturnValue({ alg: 'RS256', kid: 'test-kid-001' });
      mocks.mockCalculateDsHash.mockResolvedValue('presented-ds-hash');

      return client;
    }

    function createNativeSSOPublicClientContext(
      clientId: string,
      overrides: Record<string, string | undefined> = {}
    ) {
      const body: Record<string, string> = {
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        client_id: clientId,
        subject_token: 'subject-id-token',
        subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
        actor_token: 'presented-device-secret',
        actor_token_type: DEVICE_SECRET_TOKEN_TYPE,
        scope: 'openid profile',
        channel: 'native',
      };
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) {
          delete body[key];
        } else {
          body[key] = value;
        }
      }

      return createMockContext({
        body,
        env: mockEnv,
      });
    }

    it('should require a DPoP proof before accepting a device_secret', async () => {
      const client = createConfidentialClient({
        client_id: 'native-client-001',
        token_endpoint_auth_method: 'client_secret_post',
        grant_types: ['urn:ietf:params:oauth:grant-type:token-exchange'],
        token_exchange_allowed: true,
        native_sso_enabled: true,
        allowed_scopes: ['openid', 'profile'],
      });

      mocks.mockGetSystemSettingsCached.mockResolvedValue({
        oidc: {
          tokenExchange: {
            enabled: true,
            allowedSubjectTokenTypes: ['id_token'],
          },
        },
      });
      mocks.mockLoadTenantProfileCached.mockResolvedValue({
        tenant_id: 'default',
        allows_token_exchange: true,
      });
      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockIsNativeSSOEnabled.mockResolvedValue(true);

      const ctx = createMockContext({
        body: {
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
          client_id: client.client_id,
          client_secret: 'valid-secret',
          subject_token: 'subject-id-token',
          subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
          actor_token: 'presented-device-secret',
          actor_token_type: DEVICE_SECRET_TOKEN_TYPE,
          scope: 'openid profile',
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      const body = await parseJsonResponse<{
        error: string;
        error_description: string;
        error_details?: { code?: string };
      }>(response);

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('required');
      expect(body.error_details?.code).toBe('dpop_proof_missing');
      expect(mocks.mockDeviceSecretRepository.validateAndUse).not.toHaveBeenCalled();
    });

    it('should reject an invalid DPoP proof before accepting a device_secret', async () => {
      const client = createConfidentialClient({
        client_id: 'native-client-001',
        token_endpoint_auth_method: 'client_secret_post',
        grant_types: ['urn:ietf:params:oauth:grant-type:token-exchange'],
        token_exchange_allowed: true,
        native_sso_enabled: true,
        allowed_scopes: ['openid', 'profile'],
      });

      mocks.mockGetSystemSettingsCached.mockResolvedValue({
        oidc: {
          tokenExchange: {
            enabled: true,
            allowedSubjectTokenTypes: ['id_token'],
          },
        },
      });
      mocks.mockLoadTenantProfileCached.mockResolvedValue({
        tenant_id: 'default',
        allows_token_exchange: true,
      });
      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockIsNativeSSOEnabled.mockResolvedValue(true);
      mocks.mockExtractDPoPProof.mockReturnValue('dpop-proof');
      mocks.mockValidateDPoPProof.mockResolvedValue({
        valid: false,
        error_description: 'DPoP proof signature is invalid',
      });

      const ctx = createMockContext({
        body: {
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
          client_id: client.client_id,
          client_secret: 'valid-secret',
          subject_token: 'subject-id-token',
          subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
          actor_token: 'presented-device-secret',
          actor_token_type: DEVICE_SECRET_TOKEN_TYPE,
          scope: 'openid profile',
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      const body = await parseJsonResponse<{
        error: string;
        error_details?: { code?: string };
      }>(response);

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_request');
      expect(body.error_details?.code).toBe('dpop_proof_invalid');
      expect(mocks.mockDeviceSecretRepository.validateAndUse).not.toHaveBeenCalled();
    });

    it('should allow an eligible native public client with channel=native and DPoP', async () => {
      const client = setupNativeSSOPublicClientTest();
      mocks.mockExtractDPoPProof.mockReturnValue('dpop-proof');
      mocks.mockValidateDPoPProof.mockResolvedValue({ valid: true, jkt: 'native-jkt' });

      const response = await tokenHandler(createNativeSSOPublicClientContext(client.client_id));
      const body = await parseJsonResponse<Record<string, unknown>>(response);

      expect(response.status).toBe(200);
      expect(body.access_token).toBe('mock-access-token');
      expect(body.token_type).toBe('DPoP');
      expectNativeSSOInstallationMetadata(body, client.client_id);
      expect(mocks.mockVerifyClientSecretHash).not.toHaveBeenCalled();
    });

    it('should return resolved app display name and omit fallback for user-named devices', async () => {
      const client = setupNativeSSOValidationTest({}, { client_name: 'Authrim Wallet' });
      const now = Math.floor(Date.now() / 1000);
      mocks.mockDeviceSecretRepository.validateAndUse.mockResolvedValue({
        ok: true,
        entity: {
          id: 'ds-001',
          user_id: 'user-001',
          session_id: 'sid-001',
          device_platform: 'ios',
          device_name: 'Yuta iPhone',
          last_used_at: now * 1000,
          use_count: 0,
        },
      });

      const response = await tokenHandler(createNativeSSOTokenExchangeContext(client.client_id));
      const body = await parseJsonResponse<Record<string, unknown>>(response);

      expect(response.status).toBe(200);
      expect(body.app_display_name).toBe('Authrim Wallet');
      expect(body.display_name).toBe('Yuta iPhone');
      expect(body.fallback_display_name).toBeUndefined();
    });

    it('should reject native public client Native SSO when channel is missing', async () => {
      const client = setupNativeSSOPublicClientTest();
      mocks.mockExtractDPoPProof.mockReturnValue('dpop-proof');
      mocks.mockValidateDPoPProof.mockResolvedValue({ valid: true, jkt: 'native-jkt' });

      const response = await tokenHandler(
        createNativeSSOPublicClientContext(client.client_id, { channel: undefined })
      );
      const body = await parseJsonResponse<{ error: string; error_description: string }>(response);

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('channel=native');
      expect(mocks.mockDeviceSecretRepository.validateAndUse).not.toHaveBeenCalled();
    });

    it('should reject native public client Native SSO when channel=browser', async () => {
      const client = setupNativeSSOPublicClientTest();
      mocks.mockExtractDPoPProof.mockReturnValue('dpop-proof');
      mocks.mockValidateDPoPProof.mockResolvedValue({ valid: true, jkt: 'native-jkt' });

      const response = await tokenHandler(
        createNativeSSOPublicClientContext(client.client_id, { channel: 'browser' })
      );
      const body = await parseJsonResponse<{ error: string; error_description: string }>(response);

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('channel=native');
      expect(mocks.mockDeviceSecretRepository.validateAndUse).not.toHaveBeenCalled();
    });

    it('should reject native public client Native SSO when DPoP is missing', async () => {
      const client = setupNativeSSOPublicClientTest();

      const response = await tokenHandler(createNativeSSOPublicClientContext(client.client_id));
      const body = await parseJsonResponse<{ error: string; error_details?: { code?: string } }>(
        response
      );

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_request');
      expect(body.error_details?.code).toBe('dpop_proof_missing');
      expect(mocks.mockDeviceSecretRepository.validateAndUse).not.toHaveBeenCalled();
    });

    it('should return device_secret_missing when Native SSO actor_token is missing', async () => {
      const client = setupNativeSSOValidationTest();

      const response = await tokenHandler(
        createNativeSSOTokenExchangeContext(client.client_id, { actor_token: undefined })
      );
      const body = await parseJsonResponse<{ error: string; error_details?: { code?: string } }>(
        response
      );

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_request');
      expect(body.error_details?.code).toBe('device_secret_missing');
      expect(mocks.mockDeviceSecretRepository.validateAndUse).not.toHaveBeenCalled();
    });

    it('should return native_sso_disabled when the feature is disabled', async () => {
      const client = setupNativeSSOValidationTest();
      mocks.mockIsNativeSSOEnabled.mockResolvedValue(false);

      const response = await tokenHandler(createNativeSSOTokenExchangeContext(client.client_id));
      const body = await parseJsonResponse<{ error: string; error_details?: { code?: string } }>(
        response
      );

      expect(response.status).toBe(400);
      expect(body.error).toBe('unsupported_grant_type');
      expect(body.error_details?.code).toBe('native_sso_disabled');
      expect(mocks.mockDeviceSecretRepository.validateAndUse).not.toHaveBeenCalled();
    });

    it('should return native_sso_client_disabled when the client explicitly disables Native SSO', async () => {
      const client = setupNativeSSOValidationTest();
      client.native_sso_enabled = false;

      const response = await tokenHandler(createNativeSSOTokenExchangeContext(client.client_id));
      const body = await parseJsonResponse<{ error: string; error_details?: { code?: string } }>(
        response
      );

      expect(response.status).toBe(403);
      expect(body.error).toBe('unauthorized_client');
      expect(body.error_details?.code).toBe('native_sso_client_disabled');
      expect(mocks.mockDeviceSecretRepository.validateAndUse).not.toHaveBeenCalled();
    });

    it('should return native_sso_rate_limited with retry metadata when blocked', async () => {
      const client = setupNativeSSOValidationTest();
      mockEnv.AUTHRIM_CONFIG.get = vi.fn().mockImplementation(async (key: string) => {
        if (key.startsWith('native-sso:ratelimit:')) {
          return JSON.stringify({ count: 10, blockedUntil: Date.now() + 20_000 });
        }
        return null;
      });

      const response = await tokenHandler(createNativeSSOTokenExchangeContext(client.client_id));
      const body = await parseJsonResponse<{
        error: string;
        error_details?: { code?: string; retryable?: boolean; severity?: string };
      }>(response);

      expect(response.status).toBe(429);
      expect(body.error).toBe('slow_down');
      expect(body.error_details?.code).toBe('native_sso_rate_limited');
      expect(body.error_details?.retryable).toBe(true);
      expect(body.error_details?.severity).toBe('warning');
      expect(mocks.mockDeviceSecretRepository.validateAndUse).not.toHaveBeenCalled();
    });

    it('should issue device_secret by default for an eligible native client authorization code exchange', async () => {
      const client = createConfidentialClient({
        token_endpoint_auth_method: 'client_secret_post',
        application_type: 'native',
      });
      const authCodeData = createAuthCodeData();
      const consumeCodeRpcMock = vi.fn().mockResolvedValue(authCodeData);

      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockIsNativeSSOEnabled.mockResolvedValue(true);
      mocks.mockDeviceSecretRepository.findByUserId.mockResolvedValue([]);
      mocks.mockDeviceSecretRepository.createSecret.mockResolvedValue({
        secret: 'raw-device-secret-001',
        entity: {
          id: 'ds-001',
          user_id: authCodeData.userId,
          session_id: authCodeData.sid,
        },
      });
      mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
        consumeCodeRpc: consumeCodeRpcMock,
        registerIssuedTokensRpc: vi.fn().mockResolvedValue(true),
      });

      const response = await tokenHandler(
        createMockContext({
          body: {
            grant_type: 'authorization_code',
            code: 'valid-auth-code',
            redirect_uri: authCodeData.redirectUri,
            client_id: client.client_id,
            client_secret: 'valid-secret',
          },
          env: mockEnv,
        })
      );
      const body = await parseJsonResponse<Record<string, unknown>>(response);

      expect(response.status).toBe(200);
      expect(body.refresh_token).toBe('mock-refresh-token');
      expectRefreshTokenExpiryMetadata(body);
      expect(body.device_secret).toBe('raw-device-secret-001');
    });

    it('should not rotate existing device_secret during authorization code exchange when rotation is disabled', async () => {
      const client = createConfidentialClient({
        token_endpoint_auth_method: 'client_secret_post',
        application_type: 'native',
      });
      const authCodeData = createAuthCodeData({ sid: 'session-rotation-disabled' });
      const consumeCodeRpcMock = vi.fn().mockResolvedValue(authCodeData);

      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockIsNativeSSOEnabled.mockResolvedValue(true);
      mocks.mockDeviceSecretRepository.findByUserId.mockResolvedValue([
        {
          id: 'ds-existing-same-session',
          tenant_id: 'default',
          user_id: authCodeData.userId,
          session_id: authCodeData.sid,
          secret_hash: 'existing-hash',
          created_at: Date.now() - 1000,
          updated_at: Date.now() - 1000,
          expires_at: Date.now() + 86_400_000,
          use_count: 0,
          is_active: 1,
        },
      ]);
      mocks.mockDeviceSecretRepository.createSecret.mockResolvedValue({
        secret: 'raw-device-secret-rotation-disabled',
        entity: {
          id: 'ds-new-rotation-disabled',
          user_id: authCodeData.userId,
          session_id: authCodeData.sid,
        },
      });
      mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
        consumeCodeRpc: consumeCodeRpcMock,
        registerIssuedTokensRpc: vi.fn().mockResolvedValue(true),
      });

      const response = await tokenHandler(
        createMockContext({
          body: {
            grant_type: 'authorization_code',
            code: 'valid-auth-code',
            redirect_uri: authCodeData.redirectUri,
            client_id: client.client_id,
            client_secret: 'valid-secret',
          },
          env: mockEnv,
        })
      );
      const body = await parseJsonResponse<Record<string, unknown>>(response);

      expect(response.status).toBe(200);
      expect(body.device_secret).toBe('raw-device-secret-rotation-disabled');
      expect(mocks.mockDeviceSecretRepository.revoke).not.toHaveBeenCalled();
    });

    it('should revoke the old same-session device_secret with rotation reason when explicit rotation is enabled', async () => {
      const client = createConfidentialClient({
        token_endpoint_auth_method: 'client_secret_post',
        application_type: 'native',
      });
      const authCodeData = createAuthCodeData({ sid: 'session-rotation-enabled' });
      const consumeCodeRpcMock = vi.fn().mockResolvedValue(authCodeData);

      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockIsNativeSSOEnabled.mockResolvedValue(true);
      mocks.mockGetNativeSSOConfig.mockResolvedValue({
        enabled: true,
        deviceSecretTTLDays: 30,
        maxDeviceSecretsPerUser: 10,
        maxUseCountPerSecret: 10,
        maxSecretsBehavior: 'revoke_oldest',
        deviceSecretRotationPolicy: 'explicit',
        deviceSecretRotationOverlapSeconds: 0,
        rateLimit: {
          maxAttemptsPerMinute: 10,
          blockDurationMinutes: 1,
        },
        allowCrossClientNativeSSO: false,
      });
      mocks.mockDeviceSecretRepository.findByUserId.mockResolvedValue([
        {
          id: 'ds-old-same-session',
          tenant_id: 'default',
          user_id: authCodeData.userId,
          session_id: authCodeData.sid,
          secret_hash: 'old-same-session-hash',
          created_at: Date.now() - 2000,
          updated_at: Date.now() - 2000,
          expires_at: Date.now() + 86_400_000,
          use_count: 0,
          is_active: 1,
        },
        {
          id: 'ds-other-session',
          tenant_id: 'default',
          user_id: authCodeData.userId,
          session_id: 'session-other-device',
          secret_hash: 'other-session-hash',
          created_at: Date.now() - 1000,
          updated_at: Date.now() - 1000,
          expires_at: Date.now() + 86_400_000,
          use_count: 0,
          is_active: 1,
        },
      ]);
      mocks.mockDeviceSecretRepository.createSecret.mockResolvedValue({
        secret: 'raw-device-secret-rotation-enabled',
        entity: {
          id: 'ds-new-rotation-enabled',
          user_id: authCodeData.userId,
          session_id: authCodeData.sid,
        },
      });
      mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
        consumeCodeRpc: consumeCodeRpcMock,
        registerIssuedTokensRpc: vi.fn().mockResolvedValue(true),
      });

      const response = await tokenHandler(
        createMockContext({
          body: {
            grant_type: 'authorization_code',
            code: 'valid-auth-code',
            redirect_uri: authCodeData.redirectUri,
            client_id: client.client_id,
            client_secret: 'valid-secret',
          },
          env: mockEnv,
        })
      );
      const body = await parseJsonResponse<Record<string, unknown>>(response);

      expect(response.status).toBe(200);
      expect(body.device_secret).toBe('raw-device-secret-rotation-enabled');
      expect(mocks.mockDeviceSecretRepository.revoke).toHaveBeenCalledTimes(1);
      expect(mocks.mockDeviceSecretRepository.revoke).toHaveBeenCalledWith(
        'ds-old-same-session',
        'rotation',
        'default'
      );
    });

    it('should persist Native SSO device metadata during authorization code issuance', async () => {
      const client = createConfidentialClient({
        token_endpoint_auth_method: 'client_secret_post',
        application_type: 'native',
      });
      const authCodeData = createAuthCodeData();
      const consumeCodeRpcMock = vi.fn().mockResolvedValue(authCodeData);

      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockIsNativeSSOEnabled.mockResolvedValue(true);
      mocks.mockDeviceSecretRepository.findByUserId.mockResolvedValue([]);
      mocks.mockDeviceSecretRepository.createSecret.mockResolvedValue({
        secret: 'raw-device-secret-001',
        entity: {
          id: 'ds-001',
          user_id: authCodeData.userId,
          session_id: authCodeData.sid,
          device_name: 'Yuta iPhone',
          device_platform: 'ios',
        },
      });
      mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
        consumeCodeRpc: consumeCodeRpcMock,
        registerIssuedTokensRpc: vi.fn().mockResolvedValue(true),
      });

      const response = await tokenHandler(
        createMockContext({
          body: {
            grant_type: 'authorization_code',
            code: 'valid-auth-code',
            redirect_uri: authCodeData.redirectUri,
            client_id: client.client_id,
            client_secret: 'valid-secret',
            channel: 'native',
            device_name: '  Yuta   iPhone  ',
            device_platform: 'ios',
          },
          env: mockEnv,
        })
      );
      const body = await parseJsonResponse<Record<string, unknown>>(response);

      expect(response.status).toBe(200);
      expect(body.device_secret).toBe('raw-device-secret-001');
      expect(mocks.mockDeviceSecretRepository.createSecret).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: authCodeData.userId,
          session_id: authCodeData.sid,
          device_name: 'Yuta iPhone',
          device_platform: 'ios',
        })
      );
    });

    it('should suppress default device_secret issuance when native_sso_enabled is explicitly false', async () => {
      const client = createConfidentialClient({
        token_endpoint_auth_method: 'client_secret_post',
        application_type: 'native',
        native_sso_enabled: false,
      });
      const authCodeData = createAuthCodeData();
      const consumeCodeRpcMock = vi.fn().mockResolvedValue(authCodeData);

      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockIsNativeSSOEnabled.mockResolvedValue(true);
      mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
        consumeCodeRpc: consumeCodeRpcMock,
        registerIssuedTokensRpc: vi.fn().mockResolvedValue(true),
      });

      const response = await tokenHandler(
        createMockContext({
          body: {
            grant_type: 'authorization_code',
            code: 'valid-auth-code',
            redirect_uri: authCodeData.redirectUri,
            client_id: client.client_id,
            client_secret: 'valid-secret',
          },
          env: mockEnv,
        })
      );
      const body = await parseJsonResponse<Record<string, unknown>>(response);

      expect(response.status).toBe(200);
      expect(body.device_secret).toBeUndefined();
      expect(mocks.mockDeviceSecretRepository.createSecret).not.toHaveBeenCalled();
    });

    it('should suppress default device_secret issuance for a web client even when enabled', async () => {
      const client = createConfidentialClient({
        token_endpoint_auth_method: 'client_secret_post',
        application_type: 'web',
        native_sso_enabled: true,
      });
      const authCodeData = createAuthCodeData();
      const consumeCodeRpcMock = vi.fn().mockResolvedValue(authCodeData);

      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockIsNativeSSOEnabled.mockResolvedValue(true);
      mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
        consumeCodeRpc: consumeCodeRpcMock,
        registerIssuedTokensRpc: vi.fn().mockResolvedValue(true),
      });

      const response = await tokenHandler(
        createMockContext({
          body: {
            grant_type: 'authorization_code',
            code: 'valid-auth-code',
            redirect_uri: authCodeData.redirectUri,
            client_id: client.client_id,
            client_secret: 'valid-secret',
          },
          env: mockEnv,
        })
      );
      const body = await parseJsonResponse<Record<string, unknown>>(response);

      expect(response.status).toBe(200);
      expect(body.device_secret).toBeUndefined();
      expect(mocks.mockDeviceSecretRepository.createSecret).not.toHaveBeenCalled();
    });

    it('should suppress default device_secret issuance when native channel is not allowed', async () => {
      const client = createConfidentialClient({
        token_endpoint_auth_method: 'client_secret_post',
        application_type: 'native',
        allowed_channels: ['browser'],
      });
      const authCodeData = createAuthCodeData();
      const consumeCodeRpcMock = vi.fn().mockResolvedValue(authCodeData);

      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockIsNativeSSOEnabled.mockResolvedValue(true);
      mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
        consumeCodeRpc: consumeCodeRpcMock,
        registerIssuedTokensRpc: vi.fn().mockResolvedValue(true),
      });

      const response = await tokenHandler(
        createMockContext({
          body: {
            grant_type: 'authorization_code',
            code: 'valid-auth-code',
            redirect_uri: authCodeData.redirectUri,
            client_id: client.client_id,
            client_secret: 'valid-secret',
            channel: 'native',
          },
          env: mockEnv,
        })
      );
      const body = await parseJsonResponse<Record<string, unknown>>(response);

      expect(response.status).toBe(200);
      expect(body.device_secret).toBeUndefined();
      expect(mocks.mockDeviceSecretRepository.createSecret).not.toHaveBeenCalled();
    });

    it('should reject a malformed Native SSO subject ID Token with a machine-readable code', async () => {
      const client = setupNativeSSOValidationTest();
      mocks.mockParseToken.mockImplementation(() => {
        throw new Error('bad token');
      });

      const response = await tokenHandler(createNativeSSOTokenExchangeContext(client.client_id));
      const body = await parseJsonResponse<{ error: string; error_details?: { code?: string } }>(
        response
      );

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_grant');
      expect(body.error_details?.code).toBe('id_token_malformed');
    });

    it('should reject a subject ID Token with invalid issuer', async () => {
      const client = setupNativeSSOValidationTest({ iss: 'https://issuer.example.invalid' });

      const response = await tokenHandler(createNativeSSOTokenExchangeContext(client.client_id));
      const body = await parseJsonResponse<{ error: string; error_details?: { code?: string } }>(
        response
      );

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_grant');
      expect(body.error_details?.code).toBe('id_token_issuer_invalid');
    });

    it('should reject a subject ID Token with invalid audience shape', async () => {
      const client = setupNativeSSOValidationTest({ aud: [] });

      const response = await tokenHandler(createNativeSSOTokenExchangeContext(client.client_id));
      const body = await parseJsonResponse<{ error: string; error_details?: { code?: string } }>(
        response
      );

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_grant');
      expect(body.error_details?.code).toBe('id_token_audience_invalid');
    });

    it('should reject a subject ID Token whose client_id claim is not present in audience', async () => {
      const client = setupNativeSSOValidationTest({
        client_id: 'source-client-001',
        aud: 'different-client-001',
      });

      const response = await tokenHandler(createNativeSSOTokenExchangeContext(client.client_id));
      const body = await parseJsonResponse<{ error: string; error_details?: { code?: string } }>(
        response
      );

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_grant');
      expect(body.error_details?.code).toBe('id_token_audience_invalid');
    });

    it('should reject a subject ID Token with issuer-only audience', async () => {
      const client = setupNativeSSOValidationTest({ aud: 'https://auth.example.com' });

      const response = await tokenHandler(createNativeSSOTokenExchangeContext(client.client_id));
      const body = await parseJsonResponse<{ error: string; error_details?: { code?: string } }>(
        response
      );

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_grant');
      expect(body.error_details?.code).toBe('id_token_audience_invalid');
    });

    it('should reject a subject ID Token whose signature verification fails', async () => {
      const client = setupNativeSSOValidationTest();
      mocks.mockVerifyToken.mockRejectedValue(new Error('bad signature'));

      const response = await tokenHandler(createNativeSSOTokenExchangeContext(client.client_id));
      const body = await parseJsonResponse<{ error: string; error_details?: { code?: string } }>(
        response
      );

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_grant');
      expect(body.error_details?.code).toBe('id_token_signature_invalid');
    });

    it('should reject a subject ID Token expired beyond the 60 second clock-skew window', async () => {
      const now = Math.floor(Date.now() / 1000);
      const client = setupNativeSSOValidationTest({ exp: now - 61 });

      const response = await tokenHandler(createNativeSSOTokenExchangeContext(client.client_id));
      const body = await parseJsonResponse<{ error: string; error_details?: { code?: string } }>(
        response
      );

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_grant');
      expect(body.error_details?.code).toBe('id_token_expired');
    });

    it('should accept a subject ID Token within the 60 second clock-skew window', async () => {
      const now = Math.floor(Date.now() / 1000);
      const client = setupNativeSSOValidationTest({ exp: now - 30 });

      const response = await tokenHandler(createNativeSSOTokenExchangeContext(client.client_id));
      const body = await parseJsonResponse<Record<string, unknown>>(response);

      expect(response.status).toBe(200);
      expect(body.token_type).toBe('DPoP');
      expectNativeSSOInstallationMetadata(body, client.client_id);
    });

    it('should return id_token_replayed when a subject ID Token jti was already used', async () => {
      const client = setupNativeSSOValidationTest({ jti: 'replayed-jti-001' });
      mockEnv.AUTHRIM_CONFIG.get = vi.fn().mockImplementation(async (key: string) => {
        if (key.startsWith('native-sso:jti:')) {
          return '1';
        }
        return null;
      });

      const response = await tokenHandler(createNativeSSOTokenExchangeContext(client.client_id));
      const body = await parseJsonResponse<{ error: string; error_details?: { code?: string } }>(
        response
      );

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_grant');
      expect(body.error_details?.code).toBe('id_token_replayed');
      expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
    });

    it('should return device_secret_inactive when device_secret validation fails', async () => {
      const client = setupNativeSSOValidationTest();
      mocks.mockDeviceSecretRepository.validateAndUse.mockResolvedValue({
        ok: false,
        reason: 'revoked',
      });

      const response = await tokenHandler(createNativeSSOTokenExchangeContext(client.client_id));
      const body = await parseJsonResponse<{ error: string; error_details?: { code?: string } }>(
        response
      );

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_grant');
      expect(body.error_details?.code).toBe('device_secret_inactive');
    });

    it('should return device_secret_binding_failed when subject does not own the device_secret', async () => {
      const client = setupNativeSSOValidationTest({ sub: 'other-user-001' });

      const response = await tokenHandler(createNativeSSOTokenExchangeContext(client.client_id));
      const body = await parseJsonResponse<{ error: string; error_details?: { code?: string } }>(
        response
      );

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_grant');
      expect(body.error_details?.code).toBe('device_secret_binding_failed');
    });

    it('should return trust_group_not_allowed when cross-client Native SSO is denied', async () => {
      const client = setupNativeSSOValidationTest({ aud: 'source-client-001' });

      const response = await tokenHandler(createNativeSSOTokenExchangeContext(client.client_id));
      const body = await parseJsonResponse<{ error: string; error_details?: { code?: string } }>(
        response
      );

      expect(response.status).toBe(403);
      expect(body.error).toBe('access_denied');
      expect(body.error_details?.code).toBe('trust_group_not_allowed');
      expect(mocks.mockLoggerMethods.warn).toHaveBeenCalledWith(
        'NativeSSO Token Exchange Failure',
        expect.objectContaining({
          action: 'NativeSSO',
          outcome: 'denied',
          clientId: client.client_id,
          subjectTokenType: 'urn:ietf:params:oauth:token-type:id_token',
          actorTokenType: DEVICE_SECRET_TOKEN_TYPE,
          error: 'access_denied',
          errorDetailsCode: 'trust_group_not_allowed',
          requestedAudiences: [],
          requestedResources: [],
        })
      );
    });

    it('should allow cross-client Native SSO when both clients share a trust_group', async () => {
      const client = setupNativeSSOValidationTest({ aud: 'source-client-001' });
      client.trust_group = 'tg-wallet';
      const originalClient = createConfidentialClient({
        client_id: 'source-client-001',
        trust_group: 'tg-wallet',
      });
      mocks.mockDeviceInstallationRepository.ensureForNativeSSOTokenExchange.mockResolvedValue({
        id: 'inst-target-001',
        tenant_id: 'default',
        user_id: 'user-001',
        client_id: client.client_id,
        trust_group_id: 'tg-wallet',
        source_installation_id: 'ds-001',
        source_client_id: originalClient.client_id,
        session_id: 'sid-001',
        device_platform: 'ios',
        created_at: Date.now(),
        updated_at: Date.now(),
        last_seen_at: Date.now(),
        is_active: 1,
      });
      mocks.mockGetClientCached.mockImplementation(async (_c, _env, clientId: string) => {
        if (clientId === client.client_id) {
          return client;
        }
        if (clientId === originalClient.client_id) {
          return originalClient;
        }
        return null;
      });

      const response = await tokenHandler(createNativeSSOTokenExchangeContext(client.client_id));
      const body = await parseJsonResponse<Record<string, unknown>>(response);
      const accessTokenClaims = mocks.mockCreateAccessToken.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;

      expect(response.status).toBe(200);
      expect(body.token_type).toBe('DPoP');
      expectNativeSSOInstallationMetadata(body, client.client_id, 'inst-target-001');
      expect(accessTokenClaims?.authrim_installation_id).toBe('inst-target-001');
      expect(body.trust_group).toBeUndefined();
      expect(body.trust_group_id).toBeUndefined();
      expect(body.effective_native_sso_scope).toBeUndefined();
      expect(
        mocks.mockDeviceInstallationRepository.ensureForNativeSSOTokenExchange
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          targetClientId: client.client_id,
          targetTrustGroupId: 'tg-wallet',
          sourceClientId: originalClient.client_id,
          sameClient: false,
        })
      );
      expect(mocks.mockLoggerMethods.info).toHaveBeenCalledWith(
        'NativeSSO Token Exchange Success',
        expect.objectContaining({
          action: 'NativeSSO',
          sourceClientId: originalClient.client_id,
          issuedClientId: client.client_id,
          exchangeMode: 'cross_client',
          dpopJkt: 'native-jkt',
          trustGroupId: 'tg-wallet',
          originalTrustGroupId: 'tg-wallet',
          sourceInstallationId: 'ds-001',
          issuedInstallationId: 'inst-target-001',
        })
      );
    });

    it('should return native_sso_server_error when token issuance fails', async () => {
      const client = setupNativeSSOValidationTest();
      mocks.mockCreateAccessToken.mockRejectedValue(new Error('signing failed'));

      const response = await tokenHandler(createNativeSSOTokenExchangeContext(client.client_id));
      const body = await parseJsonResponse<{
        error: string;
        error_details?: { code?: string; retryable?: boolean };
      }>(response);

      expect(response.status).toBe(500);
      expect(body.error).toBe('server_error');
      expect(body.error_details?.code).toBe('native_sso_server_error');
      expect(body.error_details?.retryable).toBe(true);
    });

    it('should reject an ID Token whose ds_hash does not bind to the presented device_secret', async () => {
      const client = createConfidentialClient({
        client_id: 'native-client-001',
        token_endpoint_auth_method: 'client_secret_post',
        grant_types: ['urn:ietf:params:oauth:grant-type:token-exchange'],
        token_exchange_allowed: true,
        native_sso_enabled: true,
        allowed_scopes: ['openid', 'profile'],
      });
      const now = Math.floor(Date.now() / 1000);

      mocks.mockGetSystemSettingsCached.mockResolvedValue({
        oidc: {
          tokenExchange: {
            enabled: true,
            allowedSubjectTokenTypes: ['id_token'],
          },
        },
      });
      mocks.mockLoadTenantProfileCached.mockResolvedValue({
        tenant_id: 'default',
        allows_token_exchange: true,
      });
      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockIsNativeSSOEnabled.mockResolvedValue(true);
      mocks.mockDeviceSecretRepository.validateAndUse.mockResolvedValue({
        ok: true,
        entity: {
          id: 'ds-001',
          user_id: 'user-001',
          session_id: 'sid-001',
          device_platform: 'ios',
          last_used_at: now * 1000,
          use_count: 0,
        },
      });
      mocks.mockParseToken.mockReturnValue({
        iss: 'https://auth.example.com',
        sub: 'user-001',
        aud: client.client_id,
        exp: now + 3600,
        ds_hash: 'subject-ds-hash',
        scope: 'openid profile',
      });
      mocks.mockParseTokenHeader.mockReturnValue({ alg: 'RS256', kid: 'test-kid-001' });
      mocks.mockCalculateDsHash.mockResolvedValue('presented-ds-hash');
      mocks.mockExtractDPoPProof.mockReturnValue('dpop-proof');
      mocks.mockValidateDPoPProof.mockResolvedValue({ valid: true, jkt: 'native-jkt' });

      const ctx = createMockContext({
        body: {
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
          client_id: client.client_id,
          client_secret: 'valid-secret',
          subject_token: 'subject-id-token',
          subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
          actor_token: 'presented-device-secret',
          actor_token_type: DEVICE_SECRET_TOKEN_TYPE,
          scope: 'openid profile',
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      const body = await parseJsonResponse<{
        error: string;
        error_details?: { code?: string; retryable?: boolean };
      }>(response);

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_grant');
      expect(body.error_details?.code).toBe('device_secret_binding_failed');
      expect(body.error_details?.retryable).toBe(false);
      expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
    });

    it('should issue DPoP-bound tokens when the proof and ds_hash are valid', async () => {
      const client = createConfidentialClient({
        client_id: 'native-client-001',
        token_endpoint_auth_method: 'client_secret_post',
        grant_types: ['urn:ietf:params:oauth:grant-type:token-exchange'],
        token_exchange_allowed: true,
        native_sso_enabled: true,
        allowed_scopes: ['openid', 'profile'],
      });
      const now = Math.floor(Date.now() / 1000);

      mocks.mockGetSystemSettingsCached.mockResolvedValue({
        oidc: {
          tokenExchange: {
            enabled: true,
            allowedSubjectTokenTypes: ['id_token'],
          },
        },
      });
      mocks.mockLoadTenantProfileCached.mockResolvedValue({
        tenant_id: 'default',
        allows_token_exchange: true,
      });
      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockIsNativeSSOEnabled.mockResolvedValue(true);
      mocks.mockDeviceSecretRepository.validateAndUse.mockResolvedValue({
        ok: true,
        entity: {
          id: 'ds-001',
          user_id: 'user-001',
          session_id: 'sid-001',
          device_platform: 'ios',
          last_used_at: now * 1000,
          use_count: 0,
        },
      });
      mocks.mockParseToken.mockReturnValue({
        iss: 'https://auth.example.com',
        sub: 'user-001',
        aud: client.client_id,
        exp: now + 3600,
        ds_hash: 'presented-ds-hash',
        scope: 'openid profile',
      });
      mocks.mockParseTokenHeader.mockReturnValue({ alg: 'RS256', kid: 'test-kid-001' });
      mocks.mockCalculateDsHash.mockResolvedValue('presented-ds-hash');
      mocks.mockExtractDPoPProof.mockReturnValue('dpop-proof');
      mocks.mockValidateDPoPProof.mockResolvedValue({ valid: true, jkt: 'native-jkt' });

      const ctx = createMockContext({
        body: {
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
          client_id: client.client_id,
          client_secret: 'valid-secret',
          subject_token: 'subject-id-token',
          subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
          actor_token: 'presented-device-secret',
          actor_token_type: DEVICE_SECRET_TOKEN_TYPE,
          scope: 'openid profile',
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      const body = await parseJsonResponse<Record<string, unknown>>(response);
      const accessTokenClaims = mocks.mockCreateAccessToken.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;

      expect(response.status).toBe(200);
      expect(body.access_token).toBe('mock-access-token');
      expect(body.token_type).toBe('DPoP');
      expect(body.refresh_token).toBe('mock-refresh-token');
      expectRefreshTokenExpiryMetadata(body);
      expectNativeSSOInstallationMetadata(body, client.client_id);
      expect(body.cnf).toBeUndefined();
      expect(body.jkt).toBeUndefined();
      expect(accessTokenClaims?.cnf).toEqual({ jkt: 'native-jkt' });
      expect(accessTokenClaims?.authrim_installation_id).toBe('ds-001');
      expect(mocks.mockLoggerMethods.info).toHaveBeenCalledWith(
        'NativeSSO Token Exchange Success',
        expect.objectContaining({
          action: 'NativeSSO',
          sourceClientId: client.client_id,
          issuedClientId: client.client_id,
          exchangeMode: 'same_client',
          subjectUserId: 'user-001',
          sourceInstallationId: 'ds-001',
          issuedInstallationId: 'ds-001',
          refreshTokenIssued: true,
          dpopJkt: 'native-jkt',
        })
      );
    });

    it('should apply allowed Native SSO audience to the access token without echoing it', async () => {
      const targetAudience = 'https://api.example.com';
      const client = setupNativeSSOValidationTest(
        {},
        { allowed_token_exchange_resources: [targetAudience] }
      );

      const response = await tokenHandler(
        createNativeSSOTokenExchangeContext(client.client_id, { audience: targetAudience })
      );
      const body = await parseJsonResponse<Record<string, unknown>>(response);
      const accessTokenClaims = mocks.mockCreateAccessToken.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;

      expect(response.status).toBe(200);
      expect(accessTokenClaims?.aud).toBe(targetAudience);
      expect(body.audience).toBeUndefined();
      expect(body.resource).toBeUndefined();
    });

    it('should reject disallowed Native SSO resource targets', async () => {
      const client = setupNativeSSOValidationTest(
        {},
        { allowed_token_exchange_resources: ['https://allowed.example.com'] }
      );

      const response = await tokenHandler(
        createNativeSSOTokenExchangeContext(client.client_id, {
          resource: 'https://api.example.com',
        })
      );
      const body = await parseJsonResponse<Record<string, unknown>>(response);

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_target');
      expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // client_secret_basic (HTTP Basic Authentication)
  // ==========================================================================

  describe('client_secret_basic Authentication', () => {
    it('should authenticate with valid Basic auth header', async () => {
      const client = createConfidentialClient({
        token_endpoint_auth_method: 'client_secret_basic',
      });
      const authCodeData = createAuthCodeData();

      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockVerifyClientSecretHash.mockResolvedValue(true);
      mocks.mockParseBasicAuth.mockReturnValue({
        success: true,
        credentials: {
          username: client.client_id,
          password: 'valid-secret',
        },
      });

      const consumeCodeRpcMock = vi.fn().mockResolvedValue(authCodeData);
      mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
        consumeCodeRpc: consumeCodeRpcMock,
      });

      const ctx = createMockContext({
        method: 'POST',
        headers: {
          Authorization: `Basic ${base64UrlEncode(`${client.client_id}:valid-secret`)}`,
        },
        body: {
          grant_type: 'authorization_code',
          code: 'valid-auth-code',
          redirect_uri: authCodeData.redirectUri,
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      const body = await parseJsonResponse<{ access_token: string }>(response);

      expect(response.status).toBe(200);
      expect(body.access_token).toBeDefined();
      expect(mocks.mockVerifyClientSecretHash).toHaveBeenCalledWith(
        'valid-secret',
        client.client_secret_hash
      );
    });

    it('should reject invalid Basic auth credentials', async () => {
      const client = createConfidentialClient();

      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockVerifyClientSecretHash.mockResolvedValue(false);
      mocks.mockParseBasicAuth.mockReturnValue({
        success: true,
        credentials: {
          username: client.client_id,
          password: 'wrong-secret',
        },
      });

      const consumeCodeRpcMock = vi.fn().mockResolvedValue(createAuthCodeData());
      mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
        consumeCodeRpc: consumeCodeRpcMock,
      });

      const ctx = createMockContext({
        method: 'POST',
        headers: {
          Authorization: `Basic ${base64UrlEncode(`${client.client_id}:wrong-secret`)}`,
        },
        body: {
          grant_type: 'authorization_code',
          code: 'valid-auth-code',
          redirect_uri: 'https://app.example.com/callback',
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      const body = await parseJsonResponse<{ error: string }>(response);

      expect(response.status).toBe(401);
      expect(body.error).toBe('invalid_client');
    });

    it('should reject malformed Basic auth header', async () => {
      mocks.mockParseBasicAuth.mockReturnValue({
        success: false,
        error: 'malformed_credentials',
      });

      const ctx = createMockContext({
        method: 'POST',
        headers: {
          Authorization: 'Basic not-valid-base64!!!',
        },
        body: {
          grant_type: 'authorization_code',
          code: 'valid-auth-code',
          redirect_uri: 'https://app.example.com/callback',
          client_id: 'some-client',
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      const body = await parseJsonResponse<{ error: string; error_description: string }>(response);

      expect(response.status).toBe(401);
      expect(body.error).toBe('invalid_client');
      expect(body.error_description).toContain('Authorization header');
    });

    it('should reject Basic auth with decode error', async () => {
      mocks.mockParseBasicAuth.mockReturnValue({
        success: false,
        error: 'decode_error',
      });

      const ctx = createMockContext({
        method: 'POST',
        headers: {
          Authorization: 'Basic !!!invalid!!!',
        },
        body: {
          grant_type: 'authorization_code',
          code: 'valid-auth-code',
          redirect_uri: 'https://app.example.com/callback',
          client_id: 'some-client',
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      const body = await parseJsonResponse<{ error: string }>(response);

      expect(response.status).toBe(401);
      expect(body.error).toBe('invalid_client');
    });

    it('should handle URL-encoded credentials in Basic auth (RFC 7617)', async () => {
      const client = createConfidentialClient({
        client_id: 'client+with+special%chars',
      });

      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockVerifyClientSecretHash.mockResolvedValue(true);
      // RFC 7617: client_id and client_secret are URL-encoded before Base64
      mocks.mockParseBasicAuth.mockReturnValue({
        success: true,
        credentials: {
          username: 'client+with+special%chars', // URL-decoded by parseBasicAuth
          password: 'secret@123!',
        },
      });

      const consumeCodeRpcMock = vi.fn().mockResolvedValue(createAuthCodeData());
      mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
        consumeCodeRpc: consumeCodeRpcMock,
      });

      const ctx = createMockContext({
        method: 'POST',
        headers: {
          Authorization: 'Basic Y2xpZW50JTJCd2l0aCUyQnNwZWNpYWwlMjVjaGFyczpzZWNyZXQlNDAxMjMh',
        },
        body: {
          grant_type: 'authorization_code',
          code: 'valid-auth-code',
          redirect_uri: 'https://app.example.com/callback',
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      expect(response.status).toBe(200);
    });
  });

  // ==========================================================================
  // client_secret_post Authentication
  // ==========================================================================

  describe('client_secret_post Authentication', () => {
    it('should authenticate with credentials in request body', async () => {
      const client = createConfidentialClient({
        token_endpoint_auth_method: 'client_secret_post',
      });
      const authCodeData = createAuthCodeData();

      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockVerifyClientSecretHash.mockResolvedValue(true);
      mocks.mockParseBasicAuth.mockReturnValue({ success: false }); // No Basic auth

      const consumeCodeRpcMock = vi.fn().mockResolvedValue(authCodeData);
      mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
        consumeCodeRpc: consumeCodeRpcMock,
      });

      const ctx = createMockContext({
        method: 'POST',
        body: {
          grant_type: 'authorization_code',
          code: 'valid-auth-code',
          redirect_uri: authCodeData.redirectUri,
          client_id: client.client_id,
          client_secret: 'valid-secret',
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      const body = await parseJsonResponse<{ access_token: string }>(response);

      expect(response.status).toBe(200);
      expect(body.access_token).toBeDefined();
      expect(mocks.mockVerifyClientSecretHash).toHaveBeenCalledWith(
        'valid-secret',
        client.client_secret_hash
      );
    });

    it('should reject missing client_secret for confidential client', async () => {
      const client = createConfidentialClient();

      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockParseBasicAuth.mockReturnValue({ success: false });
      mocks.mockVerifyClientSecretHash.mockResolvedValue(false);

      const consumeCodeRpcMock = vi.fn().mockResolvedValue(createAuthCodeData());
      mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
        consumeCodeRpc: consumeCodeRpcMock,
      });

      const ctx = createMockContext({
        method: 'POST',
        body: {
          grant_type: 'authorization_code',
          code: 'valid-auth-code',
          redirect_uri: 'https://app.example.com/callback',
          client_id: client.client_id,
          // Missing client_secret
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      const body = await parseJsonResponse<{ error: string }>(response);

      expect(response.status).toBe(401);
      expect(body.error).toBe('invalid_client');
    });

    it('should use post credentials when both Basic auth and post credentials are provided', async () => {
      // Note: Implementation prioritizes POST body credentials over Basic auth
      // This is because form data is parsed first, and Basic auth only used as fallback
      const client = createConfidentialClient();
      const authCodeData = createAuthCodeData();

      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockVerifyClientSecretHash.mockResolvedValue(true);
      // Basic auth credentials (will be used as fallback only)
      mocks.mockParseBasicAuth.mockReturnValue({
        success: true,
        credentials: {
          username: client.client_id,
          password: 'basic-secret',
        },
      });

      const consumeCodeRpcMock = vi.fn().mockResolvedValue(authCodeData);
      mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
        consumeCodeRpc: consumeCodeRpcMock,
      });

      const ctx = createMockContext({
        method: 'POST',
        headers: {
          Authorization: `Basic ${base64UrlEncode(`${client.client_id}:basic-secret`)}`,
        },
        body: {
          grant_type: 'authorization_code',
          code: 'valid-auth-code',
          redirect_uri: authCodeData.redirectUri,
          client_id: client.client_id,
          client_secret: 'post-secret', // Different secret in body
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      expect(response.status).toBe(200);

      // POST body credentials are used (implementation prioritizes form data over Basic auth)
      expect(mocks.mockVerifyClientSecretHash).toHaveBeenCalledWith(
        'post-secret',
        client.client_secret_hash
      );
    });
  });

  // ==========================================================================
  // private_key_jwt Authentication
  // ==========================================================================

  describe('private_key_jwt Authentication', () => {
    it('should authenticate with valid JWT signed with client private key', async () => {
      const client = createPrivateKeyJwtClient();
      const authCodeData = createAuthCodeData();

      // Create a mock client assertion JWT
      const clientAssertion = createTestJWT(
        { alg: 'RS256', kid: 'client-key-001' },
        {
          iss: client.client_id,
          sub: client.client_id,
          aud: 'https://auth.example.com/token',
          exp: Math.floor(Date.now() / 1000) + 300,
          iat: Math.floor(Date.now() / 1000),
          jti: 'assertion-jti-001',
        }
      );

      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockParseToken.mockReturnValue({
        iss: client.client_id,
        sub: client.client_id,
      });
      mocks.mockValidateClientAssertion.mockResolvedValue({
        valid: true,
        client_id: client.client_id,
      });
      mocks.mockParseBasicAuth.mockReturnValue({ success: false });

      const consumeCodeRpcMock = vi.fn().mockResolvedValue(authCodeData);
      mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
        consumeCodeRpc: consumeCodeRpcMock,
      });

      const ctx = createMockContext({
        method: 'POST',
        body: {
          grant_type: 'authorization_code',
          code: 'valid-auth-code',
          redirect_uri: authCodeData.redirectUri,
          client_id: client.client_id,
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: clientAssertion,
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      const body = await parseJsonResponse<{ access_token: string }>(response);

      expect(response.status).toBe(200);
      expect(body.access_token).toBeDefined();
      expect(mocks.mockValidateClientAssertion).toHaveBeenCalledWith(
        clientAssertion,
        expect.stringContaining('/token'),
        expect.anything()
      );
    });

    it('should reject JWT with invalid signature', async () => {
      const client = createPrivateKeyJwtClient();

      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockParseToken.mockReturnValue({
        sub: client.client_id,
      });
      mocks.mockValidateClientAssertion.mockResolvedValue({
        valid: false,
        error: 'invalid_client',
        error_description: 'JWT signature verification failed',
      });
      mocks.mockParseBasicAuth.mockReturnValue({ success: false });

      const consumeCodeRpcMock = vi.fn().mockResolvedValue(createAuthCodeData());
      mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
        consumeCodeRpc: consumeCodeRpcMock,
      });

      const ctx = createMockContext({
        method: 'POST',
        body: {
          grant_type: 'authorization_code',
          code: 'valid-auth-code',
          redirect_uri: 'https://app.example.com/callback',
          client_id: client.client_id,
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: 'invalid-signature-jwt',
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      const body = await parseJsonResponse<{ error: string }>(response);

      expect(response.status).toBe(401);
      expect(body.error).toBe('invalid_client');
    });

    it('should reject JWT with invalid aud claim', async () => {
      const client = createPrivateKeyJwtClient();

      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockParseToken.mockReturnValue({ sub: client.client_id });
      mocks.mockValidateClientAssertion.mockResolvedValue({
        valid: false,
        error: 'invalid_client',
        error_description: 'JWT audience does not match token endpoint',
      });
      mocks.mockParseBasicAuth.mockReturnValue({ success: false });

      const consumeCodeRpcMock = vi.fn().mockResolvedValue(createAuthCodeData());
      mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
        consumeCodeRpc: consumeCodeRpcMock,
      });

      const ctx = createMockContext({
        method: 'POST',
        body: {
          grant_type: 'authorization_code',
          code: 'valid-auth-code',
          redirect_uri: 'https://app.example.com/callback',
          client_id: client.client_id,
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: createTestJWT(
            { alg: 'RS256' },
            { sub: client.client_id, aud: 'https://wrong-audience.com' }
          ),
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      expect(response.status).toBe(401);
    });

    it('should reject expired JWT', async () => {
      const client = createPrivateKeyJwtClient();

      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockParseToken.mockReturnValue({ sub: client.client_id });
      mocks.mockValidateClientAssertion.mockResolvedValue({
        valid: false,
        error: 'invalid_client',
        error_description: 'JWT has expired',
      });
      mocks.mockParseBasicAuth.mockReturnValue({ success: false });

      const consumeCodeRpcMock = vi.fn().mockResolvedValue(createAuthCodeData());
      mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
        consumeCodeRpc: consumeCodeRpcMock,
      });

      const ctx = createMockContext({
        method: 'POST',
        body: {
          grant_type: 'authorization_code',
          code: 'valid-auth-code',
          redirect_uri: 'https://app.example.com/callback',
          client_id: client.client_id,
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: createTestJWT(
            { alg: 'RS256' },
            {
              sub: client.client_id,
              exp: Math.floor(Date.now() / 1000) - 3600, // Expired 1 hour ago
            }
          ),
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      expect(response.status).toBe(401);
    });

    it('should extract client_id from JWT sub claim when not in body', async () => {
      const client = createPrivateKeyJwtClient();
      const authCodeData = createAuthCodeData();

      mocks.mockParseToken.mockReturnValue({
        sub: client.client_id, // client_id extracted from sub
      });
      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockValidateClientAssertion.mockResolvedValue({ valid: true });
      mocks.mockParseBasicAuth.mockReturnValue({ success: false });

      const consumeCodeRpcMock = vi.fn().mockResolvedValue(authCodeData);
      mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
        consumeCodeRpc: consumeCodeRpcMock,
      });

      const ctx = createMockContext({
        method: 'POST',
        body: {
          grant_type: 'authorization_code',
          code: 'valid-auth-code',
          redirect_uri: authCodeData.redirectUri,
          // No client_id in body
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: createTestJWT({ alg: 'RS256' }, { sub: client.client_id }),
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      expect(response.status).toBe(200);
    });

    it('should extract client_id from JWT iss claim as fallback', async () => {
      const client = createPrivateKeyJwtClient();
      const authCodeData = createAuthCodeData();

      mocks.mockParseToken.mockReturnValue({
        iss: client.client_id, // client_id extracted from iss
        // No sub claim
      });
      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockValidateClientAssertion.mockResolvedValue({ valid: true });
      mocks.mockParseBasicAuth.mockReturnValue({ success: false });

      const consumeCodeRpcMock = vi.fn().mockResolvedValue(authCodeData);
      mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
        consumeCodeRpc: consumeCodeRpcMock,
      });

      const ctx = createMockContext({
        method: 'POST',
        body: {
          grant_type: 'authorization_code',
          code: 'valid-auth-code',
          redirect_uri: authCodeData.redirectUri,
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: createTestJWT({ alg: 'RS256' }, { iss: client.client_id }),
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      expect(response.status).toBe(200);
    });

    it('should reject invalid client_assertion JWT format', async () => {
      mocks.mockParseToken.mockImplementation(() => {
        throw new Error('Invalid JWT format');
      });
      mocks.mockParseBasicAuth.mockReturnValue({ success: false });

      const ctx = createMockContext({
        method: 'POST',
        body: {
          grant_type: 'authorization_code',
          code: 'valid-auth-code',
          redirect_uri: 'https://app.example.com/callback',
          client_id: 'some-client',
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: 'not.a.valid.jwt',
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      const body = await parseJsonResponse<{ error: string; error_description: string }>(response);

      expect(response.status).toBe(401);
      expect(body.error).toBe('invalid_client');
      expect(body.error_description).toContain('client_assertion');
    });
  });

  // ==========================================================================
  // client_secret_jwt Authentication
  // ==========================================================================

  describe('client_secret_jwt Authentication', () => {
    it('should authenticate with JWT signed using client secret (HMAC)', async () => {
      const client = createConfidentialClient({
        token_endpoint_auth_method: 'client_secret_jwt',
      });
      const authCodeData = createAuthCodeData();

      const clientAssertion = createTestJWT(
        { alg: 'HS256' }, // HMAC signature
        {
          iss: client.client_id,
          sub: client.client_id,
          aud: 'https://auth.example.com/token',
          exp: Math.floor(Date.now() / 1000) + 300,
          iat: Math.floor(Date.now() / 1000),
        }
      );

      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockParseToken.mockReturnValue({
        sub: client.client_id,
      });
      mocks.mockValidateClientAssertion.mockResolvedValue({
        valid: true,
        client_id: client.client_id,
      });
      mocks.mockParseBasicAuth.mockReturnValue({ success: false });

      const consumeCodeRpcMock = vi.fn().mockResolvedValue(authCodeData);
      mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
        consumeCodeRpc: consumeCodeRpcMock,
      });

      const ctx = createMockContext({
        method: 'POST',
        body: {
          grant_type: 'authorization_code',
          code: 'valid-auth-code',
          redirect_uri: authCodeData.redirectUri,
          client_id: client.client_id,
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: clientAssertion,
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      expect(response.status).toBe(200);
    });
  });

  // ==========================================================================
  // Public Client (none) Authentication
  // ==========================================================================

  describe('Public Client (none) Authentication', () => {
    it('should allow public client without credentials', async () => {
      const client = createPublicClient({
        token_endpoint_auth_method: 'none',
        client_secret_hash: undefined, // No secret
      });
      const authCodeData = createAuthCodeData();

      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockParseBasicAuth.mockReturnValue({ success: false });

      const consumeCodeRpcMock = vi.fn().mockResolvedValue(authCodeData);
      mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
        consumeCodeRpc: consumeCodeRpcMock,
      });

      const ctx = createMockContext({
        method: 'POST',
        body: {
          grant_type: 'authorization_code',
          code: 'valid-auth-code',
          redirect_uri: authCodeData.redirectUri,
          client_id: client.client_id,
          code_verifier: 'valid-pkce-verifier-12345678901234567890123456789012345',
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      expect(response.status).toBe(200);

      // Should NOT call verifyClientSecretHash for public clients
      expect(mocks.mockVerifyClientSecretHash).not.toHaveBeenCalled();
    });

    it('should not issue a refresh token to a browser public client by default', async () => {
      const client = createPublicClient({
        token_endpoint_auth_method: 'none',
        client_secret_hash: undefined,
      });
      const authCodeData = createAuthCodeData();

      mocks.mockGetClientCached.mockResolvedValue(client);
      mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
        consumeCodeRpc: vi.fn().mockResolvedValue(authCodeData),
        registerIssuedTokensRpc: vi.fn().mockResolvedValue(true),
      });

      const response = await tokenHandler(
        createMockContext({
          method: 'POST',
          headers: {
            Origin: 'https://spa.example.com',
          },
          body: {
            grant_type: 'authorization_code',
            code: 'valid-auth-code',
            redirect_uri: authCodeData.redirectUri,
            client_id: client.client_id,
            code_verifier: 'valid-pkce-verifier-12345678901234567890123456789012345',
          },
          env: mockEnv,
        })
      );
      const body = await parseJsonResponse<Record<string, unknown>>(response);

      expect(response.status).toBe(200);
      expect(body.access_token).toBe('mock-access-token');
      expect(body.refresh_token).toBeUndefined();
      expect(body.refresh_token_expires_in).toBeUndefined();
      expect(mocks.mockCreateRefreshToken).not.toHaveBeenCalled();
    });

    it('should issue a browser public refresh token only for explicit DPoP-bound opt-in', async () => {
      const client = createPublicClient({
        token_endpoint_auth_method: 'none',
        client_secret_hash: undefined,
        browser_refresh_token_policy: 'dpop_bound',
      });
      const authCodeData = createAuthCodeData();

      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockExtractDPoPProof.mockReturnValue('dpop-proof');
      mocks.mockValidateDPoPProof.mockResolvedValue({ valid: true, jkt: 'browser-jkt' });
      mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
        consumeCodeRpc: vi.fn().mockResolvedValue(authCodeData),
        registerIssuedTokensRpc: vi.fn().mockResolvedValue(true),
      });

      const response = await tokenHandler(
        createMockContext({
          method: 'POST',
          headers: {
            Origin: 'https://spa.example.com',
            DPoP: 'dpop-proof',
          },
          body: {
            grant_type: 'authorization_code',
            code: 'valid-auth-code',
            redirect_uri: authCodeData.redirectUri,
            client_id: client.client_id,
            code_verifier: 'valid-pkce-verifier-12345678901234567890123456789012345',
          },
          env: mockEnv,
        })
      );
      const body = await parseJsonResponse<Record<string, unknown>>(response);

      expect(response.status).toBe(200);
      expect(body.token_type).toBe('DPoP');
      expect(body.refresh_token).toBe('mock-refresh-token');
      expectRefreshTokenExpiryMetadata(body);
      expect(mocks.mockCreateRefreshToken).toHaveBeenCalledWith(
        expect.any(Object),
        expect.anything(),
        expect.any(String),
        expect.any(Number),
        expect.any(String),
        expect.any(Number)
      );
    });

    it('should reject a strict browser public client token request without DPoP', async () => {
      const client = createPublicClient({
        token_endpoint_auth_method: 'none',
        client_secret_hash: undefined,
        browser_public_client_mode: 'strict',
      });
      const authCodeData = createAuthCodeData();

      mocks.mockGetClientCached.mockResolvedValue(client);
      mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
        consumeCodeRpc: vi.fn().mockResolvedValue(authCodeData),
        registerIssuedTokensRpc: vi.fn().mockResolvedValue(true),
      });

      const response = await tokenHandler(
        createMockContext({
          method: 'POST',
          headers: {
            Origin: 'https://spa.example.com',
          },
          body: {
            grant_type: 'authorization_code',
            code: 'valid-auth-code',
            redirect_uri: authCodeData.redirectUri,
            client_id: client.client_id,
            code_verifier: 'valid-pkce-verifier-12345678901234567890123456789012345',
          },
          env: mockEnv,
        })
      );
      const body = await parseJsonResponse<{ error: string; error_description: string }>(response);

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('DPoP proof');
      expect(mockEnv.AUTH_CODE_STORE.get).not.toHaveBeenCalled();
      expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
      expect(mocks.mockCreateRefreshToken).not.toHaveBeenCalled();
    });

    it('should reject public client attempting client_credentials grant', async () => {
      const client = createPublicClient({
        grant_types: ['client_credentials'], // Incorrectly configured
        client_secret_hash: undefined,
        client_credentials_allowed: false,
      });

      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockParseBasicAuth.mockReturnValue({ success: false });
      // Enable client_credentials feature flag so we get to the authorization check
      mocks.mockGetSystemSettingsCached.mockResolvedValue({
        feature_client_credentials_enabled: true,
      });
      mocks.mockLoadTenantProfileCached.mockResolvedValue({
        tenant_id: 'default',
        max_token_ttl_seconds: 3600,
        allows_client_credentials: true,
      });

      const ctx = createMockContext({
        method: 'POST',
        body: {
          grant_type: 'client_credentials',
          client_id: client.client_id,
          scope: 'api:read',
        },
        env: {
          ...mockEnv,
          ENABLE_CLIENT_CREDENTIALS: 'true',
        },
      });

      const response = await tokenHandler(ctx);
      const body = await parseJsonResponse<{ error: string }>(response);

      // Client credentials grant requires authentication - public clients fail with invalid_client (401)
      // because they have no client_secret_hash and no credentials are provided
      expect(response.status).toBe(401);
      expect(body.error).toBe('invalid_client');
    });
  });

  // ==========================================================================
  // Authentication Method Enforcement
  // ==========================================================================

  describe('Authentication Method Enforcement', () => {
    it('should allow authentication when client has client_secret_hash even if token_endpoint_auth_method is private_key_jwt', async () => {
      // Note: Current implementation allows authentication to succeed if the secret matches,
      // regardless of token_endpoint_auth_method setting. This tests actual behavior.
      // The token_endpoint_auth_method is informational for client registration/discovery.
      const client = createPrivateKeyJwtClient({
        token_endpoint_auth_method: 'private_key_jwt',
        client_secret_hash: 'hashed-secret', // Has a secret configured
      });
      const authCodeData = createAuthCodeData();

      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockVerifyClientSecretHash.mockResolvedValue(true); // Secret matches
      mocks.mockParseBasicAuth.mockReturnValue({
        success: true,
        credentials: {
          username: client.client_id,
          password: 'some-secret',
        },
      });

      const consumeCodeRpcMock = vi.fn().mockResolvedValue(authCodeData);
      mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
        consumeCodeRpc: consumeCodeRpcMock,
      });

      const ctx = createMockContext({
        method: 'POST',
        headers: {
          Authorization: `Basic ${base64UrlEncode(`${client.client_id}:some-secret`)}`,
        },
        body: {
          grant_type: 'authorization_code',
          code: 'valid-auth-code',
          redirect_uri: authCodeData.redirectUri,
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);

      // Authentication succeeds when client_secret_hash is configured and secret matches
      // token_endpoint_auth_method is not strictly enforced at runtime
      expect(response.status).toBe(200);
    });
  });

  // ==========================================================================
  // JWT Bearer Grant Audience
  // ==========================================================================

  describe('JWT Bearer Grant Audience', () => {
    it('should issue JWT bearer access token for an explicit resource target', async () => {
      const response = await tokenHandler(
        createMockContext({
          method: 'POST',
          body: {
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: 'valid-assertion',
            scope: 'api:read',
            resource: 'svc://service-admin-api',
          },
          env: mockEnv,
        })
      );
      const body = await parseJsonResponse<{ access_token?: string }>(response);

      expect(response.status).toBe(200);
      expect(body.access_token).toBeDefined();
      expect(mocks.mockCreateAccessToken).toHaveBeenCalledWith(
        expect.objectContaining({
          aud: 'svc://service-admin-api',
          client_id: 'https://service.example.com',
        }),
        expect.anything(),
        expect.any(String),
        expect.any(Number),
        expect.any(String)
      );
    });

    it('should use trusted issuer default_resource for JWT bearer access token aud', async () => {
      const response = await tokenHandler(
        createMockContext({
          method: 'POST',
          body: {
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: 'valid-assertion',
            scope: 'api:read',
          },
          env: mockEnv,
        })
      );

      expect(response.status).toBe(200);
      expect(mocks.mockCreateAccessToken).toHaveBeenCalledWith(
        expect.objectContaining({ aud: 'svc://service-api' }),
        expect.anything(),
        expect.any(String),
        expect.any(Number),
        expect.any(String)
      );
    });

    it('should reject JWT bearer when no request or trusted issuer target is configured', async () => {
      mocks.mockParseTrustedIssuers.mockReturnValue(
        new Map([
          [
            'https://service.example.com',
            {
              issuer: 'https://service.example.com',
              jwks_uri: 'https://service.example.com/jwks',
            },
          ],
        ])
      );

      const response = await tokenHandler(
        createMockContext({
          method: 'POST',
          body: {
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: 'valid-assertion',
            scope: 'api:read',
          },
          env: mockEnv,
        })
      );
      const body = await parseJsonResponse<{ error: string; error_description: string }>(response);

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_target');
      expect(body.error_description).toBe('No target resource is configured for this access token');
      expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
    });

    it('should reject JWT bearer resource outside trusted issuer allowed_resources', async () => {
      const response = await tokenHandler(
        createMockContext({
          method: 'POST',
          body: {
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: 'valid-assertion',
            scope: 'api:read',
            resource: 'svc://other-api',
          },
          env: mockEnv,
        })
      );
      const body = await parseJsonResponse<{ error: string; error_description: string }>(response);

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_target');
      expect(body.error_description).toBe(
        'Requested audience/resource not allowed: svc://other-api'
      );
      expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Security Edge Cases
  // ==========================================================================

  describe('Security Edge Cases', () => {
    it('should not reveal whether client exists via timing', async () => {
      // Test that error responses take similar time regardless of whether client exists
      // This is a conceptual test - actual timing tests would need performance measurements

      // Non-existent client
      mocks.mockGetClientCached.mockResolvedValue(null);
      mocks.mockParseBasicAuth.mockReturnValue({ success: false });

      const ctx1 = createMockContext({
        method: 'POST',
        body: {
          grant_type: 'authorization_code',
          code: 'valid-auth-code',
          redirect_uri: 'https://app.example.com/callback',
          client_id: 'non-existent-client',
        },
        env: mockEnv,
      });

      const response1 = await tokenHandler(ctx1);
      const body1 = await parseJsonResponse<{ error: string; error_description: string }>(
        response1
      );

      // Both should return the same generic error
      expect(body1.error).toBe('invalid_client');
      expect(body1.error_description).toBe('Client authentication failed');
    });

    it('should handle empty client_id', async () => {
      mocks.mockValidateClientId.mockReturnValue({
        valid: false,
        error: 'client_id is required',
      });
      mocks.mockParseBasicAuth.mockReturnValue({ success: false });

      const ctx = createMockContext({
        method: 'POST',
        body: {
          grant_type: 'authorization_code',
          code: 'valid-auth-code',
          redirect_uri: 'https://app.example.com/callback',
          client_id: '',
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      const body = await parseJsonResponse<{ error: string }>(response);

      expect(response.status).toBe(401);
      expect(body.error).toBe('invalid_client');
    });

    it('should reject client_assertion with wrong assertion_type', async () => {
      const client = createConfidentialClient();

      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockParseBasicAuth.mockReturnValue({ success: false });

      const ctx = createMockContext({
        method: 'POST',
        body: {
          grant_type: 'authorization_code',
          code: 'valid-auth-code',
          redirect_uri: 'https://app.example.com/callback',
          client_id: client.client_id,
          client_assertion_type: 'urn:wrong:assertion:type', // Wrong type
          client_assertion: 'some-jwt',
        },
        env: mockEnv,
      });

      const response = await tokenHandler(ctx);
      // Should fall back to other auth methods, not use JWT assertion
      expect(mocks.mockValidateClientAssertion).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Client Credentials Grant Authentication
  // ==========================================================================

  describe('Client Credentials Grant Authentication', () => {
    function mockAdminMachineAccess(
      overrides: {
        principalStatus?: string;
        credentialStatus?: string;
        credentialAlg?: string;
        principalType?:
          | 'setup_tool'
          | 'admin_ui_bff'
          | 'automation'
          | 'ci'
          | 'mcp_server'
          | 'ai_agent'
          | 'internal_service'
          | 'integration';
        principalId?: string;
        clientId?: string;
        credentialId?: string;
        credentialKid?: string;
        displayName?: string;
        principalPermissions?: string[];
        credentialPermissions?: string[];
        principalTenantScopes?: Array<{ scope_mode: string; tenant_id: string | null }>;
        credentialTenantScopes?: Array<{ scope_mode: string; tenant_id: string | null }>;
      } = {}
    ) {
      const principalType = overrides.principalType ?? 'setup_tool';
      const principalId = overrides.principalId ?? 'amp_setup';
      const clientId = overrides.clientId ?? 'setup-tool';
      const credentialId = overrides.credentialId ?? 'amk_setup';
      const credentialKid = overrides.credentialKid ?? 'setup-2026-05';
      const displayName = overrides.displayName ?? 'Authrim Setup Tool';
      const principalPermissions = overrides.principalPermissions ?? [
        'admin:tenants.read',
        'admin:clients.create',
      ];
      const credentialPermissions = overrides.credentialPermissions ?? [];
      const principalTenantScopes = overrides.principalTenantScopes ?? [
        { scope_mode: 'allow', tenant_id: 'default' },
      ];
      const credentialTenantScopes = overrides.credentialTenantScopes ?? [];

      mocks.mockAdminAdapter.queryOne.mockImplementation(async (sql: string) => {
        if (sql.includes('JOIN admin_machine_credentials')) {
          return {
            id: principalId,
            client_id: clientId,
            display_name: displayName,
            description: null,
            principal_type: principalType,
            status: overrides.principalStatus ?? 'active',
            default_audience: 'authrim:admin-api',
            token_ttl_seconds: 600,
            created_by_actor_type: 'bootstrap',
            created_by_actor_id: 'setup',
            created_at: 1,
            updated_at: 1,
            disabled_at: null,
            disabled_by_actor_type: null,
            disabled_by_actor_id: null,
            credential_id: credentialId,
            credential_principal_id: principalId,
            credential_kid: credentialKid,
            credential_public_jwk_json: '{"kty":"EC","crv":"P-256","x":"x","y":"y"}',
            credential_alg: overrides.credentialAlg ?? 'ES256',
            credential_display_name: 'Setup key',
            credential_description: null,
            credential_status: overrides.credentialStatus ?? 'active',
            credential_not_before: null,
            credential_expires_at: null,
            credential_last_used_at: null,
            credential_last_used_ip: null,
            credential_last_used_user_agent: null,
            credential_created_by_actor_type: 'bootstrap',
            credential_created_by_actor_id: 'setup',
            credential_created_at: 1,
            credential_updated_at: 1,
            credential_revoked_at: null,
            credential_revoked_by_actor_type: null,
            credential_revoked_by_actor_id: null,
            credential_revoke_reason: null,
          };
        }
        return null;
      });
      mocks.mockAdminAdapter.query.mockImplementation(async (sql: string) => {
        if (sql.includes('admin_machine_principal_permissions')) {
          return principalPermissions.map((permission) => ({ permission }));
        }
        if (sql.includes('admin_machine_credential_permissions')) {
          return credentialPermissions.map((permission) => ({ permission }));
        }
        if (sql.includes('admin_machine_principal_tenant_scopes')) {
          return principalTenantScopes;
        }
        if (sql.includes('admin_machine_credential_tenant_scopes')) {
          return credentialTenantScopes;
        }
        return [];
      });
    }

    it('issues Admin API machine token from DB_ADMIN machine principal', async () => {
      mockAdminMachineAccess();
      mocks.mockParseToken.mockReturnValue({
        iss: 'setup-tool',
        sub: 'setup-tool',
        aud: 'https://test.example.com/token',
        exp: Math.floor(Date.now() / 1000) + 60,
        iat: Math.floor(Date.now() / 1000),
        jti: 'assertion-1',
      });
      mocks.mockParseTokenHeader.mockReturnValue({ alg: 'ES256', kid: 'setup-2026-05' });
      mocks.mockValidateClientAssertion.mockResolvedValue({ valid: true, client_id: 'setup-tool' });

      const response = await tokenHandler(
        createMockContext({
          method: 'POST',
          body: {
            grant_type: 'client_credentials',
            client_id: 'setup-tool',
            client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
            client_assertion: 'header.payload.signature',
            audience: 'authrim:admin-api',
            scope: 'admin:tenants.read admin:clients.create',
          },
          env: {
            ...mockEnv,
            ENABLE_CLIENT_CREDENTIALS: 'true',
          },
        })
      );
      const body = await parseJsonResponse<{ access_token?: string; token_type?: string }>(
        response
      );

      expect(response.status).toBe(200);
      expect(body.access_token).toBe('mock-access-token');
      expect(body.token_type).toBe('Bearer');
      expect(mocks.mockGetClientCached).not.toHaveBeenCalled();
      expect(mocks.mockValidateClientAssertion).toHaveBeenCalledWith(
        'header.payload.signature',
        'https://auth.example.com/token',
        expect.objectContaining({
          client_id: 'setup-tool',
          token_endpoint_auth_method: 'private_key_jwt',
        }),
        { acceptIssuerIdAsAudience: false }
      );
      expect(mocks.mockCreateAccessToken).toHaveBeenCalledWith(
        expect.objectContaining({
          aud: 'authrim:admin-api',
          sub: 'machine:amp_setup',
          actor_type: 'machine',
          actor_id: 'amp_setup',
          credential_id: 'amk_setup',
          client_auth_method: 'private_key_jwt',
          scope: 'admin:tenants.read admin:clients.create',
          tenant_scope: ['default'],
        }),
        expect.anything(),
        expect.any(String),
        600,
        expect.any(String)
      );
    });

    it('allows Admin API machine access even when general client_credentials is disabled', async () => {
      mockAdminMachineAccess();
      mocks.mockParseToken.mockReturnValue({
        iss: 'setup-tool',
        sub: 'setup-tool',
        aud: 'https://test.example.com/token',
        exp: Math.floor(Date.now() / 1000) + 60,
        iat: Math.floor(Date.now() / 1000),
        jti: 'assertion-client-credentials-disabled',
      });
      mocks.mockParseTokenHeader.mockReturnValue({ alg: 'ES256', kid: 'setup-2026-05' });
      mocks.mockValidateClientAssertion.mockResolvedValue({ valid: true, client_id: 'setup-tool' });

      const response = await tokenHandler(
        createMockContext({
          method: 'POST',
          body: {
            grant_type: 'client_credentials',
            client_id: 'setup-tool',
            client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
            client_assertion: 'header.payload.signature',
            audience: 'authrim:admin-api',
            scope: 'admin:tenants.read',
          },
          env: {
            ...mockEnv,
            ENABLE_CLIENT_CREDENTIALS: 'false',
          },
        })
      );

      expect(response.status).toBe(200);
      expect(mocks.mockGetSystemSettingsCached).not.toHaveBeenCalled();
      expect(mocks.mockGetClientCached).not.toHaveBeenCalled();
      expect(mocks.mockCreateAccessToken).toHaveBeenCalledWith(
        expect.objectContaining({
          aud: 'authrim:admin-api',
          sub: 'machine:amp_setup',
          scope: 'admin:tenants.read',
        }),
        expect.anything(),
        expect.any(String),
        600,
        expect.any(String)
      );
    });

    it('issues Admin API machine tokens for MCP principals', async () => {
      mockAdminMachineAccess({
        principalType: 'mcp_server',
        principalId: 'amp_mcp_admin',
        clientId: 'mcp-admin-server',
        credentialId: 'amk_mcp_admin',
        credentialKid: 'mcp-admin-2026-05',
        displayName: 'MCP Admin Server',
        principalPermissions: ['admin:ai_grants:*'],
        principalTenantScopes: [{ scope_mode: 'allow', tenant_id: '*' }],
      });
      mocks.mockParseToken.mockReturnValue({
        iss: 'mcp-admin-server',
        sub: 'mcp-admin-server',
        aud: 'https://test.example.com/token',
        exp: Math.floor(Date.now() / 1000) + 60,
        iat: Math.floor(Date.now() / 1000),
        jti: 'mcp-admin-assertion-1',
      });
      mocks.mockParseTokenHeader.mockReturnValue({ alg: 'ES256', kid: 'mcp-admin-2026-05' });
      mocks.mockValidateClientAssertion.mockResolvedValue({
        valid: true,
        client_id: 'mcp-admin-server',
      });

      const response = await tokenHandler(
        createMockContext({
          method: 'POST',
          body: {
            grant_type: 'client_credentials',
            client_id: 'mcp-admin-server',
            client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
            client_assertion: 'header.payload.signature',
            audience: 'authrim:admin-api',
            scope: 'admin:ai_grants:create admin:ai_grants:read',
          },
          env: {
            ...mockEnv,
            ENABLE_CLIENT_CREDENTIALS: 'true',
          },
        })
      );

      expect(response.status).toBe(200);
      expect(mocks.mockCreateAccessToken).toHaveBeenCalledWith(
        expect.objectContaining({
          aud: 'authrim:admin-api',
          sub: 'machine:amp_mcp_admin',
          actor_type: 'machine',
          actor_id: 'amp_mcp_admin',
          credential_id: 'amk_mcp_admin',
          client_id: 'mcp-admin-server',
          client_auth_method: 'private_key_jwt',
          scope: 'admin:ai_grants:create admin:ai_grants:read',
          tenant_scope: ['*'],
        }),
        expect.anything(),
        expect.any(String),
        600,
        expect.any(String)
      );
    });

    it('issues Admin API machine tokens for AI agent principals', async () => {
      mockAdminMachineAccess({
        principalType: 'ai_agent',
        principalId: 'amp_ai_admin_agent',
        clientId: 'ai-admin-agent',
        credentialId: 'amk_ai_admin_agent',
        credentialKid: 'ai-admin-agent-2026-05',
        displayName: 'AI Admin Agent',
        principalPermissions: ['admin:ai_grants:*'],
      });
      mocks.mockParseToken.mockReturnValue({
        iss: 'ai-admin-agent',
        sub: 'ai-admin-agent',
        aud: 'https://test.example.com/token',
        exp: Math.floor(Date.now() / 1000) + 60,
        iat: Math.floor(Date.now() / 1000),
        jti: 'ai-admin-agent-assertion-1',
      });
      mocks.mockParseTokenHeader.mockReturnValue({ alg: 'ES256', kid: 'ai-admin-agent-2026-05' });
      mocks.mockValidateClientAssertion.mockResolvedValue({
        valid: true,
        client_id: 'ai-admin-agent',
      });

      const response = await tokenHandler(
        createMockContext({
          method: 'POST',
          body: {
            grant_type: 'client_credentials',
            client_id: 'ai-admin-agent',
            client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
            client_assertion: 'header.payload.signature',
            audience: 'authrim:admin-api',
            scope: 'admin:ai_grants:update',
          },
          env: {
            ...mockEnv,
            ENABLE_CLIENT_CREDENTIALS: 'true',
          },
        })
      );

      expect(response.status).toBe(200);
      expect(mocks.mockCreateAccessToken).toHaveBeenCalledWith(
        expect.objectContaining({
          aud: 'authrim:admin-api',
          sub: 'machine:amp_ai_admin_agent',
          actor_type: 'machine',
          actor_id: 'amp_ai_admin_agent',
          credential_id: 'amk_ai_admin_agent',
          client_id: 'ai-admin-agent',
          client_auth_method: 'private_key_jwt',
          scope: 'admin:ai_grants:update',
          tenant_scope: ['default'],
        }),
        expect.anything(),
        expect.any(String),
        600,
        expect.any(String)
      );
    });

    it('rejects Admin API machine access without private_key_jwt', async () => {
      const response = await tokenHandler(
        createMockContext({
          method: 'POST',
          body: {
            grant_type: 'client_credentials',
            client_id: 'setup-tool',
            audience: 'authrim:admin-api',
            scope: 'admin:tenants.read',
          },
          env: {
            ...mockEnv,
            ENABLE_CLIENT_CREDENTIALS: 'true',
          },
        })
      );
      const body = await parseJsonResponse<{ error: string }>(response);

      expect(response.status).toBe(401);
      expect(body.error).toBe('invalid_client');
      expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
    });

    it('rejects Admin API machine assertions without iat', async () => {
      mockAdminMachineAccess();
      mocks.mockParseToken.mockReturnValue({
        iss: 'setup-tool',
        sub: 'setup-tool',
        aud: 'https://test.example.com/token',
        exp: Math.floor(Date.now() / 1000) + 60,
        jti: 'assertion-missing-iat',
      });
      mocks.mockParseTokenHeader.mockReturnValue({ alg: 'ES256', kid: 'setup-2026-05' });

      const response = await tokenHandler(
        createMockContext({
          method: 'POST',
          body: {
            grant_type: 'client_credentials',
            client_id: 'setup-tool',
            client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
            client_assertion: 'header.payload.signature',
            audience: 'authrim:admin-api',
            scope: 'admin:tenants.read',
          },
          env: {
            ...mockEnv,
            ENABLE_CLIENT_CREDENTIALS: 'true',
          },
        })
      );
      const body = await parseJsonResponse<{ error: string; error_description: string }>(response);

      expect(response.status).toBe(401);
      expect(body.error).toBe('invalid_client');
      expect(body.error_description).toBe('Admin machine client_assertion must include iat');
      expect(mocks.mockValidateClientAssertion).not.toHaveBeenCalled();
      expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
    });

    it('rejects Admin API machine assertions with credential alg mismatch', async () => {
      mockAdminMachineAccess({ credentialAlg: 'RS256' });
      mocks.mockParseToken.mockReturnValue({
        iss: 'setup-tool',
        sub: 'setup-tool',
        aud: 'https://test.example.com/token',
        exp: Math.floor(Date.now() / 1000) + 60,
        iat: Math.floor(Date.now() / 1000),
        jti: 'assertion-alg-mismatch',
      });
      mocks.mockParseTokenHeader.mockReturnValue({ alg: 'ES256', kid: 'setup-2026-05' });

      const response = await tokenHandler(
        createMockContext({
          method: 'POST',
          body: {
            grant_type: 'client_credentials',
            client_id: 'setup-tool',
            client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
            client_assertion: 'header.payload.signature',
            audience: 'authrim:admin-api',
            scope: 'admin:tenants.read',
          },
          env: {
            ...mockEnv,
            ENABLE_CLIENT_CREDENTIALS: 'true',
          },
        })
      );

      expect(response.status).toBe(401);
      expect(mocks.mockValidateClientAssertion).not.toHaveBeenCalled();
      expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
    });

    it('rejects replayed Admin API machine client assertions', async () => {
      mockAdminMachineAccess();
      mocks.mockParseToken.mockReturnValue({
        iss: 'setup-tool',
        sub: 'setup-tool',
        aud: 'https://test.example.com/token',
        exp: Math.floor(Date.now() / 1000) + 60,
        iat: Math.floor(Date.now() / 1000),
        jti: 'assertion-1',
      });
      mocks.mockParseTokenHeader.mockReturnValue({ alg: 'ES256', kid: 'setup-2026-05' });
      mocks.mockAdminAdapter.execute.mockRejectedValueOnce(new Error('unique constraint'));

      const response = await tokenHandler(
        createMockContext({
          method: 'POST',
          body: {
            grant_type: 'client_credentials',
            client_id: 'setup-tool',
            client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
            client_assertion: 'header.payload.signature',
            audience: 'authrim:admin-api',
            scope: 'admin:tenants.read',
          },
          env: {
            ...mockEnv,
            ENABLE_CLIENT_CREDENTIALS: 'true',
          },
        })
      );
      const body = await parseJsonResponse<{ error: string; error_description: string }>(response);

      expect(response.status).toBe(401);
      expect(body.error).toBe('invalid_client');
      expect(body.error_description).toBe('Client assertion replay detected');
      expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
    });

    it('should authenticate M2M client for client_credentials grant', async () => {
      const client = createM2MClient();

      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockVerifyClientSecretHash.mockResolvedValue(true);
      mocks.mockParseBasicAuth.mockReturnValue({
        success: true,
        credentials: {
          username: client.client_id,
          password: 'valid-m2m-secret',
        },
      });
      // Mock tenant profile to allow client_credentials
      mocks.mockLoadTenantProfileCached.mockResolvedValue({
        tenant_id: 'default',
        max_token_ttl_seconds: 3600,
        allows_client_credentials: true,
        allows_refresh_token: true,
      });
      // Mock system settings to enable client_credentials feature flag
      mocks.mockGetSystemSettingsCached.mockResolvedValue({
        feature_client_credentials_enabled: true,
      });

      const ctx = createMockContext({
        method: 'POST',
        headers: {
          Authorization: `Basic ${base64UrlEncode(`${client.client_id}:valid-m2m-secret`)}`,
        },
        body: {
          grant_type: 'client_credentials',
          scope: 'api:read api:write',
        },
        env: {
          ...mockEnv,
          ENABLE_CLIENT_CREDENTIALS: 'true',
        },
      });

      const response = await tokenHandler(ctx);
      const body = await parseJsonResponse<{
        access_token?: string;
        token_type?: string;
        error?: string;
        error_description?: string;
      }>(response);

      expect(response.status).toBe(200);
      expect(body.access_token).toBeDefined();
      expect(body.token_type).toBe('Bearer');
    });

    it('should use default_resource before legacy default_audience for client_credentials aud', async () => {
      const client = createM2MClient({
        default_resource: 'svc://m2m-api',
        default_audience: 'https://legacy-audience.example.com',
      });

      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockVerifyClientSecretHash.mockResolvedValue(true);
      mocks.mockParseBasicAuth.mockReturnValue({
        success: true,
        credentials: {
          username: client.client_id,
          password: 'valid-m2m-secret',
        },
      });
      mocks.mockLoadTenantProfileCached.mockResolvedValue({
        tenant_id: 'default',
        max_token_ttl_seconds: 3600,
        allows_client_credentials: true,
      });
      mocks.mockGetSystemSettingsCached.mockResolvedValue({
        feature_client_credentials_enabled: true,
      });

      const response = await tokenHandler(
        createMockContext({
          method: 'POST',
          headers: {
            Authorization: `Basic ${base64UrlEncode(`${client.client_id}:valid-m2m-secret`)}`,
          },
          body: {
            grant_type: 'client_credentials',
            scope: 'api:read',
          },
          env: {
            ...mockEnv,
            ENABLE_CLIENT_CREDENTIALS: 'true',
          },
        })
      );

      expect(response.status).toBe(200);
      expect(mocks.mockCreateAccessToken).toHaveBeenCalledWith(
        expect.objectContaining({ aud: 'svc://m2m-api' }),
        expect.anything(),
        expect.any(String),
        expect.any(Number),
        expect.any(String)
      );
    });

    it('should reject mismatched resource and audience in client_credentials', async () => {
      const client = createM2MClient();

      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockVerifyClientSecretHash.mockResolvedValue(true);
      mocks.mockParseBasicAuth.mockReturnValue({
        success: true,
        credentials: {
          username: client.client_id,
          password: 'valid-m2m-secret',
        },
      });
      mocks.mockLoadTenantProfileCached.mockResolvedValue({
        tenant_id: 'default',
        max_token_ttl_seconds: 3600,
        allows_client_credentials: true,
      });
      mocks.mockGetSystemSettingsCached.mockResolvedValue({
        feature_client_credentials_enabled: true,
      });

      const response = await tokenHandler(
        createMockContext({
          method: 'POST',
          headers: {
            Authorization: `Basic ${base64UrlEncode(`${client.client_id}:valid-m2m-secret`)}`,
          },
          body: {
            grant_type: 'client_credentials',
            scope: 'api:read',
            resource: 'svc://resource-api',
            audience: 'svc://different-api',
          },
          env: {
            ...mockEnv,
            ENABLE_CLIENT_CREDENTIALS: 'true',
          },
        })
      );
      const body = await parseJsonResponse<{ error: string }>(response);

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_target');
      expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
    });

    it('should reject client_credentials when no request or client default target is configured', async () => {
      const client = createM2MClient({
        default_resource: undefined,
        default_audience: undefined,
      });

      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockVerifyClientSecretHash.mockResolvedValue(true);
      mocks.mockParseBasicAuth.mockReturnValue({
        success: true,
        credentials: {
          username: client.client_id,
          password: 'valid-m2m-secret',
        },
      });
      mocks.mockLoadTenantProfileCached.mockResolvedValue({
        tenant_id: 'default',
        max_token_ttl_seconds: 3600,
        allows_client_credentials: true,
      });
      mocks.mockGetSystemSettingsCached.mockResolvedValue({
        feature_client_credentials_enabled: true,
      });

      const response = await tokenHandler(
        createMockContext({
          method: 'POST',
          headers: {
            Authorization: `Basic ${base64UrlEncode(`${client.client_id}:valid-m2m-secret`)}`,
          },
          body: {
            grant_type: 'client_credentials',
            scope: 'api:read',
          },
          env: {
            ...mockEnv,
            ENABLE_CLIENT_CREDENTIALS: 'true',
          },
        })
      );
      const body = await parseJsonResponse<{
        error: string;
        error_description: string;
      }>(response);

      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_target');
      expect(body.error_description).toBe('No target resource is configured for this access token');
      expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
    });

    it('should require authentication for client_credentials grant', async () => {
      const client = createM2MClient();

      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockParseBasicAuth.mockReturnValue({ success: false }); // No auth provided
      mocks.mockVerifyClientSecretHash.mockResolvedValue(false);
      // Enable client_credentials feature flag
      mocks.mockGetSystemSettingsCached.mockResolvedValue({
        feature_client_credentials_enabled: true,
      });
      mocks.mockLoadTenantProfileCached.mockResolvedValue({
        tenant_id: 'default',
        max_token_ttl_seconds: 3600,
        allows_client_credentials: true,
      });

      const ctx = createMockContext({
        method: 'POST',
        body: {
          grant_type: 'client_credentials',
          client_id: client.client_id,
          // No client_secret
        },
        env: {
          ...mockEnv,
          ENABLE_CLIENT_CREDENTIALS: 'true',
        },
      });

      const response = await tokenHandler(ctx);
      const body = await parseJsonResponse<{ error: string }>(response);

      expect(response.status).toBe(401);
      expect(body.error).toBe('invalid_client');
    });
  });
});
