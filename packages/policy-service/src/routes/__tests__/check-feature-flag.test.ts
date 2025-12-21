/**
 * Check API Feature Flag Tests
 *
 * Tests for Check API dynamic feature flag functionality:
 * - KV dynamic override (highest priority)
 * - Environment variable fallback
 * - Default disabled state (secure default)
 * - KV error handling
 *
 * @see CLAUDE.md: 設定項目・Feature Flagsの実装方針
 * @see packages/policy-service/src/routes/check.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import app from '../../index';
import { clearBatchSizeLimitCache } from '../check';

/**
 * Create mock KV namespace
 */
function createMockKV(data: Record<string, string | null> = {}): KVNamespace {
  return {
    get: vi.fn().mockImplementation((key: string) => {
      return Promise.resolve(data[key] ?? null);
    }),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
    getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

/**
 * Create mock D1 database
 */
function createMockD1(): D1Database {
  return {
    prepare: vi.fn().mockImplementation(() => ({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
      first: vi.fn().mockResolvedValue(null),
      run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 0 } }),
    })),
  } as unknown as D1Database;
}

/**
 * Create mock VERSION_MANAGER
 */
function createMockVersionManager() {
  return {
    idFromName: vi.fn(() => ({ toString: () => 'mock-id' })),
    get: vi.fn(() => ({
      fetch: vi.fn(() => Promise.resolve(new Response(JSON.stringify({ uuid: 'test-uuid' })))),
    })),
  };
}

// Base mock environment
const baseMockEnv = {
  POLICY_API_SECRET: 'test-secret-key',
  VERSION_MANAGER: createMockVersionManager(),
  CODE_VERSION_UUID: '',
};

// Helper to create request
function createRequest(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    withAuth?: boolean;
  } = {}
): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (options.withAuth !== false) {
    headers['Authorization'] = `Bearer ${baseMockEnv.POLICY_API_SECRET}`;
  }

  return new Request(`https://test.example.com${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

describe('Check API Feature Flag - Dynamic Override', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('KV Dynamic Override (Highest Priority)', () => {
    it('should enable Check API when KV flag is true', async () => {
      const mockKV = createMockKV({ CHECK_API_ENABLED: 'true' });
      const mockD1 = createMockD1();

      const env = {
        ...baseMockEnv,
        DB: mockD1,
        POLICY_FLAGS_KV: mockKV,
        ENABLE_CHECK_API: 'false', // Env is false, but KV should override
      };

      const req = createRequest('/api/check/health', { withAuth: false });
      const res = await app.fetch(req, env);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.enabled).toBe(true);
      expect(mockKV.get).toHaveBeenCalledWith('CHECK_API_ENABLED');
    });

    it('should disable Check API when KV flag is false (overrides env true)', async () => {
      const mockKV = createMockKV({ CHECK_API_ENABLED: 'false' });
      const mockD1 = createMockD1();

      const env = {
        ...baseMockEnv,
        DB: mockD1,
        POLICY_FLAGS_KV: mockKV,
        ENABLE_CHECK_API: 'true', // Env is true, but KV should override
      };

      const req = createRequest('/api/check/health', { withAuth: false });
      const res = await app.fetch(req, env);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.enabled).toBe(false);
    });

    it('should fall through to env var when KV returns null', async () => {
      const mockKV = createMockKV({}); // Empty KV
      const mockD1 = createMockD1();

      const env = {
        ...baseMockEnv,
        DB: mockD1,
        POLICY_FLAGS_KV: mockKV,
        ENABLE_CHECK_API: 'true', // Should use env var
      };

      const req = createRequest('/api/check/health', { withAuth: false });
      const res = await app.fetch(req, env);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.enabled).toBe(true);
    });
  });

  describe('KV Error Handling', () => {
    it('should fall back to env var when KV throws error', async () => {
      const mockKV = {
        get: vi.fn().mockRejectedValue(new Error('KV connection failed')),
        put: vi.fn(),
        delete: vi.fn(),
        list: vi.fn(),
        getWithMetadata: vi.fn(),
      } as unknown as KVNamespace;
      const mockD1 = createMockD1();

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const env = {
        ...baseMockEnv,
        DB: mockD1,
        POLICY_FLAGS_KV: mockKV,
        ENABLE_CHECK_API: 'true',
      };

      const req = createRequest('/api/check/health', { withAuth: false });
      const res = await app.fetch(req, env);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.enabled).toBe(true);
      expect(consoleSpy).toHaveBeenCalledWith(
        '[Check API] Failed to read KV flag:',
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });

    it('should use secure default (disabled) when KV fails and no env var', async () => {
      const mockKV = {
        get: vi.fn().mockRejectedValue(new Error('KV connection failed')),
        put: vi.fn(),
        delete: vi.fn(),
        list: vi.fn(),
        getWithMetadata: vi.fn(),
      } as unknown as KVNamespace;
      const mockD1 = createMockD1();

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const env = {
        ...baseMockEnv,
        DB: mockD1,
        POLICY_FLAGS_KV: mockKV,
        // No ENABLE_CHECK_API - should default to disabled
      };

      const req = createRequest('/api/check/health', { withAuth: false });
      const res = await app.fetch(req, env);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.enabled).toBe(false);

      consoleSpy.mockRestore();
    });
  });

  describe('Environment Variable Fallback', () => {
    it('should enable Check API when env var is true and no KV', async () => {
      const mockD1 = createMockD1();

      const env = {
        ...baseMockEnv,
        DB: mockD1,
        ENABLE_CHECK_API: 'true',
        // No POLICY_FLAGS_KV
      };

      const req = createRequest('/api/check/health', { withAuth: false });
      const res = await app.fetch(req, env);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.enabled).toBe(true);
    });

    it('should disable Check API when env var is false and no KV', async () => {
      const mockD1 = createMockD1();

      const env = {
        ...baseMockEnv,
        DB: mockD1,
        ENABLE_CHECK_API: 'false',
      };

      const req = createRequest('/api/check/health', { withAuth: false });
      const res = await app.fetch(req, env);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.enabled).toBe(false);
    });
  });

  describe('Secure Default', () => {
    it('should default to disabled when no configuration exists', async () => {
      const mockD1 = createMockD1();

      const env = {
        ...baseMockEnv,
        DB: mockD1,
        // No POLICY_FLAGS_KV, no ENABLE_CHECK_API
      };

      const req = createRequest('/api/check/health', { withAuth: false });
      const res = await app.fetch(req, env);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.enabled).toBe(false);
    });
  });

  describe('API Endpoint Behavior', () => {
    it('should return 503 when Check API is disabled', async () => {
      const mockD1 = createMockD1();

      const env = {
        ...baseMockEnv,
        DB: mockD1,
        ENABLE_CHECK_API: 'false',
      };

      const req = createRequest('/api/check', {
        method: 'POST',
        withAuth: true,
        body: {
          subject_id: 'user_1',
          permission: 'read',
          tenant_id: 'default',
        },
      });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toBe('feature_disabled');
    });

    it('should process request when Check API is enabled via KV', async () => {
      const mockKV = createMockKV({ CHECK_API_ENABLED: 'true' });
      const mockD1 = createMockD1();

      const env = {
        ...baseMockEnv,
        DB: mockD1,
        POLICY_FLAGS_KV: mockKV,
      };

      const req = createRequest('/api/check', {
        method: 'POST',
        withAuth: true,
        body: {
          subject_id: 'user_1',
          permission: 'read',
          tenant_id: 'default',
        },
      });
      const res = await app.fetch(req, env);

      // Should not return 503 feature_disabled
      expect(res.status).not.toBe(503);
    });

    it('should return 503 for batch when Check API is disabled', async () => {
      const mockD1 = createMockD1();

      const env = {
        ...baseMockEnv,
        DB: mockD1,
        ENABLE_CHECK_API: 'false',
      };

      const req = createRequest('/api/check/batch', {
        method: 'POST',
        withAuth: true,
        body: {
          checks: [{ subject_id: 'user_1', permission: 'read', tenant_id: 'default' }],
        },
      });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toBe('feature_disabled');
    });
  });
});

/**
 * Batch Size Limit Configuration Tests
 *
 * Tests for batch size limit dynamic configuration:
 * - KV dynamic override (highest priority)
 * - Environment variable fallback
 * - Default value (100)
 * - In-memory cache behavior
 * - Validation of limits (1-1000)
 *
 * @see CLAUDE.md: 設定項目・Feature Flagsの実装方針
 */
describe('Batch Size Limit Configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearBatchSizeLimitCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearBatchSizeLimitCache();
  });

  describe('Health Check Shows Batch Size Limit', () => {
    it('should show default batch_size_limit (100) in health check', async () => {
      const mockD1 = createMockD1();

      const env = {
        ...baseMockEnv,
        DB: mockD1,
        ENABLE_CHECK_API: 'true',
      };

      const req = createRequest('/api/check/health', { withAuth: false });
      const res = await app.fetch(req, env);
      const body = (await res.json()) as { batch_size_limit: number };

      expect(res.status).toBe(200);
      expect(body.batch_size_limit).toBe(100);
    });

    it('should show KV-configured batch_size_limit in health check', async () => {
      const mockKV = createMockKV({
        CHECK_API_ENABLED: 'true',
        CHECK_API_BATCH_SIZE_LIMIT: '50',
      });
      const mockD1 = createMockD1();

      const env = {
        ...baseMockEnv,
        DB: mockD1,
        POLICY_FLAGS_KV: mockKV,
      };

      const req = createRequest('/api/check/health', { withAuth: false });
      const res = await app.fetch(req, env);
      const body = (await res.json()) as { batch_size_limit: number };

      expect(res.status).toBe(200);
      expect(body.batch_size_limit).toBe(50);
    });
  });

  describe('KV Dynamic Override (Highest Priority)', () => {
    it('should use KV batch size limit over env var', async () => {
      const mockKV = createMockKV({
        CHECK_API_ENABLED: 'true',
        CHECK_API_BATCH_SIZE_LIMIT: '25',
      });
      const mockD1 = createMockD1();

      const env = {
        ...baseMockEnv,
        DB: mockD1,
        POLICY_FLAGS_KV: mockKV,
        CHECK_API_BATCH_SIZE_LIMIT: '200', // Env should be overridden by KV
      };

      const req = createRequest('/api/check/health', { withAuth: false });
      const res = await app.fetch(req, env);
      const body = (await res.json()) as { batch_size_limit: number };

      expect(res.status).toBe(200);
      expect(body.batch_size_limit).toBe(25);
      expect(mockKV.get).toHaveBeenCalledWith('CHECK_API_BATCH_SIZE_LIMIT');
    });

    it('should reject batch exceeding KV-configured limit', async () => {
      const mockKV = createMockKV({
        CHECK_API_ENABLED: 'true',
        CHECK_API_BATCH_SIZE_LIMIT: '5',
      });
      const mockD1 = createMockD1();

      const env = {
        ...baseMockEnv,
        DB: mockD1,
        POLICY_FLAGS_KV: mockKV,
      };

      // Create 6 checks (exceeds limit of 5)
      const checks = Array.from({ length: 6 }, (_, i) => ({
        subject_id: `user_${i}`,
        permission: 'read',
        tenant_id: 'default',
      }));

      const req = createRequest('/api/check/batch', {
        method: 'POST',
        withAuth: true,
        body: { checks },
      });
      const res = await app.fetch(req, env);
      const body = (await res.json()) as { error: string; error_description: string };

      expect(res.status).toBe(400);
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('Maximum batch size is 5');
    });
  });

  describe('Environment Variable Fallback', () => {
    it('should use env var when KV returns null', async () => {
      const mockKV = createMockKV({ CHECK_API_ENABLED: 'true' });
      const mockD1 = createMockD1();

      const env = {
        ...baseMockEnv,
        DB: mockD1,
        POLICY_FLAGS_KV: mockKV,
        CHECK_API_BATCH_SIZE_LIMIT: '75',
      };

      const req = createRequest('/api/check/health', { withAuth: false });
      const res = await app.fetch(req, env);
      const body = (await res.json()) as { batch_size_limit: number };

      expect(res.status).toBe(200);
      expect(body.batch_size_limit).toBe(75);
    });

    it('should use default (100) when no KV or env var', async () => {
      const mockD1 = createMockD1();

      const env = {
        ...baseMockEnv,
        DB: mockD1,
        ENABLE_CHECK_API: 'true',
      };

      const req = createRequest('/api/check/health', { withAuth: false });
      const res = await app.fetch(req, env);
      const body = (await res.json()) as { batch_size_limit: number };

      expect(res.status).toBe(200);
      expect(body.batch_size_limit).toBe(100);
    });
  });

  describe('Limit Validation', () => {
    it('should ignore invalid KV value (non-numeric)', async () => {
      const mockKV = createMockKV({
        CHECK_API_ENABLED: 'true',
        CHECK_API_BATCH_SIZE_LIMIT: 'invalid',
      });
      const mockD1 = createMockD1();

      const env = {
        ...baseMockEnv,
        DB: mockD1,
        POLICY_FLAGS_KV: mockKV,
        CHECK_API_BATCH_SIZE_LIMIT: '50',
      };

      const req = createRequest('/api/check/health', { withAuth: false });
      const res = await app.fetch(req, env);
      const body = (await res.json()) as { batch_size_limit: number };

      // Should fall back to env var since KV value is invalid
      expect(res.status).toBe(200);
      expect(body.batch_size_limit).toBe(50);
    });

    it('should ignore KV value exceeding maximum (1000)', async () => {
      const mockKV = createMockKV({
        CHECK_API_ENABLED: 'true',
        CHECK_API_BATCH_SIZE_LIMIT: '2000',
      });
      const mockD1 = createMockD1();

      const env = {
        ...baseMockEnv,
        DB: mockD1,
        POLICY_FLAGS_KV: mockKV,
      };

      const req = createRequest('/api/check/health', { withAuth: false });
      const res = await app.fetch(req, env);
      const body = (await res.json()) as { batch_size_limit: number };

      // Should fall back to default since KV value exceeds max
      expect(res.status).toBe(200);
      expect(body.batch_size_limit).toBe(100);
    });

    it('should ignore KV value of zero or negative', async () => {
      const mockKV = createMockKV({
        CHECK_API_ENABLED: 'true',
        CHECK_API_BATCH_SIZE_LIMIT: '0',
      });
      const mockD1 = createMockD1();

      const env = {
        ...baseMockEnv,
        DB: mockD1,
        POLICY_FLAGS_KV: mockKV,
      };

      const req = createRequest('/api/check/health', { withAuth: false });
      const res = await app.fetch(req, env);
      const body = (await res.json()) as { batch_size_limit: number };

      // Should fall back to default since 0 is invalid
      expect(res.status).toBe(200);
      expect(body.batch_size_limit).toBe(100);
    });
  });

  describe('Error Handling', () => {
    it('should fall back to default when KV throws error', async () => {
      const mockKV = {
        get: vi.fn().mockImplementation((key: string) => {
          if (key === 'CHECK_API_ENABLED') return Promise.resolve('true');
          if (key === 'CHECK_API_BATCH_SIZE_LIMIT') return Promise.reject(new Error('KV error'));
          return Promise.resolve(null);
        }),
        put: vi.fn(),
        delete: vi.fn(),
        list: vi.fn(),
        getWithMetadata: vi.fn(),
      } as unknown as KVNamespace;
      const mockD1 = createMockD1();

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const env = {
        ...baseMockEnv,
        DB: mockD1,
        POLICY_FLAGS_KV: mockKV,
      };

      const req = createRequest('/api/check/health', { withAuth: false });
      const res = await app.fetch(req, env);
      const body = (await res.json()) as { batch_size_limit: number };

      expect(res.status).toBe(200);
      expect(body.batch_size_limit).toBe(100);
      expect(consoleSpy).toHaveBeenCalledWith(
        '[Check API] Failed to read batch size limit from KV:',
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });
  });
});
