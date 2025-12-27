import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { apiVersionMiddleware } from '../api-version';
import {
  deprecationHeadersMiddleware,
  getDeprecationContextFromRequest,
  isDeprecated,
} from '../deprecation-headers';
import { clearApiVersionConfigCache } from '../../utils/api-version-config';
import { clearDeprecationCache } from '../../utils/deprecation-config';
import type { Env } from '../../types/env';
import {
  DEPRECATION_HEADER,
  SUNSET_HEADER,
  LINK_HEADER,
  DEPRECATION_VERSION_PREFIX,
  DEPRECATION_ROUTE_PREFIX,
} from '../../types/deprecation';

/**
 * Deprecation Headers Middleware Tests
 *
 * Tests for RFC 8594 Sunset Header and deprecation notification
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
 * Create a test Hono app with both middlewares
 */
function createTestApp(env: Env) {
  const app = new Hono<{ Bindings: Env }>();

  // Apply middlewares in correct order
  app.use('*', apiVersionMiddleware());
  app.use('*', deprecationHeadersMiddleware());

  // Test endpoint
  app.get('/api/admin/test', (c) => {
    const deprecated = isDeprecated(c);
    const ctx = getDeprecationContextFromRequest(c);
    return c.json({
      success: true,
      isDeprecated: deprecated,
      source: ctx.source,
    });
  });

  // OIDC endpoint (should not have deprecation)
  app.get('/authorize', (c) => {
    return c.json({ endpoint: 'authorize' });
  });

  return {
    fetch: (request: Request) => app.fetch(request, env),
  };
}

describe('deprecationHeadersMiddleware', () => {
  beforeEach(() => {
    clearApiVersionConfigCache();
    clearDeprecationCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearApiVersionConfigCache();
    clearDeprecationCache();
  });

  describe('No Deprecation', () => {
    it('should not add deprecation headers when not deprecated', async () => {
      const env = createMockEnv();
      const app = createTestApp(env);

      const response = await app.fetch(new Request('http://localhost/api/admin/test'));

      expect(response.status).toBe(200);
      expect(response.headers.get(DEPRECATION_HEADER)).toBeNull();
      expect(response.headers.get(SUNSET_HEADER)).toBeNull();

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.isDeprecated).toBe(false);
    });

    it('should not add headers for OIDC endpoints', async () => {
      const env = createMockEnv();
      const app = createTestApp(env);

      const response = await app.fetch(new Request('http://localhost/authorize'));

      expect(response.status).toBe(200);
      expect(response.headers.get(DEPRECATION_HEADER)).toBeNull();
    });
  });

  describe('Version-Level Deprecation', () => {
    it('should add deprecation headers for deprecated version', async () => {
      const kvData = {
        [`${DEPRECATION_VERSION_PREFIX}2024-12-01`]: JSON.stringify({
          sunsetDate: '2025-06-01T00:00:00Z',
          migrationGuideUrl: 'https://docs.authrim.com/migration/v2025',
          replacement: '2025-01-01',
          enabled: true,
        }),
      };

      const env = createMockEnv({
        AUTHRIM_CONFIG: createMockKV(kvData),
      });
      const app = createTestApp(env);

      const request = new Request('http://localhost/api/admin/test', {
        headers: {
          'Authrim-Version': '2024-12-01',
        },
      });
      const response = await app.fetch(request);

      expect(response.status).toBe(200);
      expect(response.headers.get(DEPRECATION_HEADER)).toBe('true');
      expect(response.headers.get(SUNSET_HEADER)).toContain('2025');
      expect(response.headers.get(LINK_HEADER)).toContain('rel="deprecation"');
      expect(response.headers.get(LINK_HEADER)).toContain(
        'https://docs.authrim.com/migration/v2025'
      );

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.isDeprecated).toBe(true);
      expect(data.source).toBe('version');
    });

    it('should not add headers if deprecation is disabled', async () => {
      const kvData = {
        [`${DEPRECATION_VERSION_PREFIX}2024-12-01`]: JSON.stringify({
          sunsetDate: '2025-06-01T00:00:00Z',
          enabled: false, // Disabled
        }),
      };

      const env = createMockEnv({
        AUTHRIM_CONFIG: createMockKV(kvData),
      });
      const app = createTestApp(env);

      const response = await app.fetch(new Request('http://localhost/api/admin/test'));

      expect(response.headers.get(DEPRECATION_HEADER)).toBeNull();
    });
  });

  describe('Route-Level Deprecation', () => {
    it('should add deprecation headers for deprecated route', async () => {
      const kvData = {
        [`${DEPRECATION_ROUTE_PREFIX}/api/admin/test`]: JSON.stringify({
          sunsetDate: '2025-03-01T00:00:00Z',
          migrationGuideUrl: 'https://docs.authrim.com/migration/admin-test',
          replacement: '/api/admin/users',
          enabled: true,
        }),
      };

      const env = createMockEnv({
        AUTHRIM_CONFIG: createMockKV(kvData),
      });
      const app = createTestApp(env);

      const response = await app.fetch(new Request('http://localhost/api/admin/test'));

      expect(response.status).toBe(200);
      expect(response.headers.get(DEPRECATION_HEADER)).toBe('true');
      expect(response.headers.get(SUNSET_HEADER)).toContain('2025');

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.isDeprecated).toBe(true);
      expect(data.source).toBe('route');
    });

    it('should respect affectedVersions filter', async () => {
      const kvData = {
        [`${DEPRECATION_ROUTE_PREFIX}/api/admin/test`]: JSON.stringify({
          sunsetDate: '2025-03-01T00:00:00Z',
          affectedVersions: ['2024-06-01'], // Only affects old version
          enabled: true,
        }),
      };

      const env = createMockEnv({
        AUTHRIM_CONFIG: createMockKV(kvData),
      });
      const app = createTestApp(env);

      // Request with non-affected version
      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: {
            'Authrim-Version': '2024-12-01',
          },
        })
      );

      // Should not be deprecated for this version
      expect(response.headers.get(DEPRECATION_HEADER)).toBeNull();
    });
  });

  describe('Priority: Route > Version', () => {
    it('should prefer route-level deprecation over version-level', async () => {
      const kvData = {
        [`${DEPRECATION_VERSION_PREFIX}2024-12-01`]: JSON.stringify({
          sunsetDate: '2025-12-01T00:00:00Z', // Later date
          migrationGuideUrl: 'https://docs.authrim.com/migration/version',
          enabled: true,
        }),
        [`${DEPRECATION_ROUTE_PREFIX}/api/admin/test`]: JSON.stringify({
          sunsetDate: '2025-03-01T00:00:00Z', // Earlier date
          migrationGuideUrl: 'https://docs.authrim.com/migration/route',
          enabled: true,
        }),
      };

      const env = createMockEnv({
        AUTHRIM_CONFIG: createMockKV(kvData),
      });
      const app = createTestApp(env);

      const response = await app.fetch(new Request('http://localhost/api/admin/test'));

      // Should use route-level deprecation
      expect(response.headers.get(LINK_HEADER)).toContain('migration/route');

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.source).toBe('route');
    });
  });

  describe('Disabled via Environment', () => {
    it('should skip deprecation when DEPRECATION_HEADERS_ENABLED is false', async () => {
      const kvData = {
        [`${DEPRECATION_VERSION_PREFIX}2024-12-01`]: JSON.stringify({
          sunsetDate: '2025-06-01T00:00:00Z',
          enabled: true,
        }),
      };

      const env = createMockEnv({
        AUTHRIM_CONFIG: createMockKV(kvData),
        DEPRECATION_HEADERS_ENABLED: 'false',
      });
      const app = createTestApp(env);

      const response = await app.fetch(new Request('http://localhost/api/admin/test'));

      expect(response.headers.get(DEPRECATION_HEADER)).toBeNull();
    });
  });

  describe('Fail-Safe Behavior', () => {
    it('should continue without headers when KV throws error', async () => {
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

      const response = await app.fetch(new Request('http://localhost/api/admin/test'));

      // Should not fail, just skip deprecation headers
      expect(response.status).toBe(200);
      expect(response.headers.get(DEPRECATION_HEADER)).toBeNull();
    });
  });

  describe('Security: JSON Size Limit', () => {
    it('should reject oversized JSON payloads to prevent DoS', async () => {
      // Create a JSON payload larger than MAX_DEPRECATION_JSON_SIZE (10KB)
      const hugeJson = JSON.stringify({
        sunsetDate: '2025-06-01T00:00:00Z',
        enabled: true,
        // Add padding to exceed 10KB
        padding: 'x'.repeat(15000),
      });

      const kvData = {
        [`${DEPRECATION_VERSION_PREFIX}2024-12-01`]: hugeJson,
      };

      const env = createMockEnv({
        AUTHRIM_CONFIG: createMockKV(kvData),
      });
      const app = createTestApp(env);

      const response = await app.fetch(new Request('http://localhost/api/admin/test'));

      // Should succeed but without deprecation headers (oversized JSON is rejected)
      expect(response.status).toBe(200);
      expect(response.headers.get(DEPRECATION_HEADER)).toBeNull();
    });

    it('should accept JSON payloads within size limit', async () => {
      // Create a normal-sized JSON payload (well under 10KB)
      const normalJson = JSON.stringify({
        sunsetDate: '2025-06-01T00:00:00Z',
        migrationGuideUrl: 'https://docs.authrim.com/migration/v2025',
        replacement: '2025-01-01',
        enabled: true,
      });

      const kvData = {
        [`${DEPRECATION_VERSION_PREFIX}2024-12-01`]: normalJson,
      };

      const env = createMockEnv({
        AUTHRIM_CONFIG: createMockKV(kvData),
      });
      const app = createTestApp(env);

      const response = await app.fetch(new Request('http://localhost/api/admin/test'));

      // Should have deprecation headers
      expect(response.status).toBe(200);
      expect(response.headers.get(DEPRECATION_HEADER)).toBe('true');
    });
  });

  describe('Sunset Date Formatting', () => {
    it('should format sunset date as HTTP-date', async () => {
      const kvData = {
        [`${DEPRECATION_VERSION_PREFIX}2024-12-01`]: JSON.stringify({
          sunsetDate: '2025-06-01T00:00:00Z',
          enabled: true,
        }),
      };

      const env = createMockEnv({
        AUTHRIM_CONFIG: createMockKV(kvData),
      });
      const app = createTestApp(env);

      const response = await app.fetch(new Request('http://localhost/api/admin/test'));

      const sunsetHeader = response.headers.get(SUNSET_HEADER);
      expect(sunsetHeader).toMatch(/Sun, 01 Jun 2025 00:00:00 GMT/);
    });
  });
});
