/**
 * Logging Configuration API Tests
 *
 * Tests for the logging configuration endpoints:
 * - GET/PUT/DELETE /api/admin/settings/logging
 * - GET/PUT/DELETE /api/admin/settings/logging/tenant/:tenantId
 * - GET /api/admin/settings/logging/tenants
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  getLoggingConfig,
  updateLoggingConfig,
  resetLoggingConfig,
  getTenantLoggingConfig,
  updateTenantLoggingConfig,
  resetTenantLoggingConfig,
  listTenantLoggingOverrides,
} from '../routes/settings/logging-config';

// Mock KV namespace
function createMockKV(data: Record<string, string> = {}): KVNamespace {
  const store = new Map<string, string>(Object.entries(data));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async (options?: { prefix?: string }) => {
      const keys = Array.from(store.keys())
        .filter((k) => !options?.prefix || k.startsWith(options.prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cacheStatus: null };
    }),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

// Create test app
function createTestApp(options: { kv?: KVNamespace; env?: Record<string, string> } = {}) {
  const mockKV = options.kv ?? createMockKV();

  const app = new Hono<{
    Bindings: Env;
    Variables: { adminUser?: { id: string } };
  }>();

  // Mock admin auth middleware
  app.use('*', async (c, next) => {
    c.set('adminUser', { id: 'test_admin' });
    await next();
  });

  // Mount logging config routes
  app.get('/api/admin/settings/logging', getLoggingConfig);
  app.put('/api/admin/settings/logging', updateLoggingConfig);
  app.delete('/api/admin/settings/logging', resetLoggingConfig);
  app.get('/api/admin/settings/logging/tenant/:tenantId', getTenantLoggingConfig);
  app.put('/api/admin/settings/logging/tenant/:tenantId', updateTenantLoggingConfig);
  app.delete('/api/admin/settings/logging/tenant/:tenantId', resetTenantLoggingConfig);
  app.get('/api/admin/settings/logging/tenants', listTenantLoggingOverrides);

  // Create mock env
  const mockEnv = {
    AUTHRIM_CONFIG: mockKV,
    ...options.env,
  } as unknown as Env;

  return { app, mockEnv, mockKV };
}

describe('Logging Configuration API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // Global Logging Config
  // ==========================================================================

  describe('GET /api/admin/settings/logging', () => {
    it('should return default config when KV is empty', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request('/api/admin/settings/logging', { method: 'GET' }, mockEnv);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.level.current).toBe('info');
      expect(body.level.source).toBe('default');
      expect(body.format.current).toBe('json');
      expect(body.format.source).toBe('default');
      expect(body.hash_user_id.current).toBe(true);
      expect(body.hash_user_id.source).toBe('default');
    });

    it('should return KV values when set', async () => {
      const mockKV = createMockKV({
        log_level: 'debug',
        log_format: 'pretty',
        log_hash_user_id: 'false',
      });
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request('/api/admin/settings/logging', { method: 'GET' }, mockEnv);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.level.current).toBe('debug');
      expect(body.level.source).toBe('kv');
      expect(body.format.current).toBe('pretty');
      expect(body.format.source).toBe('kv');
      expect(body.hash_user_id.current).toBe(false);
      expect(body.hash_user_id.source).toBe('kv');
    });

    it('should include valid values and descriptions', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request('/api/admin/settings/logging', { method: 'GET' }, mockEnv);
      const body = (await res.json()) as any;

      expect(body.level.valid_values).toEqual(['debug', 'info', 'warn', 'error']);
      expect(body.format.valid_values).toEqual(['json', 'pretty']);
      expect(body.level.description).toHaveProperty('debug');
      expect(body.level.description).toHaveProperty('info');
    });
  });

  describe('PUT /api/admin/settings/logging', () => {
    it('should update log level', async () => {
      const mockKV = createMockKV();
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/settings/logging',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ level: 'debug' }),
        },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.success).toBe(true);
      expect(body.updated).toHaveProperty('log_level', 'debug');
      expect(mockKV.put).toHaveBeenCalledWith('log_level', 'debug');
    });

    it('should update multiple settings at once', async () => {
      const mockKV = createMockKV();
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/settings/logging',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            level: 'warn',
            format: 'pretty',
            hash_user_id: false,
          }),
        },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.success).toBe(true);
      expect(mockKV.put).toHaveBeenCalledTimes(3);
    });

    it('should reject invalid log level', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request(
        '/api/admin/settings/logging',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ level: 'invalid' }),
        },
        mockEnv
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;

      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('Invalid level');
    });

    it('should reject invalid log format', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request(
        '/api/admin/settings/logging',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ format: 'xml' }),
        },
        mockEnv
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;

      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('Invalid format');
    });

    it('should reject empty update', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request(
        '/api/admin/settings/logging',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
        mockEnv
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;

      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('No valid fields');
    });

    it('should return 500 when KV is not configured', async () => {
      const app = new Hono<{ Bindings: Env }>();
      app.put('/api/admin/settings/logging', updateLoggingConfig);

      const mockEnv = {} as unknown as Env;

      const res = await app.request(
        '/api/admin/settings/logging',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ level: 'debug' }),
        },
        mockEnv
      );

      expect(res.status).toBe(500);
      const body = (await res.json()) as any;
      expect(body.error).toBe('server_error');
    });
  });

  describe('DELETE /api/admin/settings/logging', () => {
    it('should reset all settings to defaults', async () => {
      const mockKV = createMockKV({
        log_level: 'debug',
        log_format: 'pretty',
        log_hash_user_id: 'false',
      });
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request('/api/admin/settings/logging', { method: 'DELETE' }, mockEnv);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.success).toBe(true);
      expect(body.reset_to_defaults.level).toBe('info');
      expect(body.reset_to_defaults.format).toBe('json');
      expect(body.reset_to_defaults.hash_user_id).toBe(true);
      expect(mockKV.delete).toHaveBeenCalledTimes(3);
    });
  });

  // ==========================================================================
  // Per-Tenant Logging Config
  // ==========================================================================

  describe('GET /api/admin/settings/logging/tenant/:tenantId', () => {
    it('should return global level when no tenant override exists', async () => {
      const mockKV = createMockKV({ log_level: 'warn' });
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/settings/logging/tenant/tenant-1',
        { method: 'GET' },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.tenant_id).toBe('tenant-1');
      expect(body.level.current).toBe('warn');
      expect(body.level.source).toBe('global_kv');
      expect(body.level.tenant_override).toBeNull();
    });

    it('should return tenant override when set', async () => {
      const mockKV = createMockKV({
        log_level: 'warn',
        'log_tenant_override:tenant-1': 'debug',
      });
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/settings/logging/tenant/tenant-1',
        { method: 'GET' },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.tenant_id).toBe('tenant-1');
      expect(body.level.current).toBe('debug');
      expect(body.level.source).toBe('tenant_override');
      expect(body.level.tenant_override).toBe('debug');
      expect(body.level.global_level).toBe('warn');
    });
  });

  describe('PUT /api/admin/settings/logging/tenant/:tenantId', () => {
    it('should set tenant-specific log level', async () => {
      const mockKV = createMockKV();
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/settings/logging/tenant/tenant-1',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ level: 'debug' }),
        },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.success).toBe(true);
      expect(body.tenant_id).toBe('tenant-1');
      expect(body.level).toBe('debug');
      expect(mockKV.put).toHaveBeenCalledWith('log_tenant_override:tenant-1', 'debug');
    });

    it('should reject missing level', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request(
        '/api/admin/settings/logging/tenant/tenant-1',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
        mockEnv
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.error_description).toContain('level is required');
    });

    it('should reject invalid level', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request(
        '/api/admin/settings/logging/tenant/tenant-1',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ level: 'verbose' }),
        },
        mockEnv
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.error_description).toContain('Invalid level');
    });
  });

  describe('DELETE /api/admin/settings/logging/tenant/:tenantId', () => {
    it('should remove tenant override', async () => {
      const mockKV = createMockKV({
        'log_tenant_override:tenant-1': 'debug',
      });
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/settings/logging/tenant/tenant-1',
        { method: 'DELETE' },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.success).toBe(true);
      expect(body.tenant_id).toBe('tenant-1');
      expect(mockKV.delete).toHaveBeenCalledWith('log_tenant_override:tenant-1');
    });
  });

  describe('GET /api/admin/settings/logging/tenants', () => {
    it('should list all tenant overrides', async () => {
      const mockKV = createMockKV({
        'log_tenant_override:tenant-1': 'debug',
        'log_tenant_override:tenant-2': 'error',
        log_level: 'info', // Should not be included
      });
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/settings/logging/tenants',
        { method: 'GET' },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.count).toBe(2);
      expect(body.overrides).toContainEqual({ tenant_id: 'tenant-1', level: 'debug' });
      expect(body.overrides).toContainEqual({ tenant_id: 'tenant-2', level: 'error' });
    });

    it('should return empty list when no overrides exist', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request(
        '/api/admin/settings/logging/tenants',
        { method: 'GET' },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.overrides).toEqual([]);
      expect(body.count).toBe(0);
    });
  });
});
