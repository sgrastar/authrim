/**
 * Audit PII Configuration API Tests
 *
 * Tests for the audit PII configuration endpoints:
 * - GET/PUT/DELETE /api/admin/tenants/:tenantId/audit/pii-config
 * - POST /api/admin/tenants/:tenantId/audit/pii-config/preset/gdpr
 * - POST /api/admin/tenants/:tenantId/audit/pii-config/preset/minimal
 * - GET /api/admin/audit/pii-configs
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { DEFAULT_PII_CONFIG } from '@authrim/ar-lib-core';
import {
  getTenantPIIConfig,
  updateTenantPIIConfig,
  resetTenantPIIConfig,
  applyGDPRPreset,
  applyMinimalPreset,
  listAllTenantPIIConfigs,
} from '../routes/settings/audit-pii-config';

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
function createTestApp(options: { kv?: KVNamespace } = {}) {
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

  // Mount PII config routes
  app.get('/api/admin/tenants/:tenantId/audit/pii-config', getTenantPIIConfig);
  app.put('/api/admin/tenants/:tenantId/audit/pii-config', updateTenantPIIConfig);
  app.delete('/api/admin/tenants/:tenantId/audit/pii-config', resetTenantPIIConfig);
  app.post('/api/admin/tenants/:tenantId/audit/pii-config/preset/gdpr', applyGDPRPreset);
  app.post('/api/admin/tenants/:tenantId/audit/pii-config/preset/minimal', applyMinimalPreset);
  app.get('/api/admin/audit/pii-configs', listAllTenantPIIConfigs);

  const mockEnv = {
    AUTHRIM_CONFIG: mockKV,
  } as unknown as Env;

  return { app, mockEnv, mockKV };
}

describe('Audit PII Configuration API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // GET PII Config
  // ==========================================================================

  describe('GET /api/admin/tenants/:tenantId/audit/pii-config', () => {
    it('should return default config when no config exists', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request(
        '/api/admin/tenants/tenant-1/audit/pii-config',
        { method: 'GET' },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.tenant_id).toBe('tenant-1');
      expect(body.source).toBe('default');
      expect(body.config).toEqual(DEFAULT_PII_CONFIG);
      expect(body.defaults).toEqual(DEFAULT_PII_CONFIG);
    });

    it('should return stored config when exists', async () => {
      const customConfig = {
        ...DEFAULT_PII_CONFIG,
        piiFields: {
          ...DEFAULT_PII_CONFIG.piiFields,
          ipAddress: true,
        },
        eventLogRetentionDays: 180,
      };

      const mockKV = createMockKV({
        'pii_config:tenant-1': JSON.stringify(customConfig),
      });
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/tenants/tenant-1/audit/pii-config',
        { method: 'GET' },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.source).toBe('kv');
      expect(body.config.piiFields.ipAddress).toBe(true);
      expect(body.config.eventLogRetentionDays).toBe(180);
    });

    it('should include field descriptions and constraints', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request(
        '/api/admin/tenants/tenant-1/audit/pii-config',
        { method: 'GET' },
        mockEnv
      );

      const body = (await res.json()) as any;

      expect(body.field_descriptions).toHaveProperty('piiFields');
      expect(body.field_descriptions.piiFields).toHaveProperty('email');
      expect(body.retention_constraints).toHaveProperty('event_log');
      expect(body.retention_constraints).toHaveProperty('pii_log');
    });
  });

  // ==========================================================================
  // UPDATE PII Config
  // ==========================================================================

  describe('PUT /api/admin/tenants/:tenantId/audit/pii-config', () => {
    it('should update piiFields', async () => {
      const mockKV = createMockKV();
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/tenants/tenant-1/audit/pii-config',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            piiFields: {
              ipAddress: true,
              userAgent: true,
            },
          }),
        },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.success).toBe(true);
      expect(body.config.piiFields.ipAddress).toBe(true);
      expect(body.config.piiFields.userAgent).toBe(true);
      expect(mockKV.put).toHaveBeenCalled();
    });

    it('should update eventLogDetailLevel', async () => {
      const mockKV = createMockKV();
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/tenants/tenant-1/audit/pii-config',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            eventLogDetailLevel: 'detailed',
          }),
        },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.config.eventLogDetailLevel).toBe('detailed');
    });

    it('should update retention days', async () => {
      const mockKV = createMockKV();
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/tenants/tenant-1/audit/pii-config',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            eventLogRetentionDays: 180,
            piiLogRetentionDays: 730,
          }),
        },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.config.eventLogRetentionDays).toBe(180);
      expect(body.config.piiLogRetentionDays).toBe(730);
    });

    it('should reject invalid piiFields', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request(
        '/api/admin/tenants/tenant-1/audit/pii-config',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            piiFields: {
              invalidField: true,
            },
          }),
        },
        mockEnv
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;

      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('Invalid piiFields');
    });

    it('should reject non-boolean piiFields values', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request(
        '/api/admin/tenants/tenant-1/audit/pii-config',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            piiFields: {
              email: 'yes',
            },
          }),
        },
        mockEnv
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;

      expect(body.error_description).toContain('must be a boolean');
    });

    it('should reject invalid eventLogDetailLevel', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request(
        '/api/admin/tenants/tenant-1/audit/pii-config',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            eventLogDetailLevel: 'verbose',
          }),
        },
        mockEnv
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;

      expect(body.error_description).toContain('Invalid eventLogDetailLevel');
    });

    it('should reject retention days below minimum', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request(
        '/api/admin/tenants/tenant-1/audit/pii-config',
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

      expect(body.error_description).toContain('at least');
    });

    it('should reject retention days above maximum', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request(
        '/api/admin/tenants/tenant-1/audit/pii-config',
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

      expect(body.error_description).toContain('cannot exceed');
    });

    it('should return 500 when KV is not configured', async () => {
      const app = new Hono<{ Bindings: Env }>();
      app.put('/api/admin/tenants/:tenantId/audit/pii-config', updateTenantPIIConfig);

      const mockEnv = {} as unknown as Env;

      const res = await app.request(
        '/api/admin/tenants/tenant-1/audit/pii-config',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventLogDetailLevel: 'minimal' }),
        },
        mockEnv
      );

      expect(res.status).toBe(500);
    });
  });

  // ==========================================================================
  // RESET PII Config
  // ==========================================================================

  describe('DELETE /api/admin/tenants/:tenantId/audit/pii-config', () => {
    it('should reset config to defaults', async () => {
      const mockKV = createMockKV({
        'pii_config:tenant-1': JSON.stringify({
          ...DEFAULT_PII_CONFIG,
          eventLogRetentionDays: 180,
        }),
      });
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/tenants/tenant-1/audit/pii-config',
        { method: 'DELETE' },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.success).toBe(true);
      expect(body.reset_to_defaults).toEqual(DEFAULT_PII_CONFIG);
      expect(mockKV.delete).toHaveBeenCalledWith('pii_config:tenant-1');
    });
  });

  // ==========================================================================
  // GDPR Preset
  // ==========================================================================

  describe('POST /api/admin/tenants/:tenantId/audit/pii-config/preset/gdpr', () => {
    it('should apply GDPR-compliant preset', async () => {
      const mockKV = createMockKV();
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/tenants/tenant-1/audit/pii-config/preset/gdpr',
        { method: 'POST' },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.success).toBe(true);
      expect(body.preset).toBe('gdpr');

      // GDPR preset should enable ipAddress as PII
      expect(body.config.piiFields.ipAddress).toBe(true);
      expect(body.config.piiFields.email).toBe(true);
      expect(body.config.piiFields.name).toBe(true);
    });
  });

  // ==========================================================================
  // Minimal Preset
  // ==========================================================================

  describe('POST /api/admin/tenants/:tenantId/audit/pii-config/preset/minimal', () => {
    it('should apply minimal preset', async () => {
      const mockKV = createMockKV();
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/tenants/tenant-1/audit/pii-config/preset/minimal',
        { method: 'POST' },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.success).toBe(true);
      expect(body.preset).toBe('minimal');
      // Note: 'minimal' preset means minimal PII, not minimal detail level
      // It actually allows 'detailed' logging since less data is considered PII
      expect(body.config.eventLogDetailLevel).toBe('detailed');
    });
  });

  // ==========================================================================
  // List All Configs
  // ==========================================================================

  describe('GET /api/admin/audit/pii-configs', () => {
    it('should list all tenant PII configs', async () => {
      const mockKV = createMockKV({
        'pii_config:tenant-1': JSON.stringify({ ...DEFAULT_PII_CONFIG, eventLogRetentionDays: 90 }),
        'pii_config:tenant-2': JSON.stringify({
          ...DEFAULT_PII_CONFIG,
          eventLogRetentionDays: 180,
        }),
        other_key: 'value', // Should not be included
      });
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request('/api/admin/audit/pii-configs', { method: 'GET' }, mockEnv);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.count).toBe(2);
      expect(body.tenants).toHaveLength(2);

      const tenant1Config = body.tenants.find(
        (c: { tenant_id: string }) => c.tenant_id === 'tenant-1'
      );
      expect(tenant1Config).toBeDefined();
      expect(tenant1Config.config.eventLogRetentionDays).toBe(90);
    });

    it('should return empty list when no configs exist', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request('/api/admin/audit/pii-configs', { method: 'GET' }, mockEnv);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.tenants).toEqual([]);
      expect(body.count).toBe(0);
    });
  });
});
