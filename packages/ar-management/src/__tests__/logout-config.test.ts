/**
 * Logout Configuration Admin API Tests
 *
 * Tests for:
 * - GET /api/admin/settings/logout
 * - PUT /api/admin/settings/logout
 * - DELETE /api/admin/settings/logout
 * - GET /api/admin/settings/logout/failures
 * - DELETE /api/admin/settings/logout/failures
 *
 * @packageDocumentation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mock logger
const { mockLogger } = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    module: vi.fn().mockReturnThis(),
  };
  return { mockLogger: logger };
});

// Mock getLogger from ar-lib-core
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getLogger: () => mockLogger,
  };
});

import {
  getLogoutConfig,
  updateLogoutConfig,
  resetLogoutConfig,
} from '../routes/settings/logout-config';
import {
  listLogoutFailures,
  getLogoutFailure,
  clearLogoutFailure,
  clearAllLogoutFailures,
} from '../routes/settings/logout-failures';
import { DEFAULT_LOGOUT_CONFIG, LOGOUT_SETTINGS_KEY } from '@authrim/ar-lib-core';

// Mock KV namespace
function createMockKV(data: Record<string, string> = {}) {
  const store = new Map(Object.entries(data));
  return {
    get: vi.fn(async (key: string) => store.get(key) || null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async ({ prefix }: { prefix: string }) => {
      const keys = Array.from(store.keys())
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys };
    }),
  };
}

// Mock context
function createMockContext(options: {
  env?: { SETTINGS?: KVNamespace; STATE_STORE?: KVNamespace };
  body?: unknown;
  query?: Record<string, string>;
  params?: Record<string, string>;
}) {
  const c = {
    env: options.env || {},
    req: {
      json: vi.fn().mockResolvedValue(options.body || {}),
      query: (key: string) => options.query?.[key],
      param: (key: string) => options.params?.[key],
    },
    get: (key: string) => {
      if (key === 'logger') return mockLogger;
      return undefined;
    },
    json: vi.fn((data, status = 200) => ({ data, status })),
  } as any;
  return c;
}

describe('Logout Config API', () => {
  describe('GET /api/admin/settings/logout', () => {
    it('should return default config when no KV override', async () => {
      const mockKV = createMockKV();
      const c = createMockContext({
        env: { SETTINGS: mockKV as unknown as KVNamespace },
      });

      await getLogoutConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          config: DEFAULT_LOGOUT_CONFIG,
          source: 'default',
          defaults: DEFAULT_LOGOUT_CONFIG,
        })
      );
    });

    it('should return merged config from KV', async () => {
      const kvConfig = {
        backchannel: { enabled: false },
        frontchannel: { enabled: true, iframe_timeout_ms: 5000 },
      };
      const mockKV = createMockKV({
        [LOGOUT_SETTINGS_KEY]: JSON.stringify(kvConfig),
      });
      const c = createMockContext({
        env: { SETTINGS: mockKV as unknown as KVNamespace },
      });

      await getLogoutConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            backchannel: expect.objectContaining({ enabled: false }),
            frontchannel: expect.objectContaining({ iframe_timeout_ms: 5000 }),
          }),
          source: 'kv',
        })
      );
    });

    it('should handle missing SETTINGS KV gracefully', async () => {
      const c = createMockContext({ env: {} });

      await getLogoutConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          config: DEFAULT_LOGOUT_CONFIG,
          source: 'default',
        })
      );
    });
  });

  describe('PUT /api/admin/settings/logout', () => {
    it('should update logout configuration in KV', async () => {
      const mockKV = createMockKV();
      const c = createMockContext({
        env: { SETTINGS: mockKV as unknown as KVNamespace },
        body: {
          backchannel: { enabled: false },
          frontchannel: { iframe_timeout_ms: 5000 },
        },
      });

      await updateLogoutConfig(c);

      expect(mockKV.put).toHaveBeenCalledWith(LOGOUT_SETTINGS_KEY, expect.any(String));
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          config: expect.objectContaining({
            backchannel: expect.objectContaining({ enabled: false }),
            frontchannel: expect.objectContaining({ iframe_timeout_ms: 5000 }),
          }),
        })
      );
    });

    it('should validate backchannel config values', async () => {
      const mockKV = createMockKV();
      const c = createMockContext({
        env: { SETTINGS: mockKV as unknown as KVNamespace },
        body: {
          backchannel: { logout_token_exp_seconds: 10 }, // Too low (min 30)
        },
      });

      await updateLogoutConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_value',
          error_description: expect.stringContaining('logout_token_exp_seconds'),
        }),
        400
      );
    });

    it('should reject invalid request_timeout_ms', async () => {
      const mockKV = createMockKV();
      const c = createMockContext({
        env: { SETTINGS: mockKV as unknown as KVNamespace },
        body: {
          backchannel: { request_timeout_ms: 100 }, // Too low (min 1000)
        },
      });

      await updateLogoutConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_value',
        }),
        400
      );
    });

    it('should reject invalid retry config', async () => {
      const mockKV = createMockKV();
      const c = createMockContext({
        env: { SETTINGS: mockKV as unknown as KVNamespace },
        body: {
          backchannel: { retry: { max_attempts: 20 } }, // Too high (max 10)
        },
      });

      await updateLogoutConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_value',
          error_description: expect.stringContaining('max_attempts'),
        }),
        400
      );
    });

    it('should return error when SETTINGS KV not configured', async () => {
      const c = createMockContext({
        env: {},
        body: { backchannel: { enabled: false } },
      });

      await updateLogoutConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'kv_not_configured',
        }),
        500
      );
    });
  });

  describe('DELETE /api/admin/settings/logout', () => {
    it('should reset config to defaults', async () => {
      const mockKV = createMockKV({
        [LOGOUT_SETTINGS_KEY]: JSON.stringify({ backchannel: { enabled: false } }),
      });
      const c = createMockContext({
        env: { SETTINGS: mockKV as unknown as KVNamespace },
      });

      await resetLogoutConfig(c);

      expect(mockKV.delete).toHaveBeenCalledWith(LOGOUT_SETTINGS_KEY);
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          config: DEFAULT_LOGOUT_CONFIG,
        })
      );
    });

    it('should return error when SETTINGS KV not configured', async () => {
      const c = createMockContext({ env: {} });

      await resetLogoutConfig(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'kv_not_configured',
        }),
        500
      );
    });
  });
});

describe('Logout Failures API', () => {
  describe('GET /api/admin/settings/logout/failures', () => {
    it('should list failure records', async () => {
      const failures = {
        'logout:failures:client-1': JSON.stringify({
          clientName: 'Test Client 1',
          timestamp: Date.now(),
          statusCode: 500,
          error: 'Connection timeout',
        }),
        'logout:failures:client-2': JSON.stringify({
          clientName: 'Test Client 2',
          timestamp: Date.now() - 1000,
          statusCode: 404,
          error: 'Not found',
        }),
      };
      const mockKV = createMockKV(failures);
      const c = createMockContext({
        env: { SETTINGS: mockKV as unknown as KVNamespace },
      });

      await listLogoutFailures(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          total: 2,
          failures: expect.arrayContaining([
            expect.objectContaining({ clientId: 'client-1' }),
            expect.objectContaining({ clientId: 'client-2' }),
          ]),
        })
      );
    });

    it('should respect limit parameter', async () => {
      const mockKV = createMockKV();
      const c = createMockContext({
        env: { SETTINGS: mockKV as unknown as KVNamespace },
        query: { limit: '50' },
      });

      await listLogoutFailures(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 50,
        })
      );
    });

    it('should return error when KV not configured', async () => {
      const c = createMockContext({ env: {} });

      await listLogoutFailures(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'kv_not_configured',
        }),
        500
      );
    });
  });

  describe('GET /api/admin/settings/logout/failures/:clientId', () => {
    it('should return failure details for client', async () => {
      const failureData = {
        clientName: 'Test Client',
        timestamp: Date.now(),
        statusCode: 503,
        error: 'Service unavailable',
      };
      const mockKV = createMockKV({
        'logout:failures:client-123': JSON.stringify(failureData),
      });
      const c = createMockContext({
        env: { SETTINGS: mockKV as unknown as KVNamespace },
        params: { clientId: 'client-123' },
      });

      await getLogoutFailure(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: 'client-123',
          ...failureData,
        })
      );
    });

    it('should return 404 when client not found', async () => {
      const mockKV = createMockKV();
      const c = createMockContext({
        env: { SETTINGS: mockKV as unknown as KVNamespace },
        params: { clientId: 'nonexistent' },
      });

      await getLogoutFailure(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'not_found',
        }),
        404
      );
    });

    it('should return 400 when clientId missing', async () => {
      const mockKV = createMockKV();
      const c = createMockContext({
        env: { SETTINGS: mockKV as unknown as KVNamespace },
        params: {},
      });

      await getLogoutFailure(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
        }),
        400
      );
    });
  });

  describe('DELETE /api/admin/settings/logout/failures/:clientId', () => {
    it('should clear failure record for client', async () => {
      const mockKV = createMockKV({
        'logout:failures:client-123': JSON.stringify({ error: 'test' }),
      });
      const c = createMockContext({
        env: { SETTINGS: mockKV as unknown as KVNamespace },
        params: { clientId: 'client-123' },
      });

      await clearLogoutFailure(c);

      expect(mockKV.delete).toHaveBeenCalledWith('logout:failures:client-123');
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          clientId: 'client-123',
        })
      );
    });
  });

  describe('DELETE /api/admin/settings/logout/failures', () => {
    it('should clear all failure records', async () => {
      const mockKV = createMockKV({
        'logout:failures:client-1': JSON.stringify({ error: 'test1' }),
        'logout:failures:client-2': JSON.stringify({ error: 'test2' }),
      });
      const c = createMockContext({
        env: { SETTINGS: mockKV as unknown as KVNamespace },
      });

      await clearAllLogoutFailures(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          cleared: 2,
        })
      );
    });
  });
});
