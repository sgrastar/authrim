/**
 * HTTPS Request URI Security Tests
 *
 * Tests for SSRF prevention and security controls when fetching external request_uri
 * OIDC Core 6.2: Request Object by Reference
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import {
  CompactEncrypt,
  SignJWT,
  compactDecrypt,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
} from 'jose';
import { authorizeHandler } from '../authorize';
import type { Env } from '@authrim/ar-lib-core/types/env';

const securityRegressionIt =
  process.env.AUTHRIM_SECURITY_REGRESSION_SUITE === 'true' ? it : it.skip;

/** Error response type for authorization endpoint */
interface ErrorResponse {
  error?: string;
  error_description?: string;
}

function getRedirectedOAuthError(response: Response): URLSearchParams {
  expect(response.status).toBe(302);
  const locationHeader = response.headers.get('location');
  expect(locationHeader).not.toBeNull();
  const location = new URL(locationHeader!);
  expect(location.origin + location.pathname).toBe('https://example.com/callback');
  return location.searchParams;
}

// Mock getClient at module level
const mockGetClient = vi.hoisted(() => vi.fn());
vi.mock('@authrim/ar-lib-core', async () => {
  const actual = await vi.importActual('@authrim/ar-lib-core');
  return {
    ...actual,
    getClient: mockGetClient,
    getClientCached: mockGetClient,
  };
});

// Mock global fetch
const mockFetch = vi.fn();

/**
 * Mock KV namespace for testing
 */
class MockKVNamespace {
  private store: Map<string, string> = new Map();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) || null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/**
 * Mock D1 Database
 */
function createMockDB() {
  const mockStatement = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(null),
    all: vi.fn().mockResolvedValue({ results: [] }),
    run: vi.fn().mockResolvedValue({ success: true }),
  };

  return {
    prepare: vi.fn().mockReturnValue(mockStatement),
    batch: vi.fn().mockResolvedValue([]),
  } as unknown as D1Database;
}

/**
 * Mock Durable Object Namespace
 */
function createMockDONamespace() {
  return {
    idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-do-id' }),
    get: vi.fn().mockReturnValue({
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }))),
    }),
  } as unknown as DurableObjectNamespace;
}

function createUnsignedRequestObject(claims: Record<string, unknown>): string {
  return createJwtRequestObject({ alg: 'none', typ: 'oauth-authz-req+jwt' }, claims);
}

function createJwtRequestObject(
  headerClaims: Record<string, unknown>,
  claims: Record<string, unknown>
): string {
  const header = btoa(JSON.stringify(headerClaims))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const payload = btoa(JSON.stringify(claims))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${header}.${payload}.`;
}

/**
 * Mock ChallengeStore Durable Object with RPC methods
 */
function createMockChallengeStore() {
  const challenges = new Map<string, any>();

  return {
    idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-challenge-store-id' }),
    get: vi.fn().mockReturnValue({
      // RPC methods
      storeChallengeRpc: vi.fn().mockImplementation(async (request: { id: string }) => {
        challenges.set(request.id, request);
        return { success: true };
      }),
      consumeChallengeRpc: vi.fn().mockImplementation(async (request: { id: string }) => {
        const data = challenges.get(request.id);
        if (data) {
          challenges.delete(request.id);
          return data;
        }
        throw new Error('Challenge not found');
      }),
      getChallengeRpc: vi.fn().mockImplementation(async (id: string) => {
        return challenges.get(id) || null;
      }),
      deleteChallengeRpc: vi.fn().mockImplementation(async (id: string) => {
        const existed = challenges.has(id);
        challenges.delete(id);
        return { deleted: existed };
      }),
      // Legacy fetch method (kept for backwards compatibility)
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }))),
    }),
    _challenges: challenges,
  };
}

describe('HTTPS Request URI Security', () => {
  let app: Hono<{ Bindings: Env; Variables: { tenantId: string } }>;
  let mockEnv: Env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock global fetch
    global.fetch = mockFetch;

    app = new Hono<{ Bindings: Env; Variables: { tenantId: string } }>();
    app.use('*', async (c, next) => {
      c.set('tenantId', 'default');
      await next();
    });
    app.get('/authorize', authorizeHandler);
    app.post('/authorize', authorizeHandler);

    // Create mock environment
    mockEnv = {
      DB: createMockDB(),
      PUBLIC_ASSETS: {} as R2Bucket,
      STATE_STORE: new MockKVNamespace() as unknown as KVNamespace,
      NONCE_STORE: new MockKVNamespace() as unknown as KVNamespace,
      CLIENTS_CACHE: new MockKVNamespace() as unknown as KVNamespace,
      KEY_MANAGER: createMockDONamespace(),
      SESSION_STORE: createMockDONamespace(),
      AUTH_CODE_STORE: createMockDONamespace(),
      REFRESH_TOKEN_ROTATOR: createMockDONamespace(),
      CHALLENGE_STORE: createMockChallengeStore() as unknown as Env['CHALLENGE_STORE'],
      RATE_LIMITER: createMockDONamespace(),
      USER_CODE_RATE_LIMITER: createMockDONamespace(),
      PAR_REQUEST_STORE: createMockDONamespace(),
      DPOP_JTI_STORE: createMockDONamespace(),
      TOKEN_REVOCATION_STORE: createMockDONamespace(),
      DEVICE_CODE_STORE: createMockDONamespace(),
      CIBA_REQUEST_STORE: createMockDONamespace(),
      VERSION_MANAGER: createMockDONamespace(),
      SAML_REQUEST_STORE: createMockDONamespace(),
      ISSUER_URL: 'https://auth.example.com',
      ACCESS_TOKEN_EXPIRY: '3600',
      AUTH_CODE_EXPIRY: '120',
      STATE_EXPIRY: '300',
      NONCE_EXPIRY: '300',
      REFRESH_TOKEN_EXPIRY: '2592000',
    } as unknown as Env;

    // Default: client exists and redirect URI is valid
    mockGetClient.mockResolvedValue({
      client_id: 'test-client',
      client_secret: 'secret',
      redirect_uris: ['https://example.com/callback'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('Feature Flag Control', () => {
    it('should reject HTTPS request_uri when feature is disabled (default)', async () => {
      // ENABLE_HTTPS_REQUEST_URI is not set (undefined or not "true")
      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&request_uri=https://malicious.com/request-object.jwt',
        { method: 'GET' },
        mockEnv
      );

      const error = getRedirectedOAuthError(response);
      expect(error.get('error')).toBe('request_uri_not_supported');
      expect(error.get('error_description')).toContain('HTTPS request_uri is disabled');
      expect(error.get('error_description')).toContain('PAR');
    });

    it('should preserve state when returning a request_uri error to a validated client', async () => {
      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&state=state-123&request_uri=https://malicious.com/request-object.jwt',
        { method: 'GET' },
        mockEnv
      );

      const error = getRedirectedOAuthError(response);
      expect(error.get('error')).toBe('request_uri_not_supported');
      expect(error.get('state')).toBe('state-123');
    });

    it('should not redirect a request_uri error to an unregistered redirect URI', async () => {
      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://attacker.example/callback&scope=openid&request_uri=https://malicious.com/request-object.jwt',
        { method: 'GET' },
        mockEnv
      );

      expect(response.status).toBe(400);
      expect(response.headers.get('location')).toBeNull();
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toBe('request_uri_not_supported');
    });

    it('should not redirect a request_uri error for a client from another tenant', async () => {
      mockGetClient.mockResolvedValueOnce({
        client_id: 'test-client',
        tenant_id: 'other-tenant',
        redirect_uris: ['https://example.com/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      });

      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&request_uri=https://malicious.com/request-object.jwt',
        { method: 'GET' },
        mockEnv
      );

      expect(response.status).toBe(400);
      expect(response.headers.get('location')).toBeNull();
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toBe('request_uri_not_supported');
    });

    it('should accept PAR URN even when HTTPS is disabled', async () => {
      // PAR URN format should always be accepted
      // This test validates that PAR URN triggers the PAR flow, not the HTTPS flow
      const parUri = 'urn:ietf:params:oauth:request_uri:test-request-id';

      // Mock PAR store to return "not found" (since we're not testing PAR here)
      const mockPARStore = {
        idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-par-id' }),
        get: vi.fn().mockReturnValue({
          fetch: vi
            .fn()
            .mockResolvedValue(new Response(JSON.stringify({ found: false }), { status: 404 })),
        }),
      };

      const envWithPAR = {
        ...mockEnv,
        PAR_REQUEST_STORE: mockPARStore as unknown as DurableObjectNamespace,
      };

      const response = await app.request(
        `/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&request_uri=${encodeURIComponent(parUri)}`,
        { method: 'GET' },
        envWithPAR
      );

      // Should NOT return "request_uri_not_supported" - PAR URN is always accepted. A missing
      // PAR entry is reported through the independently validated registered redirect URI.
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get('location')!);
      expect(location.origin + location.pathname).toBe('https://example.com/callback');
      expect(location.searchParams.get('error')).toBe('invalid_request_uri');
    });
  });

  describe('SSRF Prevention - Internal IP Blocking', () => {
    const internalAddresses = [
      'https://localhost/request.jwt',
      'https://127.0.0.1/request.jwt',
      'https://10.0.0.1/request.jwt',
      'https://172.16.0.1/request.jwt',
      'https://172.31.255.255/request.jwt',
      'https://192.168.1.1/request.jwt',
      'https://169.254.169.254/request.jwt', // AWS metadata service
      'https://0.0.0.0/request.jwt',
      'https://server.local/request.jwt',
      'https://db.internal/request.jwt',
    ];

    it.each(internalAddresses)('should block request_uri to internal address: %s', async (url) => {
      const envWithFeature = {
        ...mockEnv,
        ENABLE_HTTPS_REQUEST_URI: 'true',
      };

      const response = await app.request(
        `/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&request_uri=${encodeURIComponent(url)}`,
        { method: 'GET' },
        envWithFeature
      );

      const error = getRedirectedOAuthError(response);
      expect(error.get('error')).toBe('invalid_request_uri');
      expect(error.get('error_description')).toContain('internal addresses');
    });
  });

  describe('Domain Allowlist', () => {
    it('should reject domain not in allowlist', async () => {
      const envWithAllowlist = {
        ...mockEnv,
        ENABLE_HTTPS_REQUEST_URI: 'true',
        HTTPS_REQUEST_URI_ALLOWED_DOMAINS: 'trusted.com,verified.org',
      };

      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&request_uri=https://untrusted.com/request.jwt',
        { method: 'GET' },
        envWithAllowlist
      );

      const error = getRedirectedOAuthError(response);
      expect(error.get('error')).toBe('invalid_request_uri');
      expect(error.get('error_description')).toContain('not in the allowed list');
    });

    it('should accept domain in allowlist', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-length': '100' }),
        body: {
          getReader: () => ({
            read: vi
              .fn()
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode('invalid-jwt'),
              })
              .mockResolvedValueOnce({ done: true }),
            cancel: vi.fn(),
          }),
        },
      });

      const envWithAllowlist = {
        ...mockEnv,
        ENABLE_HTTPS_REQUEST_URI: 'true',
        HTTPS_REQUEST_URI_ALLOWED_DOMAINS: 'trusted.com,verified.org',
      };

      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&request_uri=https://trusted.com/request.jwt',
        { method: 'GET' },
        envWithAllowlist
      );

      // Should proceed to fetch (will fail on JWT parsing, but that's OK for this test)
      expect(mockFetch).toHaveBeenCalled();
    });

    it('should accept subdomain of allowed domain', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-length': '100' }),
        body: {
          getReader: () => ({
            read: vi
              .fn()
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode('invalid-jwt'),
              })
              .mockResolvedValueOnce({ done: true }),
            cancel: vi.fn(),
          }),
        },
      });

      const envWithAllowlist = {
        ...mockEnv,
        ENABLE_HTTPS_REQUEST_URI: 'true',
        HTTPS_REQUEST_URI_ALLOWED_DOMAINS: 'trusted.com',
      };

      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&request_uri=https://api.trusted.com/request.jwt',
        { method: 'GET' },
        envWithAllowlist
      );

      // Should proceed to fetch (subdomain of trusted.com is allowed)
      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe('Response Size Limit', () => {
    it('should reject response exceeding Content-Length limit', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-length': '200000' }), // 200KB > 100KB default
        body: null,
      });

      const envWithFeature = {
        ...mockEnv,
        ENABLE_HTTPS_REQUEST_URI: 'true',
      };

      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&request_uri=https://external.com/request.jwt',
        { method: 'GET' },
        envWithFeature
      );

      const error = getRedirectedOAuthError(response);
      expect(error.get('error')).toBe('invalid_request_uri');
      expect(error.get('error_description')).toContain('too large');
    });

    it('should allow custom size limit via environment variable', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-length': '150000' }), // 150KB
        body: null,
      });

      const envWithCustomLimit = {
        ...mockEnv,
        ENABLE_HTTPS_REQUEST_URI: 'true',
        HTTPS_REQUEST_URI_MAX_SIZE_BYTES: '200000', // 200KB limit
      };

      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&request_uri=https://external.com/request.jwt',
        { method: 'GET' },
        envWithCustomLimit
      );

      // Response should not be rejected for size (150KB < 200KB limit)
      // It will fail for other reasons (null body), but not for size
      const error = getRedirectedOAuthError(response);
      expect(error.get('error_description')).not.toContain('too large');
    });
  });

  describe('Redirect Handling', () => {
    it('should reject a redirect to a domain outside the allowlist before following it', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 302,
        statusText: 'Found',
        headers: new Headers({ location: 'https://evil.example/request.jwt' }),
      });

      const envWithAllowlist = {
        ...mockEnv,
        ENABLE_HTTPS_REQUEST_URI: 'true',
        HTTPS_REQUEST_URI_ALLOWED_DOMAINS: 'trusted.com',
      };

      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&request_uri=https://trusted.com/request.jwt',
        { method: 'GET' },
        envWithAllowlist
      );

      const error = getRedirectedOAuthError(response);
      expect(error.get('error')).toBe('invalid_request_uri');
      expect(error.get('error_description')).toContain('Redirected request_uri domain');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should reject a redirect to an internal address before following it', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 302,
        statusText: 'Found',
        headers: new Headers({ location: 'https://127.0.0.1/request.jwt' }),
      });

      const envWithFeature = {
        ...mockEnv,
        ENABLE_HTTPS_REQUEST_URI: 'true',
      };

      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&request_uri=https://external.com/request.jwt',
        { method: 'GET' },
        envWithFeature
      );

      const error = getRedirectedOAuthError(response);
      expect(error.get('error')).toBe('invalid_request_uri');
      expect(error.get('error_description')).toContain('redirect to internal addresses');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should use redirect: manual option and validate redirect hops', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': '100' }),
        body: {
          getReader: () => ({
            read: vi
              .fn()
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode('test'),
              })
              .mockResolvedValueOnce({ done: true }),
            cancel: vi.fn(),
          }),
        },
      });

      const envWithFeature = {
        ...mockEnv,
        ENABLE_HTTPS_REQUEST_URI: 'true',
      };

      await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&request_uri=https://external.com/request.jwt',
        { method: 'GET' },
        envWithFeature
      );

      // Redirects are followed manually so every hop is validated before another fetch.
      expect(mockFetch).toHaveBeenCalledWith(
        'https://external.com/request.jwt',
        expect.objectContaining({
          redirect: 'manual',
        })
      );
    });

    it('should follow a validated HTTPS redirect', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 302,
          statusText: 'Found',
          headers: new Headers({ location: 'https://cdn.trusted.com/request.jwt' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-length': '4' }),
          body: {
            getReader: () => ({
              read: vi
                .fn()
                .mockResolvedValueOnce({
                  done: false,
                  value: new TextEncoder().encode('test'),
                })
                .mockResolvedValueOnce({ done: true }),
              cancel: vi.fn(),
            }),
          },
        });

      const envWithAllowlist = {
        ...mockEnv,
        ENABLE_HTTPS_REQUEST_URI: 'true',
        HTTPS_REQUEST_URI_ALLOWED_DOMAINS: 'trusted.com',
      };

      await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&request_uri=https://trusted.com/request.jwt',
        { method: 'GET' },
        envWithAllowlist
      );

      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        'https://cdn.trusted.com/request.jwt',
        expect.objectContaining({ redirect: 'manual' })
      );
    });
  });

  describe('Request Object Fetching', () => {
    it('does not accept an encrypted unsigned JSON Request Object as authenticated input', async () => {
      const encryptionKeyPair = await generateKeyPair('RSA-OAEP', {
        extractable: true,
        modulusLength: 2048,
      });
      const directJsonClaims = {
        client_id: 'test-client',
        response_type: 'code',
        redirect_uri: 'https://example.com/callback',
        scope: 'openid',
        state: 'unsigned-encrypted-state',
      };
      const jwe = await new CompactEncrypt(
        new TextEncoder().encode(JSON.stringify(directJsonClaims))
      )
        .setProtectedHeader({ alg: 'RSA-OAEP', enc: 'A256GCM' })
        .encrypt(encryptionKeyPair.publicKey);

      // Negative control: the JWE and key are valid when the key retains its RSA-OAEP usage.
      const locallyDecrypted = await compactDecrypt(jwe, encryptionKeyPair.privateKey);
      expect(JSON.parse(new TextDecoder().decode(locallyDecrypted.plaintext))).toEqual(
        directJsonClaims
      );

      const response = await app.request(
        `/authorize?client_id=test-client&request=${encodeURIComponent(jwe)}`,
        { method: 'GET' },
        {
          ...mockEnv,
          PRIVATE_KEY_PEM: await exportPKCS8(encryptionKeyPair.privateKey),
        }
      );

      // Current code imports PRIVATE_KEY_PEM for RS256 signing, producing a CryptoKey that
      // cannot perform RSA-OAEP decryption. The unsigned JSON branch is therefore unreachable.
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'invalid_request_object',
        error_description: 'Failed to decrypt request object',
      });
      expect(
        (mockEnv.CHALLENGE_STORE as unknown as ReturnType<typeof createMockChallengeStore>)
          ._challenges.size
      ).toBe(0);
    });

    securityRegressionIt(
      '[security regression][AO-03] rejects a JAR whose signed client_id differs from the outer client',
      async () => {
        const clientAKeyPair = await generateKeyPair('RS256', { extractable: true });
        const clientAPublicJwk = {
          ...(await exportJWK(clientAKeyPair.publicKey)),
          kid: 'client-a-signing-key',
          alg: 'RS256',
          use: 'sig',
        };

        mockGetClient.mockImplementation(
          async (_context: unknown, _env: unknown, requestedClientId: string) => {
            if (requestedClientId === 'client-a') {
              return {
                client_id: 'client-a',
                redirect_uris: ['https://client-a.example.com/callback'],
                response_types: ['code'],
                jwks: { keys: [clientAPublicJwk] },
              };
            }
            if (requestedClientId === 'client-b') {
              return {
                client_id: 'client-b',
                client_name: 'Victim Client B',
                redirect_uris: ['https://client-b.example.com/callback'],
                grant_types: ['authorization_code'],
                response_types: ['code'],
              };
            }
            return null;
          }
        );

        // The JWT issuer/signature belongs to A, while client_id and redirect_uri target B.
        const requestObject = await new SignJWT({
          client_id: 'client-b',
          response_type: 'code',
          redirect_uri: 'https://client-b.example.com/callback',
          scope: 'openid',
          state: 'signed-by-a-for-b',
          code_challenge: 'A'.repeat(43),
          code_challenge_method: 'S256',
        })
          .setProtectedHeader({
            alg: 'RS256',
            typ: 'oauth-authz-req+jwt',
            kid: 'client-a-signing-key',
          })
          .setIssuer('client-a')
          .setAudience('https://auth.example.com')
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(clientAKeyPair.privateKey);

        const response = await app.request(
          `/authorize?client_id=client-a&request=${encodeURIComponent(requestObject)}`,
          { method: 'GET' },
          {
            ...mockEnv,
            ENABLE_CONFORMANCE_MODE: 'true',
          }
        );

        const location = response.headers.get('location');
        const challengeId = location
          ? new URL(location, 'https://auth.example.com').searchParams.get('challenge_id')
          : null;

        const challenges = (
          mockEnv.CHALLENGE_STORE as unknown as ReturnType<typeof createMockChallengeStore>
        )._challenges;

        expect(challengeId).toBeNull();
        expect([...challenges.values()]).not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'login',
              metadata: expect.objectContaining({
                client_id: 'client-b',
                redirect_uri: 'https://client-b.example.com/callback',
              }),
            }),
          ])
        );
      }
    );

    it('should reject alg=none request objects in production even when test settings allow them', async () => {
      const requestObject = createUnsignedRequestObject({
        response_type: 'code',
        client_id: 'test-client',
        redirect_uri: 'https://example.com/callback',
        scope: 'openid',
      });

      const settings = new MockKVNamespace();
      await settings.put(
        'system_settings',
        JSON.stringify({
          oidc: {
            allowNoneAlgorithm: true,
          },
        })
      );

      const response = await app.request(
        `/authorize?request=${encodeURIComponent(requestObject)}`,
        { method: 'GET' },
        {
          ...mockEnv,
          ENVIRONMENT: 'production',
          SETTINGS: settings as unknown as KVNamespace,
        }
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toBe('invalid_request_object');
      expect(body.error_description).toContain('not permitted in production');
    });

    it('should reject alg=none request objects unless explicitly enabled', async () => {
      const requestObject = createUnsignedRequestObject({
        response_type: 'code',
        client_id: 'test-client',
        redirect_uri: 'https://example.com/callback',
        scope: 'openid',
      });

      const response = await app.request(
        `/authorize?request=${encodeURIComponent(requestObject)}`,
        { method: 'GET' },
        {
          ...mockEnv,
          ENVIRONMENT: 'test',
          SETTINGS: new MockKVNamespace() as unknown as KVNamespace,
        }
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toBe('invalid_request_object');
      expect(body.error_description).toContain('not allowed');
    });

    it('should reject signed request objects when the client jwks has no signing key', async () => {
      mockGetClient.mockResolvedValueOnce({
        client_id: 'test-client',
        redirect_uris: ['https://example.com/callback'],
        response_types: ['code'],
        jwks: {
          keys: [{ kty: 'oct', kid: 'not-a-signing-key', use: 'enc', k: 'abc' }],
        },
      });
      const requestObject = createJwtRequestObject(
        { alg: 'RS256', typ: 'oauth-authz-req+jwt' },
        {
          response_type: 'code',
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          scope: 'openid',
        }
      );

      const response = await app.request(
        `/authorize?client_id=test-client&request=${encodeURIComponent(requestObject)}`,
        { method: 'GET' },
        mockEnv
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toBe('invalid_request_object');
      expect(body.error_description).toContain('No suitable signing key');
    });

    it('should reject signed request objects with an internal jwks_uri', async () => {
      mockGetClient.mockResolvedValueOnce({
        client_id: 'test-client',
        redirect_uris: ['https://example.com/callback'],
        response_types: ['code'],
        jwks_uri: 'https://127.0.0.1/jwks.json',
      });
      const requestObject = createJwtRequestObject(
        { alg: 'RS256', typ: 'oauth-authz-req+jwt' },
        {
          response_type: 'code',
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          scope: 'openid',
        }
      );

      const response = await app.request(
        `/authorize?client_id=test-client&request=${encodeURIComponent(requestObject)}`,
        { method: 'GET' },
        mockEnv
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toBe('invalid_request_object');
      expect(body.error_description).toContain('jwks_uri cannot point to internal addresses');
    });

    it('should reject signed request objects when no client public key is available', async () => {
      const requestObject = createJwtRequestObject(
        { alg: 'RS256', typ: 'oauth-authz-req+jwt' },
        {
          response_type: 'code',
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          scope: 'openid',
        }
      );

      const response = await app.request(
        `/authorize?client_id=test-client&request=${encodeURIComponent(requestObject)}`,
        { method: 'GET' },
        mockEnv
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toBe('invalid_request_object');
      expect(body.error_description).toContain('No client public key');
    });

    it('should reject signed request objects without using the server public key fallback', async () => {
      const requestObject = createJwtRequestObject(
        { alg: 'RS256', typ: 'oauth-authz-req+jwt' },
        {
          response_type: 'code',
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          scope: 'openid',
        }
      );

      const response = await app.request(
        `/authorize?client_id=test-client&request=${encodeURIComponent(requestObject)}`,
        { method: 'GET' },
        {
          ...mockEnv,
          PUBLIC_JWK_JSON: JSON.stringify({
            kty: 'RSA',
            kid: 'server-key',
            alg: 'RS256',
            use: 'sig',
            n: 'server-modulus',
            e: 'AQAB',
          }),
        }
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toBe('invalid_request_object');
      expect(body.error_description).toContain('No client public key');
    });

    it('should reject unsupported signed request object algorithms before key import', async () => {
      mockGetClient.mockResolvedValueOnce({
        client_id: 'test-client',
        redirect_uris: ['https://example.com/callback'],
        response_types: ['code'],
        jwks: {
          keys: [{ kty: 'EC', kid: 'client-ec-key', use: 'sig', alg: 'ES256' }],
        },
      });
      const requestObject = createJwtRequestObject(
        { alg: 'ES256', typ: 'oauth-authz-req+jwt', kid: 'client-ec-key' },
        {
          response_type: 'code',
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          scope: 'openid',
        }
      );

      const response = await app.request(
        `/authorize?client_id=test-client&request=${encodeURIComponent(requestObject)}`,
        { method: 'GET' },
        mockEnv
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toBe('invalid_request_object');
      expect(body.error_description).toContain('Unsupported request object signing algorithm');
    });

    it('should fetch and apply an unsigned request object only when explicitly enabled', async () => {
      const requestObject = createUnsignedRequestObject({
        response_type: 'code',
        client_id: 'test-client',
        redirect_uri: 'https://example.com/callback',
        scope: 'openid profile',
        state: 'request-object-state',
        nonce: 'request-object-nonce',
        response_mode: 'form_post',
        claims: { id_token: { email: { essential: true } } },
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        url: 'https://trusted.com/request.jwt',
        headers: new Headers({ 'content-length': String(requestObject.length) }),
        body: {
          getReader: () => ({
            read: vi
              .fn()
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode(requestObject),
              })
              .mockResolvedValueOnce({ done: true }),
            cancel: vi.fn(),
          }),
        },
      });

      const settings = new MockKVNamespace();
      await settings.put(
        'system_settings',
        JSON.stringify({
          oidc: {
            allowNoneAlgorithm: true,
          },
        })
      );
      const envWithFeature = {
        ...mockEnv,
        ENABLE_HTTPS_REQUEST_URI: 'true',
        HTTPS_REQUEST_URI_ALLOWED_DOMAINS: 'trusted.com',
        ENVIRONMENT: 'test',
        SETTINGS: settings as unknown as KVNamespace,
      };

      const response = await app.request(
        '/authorize?client_id=test-client&request_uri=https%3A%2F%2Ftrusted.com%2Frequest.jwt',
        { method: 'GET' },
        envWithFeature
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'https://trusted.com/request.jwt',
        expect.objectContaining({
          redirect: 'manual',
        })
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('method="post"');
      expect(html).toContain('action="https://example.com/callback"');
      expect(html).toContain('name="state" value="request-object-state"');
    });
  });

  describe('Timeout Control', () => {
    it('should use AbortController for timeout', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-length': '100' }),
        body: {
          getReader: () => ({
            read: vi
              .fn()
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode('test'),
              })
              .mockResolvedValueOnce({ done: true }),
            cancel: vi.fn(),
          }),
        },
      });

      const envWithFeature = {
        ...mockEnv,
        ENABLE_HTTPS_REQUEST_URI: 'true',
      };

      await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&request_uri=https://external.com/request.jwt',
        { method: 'GET' },
        envWithFeature
      );

      // Verify fetch was called with signal (AbortController)
      expect(mockFetch).toHaveBeenCalledWith(
        'https://external.com/request.jwt',
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        })
      );
    });

    it('should return timeout error when fetch times out', async () => {
      // Simulate abort error
      mockFetch.mockRejectedValueOnce(new Error('The operation was aborted'));

      const envWithFeature = {
        ...mockEnv,
        ENABLE_HTTPS_REQUEST_URI: 'true',
        HTTPS_REQUEST_URI_TIMEOUT_MS: '100', // Very short timeout
      };

      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&request_uri=https://external.com/request.jwt',
        { method: 'GET' },
        envWithFeature
      );

      const error = getRedirectedOAuthError(response);
      expect(error.get('error')).toBe('invalid_request_uri');
      expect(error.get('error_description')).toContain('timed out');
    });
  });

  describe('Invalid URL Handling', () => {
    it('should reject invalid URL format', async () => {
      const envWithFeature = {
        ...mockEnv,
        ENABLE_HTTPS_REQUEST_URI: 'true',
      };

      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&request_uri=https://',
        { method: 'GET' },
        envWithFeature
      );

      const error = getRedirectedOAuthError(response);
      expect(error.get('error')).toBe('invalid_request_uri');
    });

    it('should reject non-HTTPS/URN request_uri', async () => {
      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&request_uri=http://example.com/request.jwt',
        { method: 'GET' },
        mockEnv
      );

      const error = getRedirectedOAuthError(response);
      expect(error.get('error')).toBe('invalid_request');
      expect(error.get('error_description')).toContain('urn:ietf:params:oauth:request_uri:');
    });
  });
});
