import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { apiVersionMiddleware, getApiVersionContext, isApiVersion } from '../api-version';
import { clearApiVersionConfigCache } from '../../utils/api-version-config';
import type { Env } from '../../types/env';
import {
  API_VERSION_REQUEST_HEADER,
  API_VERSION_RESPONSE_HEADER,
  API_VERSION_WARNING_HEADER,
  UNKNOWN_VERSION_ERROR_TYPE,
} from '../../types/api-version';

/**
 * API Version Middleware Tests
 *
 * Tests for Stripe-style date-based API versioning middleware
 * including OIDC endpoint exclusion, unknown version handling, and warning headers
 */

/**
 * Create a mock KV namespace
 */
function createMockKV(data: Record<string, string> = {}): KVNamespace {
  return {
    get: vi.fn().mockImplementation((key: string) => Promise.resolve(data[key] || null)),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
    getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

/**
 * Create a mock environment for testing
 */
function createMockEnv(overrides: Partial<Env> = {}): Env {
  return {
    ISSUER_URL: 'https://test.example.com',
    AUTHRIM_CONFIG: createMockKV(),
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({}),
      }),
    } as unknown as D1Database,
    ...overrides,
  } as Env;
}

/**
 * Create a test Hono app with API version middleware
 */
function createTestApp(env: Env) {
  const app = new Hono<{ Bindings: Env }>();

  // Apply API version middleware
  app.use('*', apiVersionMiddleware());

  // Test endpoint (admin API - versioned)
  app.get('/api/admin/test', (c) => {
    const ctx = getApiVersionContext(c);
    return c.json({
      success: true,
      version: ctx.effectiveVersion,
      isOidcEndpoint: ctx.isOidcEndpoint,
      requestedVersion: ctx.requestedVersion,
    });
  });

  // OIDC endpoints (not versioned)
  app.get('/authorize', (c) => {
    const ctx = getApiVersionContext(c);
    return c.json({ endpoint: 'authorize', isOidcEndpoint: ctx.isOidcEndpoint });
  });

  app.post('/token', (c) => {
    const ctx = getApiVersionContext(c);
    return c.json({ endpoint: 'token', isOidcEndpoint: ctx.isOidcEndpoint });
  });

  app.get('/userinfo', (c) => {
    const ctx = getApiVersionContext(c);
    return c.json({ endpoint: 'userinfo', isOidcEndpoint: ctx.isOidcEndpoint });
  });

  app.get('/.well-known/openid-configuration', (c) => {
    const ctx = getApiVersionContext(c);
    return c.json({ endpoint: 'discovery', isOidcEndpoint: ctx.isOidcEndpoint });
  });

  return {
    fetch: (request: Request) => app.fetch(request, env),
  };
}

describe('apiVersionMiddleware', () => {
  let mockEnv: Env;

  beforeEach(() => {
    clearApiVersionConfigCache();
    mockEnv = createMockEnv();
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearApiVersionConfigCache();
  });

  describe('Version Header Parsing', () => {
    it('should use default version when no header is provided', async () => {
      const app = createTestApp(mockEnv);

      const request = new Request('http://localhost/api/admin/test');
      const response = await app.fetch(request);

      expect(response.status).toBe(200);
      expect(response.headers.get(API_VERSION_RESPONSE_HEADER)).toBe('2024-12-01');

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.version).toBe('2024-12-01');
      expect(data.requestedVersion).toBeNull();
    });

    it('should use requested version when valid and supported', async () => {
      const app = createTestApp(mockEnv);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          [API_VERSION_REQUEST_HEADER]: '2024-12-01',
        },
      });
      const response = await app.fetch(request);

      expect(response.status).toBe(200);
      expect(response.headers.get(API_VERSION_RESPONSE_HEADER)).toBe('2024-12-01');

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.version).toBe('2024-12-01');
      expect(data.requestedVersion).toBe('2024-12-01');
    });
  });

  describe('OIDC Endpoint Exclusion', () => {
    it('should skip versioning for /authorize endpoint', async () => {
      const app = createTestApp(mockEnv);

      const request = new Request('http://localhost/authorize');
      const response = await app.fetch(request);

      expect(response.status).toBe(200);

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.isOidcEndpoint).toBe(true);
    });

    it('should skip versioning for /token endpoint', async () => {
      const app = createTestApp(mockEnv);

      const request = new Request('http://localhost/token', {
        method: 'POST',
      });
      const response = await app.fetch(request);

      expect(response.status).toBe(200);

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.isOidcEndpoint).toBe(true);
    });

    it('should skip versioning for /userinfo endpoint', async () => {
      const app = createTestApp(mockEnv);

      const request = new Request('http://localhost/userinfo');
      const response = await app.fetch(request);

      expect(response.status).toBe(200);

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.isOidcEndpoint).toBe(true);
    });

    it('should skip versioning for /.well-known/* endpoints', async () => {
      const app = createTestApp(mockEnv);

      const request = new Request('http://localhost/.well-known/openid-configuration');
      const response = await app.fetch(request);

      expect(response.status).toBe(200);

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.isOidcEndpoint).toBe(true);
    });

    it('should apply versioning for admin endpoints', async () => {
      const app = createTestApp(mockEnv);

      const request = new Request('http://localhost/api/admin/test');
      const response = await app.fetch(request);

      expect(response.status).toBe(200);

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.isOidcEndpoint).toBe(false);
    });
  });

  describe('Unknown Version Handling - Fallback Mode (default)', () => {
    it('should fallback to default version for unknown version', async () => {
      const app = createTestApp(mockEnv);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          [API_VERSION_REQUEST_HEADER]: '2099-01-01',
        },
      });
      const response = await app.fetch(request);

      expect(response.status).toBe(200);
      expect(response.headers.get(API_VERSION_RESPONSE_HEADER)).toBe('2024-12-01');
      expect(response.headers.get(API_VERSION_WARNING_HEADER)).toContain('unknown_version');
      expect(response.headers.get(API_VERSION_WARNING_HEADER)).toContain('requested=2099-01-01');
      expect(response.headers.get(API_VERSION_WARNING_HEADER)).toContain('applied=2024-12-01');
    });

    it('should fallback for invalid format (slash separator)', async () => {
      const app = createTestApp(mockEnv);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          [API_VERSION_REQUEST_HEADER]: '2024/12/01',
        },
      });
      const response = await app.fetch(request);

      expect(response.status).toBe(200);
      expect(response.headers.get(API_VERSION_WARNING_HEADER)).toContain('invalid_format');
    });

    it('should fallback for invalid format (v prefix)', async () => {
      const app = createTestApp(mockEnv);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          [API_VERSION_REQUEST_HEADER]: 'v2024-12-01',
        },
      });
      const response = await app.fetch(request);

      expect(response.status).toBe(200);
      expect(response.headers.get(API_VERSION_WARNING_HEADER)).toContain('invalid_format');
    });

    it('should fallback for invalid format (missing day)', async () => {
      const app = createTestApp(mockEnv);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          [API_VERSION_REQUEST_HEADER]: '2024-12',
        },
      });
      const response = await app.fetch(request);

      expect(response.status).toBe(200);
      expect(response.headers.get(API_VERSION_WARNING_HEADER)).toContain('invalid_format');
    });

    it('should fallback for "latest" keyword', async () => {
      const app = createTestApp(mockEnv);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          [API_VERSION_REQUEST_HEADER]: 'latest',
        },
      });
      const response = await app.fetch(request);

      expect(response.status).toBe(200);
      expect(response.headers.get(API_VERSION_WARNING_HEADER)).toContain('invalid_format');
    });
  });

  describe('Unknown Version Handling - Reject Mode', () => {
    it('should return 400 with RFC 9457 Problem Details for unknown version', async () => {
      const env = createMockEnv({
        API_UNKNOWN_VERSION_MODE: 'reject',
      });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          [API_VERSION_REQUEST_HEADER]: '2099-01-01',
        },
      });
      const response = await app.fetch(request);

      expect(response.status).toBe(400);
      expect(response.headers.get('Content-Type')).toContain('application/problem+json');

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.type).toBe(UNKNOWN_VERSION_ERROR_TYPE);
      expect(data.title).toBe('Unknown API Version');
      expect(data.status).toBe(400);
      expect(data.requested_version).toBe('2099-01-01');
      expect(data.supported_versions).toContain('2024-12-01');
    });

    it('should return 400 for invalid format in reject mode', async () => {
      const env = createMockEnv({
        API_UNKNOWN_VERSION_MODE: 'reject',
      });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          [API_VERSION_REQUEST_HEADER]: 'invalid',
        },
      });
      const response = await app.fetch(request);

      expect(response.status).toBe(400);
    });
  });

  describe('Unknown Version Handling - Warn Mode', () => {
    it('should continue with requested version in warn mode', async () => {
      const env = createMockEnv({
        API_UNKNOWN_VERSION_MODE: 'warn',
      });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          [API_VERSION_REQUEST_HEADER]: '2099-01-01',
        },
      });
      const response = await app.fetch(request);

      expect(response.status).toBe(200);
      // In warn mode, requested version is used if format is valid
      expect(response.headers.get(API_VERSION_RESPONSE_HEADER)).toBe('2099-01-01');
      expect(response.headers.get(API_VERSION_WARNING_HEADER)).toContain('unknown_version');
    });

    it('should fallback to default for invalid format in warn mode', async () => {
      const env = createMockEnv({
        API_UNKNOWN_VERSION_MODE: 'warn',
      });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          [API_VERSION_REQUEST_HEADER]: 'invalid',
        },
      });
      const response = await app.fetch(request);

      expect(response.status).toBe(200);
      // Invalid format falls back to default even in warn mode
      expect(response.headers.get(API_VERSION_RESPONSE_HEADER)).toBe('2024-12-01');
    });
  });

  describe('Versioning Disabled', () => {
    it('should skip versioning when API_VERSIONING_ENABLED is false', async () => {
      const env = createMockEnv({
        API_VERSIONING_ENABLED: 'false',
      });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          [API_VERSION_REQUEST_HEADER]: 'invalid-should-be-ignored',
        },
      });
      const response = await app.fetch(request);

      expect(response.status).toBe(200);
      // Should not have warning headers when disabled
      expect(response.headers.get(API_VERSION_WARNING_HEADER)).toBeNull();
    });
  });

  describe('Environment Variable Override', () => {
    it('should use API_DEFAULT_VERSION from environment', async () => {
      const env = createMockEnv({
        API_DEFAULT_VERSION: '2024-06-01',
        API_SUPPORTED_VERSIONS: '2024-06-01,2024-12-01',
      });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test');
      const response = await app.fetch(request);

      expect(response.status).toBe(200);
      expect(response.headers.get(API_VERSION_RESPONSE_HEADER)).toBe('2024-06-01');
    });
  });

  describe('KV Configuration Override', () => {
    it('should use configuration from KV', async () => {
      const kvConfig = {
        currentStableVersion: '2025-01-01',
        supportedVersions: ['2024-12-01', '2025-01-01'],
        defaultVersion: '2025-01-01',
        unknownVersionMode: 'fallback',
      };

      const env = createMockEnv({
        AUTHRIM_CONFIG: createMockKV({
          'api_versions:config': JSON.stringify(kvConfig),
        }),
      });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          [API_VERSION_REQUEST_HEADER]: '2025-01-01',
        },
      });
      const response = await app.fetch(request);

      expect(response.status).toBe(200);
      expect(response.headers.get(API_VERSION_RESPONSE_HEADER)).toBe('2025-01-01');
    });
  });

  describe('Helper Functions', () => {
    it('isApiVersion should return true for matching version', async () => {
      const app = new Hono<{ Bindings: Env }>();

      app.use('*', apiVersionMiddleware());
      app.get('/test', (c) => {
        const matches = isApiVersion(c, '2024-12-01');
        return c.json({ matches });
      });

      const response = await app.fetch(new Request('http://localhost/test'), mockEnv);

      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data.matches).toBe(true);
    });

    it('isApiVersion should return false for non-matching version', async () => {
      const app = new Hono<{ Bindings: Env }>();

      app.use('*', apiVersionMiddleware());
      app.get('/test', (c) => {
        const matches = isApiVersion(c, '2099-01-01');
        return c.json({ matches });
      });

      const response = await app.fetch(new Request('http://localhost/test'), mockEnv);

      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data.matches).toBe(false);
    });
  });

  describe('Cache Behavior', () => {
    it('should cache configuration and use cached value', async () => {
      const mockKV = createMockKV({
        'api_versions:config': JSON.stringify({
          currentStableVersion: '2024-12-01',
          supportedVersions: ['2024-12-01'],
          defaultVersion: '2024-12-01',
        }),
      });

      const env = createMockEnv({
        AUTHRIM_CONFIG: mockKV,
      });
      const app = createTestApp(env);

      // First request
      await app.fetch(new Request('http://localhost/api/admin/test'));
      // Second request
      await app.fetch(new Request('http://localhost/api/admin/test'));

      // KV should only be called once due to caching
      expect(mockKV.get).toHaveBeenCalledTimes(1);
    });
  });

  describe('Fail-Safe Behavior', () => {
    it('should continue with defaults when KV throws error', async () => {
      const errorKV = {
        get: vi.fn().mockRejectedValue(new Error('KV unavailable')),
        put: vi.fn(),
        delete: vi.fn(),
        list: vi.fn(),
        getWithMetadata: vi.fn(),
      } as unknown as KVNamespace;

      const env = createMockEnv({
        AUTHRIM_CONFIG: errorKV,
      });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test');
      const response = await app.fetch(request);

      // Should not fail, use defaults
      expect(response.status).toBe(200);
      expect(response.headers.get(API_VERSION_RESPONSE_HEADER)).toBe('2024-12-01');
    });
  });

  describe('Security: Header Injection Prevention', () => {
    // Note: Modern Request API prevents CRLF injection at the HTTP level.
    // The sanitization in our code is defense-in-depth for edge cases
    // where headers might be set through other means.

    it('should reject CRLF characters at the Request API level', () => {
      // This test verifies that the runtime prevents CRLF injection
      // Modern browsers/Node.js reject invalid header values
      expect(() => {
        new Request('http://localhost/api/admin/test', {
          headers: {
            [API_VERSION_REQUEST_HEADER]: '2024-12-01\r\nX-Injected: malicious',
          },
        });
      }).toThrow();
    });

    it('should reject null bytes at the Request API level', () => {
      // This test verifies that the runtime prevents null byte injection
      expect(() => {
        new Request('http://localhost/api/admin/test', {
          headers: {
            [API_VERSION_REQUEST_HEADER]: '2024-12-01\x00malicious',
          },
        });
      }).toThrow();
    });

    it('should truncate excessively long version values', async () => {
      const env = createMockEnv({
        API_UNKNOWN_VERSION_MODE: 'fallback',
      });
      const app = createTestApp(env);

      // Attempt to send a very long version string
      const longVersion = 'x'.repeat(1000);
      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          [API_VERSION_REQUEST_HEADER]: longVersion,
        },
      });
      const response = await app.fetch(request);

      expect(response.status).toBe(200);
      // Warning header should be truncated, not the full 1000 chars
      const warningHeader = response.headers.get(API_VERSION_WARNING_HEADER);
      if (warningHeader) {
        expect(warningHeader.length).toBeLessThan(500);
      }
    });

    it('should handle special characters safely in version header', async () => {
      const env = createMockEnv({
        API_UNKNOWN_VERSION_MODE: 'fallback',
      });
      const app = createTestApp(env);

      // Test with special characters that are allowed in headers
      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          [API_VERSION_REQUEST_HEADER]: '2024-12-01<script>alert(1)</script>',
        },
      });
      const response = await app.fetch(request);

      expect(response.status).toBe(200);
      // Should be treated as invalid format and fall back
      expect(response.headers.get(API_VERSION_WARNING_HEADER)).toContain('invalid_format');
    });
  });

  describe('Security: TTL Overflow Protection', () => {
    it('should cap excessively large TTL values to prevent integer overflow', async () => {
      // Set CONFIG_CACHE_TTL to a value that would overflow when multiplied by 1000
      const env = createMockEnv({
        CONFIG_CACHE_TTL: '9999999999', // ~317 years in seconds, would overflow
      });
      const app = createTestApp(env);

      // First request should work without overflow
      const response1 = await app.fetch(new Request('http://localhost/api/admin/test'));
      expect(response1.status).toBe(200);

      // Second request should also work (proves cache didn't break)
      const response2 = await app.fetch(new Request('http://localhost/api/admin/test'));
      expect(response2.status).toBe(200);
    });

    it('should handle negative TTL values gracefully', async () => {
      const env = createMockEnv({
        CONFIG_CACHE_TTL: '-100',
      });
      const app = createTestApp(env);

      const response = await app.fetch(new Request('http://localhost/api/admin/test'));
      expect(response.status).toBe(200);
      // Should fall back to default TTL
    });

    it('should handle non-numeric TTL values gracefully', async () => {
      const env = createMockEnv({
        CONFIG_CACHE_TTL: 'invalid',
      });
      const app = createTestApp(env);

      const response = await app.fetch(new Request('http://localhost/api/admin/test'));
      expect(response.status).toBe(200);
      // Should fall back to default TTL
    });
  });

  describe('Security: Path Length Limit', () => {
    it('should handle paths exceeding MAX_PATH_LENGTH safely', async () => {
      const app = createTestApp(mockEnv);

      // Create a path longer than 2048 characters
      const longPath = '/api/admin/' + 'x'.repeat(3000);
      const request = new Request(`http://localhost${longPath}`);

      // Should not crash, even with very long path
      const response = await app.fetch(request);
      // Will return 404 because route doesn't exist, but shouldn't crash
      expect([200, 404]).toContain(response.status);
    });

    it('should handle path with many encoded characters safely', async () => {
      const app = createTestApp(mockEnv);

      // Create a path with many URL-encoded characters that would expand
      const encodedPath = '/api/admin/' + '%2F'.repeat(500);
      const request = new Request(`http://localhost${encodedPath}`);

      const response = await app.fetch(request);
      expect([200, 404]).toContain(response.status);
    });

    it('should handle Unicode normalization expansion safely', async () => {
      const app = createTestApp(mockEnv);

      // Path with fullwidth characters (will be normalized)
      // ａｐｉ would become api after NFC normalization
      const request = new Request('http://localhost/ａｐｉ/admin/test');

      const response = await app.fetch(request);
      // Should not crash during normalization
      expect([200, 404]).toContain(response.status);
    });
  });

  describe('Security: Production Information Disclosure', () => {
    it('should not expose supported_versions in production reject mode', async () => {
      const env = createMockEnv({
        API_UNKNOWN_VERSION_MODE: 'reject',
        ENVIRONMENT: 'production',
      });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          [API_VERSION_REQUEST_HEADER]: '2099-01-01',
        },
      });
      const response = await app.fetch(request);

      expect(response.status).toBe(400);
      const data = (await response.json()) as Record<string, unknown>;
      // In production, supported_versions should NOT be exposed
      expect(data.supported_versions).toBeUndefined();
      expect(data.type).toBe(UNKNOWN_VERSION_ERROR_TYPE);
    });

    it('should expose supported_versions in non-production reject mode', async () => {
      const env = createMockEnv({
        API_UNKNOWN_VERSION_MODE: 'reject',
        ENVIRONMENT: 'development',
      });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          [API_VERSION_REQUEST_HEADER]: '2099-01-01',
        },
      });
      const response = await app.fetch(request);

      expect(response.status).toBe(400);
      const data = (await response.json()) as Record<string, unknown>;
      // In development, supported_versions should be exposed for debugging
      expect(data.supported_versions).toBeDefined();
    });
  });
});
