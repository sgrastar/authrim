import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import {
  sdkCompatibilityMiddleware,
  getSdkCompatibilityContextFromRequest,
  hasSdkVersion,
  hasSdkWarning,
  getSdkStatus,
} from '../sdk-compatibility';
import { clearSdkCompatibilityCache } from '../../utils/sdk-compatibility-config';
import type { Env } from '../../types/env';
import {
  SDK_VERSION_REQUEST_HEADER,
  SDK_WARNING_HEADER,
  SDK_RECOMMENDED_HEADER,
  SDK_COMPATIBILITY_PREFIX,
  SDK_COMPATIBILITY_CONFIG_KEY,
} from '../../types/sdk-compatibility';

/**
 * SDK Compatibility Middleware Tests
 *
 * Tests for SDK version compatibility checking
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
 * Create a test Hono app with SDK compatibility middleware
 */
function createTestApp(env: Env) {
  const app = new Hono<{ Bindings: Env }>();

  // Apply middleware
  app.use('*', sdkCompatibilityMiddleware());

  // Test endpoint
  app.get('/api/admin/test', (c) => {
    const hasVersion = hasSdkVersion(c);
    const hasWarning = hasSdkWarning(c);
    const status = getSdkStatus(c);
    const ctx = getSdkCompatibilityContextFromRequest(c);
    return c.json({
      success: true,
      hasVersion,
      hasWarning,
      status,
      sdkName: ctx.result.sdk?.name,
      sdkVersion: ctx.result.sdk?.version,
    });
  });

  return {
    fetch: (request: Request) => app.fetch(request, env),
  };
}

describe('sdkCompatibilityMiddleware', () => {
  beforeEach(() => {
    clearSdkCompatibilityCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearSdkCompatibilityCache();
  });

  describe('Disabled by Default', () => {
    it('should not check SDK compatibility when disabled', async () => {
      const env = createMockEnv();
      const app = createTestApp(env);

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: {
            [SDK_VERSION_REQUEST_HEADER]: 'authrim-js/1.0.0',
          },
        })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get(SDK_WARNING_HEADER)).toBeNull();

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.status).toBe('unknown');
    });
  });

  describe('Enabled Mode', () => {
    const enabledConfig = {
      [SDK_COMPATIBILITY_CONFIG_KEY]: JSON.stringify({
        enabled: true,
        sdks: {},
      }),
    };

    it('should parse SDK version header correctly', async () => {
      const kvData = {
        ...enabledConfig,
        [`${SDK_COMPATIBILITY_PREFIX}authrim-js`]: JSON.stringify({
          minVersion: '0.5.0',
          recommendedVersion: '1.2.0',
          latestVersion: '1.5.0',
          enabled: true,
        }),
      };

      const env = createMockEnv({
        SDK_COMPATIBILITY_CHECK_ENABLED: 'true',
        AUTHRIM_CONFIG: createMockKV(kvData),
      });
      const app = createTestApp(env);

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: {
            [SDK_VERSION_REQUEST_HEADER]: 'authrim-js/1.0.0',
          },
        })
      );

      expect(response.status).toBe(200);

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.hasVersion).toBe(true);
      expect(data.sdkName).toBe('authrim-js');
      expect(data.sdkVersion).toBe('1.0.0');
    });

    it('should return compatible status for current SDK', async () => {
      const kvData = {
        ...enabledConfig,
        [`${SDK_COMPATIBILITY_PREFIX}authrim-js`]: JSON.stringify({
          minVersion: '0.5.0',
          recommendedVersion: '1.2.0',
          latestVersion: '1.5.0',
          enabled: true,
        }),
      };

      const env = createMockEnv({
        SDK_COMPATIBILITY_CHECK_ENABLED: 'true',
        AUTHRIM_CONFIG: createMockKV(kvData),
      });
      const app = createTestApp(env);

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: {
            [SDK_VERSION_REQUEST_HEADER]: 'authrim-js/1.2.0',
          },
        })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get(SDK_WARNING_HEADER)).toBeNull();

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.status).toBe('compatible');
      expect(data.hasWarning).toBe(false);
    });

    it('should warn for outdated SDK version', async () => {
      const kvData = {
        ...enabledConfig,
        [`${SDK_COMPATIBILITY_PREFIX}authrim-js`]: JSON.stringify({
          minVersion: '0.5.0',
          recommendedVersion: '1.2.0',
          latestVersion: '1.5.0',
          enabled: true,
        }),
      };

      const env = createMockEnv({
        SDK_COMPATIBILITY_CHECK_ENABLED: 'true',
        AUTHRIM_CONFIG: createMockKV(kvData),
      });
      const app = createTestApp(env);

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: {
            [SDK_VERSION_REQUEST_HEADER]: 'authrim-js/1.0.0',
          },
        })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get(SDK_WARNING_HEADER)).toBe('outdated; recommended=1.2.0');
      expect(response.headers.get(SDK_RECOMMENDED_HEADER)).toBe('1.2.0');

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.status).toBe('outdated');
      expect(data.hasWarning).toBe(true);
    });

    it('should warn for deprecated SDK version', async () => {
      const kvData = {
        ...enabledConfig,
        [`${SDK_COMPATIBILITY_PREFIX}authrim-js`]: JSON.stringify({
          minVersion: '0.5.0',
          recommendedVersion: '1.2.0',
          latestVersion: '1.5.0',
          deprecatedVersions: ['0.9.0'],
          enabled: true,
        }),
      };

      const env = createMockEnv({
        SDK_COMPATIBILITY_CHECK_ENABLED: 'true',
        AUTHRIM_CONFIG: createMockKV(kvData),
      });
      const app = createTestApp(env);

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: {
            [SDK_VERSION_REQUEST_HEADER]: 'authrim-js/0.9.0',
          },
        })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get(SDK_WARNING_HEADER)).toBe('deprecated; recommended=1.2.0');

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.status).toBe('deprecated');
    });

    it('should warn for unsupported SDK version', async () => {
      const kvData = {
        ...enabledConfig,
        [`${SDK_COMPATIBILITY_PREFIX}authrim-js`]: JSON.stringify({
          minVersion: '1.0.0',
          recommendedVersion: '1.2.0',
          latestVersion: '1.5.0',
          enabled: true,
        }),
      };

      const env = createMockEnv({
        SDK_COMPATIBILITY_CHECK_ENABLED: 'true',
        AUTHRIM_CONFIG: createMockKV(kvData),
      });
      const app = createTestApp(env);

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: {
            [SDK_VERSION_REQUEST_HEADER]: 'authrim-js/0.5.0',
          },
        })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get(SDK_WARNING_HEADER)).toBe('unsupported; recommended=1.2.0');

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.status).toBe('unsupported');
    });
  });

  describe('No SDK Header', () => {
    it('should handle requests without SDK version header', async () => {
      const env = createMockEnv({
        SDK_COMPATIBILITY_CHECK_ENABLED: 'true',
      });
      const app = createTestApp(env);

      const response = await app.fetch(new Request('http://localhost/api/admin/test'));

      expect(response.status).toBe(200);
      expect(response.headers.get(SDK_WARNING_HEADER)).toBeNull();

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.hasVersion).toBe(false);
      expect(data.status).toBe('unknown');
    });
  });

  describe('Invalid SDK Version Format', () => {
    it('should handle invalid SDK version format', async () => {
      const env = createMockEnv({
        SDK_COMPATIBILITY_CHECK_ENABLED: 'true',
      });
      const app = createTestApp(env);

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: {
            [SDK_VERSION_REQUEST_HEADER]: 'invalid-format',
          },
        })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get(SDK_WARNING_HEADER)).toBeNull();

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.hasVersion).toBe(true);
      expect(data.sdkName).toBeUndefined(); // sdk?.name returns undefined when sdk is null
      expect(data.status).toBe('unknown');
    });
  });

  describe('Unknown SDK', () => {
    it('should handle unknown SDK name', async () => {
      const enabledConfig = {
        [SDK_COMPATIBILITY_CONFIG_KEY]: JSON.stringify({
          enabled: true,
          sdks: {},
        }),
      };

      const env = createMockEnv({
        SDK_COMPATIBILITY_CHECK_ENABLED: 'true',
        AUTHRIM_CONFIG: createMockKV(enabledConfig),
      });
      const app = createTestApp(env);

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: {
            [SDK_VERSION_REQUEST_HEADER]: 'unknown-sdk/1.0.0',
          },
        })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get(SDK_WARNING_HEADER)).toBeNull();

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.hasVersion).toBe(true);
      expect(data.sdkName).toBe('unknown-sdk');
      expect(data.status).toBe('unknown');
    });
  });

  describe('Fail-Safe Behavior', () => {
    it('should continue without warnings when KV throws error', async () => {
      const errorKV = {
        get: vi.fn().mockRejectedValue(new Error('KV unavailable')),
        put: vi.fn(),
        delete: vi.fn(),
        list: vi.fn(),
        getWithMetadata: vi.fn(),
      } as unknown as KVNamespace;

      const env = createMockEnv({
        SDK_COMPATIBILITY_CHECK_ENABLED: 'true',
        AUTHRIM_CONFIG: errorKV,
      });
      const app = createTestApp(env);

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: {
            [SDK_VERSION_REQUEST_HEADER]: 'authrim-js/1.0.0',
          },
        })
      );

      // Should not fail, just skip SDK warnings
      expect(response.status).toBe(200);
      expect(response.headers.get(SDK_WARNING_HEADER)).toBeNull();
    });
  });

  describe('Version Comparison', () => {
    it('should correctly compare semver versions', async () => {
      const kvData = {
        [SDK_COMPATIBILITY_CONFIG_KEY]: JSON.stringify({ enabled: true, sdks: {} }),
        [`${SDK_COMPATIBILITY_PREFIX}authrim-js`]: JSON.stringify({
          minVersion: '1.0.0',
          recommendedVersion: '2.0.0',
          latestVersion: '2.5.0',
          enabled: true,
        }),
      };

      const env = createMockEnv({
        SDK_COMPATIBILITY_CHECK_ENABLED: 'true',
        AUTHRIM_CONFIG: createMockKV(kvData),
      });
      const app = createTestApp(env);

      // Test with version between min and recommended
      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: {
            [SDK_VERSION_REQUEST_HEADER]: 'authrim-js/1.5.0',
          },
        })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get(SDK_WARNING_HEADER)).toBe('outdated; recommended=2.0.0');

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.status).toBe('outdated');
    });

    it('should treat version at recommended as compatible', async () => {
      const kvData = {
        [SDK_COMPATIBILITY_CONFIG_KEY]: JSON.stringify({ enabled: true, sdks: {} }),
        [`${SDK_COMPATIBILITY_PREFIX}authrim-js`]: JSON.stringify({
          minVersion: '1.0.0',
          recommendedVersion: '2.0.0',
          latestVersion: '2.5.0',
          enabled: true,
        }),
      };

      const env = createMockEnv({
        SDK_COMPATIBILITY_CHECK_ENABLED: 'true',
        AUTHRIM_CONFIG: createMockKV(kvData),
      });
      const app = createTestApp(env);

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: {
            [SDK_VERSION_REQUEST_HEADER]: 'authrim-js/2.0.0',
          },
        })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get(SDK_WARNING_HEADER)).toBeNull();

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.status).toBe('compatible');
    });

    it('should treat version above recommended as compatible', async () => {
      const kvData = {
        [SDK_COMPATIBILITY_CONFIG_KEY]: JSON.stringify({ enabled: true, sdks: {} }),
        [`${SDK_COMPATIBILITY_PREFIX}authrim-js`]: JSON.stringify({
          minVersion: '1.0.0',
          recommendedVersion: '2.0.0',
          latestVersion: '2.5.0',
          enabled: true,
        }),
      };

      const env = createMockEnv({
        SDK_COMPATIBILITY_CHECK_ENABLED: 'true',
        AUTHRIM_CONFIG: createMockKV(kvData),
      });
      const app = createTestApp(env);

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: {
            [SDK_VERSION_REQUEST_HEADER]: 'authrim-js/2.3.0',
          },
        })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get(SDK_WARNING_HEADER)).toBeNull();

      const data = (await response.json()) as Record<string, unknown>;
      expect(data.status).toBe('compatible');
    });
  });

  describe('Security: Input Length Limits', () => {
    it('should reject excessively long SDK version headers', async () => {
      const env = createMockEnv({
        SDK_COMPATIBILITY_CHECK_ENABLED: 'true',
      });
      const app = createTestApp(env);

      // SDK version header with length > MAX_SDK_VERSION_LENGTH (100)
      const longSdkVersion = 'a'.repeat(50) + '/1.0.0'; // 56 chars, valid format but long name
      const veryLongSdkVersion = 'x'.repeat(200) + '/1.0.0'; // 206 chars

      // Long but valid format should be parsed
      const response1 = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: {
            [SDK_VERSION_REQUEST_HEADER]: longSdkVersion,
          },
        })
      );
      expect(response1.status).toBe(200);
      const data1 = (await response1.json()) as Record<string, unknown>;
      expect(data1.hasVersion).toBe(true);
      expect(data1.sdkName).toBe('a'.repeat(50));

      // Very long should be rejected (treated as invalid)
      const response2 = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: {
            [SDK_VERSION_REQUEST_HEADER]: veryLongSdkVersion,
          },
        })
      );
      expect(response2.status).toBe(200);
      const data2 = (await response2.json()) as Record<string, unknown>;
      expect(data2.hasVersion).toBe(true);
      expect(data2.sdkName).toBeUndefined(); // Parsed as null due to length limit
      expect(data2.status).toBe('unknown');
    });

    it('should not crash on malformed version numbers', async () => {
      const env = createMockEnv({
        SDK_COMPATIBILITY_CHECK_ENABLED: 'true',
      });
      const app = createTestApp(env);

      // These should be handled gracefully (rejected as invalid format)
      const malformedVersions = [
        'sdk/1.2.a', // Non-numeric patch
        'sdk/1..2', // Missing minor
        'sdk/.1.2', // Missing major
        'sdk/999999999999999999.1.1', // Very large number
      ];

      for (const version of malformedVersions) {
        const response = await app.fetch(
          new Request('http://localhost/api/admin/test', {
            headers: {
              [SDK_VERSION_REQUEST_HEADER]: version,
            },
          })
        );
        expect(response.status).toBe(200);
        // Should not crash, just return unknown
        const data = (await response.json()) as Record<string, unknown>;
        expect(data.hasVersion).toBe(true);
      }
    });
  });

  describe('Security: JSON Type Validation', () => {
    it('should handle malformed JSON in KV gracefully', async () => {
      const kvData = {
        [SDK_COMPATIBILITY_CONFIG_KEY]: 'not valid json',
      };

      const env = createMockEnv({
        SDK_COMPATIBILITY_CHECK_ENABLED: 'true',
        AUTHRIM_CONFIG: createMockKV(kvData),
      });
      const app = createTestApp(env);

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: {
            [SDK_VERSION_REQUEST_HEADER]: 'authrim-js/1.0.0',
          },
        })
      );

      // Should not crash, just skip SDK check
      expect(response.status).toBe(200);
    });

    it('should handle missing required fields in SDK entry', async () => {
      const kvData = {
        [SDK_COMPATIBILITY_CONFIG_KEY]: JSON.stringify({ enabled: true, sdks: {} }),
        // SDK entry missing required fields
        [`${SDK_COMPATIBILITY_PREFIX}authrim-js`]: JSON.stringify({
          // Missing minVersion, recommendedVersion, latestVersion, enabled
          someOtherField: 'value',
        }),
      };

      const env = createMockEnv({
        SDK_COMPATIBILITY_CHECK_ENABLED: 'true',
        AUTHRIM_CONFIG: createMockKV(kvData),
      });
      const app = createTestApp(env);

      const response = await app.fetch(
        new Request('http://localhost/api/admin/test', {
          headers: {
            [SDK_VERSION_REQUEST_HEADER]: 'authrim-js/1.0.0',
          },
        })
      );

      // Should not crash, treat as unknown SDK
      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data.status).toBe('unknown');
    });
  });
});
