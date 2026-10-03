/**
 * Logout Failures Admin API Tests
 *
 * Tests for:
 * - GET /api/admin/logout-failures
 * - GET/DELETE /api/admin/logout-failures/:clientId
 * - DELETE /api/admin/logout-failures
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
  listLogoutFailures,
  getLogoutFailure,
  clearLogoutFailure,
  clearAllLogoutFailures,
} from '../routes/logout-failures';

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

describe('Logout Failures API', () => {
  describe('GET /api/admin/logout-failures', () => {
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

  describe('GET /api/admin/logout-failures/:clientId', () => {
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

  describe('DELETE /api/admin/logout-failures/:clientId', () => {
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

  describe('DELETE /api/admin/logout-failures', () => {
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
