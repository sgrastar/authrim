/**
 * HTTPS Request URI Security Tests
 *
 * Tests for SSRF prevention and security controls when fetching external request_uri
 * OIDC Core 6.2: Request Object by Reference
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { authorizeHandler } from '../authorize';
import type { Env } from '@authrim/shared/types/env';

/** Error response type for authorization endpoint */
interface ErrorResponse {
  error?: string;
  error_description?: string;
}

// Mock getClient at module level
const mockGetClient = vi.hoisted(() => vi.fn());
vi.mock('@authrim/shared', async () => {
  const actual = await vi.importActual('@authrim/shared');
  return {
    ...actual,
    getClient: mockGetClient,
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
  let app: Hono<{ Bindings: Env }>;
  let mockEnv: Env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock global fetch
    global.fetch = mockFetch;

    app = new Hono<{ Bindings: Env }>();
    app.get('/authorize', authorizeHandler);
    app.post('/authorize', authorizeHandler);

    // Create mock environment
    mockEnv = {
      DB: createMockDB(),
      AVATARS: {} as R2Bucket,
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
      TOKEN_EXPIRY: '3600',
      CODE_EXPIRY: '120',
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

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toBe('request_uri_not_supported');
      expect(body.error_description).toContain('HTTPS request_uri is disabled');
      expect(body.error_description).toContain('PAR');
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

      // Should NOT return "request_uri_not_supported" - PAR URN is always accepted
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).not.toBe('request_uri_not_supported');
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

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toBe('invalid_request_uri');
      expect(body.error_description).toContain('internal addresses');
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

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toBe('invalid_request_uri');
      expect(body.error_description).toContain('not in the allowed list');
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

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toBe('invalid_request_uri');
      expect(body.error_description).toContain('too large');
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
      const body = (await response.json()) as ErrorResponse;
      expect(body.error_description).not.toContain('too large');
    });
  });

  describe('Redirect Prevention', () => {
    it('should use redirect: error option in fetch', async () => {
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

      // Verify fetch was called with redirect: 'error'
      expect(mockFetch).toHaveBeenCalledWith(
        'https://external.com/request.jwt',
        expect.objectContaining({
          redirect: 'error',
        })
      );
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

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toBe('invalid_request_uri');
      expect(body.error_description).toContain('timed out');
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

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toBe('invalid_request_uri');
    });

    it('should reject non-HTTPS/URN request_uri', async () => {
      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&request_uri=http://example.com/request.jwt',
        { method: 'GET' },
        mockEnv
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('urn:ietf:params:oauth:request_uri:');
    });
  });
});
