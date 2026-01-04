/**
 * Audit Storage Configuration API Tests
 *
 * Tests for the audit storage configuration endpoints:
 * - GET/PUT /api/admin/settings/audit-storage
 * - GET/PUT /api/admin/settings/audit-storage/retention
 * - GET/PUT/POST/DELETE /api/admin/settings/audit-storage/routing-rules
 * - POST /api/admin/settings/audit-storage/cleanup
 * - GET /api/admin/settings/audit-storage/stats
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { DEFAULT_AUDIT_STORAGE_CONFIG } from '@authrim/ar-lib-core';
import {
  getAuditStorageConfig,
  updateAuditStorageConfig,
  getRetentionConfig,
  updateRetentionConfig,
  getRoutingRules,
  updateRoutingRules,
  addRoutingRule,
  deleteRoutingRule,
  triggerRetentionCleanup,
  getStorageStats,
} from '../routes/settings/audit-storage';

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
    list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

// Mock D1Database
function createMockD1(): D1Database {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ count: 1000 }),
      run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 50 } }),
      all: vi.fn().mockResolvedValue({ results: [] }),
    }),
    batch: vi.fn().mockResolvedValue([]),
    exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
    dump: vi.fn(),
  } as unknown as D1Database;
}

// Create test app
function createTestApp(options: { kv?: KVNamespace; db?: D1Database } = {}) {
  const mockKV = options.kv ?? createMockKV();
  const mockDB = options.db ?? createMockD1();

  const app = new Hono<{
    Bindings: Env;
    Variables: { adminUser?: { id: string } };
  }>();

  // Mock admin auth middleware
  app.use('*', async (c, next) => {
    c.set('adminUser', { id: 'test_admin' });
    await next();
  });

  // Mount audit storage routes
  app.get('/api/admin/settings/audit-storage', getAuditStorageConfig);
  app.put('/api/admin/settings/audit-storage', updateAuditStorageConfig);
  app.get('/api/admin/settings/audit-storage/retention', getRetentionConfig);
  app.put('/api/admin/settings/audit-storage/retention', updateRetentionConfig);
  app.get('/api/admin/settings/audit-storage/routing-rules', getRoutingRules);
  app.put('/api/admin/settings/audit-storage/routing-rules', updateRoutingRules);
  app.post('/api/admin/settings/audit-storage/routing-rules', addRoutingRule);
  app.delete('/api/admin/settings/audit-storage/routing-rules/:name', deleteRoutingRule);
  app.post('/api/admin/settings/audit-storage/cleanup', triggerRetentionCleanup);
  app.get('/api/admin/settings/audit-storage/stats', getStorageStats);

  const mockEnv = {
    AUTHRIM_CONFIG: mockKV,
    DB: mockDB,
  } as unknown as Env;

  return { app, mockEnv, mockKV, mockDB };
}

describe('Audit Storage Configuration API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // GET Storage Config
  // ==========================================================================

  describe('GET /api/admin/settings/audit-storage', () => {
    it('should return default config when KV is empty', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request(
        '/api/admin/settings/audit-storage',
        { method: 'GET' },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.storage.source).toBe('default');
      expect(body.storage.config).toEqual(DEFAULT_AUDIT_STORAGE_CONFIG);
      expect(body.retention.source).toBe('default');
      expect(body.routing_rules.rules).toEqual([]);
    });

    it('should return stored config when exists', async () => {
      const customConfig = {
        ...DEFAULT_AUDIT_STORAGE_CONFIG,
        defaultEventBackend: 'r2',
      };

      const mockKV = createMockKV({
        audit_storage_config: JSON.stringify(customConfig),
      });
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/settings/audit-storage',
        { method: 'GET' },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.storage.source).toBe('kv');
      expect(body.storage.config.defaultEventBackend).toBe('r2');
    });

    it('should include backend types and constraints', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request(
        '/api/admin/settings/audit-storage',
        { method: 'GET' },
        mockEnv
      );
      const body = (await res.json()) as any;

      expect(body.backend_types).toHaveProperty('D1');
      expect(body.backend_types).toHaveProperty('R2');
      expect(body.backend_types).toHaveProperty('HYPERDRIVE');
      expect(body.retention.constraints).toHaveProperty('min_event_log_retention_days');
      expect(body.retention.constraints).toHaveProperty('max_event_log_retention_days');
    });
  });

  // ==========================================================================
  // UPDATE Storage Config
  // ==========================================================================

  describe('PUT /api/admin/settings/audit-storage', () => {
    it('should update defaultEventBackend', async () => {
      const mockKV = createMockKV();
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/settings/audit-storage',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            // Valid backend from DEFAULT_AUDIT_STORAGE_CONFIG.backends
            defaultEventBackend: 'd1-core',
          }),
        },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.success).toBe(true);
      expect(mockKV.put).toHaveBeenCalled();
    });

    it('should reject invalid backend', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request(
        '/api/admin/settings/audit-storage',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            defaultEventBackend: 'invalid_backend',
          }),
        },
        mockEnv
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;

      expect(body.error).toBe('invalid_request');
    });

    it('should return 500 when KV is not configured', async () => {
      const app = new Hono<{ Bindings: Env }>();
      app.put('/api/admin/settings/audit-storage', updateAuditStorageConfig);

      const mockEnv = {} as unknown as Env;

      const res = await app.request(
        '/api/admin/settings/audit-storage',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ defaultEventBackend: 'd1' }),
        },
        mockEnv
      );

      expect(res.status).toBe(500);
    });
  });

  // ==========================================================================
  // Retention Config
  // ==========================================================================

  describe('GET /api/admin/settings/audit-storage/retention', () => {
    it('should return default retention config', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request(
        '/api/admin/settings/audit-storage/retention',
        { method: 'GET' },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.source).toBe('default');
      expect(body.config.eventLogRetentionDays).toBe(90);
      expect(body.config.piiLogRetentionDays).toBe(365);
    });

    it('should return stored retention config', async () => {
      const customRetention = {
        eventLogRetentionDays: 180,
        piiLogRetentionDays: 730,
        archiveBeforeDelete: true,
      };

      const mockKV = createMockKV({
        audit_retention_config: JSON.stringify(customRetention),
      });
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/settings/audit-storage/retention',
        { method: 'GET' },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.source).toBe('kv');
      expect(body.config.eventLogRetentionDays).toBe(180);
      expect(body.config.archiveBeforeDelete).toBe(true);
    });
  });

  describe('PUT /api/admin/settings/audit-storage/retention', () => {
    it('should update retention config', async () => {
      const mockKV = createMockKV();
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/settings/audit-storage/retention',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            eventLogRetentionDays: 180,
            piiLogRetentionDays: 730,
            archiveBeforeDelete: true,
          }),
        },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.success).toBe(true);
      expect(body.config.eventLogRetentionDays).toBe(180);
      expect(body.config.archiveBeforeDelete).toBe(true);
    });

    it('should reject invalid retention days', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request(
        '/api/admin/settings/audit-storage/retention',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            eventLogRetentionDays: 0,
          }),
        },
        mockEnv
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;

      // Error format: "must be between X and Y"
      expect(body.error_description).toContain('must be between');
    });

    it('should reject retention days exceeding maximum', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request(
        '/api/admin/settings/audit-storage/retention',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            eventLogRetentionDays: 10000,
          }),
        },
        mockEnv
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;

      // Error format: "must be between X and Y"
      expect(body.error_description).toContain('must be between');
    });
  });

  // ==========================================================================
  // Routing Rules
  // ==========================================================================

  describe('GET /api/admin/settings/audit-storage/routing-rules', () => {
    it('should return empty rules by default', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request(
        '/api/admin/settings/audit-storage/routing-rules',
        { method: 'GET' },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.rules).toEqual([]);
      expect(body.count).toBe(0);
    });

    it('should return stored routing rules', async () => {
      const rules = [
        {
          id: 'rule-1',
          name: 'EU Data',
          priority: 10,
          enabled: true,
          conditions: { region: 'eu' },
          backend: 'hyperdrive',
        },
      ];

      const mockKV = createMockKV({
        audit_routing_rules: JSON.stringify(rules),
      });
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/settings/audit-storage/routing-rules',
        { method: 'GET' },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.rules).toHaveLength(1);
      expect(body.rules[0].name).toBe('EU Data');
    });
  });

  describe('POST /api/admin/settings/audit-storage/routing-rules', () => {
    it('should add a new routing rule', async () => {
      const mockKV = createMockKV();
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/settings/audit-storage/routing-rules',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'High Priority Tenant',
            priority: 100,
            enabled: true,
            conditions: { tenantId: 'premium-tenant' },
            backend: 'd1-core',
          }),
        },
        mockEnv
      );

      // addRoutingRule returns 200 not 201
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.success).toBe(true);
      expect(body.rule.name).toBe('High Priority Tenant');
    });

    it('should reject rule without name', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request(
        '/api/admin/settings/audit-storage/routing-rules',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            priority: 100,
            backend: 'd1-core',
          }),
        },
        mockEnv
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;

      expect(body.error_description).toContain('name is required');
    });
  });

  describe('DELETE /api/admin/settings/audit-storage/routing-rules/:name', () => {
    it('should delete an existing rule', async () => {
      const rules = [
        {
          name: 'To Delete',
          priority: 10,
          enabled: true,
          conditions: {},
          backend: 'd1-core',
        },
        {
          name: 'To Keep',
          priority: 20,
          enabled: true,
          conditions: {},
          backend: 'd1-pii',
        },
      ];

      const mockKV = createMockKV({
        audit_routing_rules: JSON.stringify(rules),
      });
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      // Use rule name, not id
      const res = await app.request(
        '/api/admin/settings/audit-storage/routing-rules/To Delete',
        { method: 'DELETE' },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.success).toBe(true);
      expect(body.remaining_rules).toBe(1);
    });

    it('should return 404 for non-existent rule', async () => {
      const mockKV = createMockKV({
        audit_routing_rules: JSON.stringify([]),
      });
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/settings/audit-storage/routing-rules/nonexistent',
        { method: 'DELETE' },
        mockEnv
      );

      expect(res.status).toBe(404);
    });
  });

  // ==========================================================================
  // Retention Cleanup
  // ==========================================================================

  describe('POST /api/admin/settings/audit-storage/cleanup', () => {
    it('should trigger retention cleanup', async () => {
      const mockDB = createMockD1();
      const { app, mockEnv } = createTestApp({ db: mockDB });

      const res = await app.request(
        '/api/admin/settings/audit-storage/cleanup',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      // This endpoint returns info about scheduled cleanup, not actual deletion
      expect(body.success).toBe(true);
      expect(body.note).toBeDefined();
      expect(body.scheduled_cleanup).toBeDefined();
    });
  });

  // ==========================================================================
  // Storage Stats
  // ==========================================================================

  describe('GET /api/admin/settings/audit-storage/stats', () => {
    it('should return storage statistics', async () => {
      const mockDB = createMockD1();
      const { app, mockEnv } = createTestApp({ db: mockDB });

      const res = await app.request(
        '/api/admin/settings/audit-storage/stats',
        { method: 'GET' },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      // Stats endpoint returns backend configuration status
      expect(body.backends).toBeDefined();
      expect(body.backends.d1_core).toBeDefined();
      expect(body.backends.d1_pii).toBeDefined();
    });
  });
});
