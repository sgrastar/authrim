/**
 * Common Mock Infrastructure for ar-token Tests
 *
 * Provides reusable mocks for:
 * - Cloudflare Workers bindings (KVNamespace, D1Database, DurableObject)
 * - ar-lib-core functions (validation, caching, token creation)
 * - Hono Context
 */

import { vi } from 'vitest';
import type { Context } from 'hono';
import type { Mock } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Mock KVNamespace interface
 */
export interface MockKVNamespace {
  get: Mock<
    (key: string, options?: { type?: string; cacheTtl?: number }) => Promise<string | null>
  >;
  put: Mock<(key: string, value: string, options?: { expirationTtl?: number }) => Promise<void>>;
  delete: Mock<(key: string) => Promise<void>>;
  list: Mock<
    (options?: { prefix?: string; limit?: number }) => Promise<{ keys: { name: string }[] }>
  >;
  getWithMetadata: Mock<
    (key: string, options?: object) => Promise<{ value: string | null; metadata: object | null }>
  >;
}

/**
 * Mock D1Database interface
 */
export interface MockD1Database {
  prepare: Mock<(query: string) => MockD1PreparedStatement>;
  batch: Mock<(statements: MockD1PreparedStatement[]) => Promise<{ results: object[] }[]>>;
  exec: Mock<(query: string) => Promise<{ count: number; duration: number }>>;
  dump: Mock<() => Promise<ArrayBuffer>>;
}

/**
 * Mock D1PreparedStatement interface
 */
export interface MockD1PreparedStatement {
  bind: Mock<(...values: unknown[]) => MockD1PreparedStatement>;
  run: Mock<() => Promise<{ success: boolean; meta: object }>>;
  all: Mock<() => Promise<{ results: object[]; success: boolean }>>;
  first: Mock<(column?: string) => Promise<object | null>>;
  raw: Mock<() => Promise<unknown[][]>>;
}

/**
 * Mock DurableObjectStub interface
 */
export interface MockDurableObjectStub {
  fetch: Mock<(input: RequestInfo, init?: RequestInit) => Promise<Response>>;
  id: DurableObjectId;
  // RPC methods for KeyManager
  getActiveKeyWithPrivateRpc?: Mock<() => Promise<{ kid: string; privatePEM: string } | null>>;
  getActiveOIDCSigningKeyWithPrivateRpc?: Mock<
    (algorithm: 'RS256' | 'ES256') => Promise<{ kid: string; privatePEM: string }>
  >;
  rotateKeysWithPrivateRpc?: Mock<() => Promise<{ kid: string; privatePEM: string }>>;
  getAllPublicKeysRpc?: Mock<() => Promise<object[]>>;
  // RPC methods for AuthCodeStore
  consumeCodeRpc?: Mock<
    (params: { code: string; clientId: string; codeVerifier?: string }) => Promise<object>
  >;
  // RPC methods for RefreshTokenRotator
  rotateTokenRpc?: Mock<(params: object) => Promise<object>>;
  createFamilyRpc?: Mock<
    (params: object) => Promise<{
      version: number;
      newJti: string;
      expiresIn: number;
      allowedScope: string;
      resourceAudience?: string | string[];
    }>
  >;
  // RPC methods for DeviceCodeStore
  getRequestRpc?: Mock<(params: object) => Promise<object | null>>;
  // RPC methods for CIBARequestStore
  getRequestStatusRpc?: Mock<(params: object) => Promise<object | null>>;
}

/**
 * Mock DurableObjectNamespace interface
 */
export interface MockDurableObjectNamespace {
  idFromName: Mock<(name: string) => DurableObjectId>;
  idFromString: Mock<(id: string) => DurableObjectId>;
  get: Mock<(id: DurableObjectId) => MockDurableObjectStub>;
  newUniqueId: Mock<() => DurableObjectId>;
}

/**
 * Mock Env bindings for Cloudflare Workers
 */
export interface MockEnv {
  // KV Namespaces
  AUTHRIM_CONFIG: MockKVNamespace;
  REVOKED_TOKENS: MockKVNamespace;
  SESSIONS: MockKVNamespace;
  RATE_LIMIT_CACHE: MockKVNamespace;
  // D1 Databases
  DB: MockD1Database;
  // Durable Objects
  KEY_MANAGER: MockDurableObjectNamespace;
  AUTH_CODE_STORE: MockDurableObjectNamespace;
  REFRESH_TOKEN_ROTATOR: MockDurableObjectNamespace;
  DEVICE_CODE_STORE: MockDurableObjectNamespace;
  CIBA_REQUEST_STORE: MockDurableObjectNamespace;
  DPOP_NONCE_STORE: MockDurableObjectNamespace;
  SESSION_CLIENT_STORE: MockDurableObjectNamespace;
  DEVICE_SECRET_STORE: MockDurableObjectNamespace;
  // Environment variables
  ISSUER_URL: string;
  KEY_MANAGER_SECRET: string;
  ENVIRONMENT: string;
  PUBLIC_JWK_JSON?: string;
  ENABLE_HTTP_REDIRECT?: string;
  ENABLE_TOKEN_EXCHANGE?: string;
  ENABLE_NATIVE_SSO?: string;
  ENABLE_CIBA?: string;
  ENABLE_CLIENT_CREDENTIALS?: string;
  ENABLE_REFRESH_TOKEN_ROTATION?: string;
  TOKEN_EXCHANGE_ALLOWED_TYPES?: string;
  TOKEN_EXCHANGE_MAX_RESOURCE_PARAMS?: string;
  TOKEN_EXCHANGE_MAX_AUDIENCE_PARAMS?: string;
  // Region-aware sharding
  CF_REGION?: string;
}

// ============================================================================
// KV Namespace Mock
// ============================================================================

/**
 * Create a mock KVNamespace with optional initial data
 */
export function createMockKV(initialData?: Record<string, string>): MockKVNamespace {
  const storage = new Map<string, string>(Object.entries(initialData ?? {}));
  const metadata = new Map<string, object>();

  return {
    get: vi.fn().mockImplementation(async (key: string) => storage.get(key) ?? null),
    put: vi.fn().mockImplementation(async (key: string, value: string) => {
      storage.set(key, value);
    }),
    delete: vi.fn().mockImplementation(async (key: string) => {
      storage.delete(key);
    }),
    list: vi.fn().mockImplementation(async (options?: { prefix?: string }) => {
      const keys: { name: string }[] = [];
      for (const key of storage.keys()) {
        if (!options?.prefix || key.startsWith(options.prefix)) {
          keys.push({ name: key });
        }
      }
      return { keys };
    }),
    getWithMetadata: vi.fn().mockImplementation(async (key: string) => ({
      value: storage.get(key) ?? null,
      metadata: metadata.get(key) ?? null,
    })),
  };
}

// ============================================================================
// D1 Database Mock
// ============================================================================

/**
 * Create a mock D1Database
 */
export function createMockD1(options?: {
  queryResults?: Record<string, object[]>;
  firstResult?: object | null;
}): MockD1Database {
  const createStatement = (): MockD1PreparedStatement => {
    const statement: MockD1PreparedStatement = {
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({ success: true, meta: {} }),
      all: vi
        .fn()
        .mockResolvedValue({ results: options?.queryResults?.['default'] ?? [], success: true }),
      first: vi.fn().mockResolvedValue(options?.firstResult ?? null),
      raw: vi.fn().mockResolvedValue([]),
    };
    return statement;
  };

  return {
    prepare: vi.fn().mockImplementation(() => createStatement()),
    batch: vi.fn().mockResolvedValue([{ results: [] }]),
    exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
    dump: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
  };
}

// ============================================================================
// Durable Object Mock
// ============================================================================

/**
 * Create a mock DurableObjectId
 */
export function createMockDurableObjectId(name?: string): DurableObjectId {
  return {
    toString: () => name ?? 'mock-do-id',
    equals: (other: DurableObjectId) => other.toString() === (name ?? 'mock-do-id'),
    name: name,
  } as DurableObjectId;
}

/**
 * Create a mock DurableObjectStub
 */
export function createMockDurableObjectStub(options?: {
  fetchResponse?: Response;
  rpcMethods?: Partial<MockDurableObjectStub>;
}): MockDurableObjectStub {
  return {
    fetch: vi.fn().mockResolvedValue(options?.fetchResponse ?? new Response('{}', { status: 200 })),
    id: createMockDurableObjectId(),
    getActiveKeyWithPrivateRpc:
      options?.rpcMethods?.getActiveKeyWithPrivateRpc ?? vi.fn().mockResolvedValue(null),
    getActiveOIDCSigningKeyWithPrivateRpc:
      options?.rpcMethods?.getActiveOIDCSigningKeyWithPrivateRpc ??
      vi.fn().mockRejectedValue(new Error('OIDC signing key not configured')),
    rotateKeysWithPrivateRpc:
      options?.rpcMethods?.rotateKeysWithPrivateRpc ??
      vi.fn().mockResolvedValue({ kid: 'test-kid', privatePEM: 'test-pem' }),
    getAllPublicKeysRpc: options?.rpcMethods?.getAllPublicKeysRpc ?? vi.fn().mockResolvedValue([]),
    consumeCodeRpc:
      options?.rpcMethods?.consumeCodeRpc ?? vi.fn().mockRejectedValue(new Error('Code not found')),
    rotateTokenRpc:
      options?.rpcMethods?.rotateTokenRpc ??
      vi.fn().mockRejectedValue(new Error('Token not found')),
    createFamilyRpc:
      options?.rpcMethods?.createFamilyRpc ??
      vi.fn().mockResolvedValue({
        version: 1,
        newJti: 'mock-refresh-jti',
        expiresIn: 2592000,
        allowedScope: 'openid profile',
      }),
    getRequestRpc: options?.rpcMethods?.getRequestRpc ?? vi.fn().mockResolvedValue(null),
    getRequestStatusRpc:
      options?.rpcMethods?.getRequestStatusRpc ?? vi.fn().mockResolvedValue(null),
  };
}

/**
 * Create a mock DurableObjectNamespace
 */
export function createMockDurableObjectNamespace(stubOptions?: {
  fetchResponse?: Response;
  rpcMethods?: Partial<MockDurableObjectStub>;
}): MockDurableObjectNamespace {
  const stub = createMockDurableObjectStub(stubOptions);

  return {
    idFromName: vi.fn().mockImplementation((name: string) => createMockDurableObjectId(name)),
    idFromString: vi.fn().mockImplementation((id: string) => createMockDurableObjectId(id)),
    get: vi.fn().mockReturnValue(stub),
    newUniqueId: vi.fn().mockReturnValue(createMockDurableObjectId('unique-id')),
  };
}

// ============================================================================
// Mock Environment
// ============================================================================

/**
 * Create a complete mock environment for token handler tests
 */
export function createMockEnv(overrides?: Partial<MockEnv>): MockEnv {
  return {
    // KV Namespaces
    AUTHRIM_CONFIG: createMockKV(),
    REVOKED_TOKENS: createMockKV(),
    SESSIONS: createMockKV(),
    RATE_LIMIT_CACHE: createMockKV(),
    // D1 Database
    DB: createMockD1(),
    // Durable Objects
    KEY_MANAGER: createMockDurableObjectNamespace({
      rpcMethods: {
        getActiveKeyWithPrivateRpc: vi.fn().mockResolvedValue({
          kid: 'test-kid-001',
          privatePEM: getMockPrivateKeyPEM(),
        }),
        getAllPublicKeysRpc: vi.fn().mockResolvedValue([getMockPublicJWK()]),
      },
    }),
    AUTH_CODE_STORE: createMockDurableObjectNamespace(),
    REFRESH_TOKEN_ROTATOR: createMockDurableObjectNamespace(),
    DEVICE_CODE_STORE: createMockDurableObjectNamespace(),
    CIBA_REQUEST_STORE: createMockDurableObjectNamespace(),
    DPOP_NONCE_STORE: createMockDurableObjectNamespace(),
    SESSION_CLIENT_STORE: createMockDurableObjectNamespace(),
    DEVICE_SECRET_STORE: createMockDurableObjectNamespace(),
    // Environment variables
    ISSUER_URL: 'https://auth.example.com',
    KEY_MANAGER_SECRET: 'test-key-manager-secret',
    ENVIRONMENT: 'test',
    // PUBLIC_JWK_JSON for token verification (used by getVerificationKeyFromJWKS)
    PUBLIC_JWK_JSON: JSON.stringify(getMockPublicJWK()),
    ...overrides,
  };
}

// ============================================================================
// Hono Context Mock
// ============================================================================

/**
 * Options for creating a mock Hono context
 */
export interface MockContextOptions {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: Record<string, string>;
  env?: Partial<MockEnv>;
  params?: Record<string, string>;
  tenantId?: string;
}

/**
 * Create a mock Hono context for testing handlers
 *
 * Note: Returns Context<{ Bindings: Env }> type for compatibility with token handlers.
 * The actual MockEnv is a subset of Env, but handlers only use the mocked properties.
 */
export function createMockContext(options: MockContextOptions = {}): Context<{ Bindings: Env }> {
  const {
    method = 'POST',
    url = 'https://auth.example.com/oauth/token',
    headers = {},
    body = {},
    env = {},
    params = {},
    tenantId = 'default',
  } = options;

  // Create URLSearchParams for form body
  const formBody = new URLSearchParams(body).toString();

  // Build headers with defaults
  const requestHeaders = new Headers({
    'Content-Type': 'application/x-www-form-urlencoded',
    ...headers,
  });

  // Create Request object
  const request = new Request(url, {
    method,
    headers: requestHeaders,
    body: method !== 'GET' ? formBody : undefined,
  });

  // Mock response headers
  const responseHeaders = new Map<string, string>();

  // Create mock context
  const mockEnv = createMockEnv(env);
  const contextData = new Map<string, unknown>([['tenantId', tenantId]]);

  // Create a minimal mock context
  const mockContext = {
    req: {
      raw: request,
      url,
      method,
      header: (name: string) => requestHeaders.get(name),
      headers: requestHeaders,
      parseBody: vi.fn().mockResolvedValue(body),
      param: (name: string) => params[name],
      query: (name: string) => new URL(url).searchParams.get(name),
    },
    env: mockEnv,
    header: vi.fn().mockImplementation((name: string, value: string) => {
      responseHeaders.set(name, value);
    }),
    json: vi.fn().mockImplementation((data: unknown, status?: number) => {
      return new Response(JSON.stringify(data), {
        status: status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
    text: vi.fn().mockImplementation((text: string, status?: number) => {
      return new Response(text, { status: status ?? 200 });
    }),
    set: vi.fn().mockImplementation((key: string, value: unknown) => {
      contextData.set(key, value);
    }),
    get: vi.fn().mockImplementation((key: string) => contextData.get(key)),
    executionCtx: {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    },
    res: {
      headers: responseHeaders,
    },
  };

  return mockContext as unknown as Context<{ Bindings: Env }>;
}

// ============================================================================
// JWT and Crypto Helpers
// ============================================================================

/**
 * Base64URL encode a string
 */
export function base64UrlEncode(str: string): string {
  const base64 = Buffer.from(str).toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]/g, '');
}

/**
 * Base64URL decode a string
 */
export function base64UrlDecode(str: string): string {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '==='.slice(0, (4 - (base64.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString();
}

/**
 * Create a test JWT (for parsing tests, not signature verification)
 */
export function createTestJWT(
  header: object,
  payload: object,
  signature = 'test-signature'
): string {
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signatureB64 = base64UrlEncode(signature);
  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

/**
 * Get a mock RSA private key PEM (for testing only)
 * This is a test key - never use in production
 */
export function getMockPrivateKeyPEM(): string {
  return `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDN4ue6C4lWsVpq
2w8dqJqV7y8yLxQQ7Q7E8nxV/ZKe9Y8s3XzQ7X6Q8yPj4dKqq3ZGWqY+XRmW3EJi
m4KqmVq2p9Y+Zj6F8YqK8mX3Q7X6Q8yPj4dKqq3ZGWqY+XRmW3EJim4KqmVq2p9Y
+Zj6F8YqK8mX3Q7X6Q8yPj4dKqq3ZGWqY+XRmW3EJim4KqmVq2p9Y+Zj6F8YqK8m
X3Q7X6Q8yPj4dKqq3ZGWqY+XRmW3EJim4KqmVq2p9Y+Zj6F8YqK8mX3Q7X6Q8yPj
4dKqq3ZGWqY+XRmW3EJim4KqmVq2p9Y+Zj6F8YqK8mX3Q7X6Q8yPj4dKqq3ZGWqY
+XRmW3EJim4KqmVq2p9Y+Zj6F8YqK8mX3AgMBAAECggEAIoH8m+7Q7X6Q8yPj4dKq
q3ZGWqY+XRmW3EJim4KqmVq2p9Y+Zj6F8YqK8mX3Q7X6Q8yPj4dKqq3ZGWqY+XRm
W3EJim4KqmVq2p9Y+Zj6F8YqK8mX3Q7X6Q8yPj4dKqq3ZGWqY+XRmW3EJim4KqmV
q2p9Y+Zj6F8YqK8mX3Q7X6Q8yPj4dKqq3ZGWqY+XRmW3EJim4KqmVq2p9Y+Zj6F8
YqK8mX3Q7X6Q8yPj4dKqq3ZGWqY+XRmW3EJim4KqmVq2p9Y+Zj6F8YqK8mX3Q7X6
Q8yPj4dKqq3ZGWqY+XRmW3EJim4KqmVq2p9Y+Zj6F8YqK8mX3Q7X6Q8yPj4dKqq3
ZGWqYQKBgQDN4ue6C4lWsVpq2w8dqJqV7y8yLxQQ7Q7E8nxV/ZKe9Y8s3XzQ7X6Q
8yPj4dKqq3ZGWqY+XRmW3EJim4KqmVq2p9Y+Zj6F8YqK8mX3Q7X6Q8yPj4dKqq3Z
GWqY+XRmW3EJim4KqmVq2p9Y+Zj6F8YqK8mX3Q7X6Q8yPj4dKqq3ZGWqYQKBgQDN
4ue6C4lWsVpq2w8dqJqV7y8yLxQQ7Q7E8nxV/ZKe9Y8s3XzQ7X6Q8yPj4dKqq3ZG
WqY+XRmW3EJim4KqmVq2p9Y+Zj6F8YqK8mX3Q7X6Q8yPj4dKqq3ZGWqY+XRmW3EJ
im4KqmVq2p9Y+Zj6F8YqK8mX3Q7X6Q8yPj4dKqq3ZGWqYQKBgDN4ue6C4lWsVpq2
w8dqJqV7y8yLxQQ7Q7E8nxV/ZKe9Y8s3XzQ7X6Q8yPj4dKqq3ZGWqY+XRmW3EJim
4KqmVq2p9Y+Zj6F8YqK8mX3Q7X6Q8yPj4dKqq3ZGWqY+XRmW3EJim4KqmVq2p9Y+
Zj6F8YqK8mX3Q7X6Q8yPj4dKqq3ZGWqYAoGAM3i57oLiVaxWmrbDx2ompXvLzIvF
BDtDsTyfFX9kp71jyzdfNDtfpDzI+Ph0qqrdkZapj5dGZbcQmKbgqqZWran1j5mP
oXxiorwZfdDtfpDzI+Ph0qqrdkZapj5dGZbcQmKbgqqZWran1j5mPoXxiorwZfcC
gYAzeLnuguJVrFaatsPHaiole8vMi8UEO0OxPJ8Vf2SnvWPLN180O1+kPMj4+HSq
qt2RlqmPl0ZltxCYpuCqplasqfWPmY+hfGKivJl90O1+kPMj4+HSqqt2RlqmPl0Z
ltxCYpuCqplasqfWPmY+hfGKivJl9w==
-----END PRIVATE KEY-----`;
}

/**
 * Get a mock RSA public key JWK (for testing only)
 */
export function getMockPublicJWK(): object {
  return {
    kty: 'RSA',
    kid: 'test-kid-001',
    use: 'sig',
    alg: 'RS256',
    n: 'zeLougu_test_key_n_value',
    e: 'AQAB',
  };
}

// ============================================================================
// ar-lib-core Mock Helpers
// ============================================================================

/**
 * Create hoisted mocks for ar-lib-core functions
 * Use with vi.hoisted() at the top of test files
 */
export function createArLibCoreMocks() {
  return {
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

    // Caching (P0 Optimization)
    mockGetClientCached: vi.fn().mockResolvedValue(null),
    mockLoadTenantProfileCached: vi.fn().mockResolvedValue(null),
    mockGetSystemSettingsCached: vi.fn().mockResolvedValue(null),
    mockGetChallengeStoreByChallengeId: vi.fn().mockResolvedValue({
      consumeChallengeRpc: vi.fn().mockRejectedValue(new Error('Artifact not found')),
    }),

    // Token Operations
    mockCreateAccessToken: vi.fn().mockResolvedValue('mock-access-token'),
    mockCreateIDToken: vi.fn().mockResolvedValue('mock-id-token'),
    mockCreateRefreshToken: vi.fn().mockResolvedValue('mock-refresh-token'),
    mockVerifyToken: vi.fn().mockResolvedValue({ valid: true, payload: {} }),
    mockParseToken: vi.fn().mockReturnValue({}),
    mockParseTokenHeader: vi.fn().mockReturnValue({ alg: 'RS256', kid: 'test-kid' }),

    // Token Revocation
    mockRevokeToken: vi.fn().mockResolvedValue(undefined),
    mockIsTokenRevoked: vi.fn().mockResolvedValue(false),

    // Client Authentication
    mockValidateClientAssertion: vi
      .fn()
      .mockResolvedValue({ valid: true, client_id: 'test-client' }),
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
    mockParseRefreshTokenJti: vi.fn().mockReturnValue({ shardIndex: 0, randomPart: 'abc' }),
    mockBuildRefreshTokenRotatorInstanceName: vi.fn().mockReturnValue('refresh-token-0'),
    mockGenerateRefreshTokenRandomPart: vi.fn().mockReturnValue('random-part'),
    mockGenerateRegionAwareJti: vi.fn().mockReturnValue('jti-region-001'),

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

    // Device Flow
    mockParseDeviceCodeId: vi.fn().mockReturnValue(null),
    mockGetDeviceCodeStoreById: vi.fn().mockReturnValue(null),

    // CIBA
    mockParseCIBARequestId: vi.fn().mockReturnValue(null),
    mockGetCIBARequestStoreById: vi.fn().mockReturnValue(null),

    // RBAC / Policy
    mockGetIDTokenRBACClaims: vi.fn().mockResolvedValue({}),
    mockGetAccessTokenRBACClaims: vi.fn().mockResolvedValue({}),
    mockEvaluatePermissionsForScope: vi.fn().mockReturnValue([]),
    mockIsPolicyEmbeddingEnabled: vi.fn().mockResolvedValue(false),
    mockCreateTokenClaimEvaluator: vi
      .fn()
      .mockReturnValue({ evaluate: vi.fn().mockReturnValue({}) }),
    mockEvaluateIdLevelPermissions: vi.fn().mockReturnValue([]),
    mockIsCustomClaimsEnabled: vi.fn().mockResolvedValue(false),
    mockIsIdLevelPermissionsEnabled: vi.fn().mockResolvedValue(false),
    mockGetEmbeddingLimits: vi.fn().mockReturnValue({ maxClaims: 50, maxSize: 4096 }),

    // JWE Encryption
    mockEncryptJWT: vi.fn().mockResolvedValue('encrypted-jwt'),
    mockIsIDTokenEncryptionRequired: vi.fn().mockReturnValue(false),
    mockGetClientPublicKey: vi.fn().mockResolvedValue(null),
    mockValidateJWEOptions: vi.fn().mockReturnValue({ valid: true }),

    // JWT Bearer
    mockValidateJWTBearerAssertion: vi.fn().mockResolvedValue({ valid: true, payload: {} }),
    mockParseTrustedIssuers: vi.fn().mockReturnValue([]),

    // ID-JAG
    mockIsValidIdJagSubjectTokenType: vi.fn().mockReturnValue(false),
    mockIsIdJagRequest: vi.fn().mockReturnValue(false),

    // Events
    mockPublishEvent: vi.fn().mockResolvedValue(undefined),

    // Configuration Manager
    mockCreateOAuthConfigManager: vi.fn().mockReturnValue({
      get: vi.fn().mockResolvedValue(null),
      getWithDefault: vi
        .fn()
        .mockImplementation((_key: string, defaultValue: unknown) => Promise.resolve(defaultValue)),
    }),

    // Timing-safe comparison
    mockTimingSafeEqual: vi.fn().mockReturnValue(true),

    // SD-JWT
    mockCreateSDJWTIDTokenFromClaims: vi.fn().mockResolvedValue('sd-jwt-token'),
    mockCalculateAtHash: vi.fn().mockReturnValue('at-hash'),
    mockCalculateDsHash: vi.fn().mockReturnValue('ds-hash'),

    // Refresh Token Store
    mockStoreRefreshToken: vi.fn().mockResolvedValue(undefined),
    mockGetRefreshToken: vi.fn().mockResolvedValue(null),
    mockDeleteRefreshToken: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Helper to reset all mocks to their default implementations
 */
export function resetMocks(mocks: ReturnType<typeof createArLibCoreMocks>): void {
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
  mocks.mockGetChallengeStoreByChallengeId.mockReset().mockResolvedValue({
    consumeChallengeRpc: vi.fn().mockRejectedValue(new Error('Artifact not found')),
  });

  // Reset token mocks
  mocks.mockCreateAccessToken.mockReset().mockResolvedValue('mock-access-token');
  mocks.mockCreateIDToken.mockReset().mockResolvedValue('mock-id-token');
  mocks.mockCreateRefreshToken.mockReset().mockResolvedValue('mock-refresh-token');
  mocks.mockVerifyToken.mockReset().mockResolvedValue({ valid: true, payload: {} });
  mocks.mockRevokeToken.mockReset().mockResolvedValue(undefined);
  mocks.mockIsTokenRevoked.mockReset().mockResolvedValue(false);

  // Reset other mocks to defaults
  mocks.mockParseBasicAuth.mockReset().mockReturnValue({ success: false });
  mocks.mockExtractDPoPProof.mockReset().mockReturnValue(null);
  mocks.mockValidateDPoPProof.mockReset().mockResolvedValue({ valid: true, jkt: 'test-jkt' });
  mocks.mockParseShardedAuthCode.mockReset().mockReturnValue(null);
  mocks.mockGetShardCount.mockReset().mockResolvedValue(1);
}

// ============================================================================
// Response Helpers
// ============================================================================

/**
 * Parse JSON from a Response object (type-safe)
 */
export async function parseJsonResponse<T = unknown>(response: Response): Promise<T> {
  const text = await response.text();
  return JSON.parse(text) as T;
}

/**
 * Get mock function calls in a type-safe way
 */
export function getMockCalls<T extends Mock>(mock: T): Parameters<T>[] {
  return mock.mock.calls as Parameters<T>[];
}
