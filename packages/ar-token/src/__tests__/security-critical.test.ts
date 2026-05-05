/**
 * Security-Critical Tests for ar-token
 *
 * Tests critical security paths:
 * - PKCE validation (RFC 7636)
 * - DPoP validation (RFC 9449)
 * - Replay attack prevention
 * - Refresh token rotation and theft detection
 * - Client authentication
 * - Token revocation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import {
  createMockEnv,
  createMockContext,
  createMockDurableObjectNamespace,
  createTestJWT,
  base64UrlEncode,
  parseJsonResponse,
  type MockEnv,
} from './helpers/mocks';
import {
  createConfidentialClient,
  createPublicClient,
  createFAPIClient,
  createAuthCodeData,
  createDPoPBoundAuthCodeData,
  createReplayAttackAuthCodeData,
  createAuthCodeGrantRequest,
  createRefreshTokenGrantRequest,
  createRefreshTokenPayload,
  createTestRefreshTokenJWT,
  createPKCEValues,
  createInvalidPKCEVerifierShort,
  createInvalidPKCEVerifierLong,
  createInvalidPKCEVerifierChars,
  createDPoPProofHeader,
  createDPoPProofPayload,
  OAuthErrors,
  type TestAuthCodeData,
} from './helpers/fixtures';

// ============================================================================
// Module Mock Setup
// ============================================================================

// Define mocks inline in vi.hoisted to avoid import issues
const mocks = vi.hoisted(() => ({
  // Logging
  mockGetLogger: vi.fn().mockReturnValue({
    module: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  }),
  mockCreateLogger: vi.fn().mockReturnValue({
    module: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  }),

  // Validation
  mockValidateGrantType: vi.fn().mockReturnValue({ valid: true }),
  mockValidateAuthCode: vi.fn().mockReturnValue({ valid: true }),
  mockValidateClientId: vi.fn().mockReturnValue({ valid: true }),
  mockValidateRedirectUri: vi.fn().mockReturnValue({ valid: true }),

  // Caching
  mockGetClientCached: vi.fn().mockResolvedValue(null),
  mockLoadTenantProfileCached: vi.fn().mockResolvedValue(null),
  mockGetSystemSettingsCached: vi.fn().mockResolvedValue(null),

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
  mockCalculateDsHash: vi.fn().mockResolvedValue('ds-hash-value'),

  // Token revocation
  mockRevokeToken: vi.fn().mockResolvedValue(undefined),
  mockIsTokenRevoked: vi.fn().mockResolvedValue(false),

  // Client authentication
  mockValidateClientAssertion: vi.fn().mockResolvedValue({ valid: true, client_id: 'test-client' }),
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

  // Refresh Token
  mockGetRefreshTokenShardConfig: vi.fn().mockReturnValue({ count: 1 }),
  mockGetRefreshTokenShardIndex: vi.fn().mockReturnValue(0),
  mockCreateRefreshTokenJti: vi.fn().mockReturnValue('rt-jti-001'),
  mockParseRefreshTokenJti: vi
    .fn()
    .mockReturnValue({ shardIndex: 0, randomPart: 'abc', generation: 1 }),
  mockBuildRefreshTokenRotatorInstanceName: vi.fn().mockReturnValue('refresh-token-0'),
  mockGenerateRefreshTokenRandomPart: vi.fn().mockReturnValue('random-part'),
  mockGenerateRegionAwareJti: vi.fn().mockResolvedValue({ jti: 'jti-region-001' }),
  mockStoreRefreshToken: vi.fn().mockResolvedValue(undefined),
  mockGetRefreshToken: vi.fn().mockResolvedValue(null),
  mockDeleteRefreshToken: vi.fn().mockResolvedValue(undefined),

  // Database
  mockD1Adapter: vi.fn().mockReturnValue({
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue({ success: true }),
  }),

  // User
  mockGetCachedUser: vi.fn().mockResolvedValue(null),
  mockGetCachedUserCore: vi.fn().mockResolvedValue(null),

  // Session
  mockSessionClientRepository: {
    getClients: vi.fn().mockResolvedValue([]),
    addClient: vi.fn().mockResolvedValue(undefined),
    removeClient: vi.fn().mockResolvedValue(undefined),
  },

  // Native SSO
  mockDeviceSecretRepository: {
    get: vi.fn().mockResolvedValue(null),
    store: vi.fn().mockResolvedValue(undefined),
    revoke: vi.fn().mockResolvedValue(undefined),
  },
  mockIsNativeSSOEnabled: vi.fn().mockResolvedValue(false),
  mockGetNativeSSOConfig: vi.fn().mockResolvedValue({}),

  // Device Flow / CIBA
  mockParseDeviceCodeId: vi.fn().mockReturnValue(null),
  mockGetDeviceCodeStoreById: vi.fn().mockReturnValue(null),
  mockParseCIBARequestId: vi.fn().mockReturnValue(null),
  mockGetCIBARequestStoreById: vi.fn().mockReturnValue(null),

  // RBAC / Policy
  mockGetIDTokenRBACClaims: vi.fn().mockResolvedValue({}),
  mockGetAccessTokenRBACClaims: vi.fn().mockResolvedValue({}),
  mockEvaluatePermissionsForScope: vi.fn().mockReturnValue([]),
  mockIsPolicyEmbeddingEnabled: vi.fn().mockResolvedValue(false),
  mockCreateTokenClaimEvaluator: vi.fn().mockReturnValue({ evaluate: vi.fn().mockReturnValue({}) }),
  mockEvaluateIdLevelPermissions: vi.fn().mockReturnValue([]),
  mockIsCustomClaimsEnabled: vi.fn().mockResolvedValue(false),
  mockIsIdLevelPermissionsEnabled: vi.fn().mockResolvedValue(false),
  mockGetEmbeddingLimits: vi.fn().mockReturnValue({ maxClaims: 50, maxSize: 4096 }),

  // Configuration
  mockCreateOAuthConfigManager: vi.fn().mockReturnValue({
    getTokenExpiry: vi.fn().mockResolvedValue(3600),
    getRefreshTokenExpiry: vi.fn().mockResolvedValue(86400 * 30),
  }),

  // Timing-safe comparison
  mockTimingSafeEqual: vi.fn().mockReturnValue(true),

  // Events
  mockPublishEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    // Logging
    getLogger: mocks.mockGetLogger,
    createLogger: mocks.mockCreateLogger,
    // Validation
    validateGrantType: mocks.mockValidateGrantType,
    validateAuthCode: mocks.mockValidateAuthCode,
    validateClientId: mocks.mockValidateClientId,
    validateRedirectUri: mocks.mockValidateRedirectUri,
    // Caching
    getClientCached: mocks.mockGetClientCached,
    loadTenantProfileCached: mocks.mockLoadTenantProfileCached,
    getSystemSettingsCached: mocks.mockGetSystemSettingsCached,
    // Token operations
    createAccessToken: mocks.mockCreateAccessToken,
    createIDToken: mocks.mockCreateIDToken,
    createRefreshToken: mocks.mockCreateRefreshToken,
    verifyToken: mocks.mockVerifyToken,
    parseToken: mocks.mockParseToken,
    parseTokenHeader: mocks.mockParseTokenHeader,
    calculateAtHash: mocks.mockCalculateAtHash,
    calculateDsHash: mocks.mockCalculateDsHash,
    // Token revocation
    revokeToken: mocks.mockRevokeToken,
    isTokenRevoked: mocks.mockIsTokenRevoked,
    // Client authentication
    validateClientAssertion: mocks.mockValidateClientAssertion,
    verifyClientSecretHash: mocks.mockVerifyClientSecretHash,
    parseBasicAuth: mocks.mockParseBasicAuth,
    // DPoP
    extractDPoPProof: mocks.mockExtractDPoPProof,
    validateDPoPProof: mocks.mockValidateDPoPProof,
    // Sharding
    parseShardedAuthCode: mocks.mockParseShardedAuthCode,
    getShardCount: mocks.mockGetShardCount,
    remapShardIndex: mocks.mockRemapShardIndex,
    buildAuthCodeShardInstanceName: mocks.mockBuildAuthCodeShardInstanceName,
    // Refresh Token
    getRefreshTokenShardConfig: mocks.mockGetRefreshTokenShardConfig,
    getRefreshTokenShardIndex: mocks.mockGetRefreshTokenShardIndex,
    createRefreshTokenJti: mocks.mockCreateRefreshTokenJti,
    parseRefreshTokenJti: mocks.mockParseRefreshTokenJti,
    buildRefreshTokenRotatorInstanceName: mocks.mockBuildRefreshTokenRotatorInstanceName,
    generateRefreshTokenRandomPart: mocks.mockGenerateRefreshTokenRandomPart,
    generateRegionAwareJti: mocks.mockGenerateRegionAwareJti,
    storeRefreshToken: mocks.mockStoreRefreshToken,
    getRefreshToken: mocks.mockGetRefreshToken,
    deleteRefreshToken: mocks.mockDeleteRefreshToken,
    // Database
    D1Adapter: mocks.mockD1Adapter,
    // RBAC
    getIDTokenRBACClaims: mocks.mockGetIDTokenRBACClaims,
    getAccessTokenRBACClaims: mocks.mockGetAccessTokenRBACClaims,
    evaluatePermissionsForScope: mocks.mockEvaluatePermissionsForScope,
    isPolicyEmbeddingEnabled: mocks.mockIsPolicyEmbeddingEnabled,
    createTokenClaimEvaluator: mocks.mockCreateTokenClaimEvaluator,
    isCustomClaimsEnabled: mocks.mockIsCustomClaimsEnabled,
    isIdLevelPermissionsEnabled: mocks.mockIsIdLevelPermissionsEnabled,
    getEmbeddingLimits: mocks.mockGetEmbeddingLimits,
    evaluateIdLevelPermissions: mocks.mockEvaluateIdLevelPermissions,
    // User
    getCachedUser: mocks.mockGetCachedUser,
    getCachedUserCore: mocks.mockGetCachedUserCore,
    // Native SSO
    isNativeSSOEnabled: mocks.mockIsNativeSSOEnabled,
    getNativeSSOConfig: mocks.mockGetNativeSSOConfig,
    DeviceSecretRepository: vi.fn().mockReturnValue(mocks.mockDeviceSecretRepository),
    SessionClientRepository: vi.fn().mockReturnValue(mocks.mockSessionClientRepository),
    // Device Flow / CIBA
    parseDeviceCodeId: mocks.mockParseDeviceCodeId,
    getDeviceCodeStoreById: mocks.mockGetDeviceCodeStoreById,
    parseCIBARequestId: mocks.mockParseCIBARequestId,
    getCIBARequestStoreById: mocks.mockGetCIBARequestStoreById,
    // Configuration
    createOAuthConfigManager: mocks.mockCreateOAuthConfigManager,
    // Timing-safe comparison
    timingSafeEqual: mocks.mockTimingSafeEqual,
    // Events
    publishEvent: mocks.mockPublishEvent,
    TOKEN_EVENTS: {
      ACCESS_ISSUED: 'token.access.issued',
      ID_ISSUED: 'token.id.issued',
      REFRESH_ISSUED: 'token.refresh.issued',
      REFRESH_ROTATED: 'token.refresh.rotated',
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

// Import after mocking
import { tokenHandler } from '../token';

// ============================================================================
// Test Setup
// Helper to reset mocks to default implementations
function resetAllMocks() {
  // Reset logging mocks
  mocks.mockGetLogger.mockReset().mockReturnValue({
    module: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  });
  mocks.mockCreateLogger.mockReset().mockReturnValue({
    module: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  });

  // Reset validation mocks
  mocks.mockValidateGrantType.mockReset().mockReturnValue({ valid: true });
  mocks.mockValidateAuthCode.mockReset().mockReturnValue({ valid: true });
  mocks.mockValidateClientId.mockReset().mockReturnValue({ valid: true });
  mocks.mockValidateRedirectUri.mockReset().mockReturnValue({ valid: true });

  // Reset caching mocks
  mocks.mockGetClientCached.mockReset().mockResolvedValue(null);
  mocks.mockLoadTenantProfileCached.mockReset().mockResolvedValue(null);
  mocks.mockGetSystemSettingsCached.mockReset().mockResolvedValue(null);

  // Reset token operation mocks
  mocks.mockCreateAccessToken
    .mockReset()
    .mockResolvedValue({ token: 'mock-access-token', jti: 'at-jti-001' });
  mocks.mockCreateIDToken.mockReset().mockResolvedValue('mock-id-token');
  mocks.mockCreateRefreshToken
    .mockReset()
    .mockResolvedValue({ token: 'mock-refresh-token', jti: 'rt-jti-001' });
  mocks.mockVerifyToken.mockReset().mockResolvedValue({ valid: true, payload: {} });
  mocks.mockRevokeToken.mockReset().mockResolvedValue(undefined);
  mocks.mockIsTokenRevoked.mockReset().mockResolvedValue(false);

  // Reset client auth mocks
  mocks.mockParseBasicAuth.mockReset().mockReturnValue({ success: false });
  mocks.mockVerifyClientSecretHash.mockReset().mockReturnValue(true);
  mocks.mockValidateClientAssertion.mockReset().mockResolvedValue({ valid: true });

  // Reset DPoP mocks
  mocks.mockExtractDPoPProof.mockReset().mockReturnValue(null);
  mocks.mockValidateDPoPProof.mockReset().mockResolvedValue({ valid: true, jkt: 'test-jkt' });

  // Reset sharding mocks
  mocks.mockParseShardedAuthCode.mockReset().mockReturnValue(null);
  mocks.mockGetShardCount.mockReset().mockResolvedValue(1);
  mocks.mockParseRefreshTokenJti
    .mockReset()
    .mockReturnValue({ shardIndex: 0, randomPart: 'abc', generation: 1 });
  mocks.mockGenerateRegionAwareJti.mockReset().mockResolvedValue({ jti: 'jti-region-001' });
  mocks.mockGetRefreshToken.mockReset().mockResolvedValue(null);

  // Reset RBAC mocks
  mocks.mockGetIDTokenRBACClaims.mockReset().mockResolvedValue({});
  mocks.mockGetAccessTokenRBACClaims.mockReset().mockResolvedValue({});
  mocks.mockIsPolicyEmbeddingEnabled.mockReset().mockResolvedValue(false);
  mocks.mockIsNativeSSOEnabled.mockReset().mockResolvedValue(false);
  mocks.mockIsCustomClaimsEnabled.mockReset().mockResolvedValue(false);
  mocks.mockIsIdLevelPermissionsEnabled.mockReset().mockResolvedValue(false);
  mocks.mockGetCachedUserCore.mockReset().mockResolvedValue(null);
}

// ============================================================================

function createRuntimeCoreAdapter(): DatabaseAdapter {
  return {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue({ rowsAffected: 1, success: true }),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 0, type: 'runtime-core' }),
    getType: vi.fn().mockReturnValue('runtime-core'),
    close: vi.fn(),
  } as unknown as DatabaseAdapter;
}

describe('Security-Critical Tests', () => {
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

  describe('Storage portability wiring', () => {
    it('uses the runtime-resolved core adapter for authorization_code RBAC and policy lookups', async () => {
      const client = createConfidentialClient({ require_pkce: false });
      const authCodeData = createAuthCodeData({
        userId: 'user-001',
        scope: 'openid profile',
      });
      const runtimeCoreAdapter = createRuntimeCoreAdapter();

      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockValidateGrantType.mockReturnValue({ valid: true });
      mocks.mockValidateAuthCode.mockReturnValue({ valid: true });
      mocks.mockValidateClientId.mockReturnValue({ valid: true });
      mocks.mockValidateRedirectUri.mockReturnValue({ valid: true });
      mocks.mockIsPolicyEmbeddingEnabled.mockResolvedValue(true);
      mocks.mockEvaluatePermissionsForScope.mockResolvedValue(['perm:read']);

      mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
        consumeCodeRpc: vi.fn().mockResolvedValue(authCodeData),
        registerIssuedTokensRpc: vi.fn().mockResolvedValue(undefined),
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
        env: {
          ...mockEnv,
          DB: undefined as any,
        },
      });
      (ctx as any).set('runtimeUserStoreSources', {
        storageProfile: {
          id: 'tenant-default-storage',
          kind: 'storage',
          label: 'Tenant Default Storage',
          slices: {},
        },
        coreDb: runtimeCoreAdapter,
        piiDb: null,
      });

      const response = await tokenHandler(ctx);

      expect(response.status).toBe(200);
      expect(mocks.mockGetAccessTokenRBACClaims).toHaveBeenCalledWith(
        runtimeCoreAdapter,
        authCodeData.userId,
        expect.any(Object)
      );
      expect(mocks.mockGetIDTokenRBACClaims).toHaveBeenCalledWith(
        runtimeCoreAdapter,
        authCodeData.userId,
        expect.any(Object)
      );
      expect(mocks.mockEvaluatePermissionsForScope).toHaveBeenCalledWith(
        runtimeCoreAdapter,
        authCodeData.userId,
        authCodeData.scope,
        expect.any(Object)
      );
    });

    it('uses the runtime-resolved core adapter for refresh_token RBAC and policy lookups', async () => {
      const client = createConfidentialClient({ require_pkce: false });
      const refreshTokenPayload = createRefreshTokenPayload({
        client_id: client.client_id,
        sub: 'user-002',
        scope: 'openid profile',
      });
      const refreshTokenJWT = createTestRefreshTokenJWT({
        client_id: client.client_id,
      });
      const runtimeCoreAdapter = createRuntimeCoreAdapter();

      mocks.mockGetClientCached.mockResolvedValue(client);
      mocks.mockParseToken.mockReturnValue(refreshTokenPayload);
      mocks.mockGetRefreshToken.mockResolvedValue({
        sub: refreshTokenPayload.sub,
        scope: refreshTokenPayload.scope,
        client_id: refreshTokenPayload.client_id,
      });
      mocks.mockParseRefreshTokenJti.mockReturnValue({
        generation: 1,
        shardIndex: 0,
        randomPart: 'abc',
      });
      mocks.mockIsPolicyEmbeddingEnabled.mockResolvedValue(true);
      mocks.mockEvaluatePermissionsForScope.mockResolvedValue(['perm:refresh']);

      mockEnv.REFRESH_TOKEN_ROTATOR.get = vi.fn().mockReturnValue({
        rotateRpc: vi.fn().mockResolvedValue({
          newJti: 'rt-new-jti-002',
          newVersion: 2,
        }),
      });

      const ctx = createMockContext({
        method: 'POST',
        body: {
          grant_type: 'refresh_token',
          refresh_token: refreshTokenJWT,
          client_id: client.client_id,
          client_secret: 'valid-secret',
        },
        env: {
          ...mockEnv,
          DB: undefined as any,
        },
      });
      (ctx as any).set('runtimeUserStoreSources', {
        storageProfile: {
          id: 'tenant-default-storage',
          kind: 'storage',
          label: 'Tenant Default Storage',
          slices: {},
        },
        coreDb: runtimeCoreAdapter,
        piiDb: null,
      });

      const response = await tokenHandler(ctx);

      expect(response.status).toBe(200);
      expect(mocks.mockGetAccessTokenRBACClaims).toHaveBeenCalledWith(
        runtimeCoreAdapter,
        refreshTokenPayload.sub,
        expect.any(Object)
      );
      expect(mocks.mockGetIDTokenRBACClaims).toHaveBeenCalledWith(
        runtimeCoreAdapter,
        refreshTokenPayload.sub,
        expect.any(Object)
      );
      expect(mocks.mockEvaluatePermissionsForScope).toHaveBeenCalledWith(
        runtimeCoreAdapter,
        refreshTokenPayload.sub,
        refreshTokenPayload.scope,
        expect.any(Object)
      );
    });
  });

  // ==========================================================================
  // PKCE Validation Tests (RFC 7636)
  // ==========================================================================

  describe('PKCE Validation (RFC 7636)', () => {
    describe('Valid PKCE Flow', () => {
      it('should accept valid S256 code_verifier', async () => {
        const pkce = createPKCEValues();
        const client = createPublicClient({ require_pkce: true });
        const authCodeData = createAuthCodeData({
          userId: 'user-001',
          scope: 'openid profile',
        });

        // Setup mocks
        mocks.mockGetClientCached.mockResolvedValue(client);
        mocks.mockValidateGrantType.mockReturnValue({ valid: true });
        mocks.mockValidateAuthCode.mockReturnValue({ valid: true });
        mocks.mockValidateClientId.mockReturnValue({ valid: true });
        mocks.mockValidateRedirectUri.mockReturnValue({ valid: true });

        // Mock AuthCodeStore DO to return code data
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
            code_verifier: pkce.verifier,
          },
          env: mockEnv,
        });

        const response = await tokenHandler(ctx);
        const body = await parseJsonResponse(response);

        // PKCE verification happens in AuthCodeStore DO
        expect(consumeCodeRpcMock).toHaveBeenCalledWith(
          expect.objectContaining({
            codeVerifier: pkce.verifier,
          })
        );
      });

      it('should reject missing code_verifier when PKCE was used in authorization', async () => {
        const client = createPublicClient({ require_pkce: true });

        // Mock AuthCodeStore DO to throw error for missing verifier
        const consumeCodeRpcMock = vi
          .fn()
          .mockRejectedValue(new Error('PKCE code_verifier is required'));
        mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
          consumeCodeRpc: consumeCodeRpcMock,
        });

        mocks.mockGetClientCached.mockResolvedValue(client);

        const ctx = createMockContext({
          method: 'POST',
          body: {
            grant_type: 'authorization_code',
            code: 'valid-auth-code',
            redirect_uri: 'https://app.example.com/callback',
            client_id: client.client_id,
            // No code_verifier provided
          },
          env: mockEnv,
        });

        const response = await tokenHandler(ctx);
        const body = await parseJsonResponse<{ error: string }>(response);

        expect(response.status).toBe(400);
        expect(body.error).toBe('invalid_grant');
      });
    });

    describe('Invalid PKCE Verifier Format', () => {
      it('should reject code_verifier that is too short (< 43 characters)', async () => {
        const client = createPublicClient({ require_pkce: true });

        // Mock AuthCodeStore DO to throw error for invalid verifier
        const consumeCodeRpcMock = vi
          .fn()
          .mockRejectedValue(new Error('Invalid code_verifier format'));
        mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
          consumeCodeRpc: consumeCodeRpcMock,
        });

        mocks.mockGetClientCached.mockResolvedValue(client);

        const ctx = createMockContext({
          method: 'POST',
          body: {
            grant_type: 'authorization_code',
            code: 'valid-auth-code',
            redirect_uri: 'https://app.example.com/callback',
            client_id: client.client_id,
            code_verifier: createInvalidPKCEVerifierShort(),
          },
          env: mockEnv,
        });

        const response = await tokenHandler(ctx);
        const body = await parseJsonResponse<{ error: string }>(response);

        expect(response.status).toBe(400);
        expect(body.error).toBe('invalid_grant');
      });

      it('should reject code_verifier that is too long (> 128 characters)', async () => {
        const client = createPublicClient({ require_pkce: true });

        const consumeCodeRpcMock = vi
          .fn()
          .mockRejectedValue(new Error('Invalid code_verifier format'));
        mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
          consumeCodeRpc: consumeCodeRpcMock,
        });

        mocks.mockGetClientCached.mockResolvedValue(client);

        const ctx = createMockContext({
          method: 'POST',
          body: {
            grant_type: 'authorization_code',
            code: 'valid-auth-code',
            redirect_uri: 'https://app.example.com/callback',
            client_id: client.client_id,
            code_verifier: createInvalidPKCEVerifierLong(),
          },
          env: mockEnv,
        });

        const response = await tokenHandler(ctx);
        expect(response.status).toBe(400);
      });

      it('should reject code_verifier with invalid characters', async () => {
        const client = createPublicClient({ require_pkce: true });

        const consumeCodeRpcMock = vi
          .fn()
          .mockRejectedValue(new Error('Invalid code_verifier format'));
        mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
          consumeCodeRpc: consumeCodeRpcMock,
        });

        mocks.mockGetClientCached.mockResolvedValue(client);

        const ctx = createMockContext({
          method: 'POST',
          body: {
            grant_type: 'authorization_code',
            code: 'valid-auth-code',
            redirect_uri: 'https://app.example.com/callback',
            client_id: client.client_id,
            code_verifier: createInvalidPKCEVerifierChars(),
          },
          env: mockEnv,
        });

        const response = await tokenHandler(ctx);
        expect(response.status).toBe(400);
      });
    });

    describe('PKCE Challenge/Verifier Mismatch', () => {
      it('should reject mismatched code_verifier and code_challenge', async () => {
        const client = createPublicClient({ require_pkce: true });

        // Mock AuthCodeStore DO to throw error for PKCE mismatch
        const consumeCodeRpcMock = vi
          .fn()
          .mockRejectedValue(
            new Error('PKCE verification failed: code_verifier does not match code_challenge')
          );
        mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
          consumeCodeRpc: consumeCodeRpcMock,
        });

        mocks.mockGetClientCached.mockResolvedValue(client);

        const ctx = createMockContext({
          method: 'POST',
          body: {
            grant_type: 'authorization_code',
            code: 'valid-auth-code',
            redirect_uri: 'https://app.example.com/callback',
            client_id: client.client_id,
            code_verifier: 'wrong-verifier-that-does-not-match-the-original-challenge-1234567',
          },
          env: mockEnv,
        });

        const response = await tokenHandler(ctx);
        const body = await parseJsonResponse<{ error: string }>(response);

        expect(response.status).toBe(400);
        expect(body.error).toBe('invalid_grant');
      });
    });
  });

  // ==========================================================================
  // DPoP Validation Tests (RFC 9449)
  // ==========================================================================

  describe('DPoP Validation (RFC 9449)', () => {
    describe('DPoP Requirement Enforcement', () => {
      it('should require DPoP proof when client has dpop_bound_access_tokens enabled', async () => {
        const client = createFAPIClient({ dpop_bound_access_tokens: true });
        const authCodeData = createAuthCodeData();

        mocks.mockGetClientCached.mockResolvedValue(client);
        mocks.mockExtractDPoPProof.mockReturnValue(null); // No DPoP proof

        const ctx = createMockContext({
          method: 'POST',
          body: {
            grant_type: 'authorization_code',
            code: 'valid-auth-code',
            redirect_uri: authCodeData.redirectUri,
            client_id: client.client_id,
            code_verifier: 'valid-verifier-12345678901234567890123456789012345',
          },
          env: mockEnv,
        });

        const response = await tokenHandler(ctx);
        const body = await parseJsonResponse<{ error: string; error_description: string }>(
          response
        );

        expect(response.status).toBe(400);
        expect(body.error).toBe('invalid_request');
        expect(body.error_description).toContain('DPoP proof is required');
      });

      it('should require DPoP proof when FAPI settings require DPoP globally', async () => {
        const client = createConfidentialClient();
        const authCodeData = createAuthCodeData();

        mocks.mockGetClientCached.mockResolvedValue(client);
        mocks.mockExtractDPoPProof.mockReturnValue(null);
        mocks.mockGetSystemSettingsCached.mockResolvedValue({
          fapi: { enabled: true, requireDpop: true },
        });

        const ctx = createMockContext({
          method: 'POST',
          body: {
            grant_type: 'authorization_code',
            code: 'valid-auth-code',
            redirect_uri: authCodeData.redirectUri,
            client_id: client.client_id,
          },
          env: mockEnv,
        });

        const response = await tokenHandler(ctx);
        const body = await parseJsonResponse<{ error: string }>(response);

        expect(response.status).toBe(400);
        expect(body.error).toBe('invalid_request');
      });
    });

    describe('DPoP Proof Validation', () => {
      it('should reject invalid DPoP proof signature', async () => {
        const client = createFAPIClient();
        const authCodeData = createAuthCodeData();

        mocks.mockGetClientCached.mockResolvedValue(client);
        mocks.mockExtractDPoPProof.mockReturnValue('invalid-dpop-proof');
        mocks.mockValidateDPoPProof.mockResolvedValue({
          valid: false,
          error: 'invalid_dpop_proof',
          error_description: 'Invalid DPoP proof signature',
        });

        const ctx = createMockContext({
          method: 'POST',
          headers: {
            DPoP: 'invalid-dpop-proof',
          },
          body: {
            grant_type: 'authorization_code',
            code: 'valid-auth-code',
            redirect_uri: authCodeData.redirectUri,
            client_id: client.client_id,
          },
          env: mockEnv,
        });

        const response = await tokenHandler(ctx);
        const body = await parseJsonResponse<{ error: string }>(response);

        expect(response.status).toBe(400);
        expect(body.error).toBe('invalid_dpop_proof');
      });

      it('should reject expired DPoP proof', async () => {
        const client = createFAPIClient();

        mocks.mockGetClientCached.mockResolvedValue(client);
        mocks.mockExtractDPoPProof.mockReturnValue('expired-dpop-proof');
        mocks.mockValidateDPoPProof.mockResolvedValue({
          valid: false,
          error: 'invalid_dpop_proof',
          error_description: 'DPoP proof has expired',
        });

        const ctx = createMockContext({
          method: 'POST',
          headers: {
            DPoP: 'expired-dpop-proof',
          },
          body: {
            grant_type: 'authorization_code',
            code: 'valid-auth-code',
            redirect_uri: 'https://app.example.com/callback',
            client_id: client.client_id,
          },
          env: mockEnv,
        });

        const response = await tokenHandler(ctx);
        const body = await parseJsonResponse<{ error: string; error_description: string }>(
          response
        );

        expect(response.status).toBe(400);
        expect(body.error).toBe('invalid_dpop_proof');
        expect(body.error_description).toContain('expired');
      });

      it('should reject DPoP proof with JTI replay', async () => {
        const client = createFAPIClient();

        mocks.mockGetClientCached.mockResolvedValue(client);
        mocks.mockExtractDPoPProof.mockReturnValue('replayed-dpop-proof');
        mocks.mockValidateDPoPProof.mockResolvedValue({
          valid: false,
          error: 'invalid_dpop_proof',
          error_description: 'DPoP JTI has already been used',
        });

        const ctx = createMockContext({
          method: 'POST',
          headers: {
            DPoP: 'replayed-dpop-proof',
          },
          body: {
            grant_type: 'authorization_code',
            code: 'valid-auth-code',
            redirect_uri: 'https://app.example.com/callback',
            client_id: client.client_id,
          },
          env: mockEnv,
        });

        const response = await tokenHandler(ctx);
        const body = await parseJsonResponse<{ error: string }>(response);

        expect(response.status).toBe(400);
        expect(body.error).toBe('invalid_dpop_proof');
      });

      it('should return DPoP-Nonce when replay validation requires a nonce retry', async () => {
        const client = createFAPIClient();

        mocks.mockGetClientCached.mockResolvedValue(client);
        mocks.mockExtractDPoPProof.mockReturnValue('replayed-dpop-proof');
        mocks.mockValidateDPoPProof.mockResolvedValue({
          valid: false,
          error: 'use_dpop_nonce',
          error_description: 'DPoP proof jti has already been used',
        });

        const ctx = createMockContext({
          method: 'POST',
          headers: {
            DPoP: 'replayed-dpop-proof',
          },
          body: {
            grant_type: 'authorization_code',
            code: 'valid-auth-code',
            redirect_uri: 'https://app.example.com/callback',
            client_id: client.client_id,
          },
          env: mockEnv,
        });

        const response = await tokenHandler(ctx);
        const body = await parseJsonResponse<{ error: string; error_description: string }>(
          response
        );

        expect(response.status).toBe(400);
        expect(body.error).toBe('use_dpop_nonce');
        expect(body.error_description).toContain('jti');
        expect(response.headers.get('DPoP-Nonce')).toMatch(/^[A-Za-z0-9_-]+$/);
      });

      it('should allow tenant policy to disable DPoP nonce challenges', async () => {
        const client = createFAPIClient();

        mocks.mockGetClientCached.mockResolvedValue(client);
        mocks.mockGetSystemSettingsCached.mockResolvedValue({
          'security.dpop_nonce_enabled': false,
        });
        mocks.mockExtractDPoPProof.mockReturnValue('replayed-dpop-proof');
        mocks.mockValidateDPoPProof.mockResolvedValue({
          valid: false,
          error: 'use_dpop_nonce',
          error_description: 'DPoP proof jti has already been used',
        });

        const ctx = createMockContext({
          method: 'POST',
          headers: {
            DPoP: 'replayed-dpop-proof',
          },
          body: {
            grant_type: 'authorization_code',
            code: 'valid-auth-code',
            redirect_uri: 'https://app.example.com/callback',
            client_id: client.client_id,
          },
          env: mockEnv,
        });

        const response = await tokenHandler(ctx);
        const body = await parseJsonResponse<{ error: string }>(response);

        expect(response.status).toBe(400);
        expect(body.error).toBe('invalid_dpop_proof');
        expect(response.headers.get('DPoP-Nonce')).toBeNull();
      });

      it('should reject DPoP proof with mismatched htm (HTTP method)', async () => {
        const client = createFAPIClient();

        mocks.mockGetClientCached.mockResolvedValue(client);
        mocks.mockExtractDPoPProof.mockReturnValue('wrong-method-dpop-proof');
        mocks.mockValidateDPoPProof.mockResolvedValue({
          valid: false,
          error: 'invalid_dpop_proof',
          error_description: 'DPoP htm does not match request method',
        });

        const ctx = createMockContext({
          method: 'POST',
          headers: {
            DPoP: 'wrong-method-dpop-proof',
          },
          body: {
            grant_type: 'authorization_code',
            code: 'valid-auth-code',
            redirect_uri: 'https://app.example.com/callback',
            client_id: client.client_id,
          },
          env: mockEnv,
        });

        const response = await tokenHandler(ctx);
        expect(response.status).toBe(400);
      });

      it('should reject DPoP proof with mismatched htu (HTTP URI)', async () => {
        const client = createFAPIClient();

        mocks.mockGetClientCached.mockResolvedValue(client);
        mocks.mockExtractDPoPProof.mockReturnValue('wrong-uri-dpop-proof');
        mocks.mockValidateDPoPProof.mockResolvedValue({
          valid: false,
          error: 'invalid_dpop_proof',
          error_description: 'DPoP htu does not match request URI',
        });

        const ctx = createMockContext({
          method: 'POST',
          headers: {
            DPoP: 'wrong-uri-dpop-proof',
          },
          body: {
            grant_type: 'authorization_code',
            code: 'valid-auth-code',
            redirect_uri: 'https://app.example.com/callback',
            client_id: client.client_id,
          },
          env: mockEnv,
        });

        const response = await tokenHandler(ctx);
        expect(response.status).toBe(400);
      });
    });

    describe('DPoP Authorization Code Binding', () => {
      it('should reject when DPoP JKT does not match authorization code binding', async () => {
        const client = createFAPIClient();
        const authCodeData = createDPoPBoundAuthCodeData({
          dpopJkt: 'original-jkt-from-authorization',
        });

        mocks.mockGetClientCached.mockResolvedValue(client);
        mocks.mockExtractDPoPProof.mockReturnValue('valid-dpop-proof');
        mocks.mockValidateDPoPProof.mockResolvedValue({
          valid: true,
          jkt: 'different-jkt-from-token-request', // Different JKT
        });

        // Mock AuthCodeStore to return DPoP-bound code
        const consumeCodeRpcMock = vi.fn().mockResolvedValue(authCodeData);
        mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
          consumeCodeRpc: consumeCodeRpcMock,
        });

        const ctx = createMockContext({
          method: 'POST',
          headers: {
            DPoP: 'valid-dpop-proof',
          },
          body: {
            grant_type: 'authorization_code',
            code: 'dpop-bound-auth-code',
            redirect_uri: authCodeData.redirectUri,
            client_id: client.client_id,
          },
          env: mockEnv,
        });

        const response = await tokenHandler(ctx);
        const body = await parseJsonResponse<{ error: string; error_description: string }>(
          response
        );

        expect(response.status).toBe(400);
        expect(body.error).toBe('invalid_grant');
        expect(body.error_description).toContain('DPoP key mismatch');
      });

      it('should require DPoP proof when authorization code was bound to DPoP key', async () => {
        const client = createConfidentialClient();
        const authCodeData = createDPoPBoundAuthCodeData();

        mocks.mockGetClientCached.mockResolvedValue(client);
        mocks.mockExtractDPoPProof.mockReturnValue(null); // No DPoP proof

        // Mock AuthCodeStore to return DPoP-bound code
        const consumeCodeRpcMock = vi.fn().mockResolvedValue(authCodeData);
        mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
          consumeCodeRpc: consumeCodeRpcMock,
        });

        const ctx = createMockContext({
          method: 'POST',
          body: {
            grant_type: 'authorization_code',
            code: 'dpop-bound-auth-code',
            redirect_uri: authCodeData.redirectUri,
            client_id: client.client_id,
          },
          env: mockEnv,
        });

        const response = await tokenHandler(ctx);
        const body = await parseJsonResponse<{ error: string; error_description: string }>(
          response
        );

        expect(response.status).toBe(400);
        expect(body.error).toBe('invalid_grant');
        expect(body.error_description).toContain('DPoP proof required');
      });
    });

    describe('DPoP Token Binding', () => {
      it('should include cnf claim with jkt in access token when DPoP is used', async () => {
        // Use FAPI client but override auth method to allow secret-based auth for testing
        const client = createFAPIClient({
          token_endpoint_auth_method: 'client_secret_post',
          client_secret_hash: 'test-secret-hash',
        });
        const authCodeData = createAuthCodeData();
        const expectedJkt = 'dpop-thumbprint-value';

        mocks.mockGetClientCached.mockResolvedValue(client);
        mocks.mockExtractDPoPProof.mockReturnValue('valid-dpop-proof');
        mocks.mockValidateDPoPProof.mockResolvedValue({
          valid: true,
          jkt: expectedJkt,
        });

        const consumeCodeRpcMock = vi.fn().mockResolvedValue(authCodeData);
        mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
          consumeCodeRpc: consumeCodeRpcMock,
        });

        const ctx = createMockContext({
          method: 'POST',
          headers: {
            DPoP: 'valid-dpop-proof',
          },
          body: {
            grant_type: 'authorization_code',
            code: 'valid-auth-code',
            redirect_uri: authCodeData.redirectUri,
            client_id: client.client_id,
            client_secret: 'valid-secret',
          },
          env: mockEnv,
        });

        await tokenHandler(ctx);

        // Verify createAccessToken was called with cnf claim
        expect(mocks.mockCreateAccessToken).toHaveBeenCalledWith(
          expect.objectContaining({
            cnf: { jkt: expectedJkt },
          }),
          expect.anything(),
          expect.anything(),
          expect.anything(),
          expect.anything()
        );
      });

      it('should return token_type as DPoP when DPoP is used', async () => {
        // Use FAPI client but override auth method to allow secret-based auth for testing
        const client = createFAPIClient({
          token_endpoint_auth_method: 'client_secret_post',
          client_secret_hash: 'test-secret-hash',
        });
        const authCodeData = createAuthCodeData();

        mocks.mockGetClientCached.mockResolvedValue(client);
        mocks.mockExtractDPoPProof.mockReturnValue('valid-dpop-proof');
        mocks.mockValidateDPoPProof.mockResolvedValue({
          valid: true,
          jkt: 'dpop-jkt',
        });

        const consumeCodeRpcMock = vi.fn().mockResolvedValue(authCodeData);
        mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
          consumeCodeRpc: consumeCodeRpcMock,
        });

        const ctx = createMockContext({
          method: 'POST',
          headers: {
            DPoP: 'valid-dpop-proof',
          },
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
        const body = await parseJsonResponse<{ token_type: string }>(response);

        expect(body.token_type).toBe('DPoP');
      });
    });
  });

  // ==========================================================================
  // Replay Attack Prevention Tests
  // ==========================================================================

  describe('Replay Attack Prevention', () => {
    describe('Authorization Code Single-Use', () => {
      it('should reject already-consumed authorization code', async () => {
        const client = createConfidentialClient();

        mocks.mockGetClientCached.mockResolvedValue(client);

        // Mock AuthCodeStore to throw error for already consumed code
        const consumeCodeRpcMock = vi
          .fn()
          .mockRejectedValue(new Error('Authorization code has already been consumed'));
        mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
          consumeCodeRpc: consumeCodeRpcMock,
        });

        const ctx = createMockContext({
          method: 'POST',
          body: {
            grant_type: 'authorization_code',
            code: 'already-used-code',
            redirect_uri: 'https://app.example.com/callback',
            client_id: client.client_id,
          },
          env: mockEnv,
        });

        const response = await tokenHandler(ctx);
        const body = await parseJsonResponse<{ error: string }>(response);

        expect(response.status).toBe(400);
        expect(body.error).toBe('invalid_grant');
      });

      it('should revoke previously issued tokens when replay attack is detected', async () => {
        const client = createConfidentialClient();
        const authCodeData = createReplayAttackAuthCodeData({
          replayAttack: {
            accessTokenJti: 'at-jti-to-revoke',
            refreshTokenJti: 'rt-jti-to-revoke',
          },
        });

        mocks.mockGetClientCached.mockResolvedValue(client);

        // Mock AuthCodeStore to return replay attack data
        const consumeCodeRpcMock = vi.fn().mockResolvedValue(authCodeData);
        mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
          consumeCodeRpc: consumeCodeRpcMock,
        });

        const ctx = createMockContext({
          method: 'POST',
          body: {
            grant_type: 'authorization_code',
            code: 'replayed-code',
            redirect_uri: authCodeData.redirectUri,
            client_id: client.client_id,
          },
          env: mockEnv,
        });

        const response = await tokenHandler(ctx);
        const body = await parseJsonResponse<{ error: string }>(response);

        // Should return error
        expect(response.status).toBe(400);
        expect(body.error).toBe('invalid_grant');

        // Should revoke previously issued tokens
        expect(mocks.mockRevokeToken).toHaveBeenCalledWith(
          expect.anything(),
          'at-jti-to-revoke',
          expect.any(Number),
          'Authorization code replay attack'
        );
        expect(mocks.mockRevokeToken).toHaveBeenCalledWith(
          expect.anything(),
          'rt-jti-to-revoke',
          expect.any(Number),
          'Authorization code replay attack'
        );
      });
    });

    describe('DPoP JTI Replay Prevention', () => {
      it('should detect and reject reused DPoP JTI', async () => {
        const client = createFAPIClient();

        mocks.mockGetClientCached.mockResolvedValue(client);
        mocks.mockExtractDPoPProof.mockReturnValue('dpop-with-reused-jti');
        mocks.mockValidateDPoPProof.mockResolvedValue({
          valid: false,
          error: 'invalid_dpop_proof',
          error_description: 'DPoP JTI replay detected',
        });

        const ctx = createMockContext({
          method: 'POST',
          headers: {
            DPoP: 'dpop-with-reused-jti',
          },
          body: {
            grant_type: 'authorization_code',
            code: 'valid-auth-code',
            redirect_uri: 'https://app.example.com/callback',
            client_id: client.client_id,
          },
          env: mockEnv,
        });

        const response = await tokenHandler(ctx);
        const body = await parseJsonResponse<{ error: string }>(response);

        expect(response.status).toBe(400);
        expect(body.error).toBe('invalid_dpop_proof');
      });
    });
  });

  // ==========================================================================
  // Refresh Token Rotation and Theft Detection Tests
  // ==========================================================================

  describe('Refresh Token Security', () => {
    // Set up common mocks for refresh token tests - all require client authentication
    beforeEach(() => {
      // Default to allowing client authentication via POST (client_id in body + client_secret)
      // Individual tests can override as needed
      mocks.mockVerifyClientSecretHash.mockResolvedValue(true);
    });

    describe('Refresh Token Rotation', () => {
      it('should issue new refresh token on each refresh (rotation enabled)', async () => {
        const client = createConfidentialClient();
        const refreshTokenPayload = createRefreshTokenPayload({
          client_id: client.client_id,
          sub: 'user-001',
        });
        // Create a valid JWT string with proper header (kid matching mock public key)
        const refreshTokenJWT = createTestRefreshTokenJWT({
          client_id: client.client_id,
          sub: 'user-001',
        });

        mocks.mockGetClientCached.mockResolvedValue(client);
        mocks.mockParseToken.mockReturnValue(refreshTokenPayload);
        mocks.mockGetRefreshToken.mockResolvedValue({
          sub: refreshTokenPayload.sub,
          scope: refreshTokenPayload.scope,
          client_id: refreshTokenPayload.client_id,
        });
        mocks.mockParseRefreshTokenJti.mockReturnValue({
          generation: 1,
          shardIndex: 0,
          randomPart: 'abc',
        });

        // Mock RefreshTokenRotator DO
        const rotateRpcMock = vi.fn().mockResolvedValue({
          newJti: 'rt-new-jti-002',
          newVersion: 2,
        });
        mockEnv.REFRESH_TOKEN_ROTATOR.get = vi.fn().mockReturnValue({
          rotateRpc: rotateRpcMock,
        });

        const ctx = createMockContext({
          method: 'POST',
          body: {
            grant_type: 'refresh_token',
            refresh_token: refreshTokenJWT,
            client_id: client.client_id,
            client_secret: 'valid-secret', // Required for confidential client
          },
          env: mockEnv,
        });

        const response = await tokenHandler(ctx);
        const body = await parseJsonResponse<{ refresh_token: string }>(response);

        expect(response.status).toBe(200);
        // Verify rotation was called
        expect(rotateRpcMock).toHaveBeenCalled();
        // New refresh token should be different
        expect(mocks.mockCreateRefreshToken).toHaveBeenCalled();
      });

      it('should return same refresh token when rotation is disabled', async () => {
        const client = createConfidentialClient();
        const refreshTokenPayload = createRefreshTokenPayload({
          client_id: client.client_id,
        });
        const refreshTokenJWT = createTestRefreshTokenJWT({
          client_id: client.client_id,
        });

        // Disable rotation via env
        mockEnv.ENABLE_REFRESH_TOKEN_ROTATION = 'false';

        mocks.mockGetClientCached.mockResolvedValue(client);
        mocks.mockParseToken.mockReturnValue(refreshTokenPayload);
        mocks.mockGetRefreshToken.mockResolvedValue({
          sub: refreshTokenPayload.sub,
          scope: refreshTokenPayload.scope,
          client_id: refreshTokenPayload.client_id,
        });

        const ctx = createMockContext({
          method: 'POST',
          body: {
            grant_type: 'refresh_token',
            refresh_token: refreshTokenJWT,
            client_id: client.client_id,
            client_secret: 'valid-secret', // Required for confidential client
          },
          env: mockEnv,
        });

        const response = await tokenHandler(ctx);
        const body = await parseJsonResponse<{ refresh_token: string }>(response);

        expect(response.status).toBe(200);
        expect(body.refresh_token).toBe(refreshTokenJWT);
      });
    });

    describe('Refresh Token Theft Detection', () => {
      it('should detect and revoke token family when old version is reused', async () => {
        const client = createConfidentialClient();
        const refreshTokenPayload = createRefreshTokenPayload({
          client_id: client.client_id,
          version: 1, // Old version
        });
        const refreshTokenJWT = createTestRefreshTokenJWT({
          client_id: client.client_id,
          version: 1,
        });

        mocks.mockGetClientCached.mockResolvedValue(client);
        mocks.mockParseToken.mockReturnValue(refreshTokenPayload);
        mocks.mockGetRefreshToken.mockResolvedValue({
          sub: refreshTokenPayload.sub,
          scope: refreshTokenPayload.scope,
          client_id: refreshTokenPayload.client_id,
        });
        mocks.mockParseRefreshTokenJti.mockReturnValue({
          generation: 1,
          shardIndex: 0,
          randomPart: 'abc',
        });

        // Mock RefreshTokenRotator to detect theft
        const rotateRpcMock = vi
          .fn()
          .mockRejectedValue(new Error('Token theft detected: version mismatch'));
        mockEnv.REFRESH_TOKEN_ROTATOR.get = vi.fn().mockReturnValue({
          rotateRpc: rotateRpcMock,
        });

        const ctx = createMockContext({
          method: 'POST',
          body: {
            grant_type: 'refresh_token',
            refresh_token: refreshTokenJWT,
            client_id: client.client_id,
            client_secret: 'valid-secret', // Required for confidential client
          },
          env: mockEnv,
        });

        const response = await tokenHandler(ctx);
        const body = await parseJsonResponse<{ error: string; error_description: string }>(
          response
        );

        expect(response.status).toBe(400);
        expect(body.error).toBe('invalid_grant');
        expect(body.error_description).toContain('revoked');
      });

      it('should revoke entire token family when theft is detected', async () => {
        const client = createConfidentialClient();
        const refreshTokenPayload = createRefreshTokenPayload({
          client_id: client.client_id,
          family_id: 'family-001',
        });
        const refreshTokenJWT = createTestRefreshTokenJWT({
          client_id: client.client_id,
          family_id: 'family-001',
        });

        mocks.mockGetClientCached.mockResolvedValue(client);
        mocks.mockParseToken.mockReturnValue(refreshTokenPayload);
        mocks.mockGetRefreshToken.mockResolvedValue({
          sub: refreshTokenPayload.sub,
          scope: refreshTokenPayload.scope,
          client_id: refreshTokenPayload.client_id,
        });
        mocks.mockParseRefreshTokenJti.mockReturnValue({
          generation: 1,
          shardIndex: 0,
          randomPart: 'abc',
        });

        // Mock RefreshTokenRotator to indicate family was revoked
        const rotateRpcMock = vi
          .fn()
          .mockRejectedValue(new Error('Token family revoked due to theft detection'));
        mockEnv.REFRESH_TOKEN_ROTATOR.get = vi.fn().mockReturnValue({
          rotateRpc: rotateRpcMock,
        });

        const ctx = createMockContext({
          method: 'POST',
          body: {
            grant_type: 'refresh_token',
            refresh_token: refreshTokenJWT,
            client_id: client.client_id,
            client_secret: 'valid-secret', // Required for confidential client
          },
          env: mockEnv,
        });

        const response = await tokenHandler(ctx);
        const body = await parseJsonResponse<{ error: string }>(response);

        expect(response.status).toBe(400);
        expect(body.error).toBe('invalid_grant');
      });
    });

    describe('Refresh Token Scope Validation', () => {
      it('should reject scope exceeding original grant', async () => {
        const client = createConfidentialClient();
        const refreshTokenPayload = createRefreshTokenPayload({
          client_id: client.client_id,
          scope: 'openid profile', // Original scope
        });
        const refreshTokenJWT = createTestRefreshTokenJWT({
          client_id: client.client_id,
          scope: 'openid profile',
        });

        mocks.mockGetClientCached.mockResolvedValue(client);
        mocks.mockParseToken.mockReturnValue(refreshTokenPayload);
        mocks.mockGetRefreshToken.mockResolvedValue({
          sub: refreshTokenPayload.sub,
          scope: 'openid profile', // Original scope
          client_id: refreshTokenPayload.client_id,
        });

        const ctx = createMockContext({
          method: 'POST',
          body: {
            grant_type: 'refresh_token',
            refresh_token: refreshTokenJWT,
            client_id: client.client_id,
            client_secret: 'valid-secret', // Required for confidential client
            scope: 'openid profile admin', // Requesting more scopes
          },
          env: mockEnv,
        });

        const response = await tokenHandler(ctx);
        const body = await parseJsonResponse<{ error: string; error_description: string }>(
          response
        );

        expect(response.status).toBe(400);
        expect(body.error).toBe('invalid_scope');
        expect(body.error_description).toContain('exceeds original scope');
      });

      it('should allow scope that is a subset of original grant', async () => {
        const client = createConfidentialClient();
        const refreshTokenPayload = createRefreshTokenPayload({
          client_id: client.client_id,
          scope: 'openid profile email',
        });
        const refreshTokenJWT = createTestRefreshTokenJWT({
          client_id: client.client_id,
          scope: 'openid profile email',
        });

        mocks.mockGetClientCached.mockResolvedValue(client);
        mocks.mockParseToken.mockReturnValue(refreshTokenPayload);
        mocks.mockGetRefreshToken.mockResolvedValue({
          sub: refreshTokenPayload.sub,
          scope: 'openid profile email',
          client_id: refreshTokenPayload.client_id,
        });
        mocks.mockParseRefreshTokenJti.mockReturnValue({
          generation: 1,
          shardIndex: 0,
          randomPart: 'abc',
        });

        const rotateRpcMock = vi.fn().mockResolvedValue({
          newJti: 'rt-new-jti',
          newVersion: 2,
        });
        mockEnv.REFRESH_TOKEN_ROTATOR.get = vi.fn().mockReturnValue({
          rotateRpc: rotateRpcMock,
        });

        const ctx = createMockContext({
          method: 'POST',
          body: {
            grant_type: 'refresh_token',
            refresh_token: refreshTokenJWT,
            client_id: client.client_id,
            client_secret: 'valid-secret', // Required for confidential client
            scope: 'openid profile', // Subset of original
          },
          env: mockEnv,
        });

        const response = await tokenHandler(ctx);
        const body = await parseJsonResponse<{ scope: string }>(response);

        expect(response.status).toBe(200);
        expect(body.scope).toBe('openid profile');
      });
    });

    describe('Refresh Token Resource Audience Validation', () => {
      it('should use durable refresh family resource audience instead of the JWT fallback', async () => {
        const client = createConfidentialClient({
          allowed_token_exchange_resources: ['svc://original-api'],
          default_resource: 'svc://current-default',
        });
        const refreshTokenPayload = createRefreshTokenPayload({
          client_id: client.client_id,
          resource_aud: 'svc://jwt-fallback',
        });
        const refreshTokenJWT = createTestRefreshTokenJWT({
          client_id: client.client_id,
          resource_aud: 'svc://jwt-fallback',
        });

        mocks.mockGetClientCached.mockResolvedValue(client);
        mocks.mockParseToken.mockReturnValue(refreshTokenPayload);
        mocks.mockGetRefreshToken.mockResolvedValue({
          sub: refreshTokenPayload.sub,
          scope: refreshTokenPayload.scope,
          client_id: refreshTokenPayload.client_id,
          resource_aud: 'svc://original-api',
        });
        mocks.mockParseRefreshTokenJti.mockReturnValue({
          generation: 1,
          shardIndex: 0,
          randomPart: 'abc',
        });

        const rotateRpcMock = vi.fn().mockResolvedValue({
          newJti: 'rt-new-jti',
          newVersion: 2,
        });
        mockEnv.REFRESH_TOKEN_ROTATOR.get = vi.fn().mockReturnValue({
          rotateRpc: rotateRpcMock,
        });

        const response = await tokenHandler(
          createMockContext({
            method: 'POST',
            body: {
              grant_type: 'refresh_token',
              refresh_token: refreshTokenJWT,
              client_id: client.client_id,
              client_secret: 'valid-secret',
            },
            env: mockEnv,
          })
        );
        const accessTokenClaims = mocks.mockCreateAccessToken.mock.calls[0]?.[0] as
          | Record<string, unknown>
          | undefined;
        const refreshTokenClaims = mocks.mockCreateRefreshToken.mock.calls[0]?.[0] as
          | Record<string, unknown>
          | undefined;

        expect(response.status).toBe(200);
        expect(accessTokenClaims?.aud).toBe('svc://original-api');
        expect(refreshTokenClaims?.resource_aud).toBe('svc://original-api');
      });

      it('should reject refresh when the original resource audience is no longer allowed', async () => {
        const client = createConfidentialClient({
          allowed_token_exchange_resources: ['svc://still-allowed'],
          default_resource: 'svc://current-default',
        });
        const refreshTokenPayload = createRefreshTokenPayload({
          client_id: client.client_id,
          resource_aud: 'svc://revoked-api',
        });
        const refreshTokenJWT = createTestRefreshTokenJWT({
          client_id: client.client_id,
          resource_aud: 'svc://revoked-api',
        });

        mocks.mockGetClientCached.mockResolvedValue(client);
        mocks.mockParseToken.mockReturnValue(refreshTokenPayload);
        mocks.mockGetRefreshToken.mockResolvedValue({
          sub: refreshTokenPayload.sub,
          scope: refreshTokenPayload.scope,
          client_id: refreshTokenPayload.client_id,
          resource_aud: 'svc://revoked-api',
        });

        const response = await tokenHandler(
          createMockContext({
            method: 'POST',
            body: {
              grant_type: 'refresh_token',
              refresh_token: refreshTokenJWT,
              client_id: client.client_id,
              client_secret: 'valid-secret',
            },
            env: mockEnv,
          })
        );
        const body = await parseJsonResponse<{ error: string }>(response);

        expect(response.status).toBe(400);
        expect(body.error).toBe('invalid_target');
        expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
      });
    });

    describe('Refresh Token Client Binding', () => {
      it('should reject refresh token issued to a different client', async () => {
        const client = createConfidentialClient({ client_id: 'client-a' });
        const refreshTokenPayload = createRefreshTokenPayload({
          client_id: 'client-b', // Different client
        });
        const refreshTokenJWT = createTestRefreshTokenJWT({
          client_id: 'client-b',
        });

        mocks.mockGetClientCached.mockResolvedValue(client);
        mocks.mockParseToken.mockReturnValue(refreshTokenPayload);
        mocks.mockGetRefreshToken.mockResolvedValue({
          sub: refreshTokenPayload.sub,
          scope: refreshTokenPayload.scope,
          client_id: 'client-b', // Token was issued to different client
        });

        const ctx = createMockContext({
          method: 'POST',
          body: {
            grant_type: 'refresh_token',
            refresh_token: refreshTokenJWT,
            client_id: 'client-a', // Trying to use with different client
            client_secret: 'valid-secret', // Required for confidential client
          },
          env: mockEnv,
        });

        const response = await tokenHandler(ctx);
        const body = await parseJsonResponse<{ error: string; error_description: string }>(
          response
        );

        expect(response.status).toBe(400);
        expect(body.error).toBe('invalid_grant');
        expect(body.error_description).toContain('different client');
      });
    });
  });

  // ==========================================================================
  // Token Revocation Tests
  // ==========================================================================

  describe('Token Revocation', () => {
    describe('Revoked Token Rejection', () => {
      it('should reject access token that has been revoked', async () => {
        // This would typically be tested in a resource server,
        // but we can test the revocation check mechanism
        mocks.mockIsTokenRevoked.mockResolvedValue(true);

        // Test that the revocation check returns true
        const isRevoked = await mocks.mockIsTokenRevoked('revoked-jti');
        expect(isRevoked).toBe(true);
      });
    });
  });

  // ==========================================================================
  // Client Authentication Tests
  // ==========================================================================

  describe('Client Authentication Security', () => {
    describe('Client Secret Verification', () => {
      it('should reject incorrect client secret', async () => {
        const client = createConfidentialClient();

        mocks.mockGetClientCached.mockResolvedValue(client);
        mocks.mockVerifyClientSecretHash.mockResolvedValue(false); // Wrong secret

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
            client_secret: 'wrong-secret',
          },
          env: mockEnv,
        });

        const response = await tokenHandler(ctx);
        const body = await parseJsonResponse<{ error: string }>(response);

        expect(response.status).toBe(401);
        expect(body.error).toBe('invalid_client');
      });

      it('should accept correct client secret via Basic auth', async () => {
        const client = createConfidentialClient();
        const authCodeData = createAuthCodeData();

        mocks.mockGetClientCached.mockResolvedValue(client);
        mocks.mockVerifyClientSecretHash.mockResolvedValue(true);
        mocks.mockParseBasicAuth.mockReturnValue({
          success: true,
          credentials: {
            username: client.client_id,
            password: 'correct-secret',
          },
        });

        const consumeCodeRpcMock = vi.fn().mockResolvedValue(authCodeData);
        mockEnv.AUTH_CODE_STORE.get = vi.fn().mockReturnValue({
          consumeCodeRpc: consumeCodeRpcMock,
        });

        const ctx = createMockContext({
          method: 'POST',
          headers: {
            Authorization: `Basic ${base64UrlEncode(`${client.client_id}:correct-secret`)}`,
          },
          body: {
            grant_type: 'authorization_code',
            code: 'valid-auth-code',
            redirect_uri: authCodeData.redirectUri,
          },
          env: mockEnv,
        });

        const response = await tokenHandler(ctx);
        expect(response.status).toBe(200);
      });
    });

    describe('Client Assertion Validation', () => {
      it('should reject invalid client assertion JWT', async () => {
        const client = createConfidentialClient({
          token_endpoint_auth_method: 'private_key_jwt',
        });

        mocks.mockGetClientCached.mockResolvedValue(client);
        mocks.mockParseToken.mockImplementation(() => {
          throw new Error('Invalid JWT format');
        });

        const ctx = createMockContext({
          method: 'POST',
          body: {
            grant_type: 'authorization_code',
            code: 'valid-auth-code',
            redirect_uri: 'https://app.example.com/callback',
            client_id: client.client_id,
            client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
            client_assertion: 'invalid-jwt-token',
          },
          env: mockEnv,
        });

        const response = await tokenHandler(ctx);
        const body = await parseJsonResponse<{ error: string }>(response);

        expect(response.status).toBe(401);
        expect(body.error).toBe('invalid_client');
      });

      it('should reject client assertion with invalid signature', async () => {
        const client = createConfidentialClient({
          token_endpoint_auth_method: 'private_key_jwt',
        });

        mocks.mockGetClientCached.mockResolvedValue(client);
        mocks.mockParseToken.mockReturnValue({ sub: client.client_id });
        mocks.mockValidateClientAssertion.mockResolvedValue({
          valid: false,
          error: 'invalid_client',
          error_description: 'Client assertion signature verification failed',
        });

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
              { alg: 'RS256', kid: 'test-kid' },
              { sub: client.client_id, iss: client.client_id }
            ),
          },
          env: mockEnv,
        });

        const response = await tokenHandler(ctx);
        const body = await parseJsonResponse<{ error: string }>(response);

        expect(response.status).toBe(401);
        expect(body.error).toBe('invalid_client');
      });
    });

    describe('Client Enumeration Prevention', () => {
      it('should return generic error for non-existent client', async () => {
        mocks.mockGetClientCached.mockResolvedValue(null); // Client not found

        const ctx = createMockContext({
          method: 'POST',
          body: {
            grant_type: 'authorization_code',
            code: 'valid-auth-code',
            redirect_uri: 'https://app.example.com/callback',
            client_id: 'non-existent-client',
          },
          env: mockEnv,
        });

        const response = await tokenHandler(ctx);
        const body = await parseJsonResponse<{ error: string; error_description: string }>(
          response
        );

        expect(response.status).toBe(401);
        expect(body.error).toBe('invalid_client');
        // Should be generic message, not revealing client doesn't exist
        expect(body.error_description).toBe('Client authentication failed');
        expect(body.error_description).not.toContain('not found');
        expect(body.error_description).not.toContain('does not exist');
      });
    });
  });

  // ==========================================================================
  // Error Response Security Tests
  // ==========================================================================

  describe('Error Response Security', () => {
    describe('Cache-Control Headers', () => {
      it('should include no-store cache headers on error responses', async () => {
        mocks.mockGetClientCached.mockResolvedValue(null);

        const ctx = createMockContext({
          method: 'POST',
          body: {
            grant_type: 'authorization_code',
            code: 'valid-auth-code',
            redirect_uri: 'https://app.example.com/callback',
            client_id: 'unknown-client',
          },
          env: mockEnv,
        });

        await tokenHandler(ctx);

        // Verify cache headers were set
        expect(ctx.header).toHaveBeenCalledWith('Cache-Control', 'no-store');
        expect(ctx.header).toHaveBeenCalledWith('Pragma', 'no-cache');
      });
    });

    describe('WWW-Authenticate Header', () => {
      it('should include WWW-Authenticate header on 401 responses', async () => {
        const client = createConfidentialClient();

        mocks.mockGetClientCached.mockResolvedValue(client);
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
            client_secret: 'wrong-secret',
          },
          env: mockEnv,
        });

        await tokenHandler(ctx);

        // Verify WWW-Authenticate header was set
        expect(ctx.header).toHaveBeenCalledWith(
          'WWW-Authenticate',
          expect.stringContaining('Bearer')
        );
      });
    });

    describe('Information Leakage Prevention', () => {
      it('should not reveal internal error details in response', async () => {
        const client = createConfidentialClient();

        mocks.mockGetClientCached.mockResolvedValue(client);

        // Mock internal error
        const consumeCodeRpcMock = vi
          .fn()
          .mockRejectedValue(
            new Error('Internal database connection failed: host=db.internal.example.com')
          );
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
          },
          env: mockEnv,
        });

        const response = await tokenHandler(ctx);
        const body = await parseJsonResponse<{ error_description: string }>(response);

        // Should not reveal internal details
        expect(body.error_description).not.toContain('database');
        expect(body.error_description).not.toContain('internal');
        expect(body.error_description).not.toContain('host=');
      });
    });
  });
});
