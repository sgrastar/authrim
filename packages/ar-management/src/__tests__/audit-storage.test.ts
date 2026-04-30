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
import { DEFAULT_AUDIT_PROFILE_ID, DEFAULT_AUDIT_STORAGE_CONFIG } from '@authrim/ar-lib-core';
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
    list: vi.fn(async (options?: { prefix?: string }) => ({
      keys: Array.from(store.keys())
        .filter((key) => !options?.prefix || key.startsWith(options.prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    })),
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
function createTestApp(
  options: {
    kv?: KVNamespace;
    settingsKv?: KVNamespace;
    db?: D1Database;
    defaultAuditProfileId?: string;
    extraEnv?: Record<string, unknown>;
  } = {}
) {
  const mockKV = options.kv ?? createMockKV();
  const mockSettingsKV = options.settingsKv ?? createMockKV();
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
    SETTINGS: mockSettingsKV,
    DB: mockDB,
    AUDIT_QUEUE: {
      send: vi.fn(),
      sendBatch: vi.fn(),
    },
    AUDIT_ARCHIVE: {
      put: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      head: vi.fn(),
      createMultipartUpload: vi.fn(),
      resumeMultipartUpload: vi.fn(),
    },
    PROFILE_REGISTRY_BACKEND: 'kv',
    DEFAULT_AUDIT_PROFILE_ID: options.defaultAuditProfileId ?? DEFAULT_AUDIT_PROFILE_ID,
    ...options.extraEnv,
  } as unknown as Env;

  return { app, mockEnv, mockKV, mockSettingsKV, mockDB };
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

      expect(body.storage.source).toBe('builtin');
      expect(body.storage.profile_id).toBe(DEFAULT_AUDIT_PROFILE_ID);
      expect(body.storage.available_profiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: DEFAULT_AUDIT_PROFILE_ID,
            primaryType: 'd1',
          }),
        ])
      );
      expect(body.storage.config.defaultEventBackend).toBe('d1-core');
      expect(body.storage.config.defaultPiiBackend).toBe('d1-pii');
      expect(body.storage.config.batchConfig).toEqual(DEFAULT_AUDIT_STORAGE_CONFIG.batchConfig);
      expect(body.retention.source).toBe('builtin');
      expect(body.routing_rules.rules).toEqual([]);
      expect(body.operational_policy.cleanup.mode).toBe('primary_delete_by_retention');
      expect(body.operational_policy.retry.archiveDelivery).toBe('queue_retry_until_dlq');
      expect(body.operational_policy.backpressure.mode).toBe('queue_fanout');
      expect(body.operational_policy.queue.binding).toBe('AUDIT_QUEUE');
      expect(body.operational_policy.queue.retryLimit).toBe(5);
      expect(body.operational_policy.queue.archiveBackupStatus).toBe('configured');
      expect(body.queue.audit_queue.status).toBe('configured');
    });

    it('should merge legacy batch config while keeping runtime profile as the source of truth', async () => {
      const customConfig = {
        ...DEFAULT_AUDIT_STORAGE_CONFIG,
        batchConfig: {
          maxBufferSize: 250,
          flushIntervalMs: 2500,
          maxBatchSize: 50,
        },
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

      expect(body.storage.source).toBe('builtin');
      expect(body.storage.batch_config_source).toBe('kv');
      expect(body.storage.config.defaultEventBackend).toBe('d1-core');
      expect(body.storage.config.batchConfig).toEqual(customConfig.batchConfig);
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
      const { app, mockEnv, mockSettingsKV } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/settings/audit-storage',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            defaultEventBackend: 'archive-only',
            defaultPiiBackend: 'archive-only',
            batchConfig: {
              maxBufferSize: 120,
            },
          }),
        },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.success).toBe(true);
      expect(body.source).toBe('runtime_profile');
      expect(body.profile_id).toBe('managed:audit:settings-default');
      expect(body.config.defaultEventBackend).toBe('archive-only');
      expect(body.config.defaultPiiBackend).toBe('archive-only');
      expect(mockSettingsKV.put).toHaveBeenCalled();
      expect(mockKV.put).toHaveBeenCalled();
    });

    it('should accept a Hyperdrive backend when provided in the legacy backend list', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request(
        '/api/admin/settings/audit-storage',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            backends: [
              {
                id: 'hyperdrive-audit',
                type: 'HYPERDRIVE',
                enabled: true,
                priority: 1,
                hyperdriveConfig: {
                  binding: 'audit-hyperdrive',
                  schema: 'public',
                },
              },
            ],
            defaultEventBackend: 'hyperdrive-audit',
            defaultPiiBackend: 'hyperdrive-audit',
          }),
        },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.config.defaultEventBackend).toBe('audit-hyperdrive');
    });

    it('rejects fan-out targets when AUDIT_QUEUE is unavailable', async () => {
      const { app, mockEnv } = createTestApp({
        extraEnv: {
          AUDIT_QUEUE: undefined,
        },
      });

      const res = await app.request(
        '/api/admin/settings/audit-storage',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            backends: [
              {
                id: 'archive-r2',
                type: 'R2',
                enabled: true,
                priority: 1,
                r2Config: {
                  binding: 'DIAGNOSTIC_LOGS',
                  pathPrefix: 'audit/',
                },
              },
            ],
            defaultEventBackend: 'd1-core',
            defaultPiiBackend: 'd1-pii',
          }),
        },
        mockEnv
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.error_description).toContain('AUDIT_QUEUE must be configured');
    });

    it('should switch the default audit profile without mutating the managed profile', async () => {
      const mockKV = createMockKV({
        'profile-registry:audit:archive-only': JSON.stringify({
          id: 'archive-only',
          kind: 'audit',
          label: 'Archive Only',
          builtin: false,
          primary: null,
          archive: {
            type: 'r2',
            bucketRef: 'DIAGNOSTIC_LOGS',
            prefix: 'audit/',
          },
          sinks: [],
        }),
      });
      const { app, mockEnv, mockSettingsKV, mockKV: authrimKv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/settings/audit-storage',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            auditProfileId: 'archive-only',
          }),
        },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.success).toBe(true);
      expect(body.profile_id).toBe('archive-only');
      expect(body.config.defaultEventBackend).toBe('archive-only');
      expect(mockSettingsKV.put).toHaveBeenCalled();
      expect(authrimKv.put).not.toHaveBeenCalledWith(
        'profile-registry:audit:managed:audit:settings-default',
        expect.any(String)
      );
    });

    it('should reject switching to a custom profile while also mutating storage targets', async () => {
      const mockKV = createMockKV({
        'profile-registry:audit:archive-only': JSON.stringify({
          id: 'archive-only',
          kind: 'audit',
          label: 'Archive Only',
          builtin: false,
          primary: null,
          archive: {
            type: 'r2',
            bucketRef: 'DIAGNOSTIC_LOGS',
            prefix: 'audit/',
          },
          sinks: [],
        }),
      });
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/settings/audit-storage',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            auditProfileId: 'archive-only',
            defaultEventBackend: 'archive-only',
          }),
        },
        mockEnv
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.error).toBe('invalid_request');
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

      expect(body.source).toBe('builtin');
      expect(body.config.eventLogRetentionDays).toBe(90);
      expect(body.config.piiLogRetentionDays).toBe(365);
    });

    it('should return runtime-profile retention config when a custom audit profile is active', async () => {
      const customProfileId = 'custom-retention-profile';
      const mockKV = createMockKV({
        'profile-registry:audit:custom-retention-profile': JSON.stringify({
          id: customProfileId,
          kind: 'audit',
          label: 'Custom Retention',
          builtin: false,
          primary: { type: 'd1', bindingRef: 'DB', dataset: 'event_log' },
          archive: null,
          sinks: [],
          retention: {
            eventLogRetentionDays: 180,
            piiLogRetentionDays: 730,
            archiveBeforeDelete: true,
          },
        }),
      });
      const { app, mockEnv } = createTestApp({
        kv: mockKV,
        defaultAuditProfileId: customProfileId,
      });

      const res = await app.request(
        '/api/admin/settings/audit-storage/retention',
        { method: 'GET' },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.source).toBe('runtime_profile');
      expect(body.config.eventLogRetentionDays).toBe(180);
      expect(body.config.archiveBeforeDelete).toBe(true);
    });
  });

  describe('PUT /api/admin/settings/audit-storage/retention', () => {
    it('should update retention config', async () => {
      const managedProfileId = 'managed:audit:settings-default';
      const mockKV = createMockKV({
        [`profile-registry:audit:${managedProfileId}`]: JSON.stringify({
          id: managedProfileId,
          kind: 'audit',
          label: 'Managed Audit Profile',
          builtin: false,
          primary: { type: 'd1', bindingRef: 'DB', dataset: 'event_log' },
          archive: { type: 'r2', bucketRef: 'DIAGNOSTIC_LOGS', prefix: 'audit/' },
          sinks: [],
          retention: {
            eventLogRetentionDays: 90,
            piiLogRetentionDays: 365,
            archiveBeforeDelete: false,
          },
        }),
      });
      const { app, mockEnv, mockSettingsKV } = createTestApp({ kv: mockKV });

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
      expect(body.source).toBe('runtime_profile');
      expect(body.profile_id).toBe('managed:audit:settings-default');
      expect(mockKV.put).toHaveBeenCalled();
      expect(mockSettingsKV.put).toHaveBeenCalled();
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

    it('rejects archiveBeforeDelete when no archive target is configured', async () => {
      const { app, mockEnv } = createTestApp({
        defaultAuditProfileId: 'builtin:audit:minimal',
      });

      const res = await app.request(
        '/api/admin/settings/audit-storage/retention',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            archiveBeforeDelete: true,
          }),
        },
        mockEnv
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.error_description).toContain('archiveBeforeDelete requires an archive target');
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
      expect(body.rules[0].targets).toEqual({ primaryStore: 'hyperdrive' });
      expect(body.rules[0].backend).toBeUndefined();
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
            targets: {
              primaryStore: 'd1-core',
              forwardingSinks: ['logpush-premium'],
            },
          }),
        },
        mockEnv
      );

      // addRoutingRule returns 200 not 201
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.success).toBe(true);
      expect(body.rule.name).toBe('High Priority Tenant');
      expect(body.rule.targets).toEqual({
        primaryStore: 'd1-core',
        forwardingSinks: ['logpush-premium'],
      });
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

    it('accepts legacy backend and normalizes it to targets.primaryStore', async () => {
      const mockKV = createMockKV();
      const { app, mockEnv, mockKV: kv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/settings/audit-storage/routing-rules',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Legacy Backend Rule',
            priority: 50,
            enabled: true,
            conditions: { logType: 'event' },
            backend: 'd1-core',
          }),
        },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.rule.targets).toEqual({ primaryStore: 'd1-core' });
      expect(body.rule.backend).toBeUndefined();

      const [, storedValue] = (kv.put as any).mock.calls.at(-1);
      expect(JSON.parse(storedValue)).toEqual([
        expect.objectContaining({
          name: 'Legacy Backend Rule',
          targets: { primaryStore: 'd1-core' },
        }),
      ]);
    });

    it('rejects a rule when no targets are configured', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request(
        '/api/admin/settings/audit-storage/routing-rules',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'No Target Rule',
            priority: 100,
            enabled: true,
            conditions: { tenantId: 'tenant-1' },
            targets: {},
          }),
        },
        mockEnv
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.error_description).toContain('at least one target is required');
    });
  });

  describe('PUT /api/admin/settings/audit-storage/routing-rules', () => {
    it('sorts and stores canonical target-based rules', async () => {
      const mockKV = createMockKV();
      const { app, mockEnv, mockKV: kv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/settings/audit-storage/routing-rules',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            rules: [
              {
                name: 'Archive First',
                priority: 20,
                enabled: true,
                conditions: { logType: 'event' },
                targets: { archiveStores: ['r2-archive'] },
              },
              {
                name: 'Hot Path',
                priority: 10,
                enabled: true,
                conditions: { tenantId: 'tenant-1' },
                backend: 'd1-core',
              },
            ],
          }),
        },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.rules.map((rule: any) => rule.name)).toEqual(['Hot Path', 'Archive First']);
      expect(body.rules[0].targets).toEqual({ primaryStore: 'd1-core' });
      expect(body.rules[1].targets).toEqual({ archiveStores: ['r2-archive'] });

      const [, storedValue] = (kv.put as any).mock.calls.at(-1);
      const stored = JSON.parse(storedValue);
      expect(stored[0].backend).toBeUndefined();
      expect(stored[0].targets).toEqual({ primaryStore: 'd1-core' });
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
          targets: { primaryStore: 'd1-core' },
        },
        {
          name: 'To Keep',
          priority: 20,
          enabled: true,
          conditions: {},
          targets: { primaryStore: 'd1-pii' },
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
      expect(body.profile_id).toBe(DEFAULT_AUDIT_PROFILE_ID);
      expect(body.note).toBeDefined();
      expect(body.scheduled_cleanup).toBeDefined();
      expect(body.hot_query.status).toBe('supported');
      expect(body.operational_policy.cleanup.primaryRetentionDeleteSupported).toBe(true);
    });

    it('marks archive-only profiles as hot-query unsupported', async () => {
      const mockKV = createMockKV({
        'profile-registry:audit:archive-only': JSON.stringify({
          id: 'archive-only',
          kind: 'audit',
          label: 'Archive Only',
          builtin: false,
          primary: null,
          archive: {
            type: 'r2',
            bucketRef: 'DIAGNOSTIC_LOGS',
            prefix: 'audit/',
          },
          sinks: [],
        }),
      });
      const { app, mockEnv } = createTestApp({
        kv: mockKV,
        defaultAuditProfileId: 'archive-only',
      });

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
      expect(body.profile_id).toBe('archive-only');
      expect(body.hot_query.status).toBe('not_supported');
      expect(body.functions.event_log).toBeNull();
      expect(body.operational_policy.cleanup.mode).toBe('archive_only');
    });

    it('marks postgres primary as supported when a Hyperdrive binding is resolved', async () => {
      const mockKV = createMockKV({
        'profile-registry:audit:pg-primary': JSON.stringify({
          id: 'pg-primary',
          kind: 'audit',
          label: 'Postgres Primary',
          builtin: false,
          primary: {
            type: 'postgres',
            bindingRef: 'HYPERDRIVE_AUDIT_PRIMARY',
            connectionRef: 'audit-primary',
          },
          archive: null,
          sinks: [],
        }),
      });
      const { app, mockEnv } = createTestApp({
        kv: mockKV,
        defaultAuditProfileId: 'pg-primary',
        extraEnv: {
          HYPERDRIVE_AUDIT_PRIMARY: {
            connectionString: 'postgres://example',
          },
        },
      });

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
      expect(body.profile_id).toBe('pg-primary');
      expect(body.hot_query.status).toBe('supported');
      expect(body.functions.event_log).toBe('cleanupExpiredEventLogs(db, tenantId?, batchSize?)');
      expect(body.operational_policy.cleanup.mode).toBe('primary_delete_by_retention');
    });

    it('surfaces pending archive-before-delete enforcement as an operational warning', async () => {
      const mockKV = createMockKV({
        'profile-registry:audit:archive-before-delete': JSON.stringify({
          id: 'archive-before-delete',
          kind: 'audit',
          label: 'Archive Before Delete',
          builtin: false,
          primary: {
            type: 'd1',
            bindingRef: 'DB',
            dataset: 'event_log',
          },
          archive: {
            type: 'r2',
            bucketRef: 'DIAGNOSTIC_LOGS',
            prefix: 'audit/',
          },
          sinks: [],
          retention: {
            eventLogRetentionDays: 90,
            piiLogRetentionDays: 365,
            archiveBeforeDelete: true,
          },
        }),
      });
      const { app, mockEnv } = createTestApp({
        kv: mockKV,
        defaultAuditProfileId: 'archive-before-delete',
      });

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
      expect(body.operational_policy.retention.archiveBeforeDelete).toBe(true);
      expect(body.operational_policy.retention.archiveBeforeDeleteStatus).toBe('enforced');
      expect(body.operational_policy.retention.note).toContain(
        'Scheduled retention cleanup rewrites expiring records'
      );
      expect(body.operational_policy.warnings).toEqual([]);
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

      expect(body.profile_id).toBe(DEFAULT_AUDIT_PROFILE_ID);
      expect(body.targets.primary).toBeDefined();
      expect(body.targets.primary.type).toBe('d1');
      expect(body.hot_query.status).toBe('supported');
      expect(body.operational_policy.deliveryGuarantee.primary).toBe('sync_request_path');
      expect(body.queue.audit_queue.retryLimit).toBe(5);
      expect(body.queue.audit_queue.archiveBackupStatus).toBe('configured');
    });

    it('returns archive-only stats when the resolved audit profile has no primary store', async () => {
      const mockKV = createMockKV({
        'profile-registry:audit:archive-only': JSON.stringify({
          id: 'archive-only',
          kind: 'audit',
          label: 'Archive Only',
          builtin: false,
          primary: null,
          archive: {
            type: 'r2',
            bucketRef: 'DIAGNOSTIC_LOGS',
            prefix: 'audit/',
          },
          sinks: [
            {
              type: 'logpush',
              destinationRef: 'workers-logpush',
              dataset: 'authrim_audit',
            },
          ],
        }),
      });
      const { app, mockEnv } = createTestApp({
        kv: mockKV,
        defaultAuditProfileId: 'archive-only',
      });

      const res = await app.request(
        '/api/admin/settings/audit-storage/stats',
        { method: 'GET' },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.profile_id).toBe('archive-only');
      expect(body.targets.primary).toBeNull();
      expect(body.targets.archive.type).toBe('r2');
      expect(body.targets.sinks).toHaveLength(1);
      expect(body.hot_query.status).toBe('not_supported');
      expect(body.operational_policy.deliveryGuarantee.archive).toBe('best_effort');
      expect(body.operational_policy.deliveryGuarantee.sink).toBe('best_effort');
      expect(body.operational_policy.deliveryGuarantee.primary).toBe('none');
    });

    it('returns supported hot-query stats for postgres primary when a binding is configured', async () => {
      const mockKV = createMockKV({
        'profile-registry:audit:pg-primary': JSON.stringify({
          id: 'pg-primary',
          kind: 'audit',
          label: 'Postgres Primary',
          builtin: false,
          primary: {
            type: 'postgres',
            bindingRef: 'HYPERDRIVE_AUDIT_PRIMARY',
            connectionRef: 'audit-primary',
          },
          archive: null,
          sinks: [],
        }),
      });
      const { app, mockEnv } = createTestApp({
        kv: mockKV,
        defaultAuditProfileId: 'pg-primary',
        extraEnv: {
          HYPERDRIVE_AUDIT_PRIMARY: {
            connectionString: 'postgres://example',
          },
        },
      });

      const res = await app.request(
        '/api/admin/settings/audit-storage/stats',
        { method: 'GET' },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.profile_id).toBe('pg-primary');
      expect(body.targets.primary.type).toBe('postgres');
      expect(body.hot_query.status).toBe('supported');
      expect(body.hot_query.supported).toBe(true);
      expect(body.operational_policy.cleanup.primaryRetentionDeleteSupported).toBe(true);
    });

    it('returns pending runtime support for postgres primary without a binding', async () => {
      const mockKV = createMockKV({
        'profile-registry:audit:pg-primary': JSON.stringify({
          id: 'pg-primary',
          kind: 'audit',
          label: 'Postgres Primary',
          builtin: false,
          primary: {
            type: 'postgres',
            bindingRef: 'HYPERDRIVE_AUDIT_PRIMARY',
            connectionRef: 'audit-primary',
          },
          archive: null,
          sinks: [],
        }),
      });
      const { app, mockEnv } = createTestApp({
        kv: mockKV,
        defaultAuditProfileId: 'pg-primary',
      });

      const res = await app.request(
        '/api/admin/settings/audit-storage/stats',
        { method: 'GET' },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.profile_id).toBe('pg-primary');
      expect(body.hot_query.status).toBe('pending_runtime_support');
      expect(body.hot_query.supported).toBe(false);
      expect(body.operational_policy.cleanup.mode).toBe('pending_runtime_support');
    });

    it('returns supported hot-query status for mysql primary with a Hyperdrive binding', async () => {
      const mockKV = createMockKV({
        'profile-registry:audit:mysql-primary': JSON.stringify({
          id: 'mysql-primary',
          kind: 'audit',
          label: 'MySQL Primary',
          builtin: false,
          primary: {
            type: 'mysql',
            bindingRef: 'HYPERDRIVE_AUDIT_PRIMARY_MYSQL',
            connectionRef: 'audit-primary-mysql',
          },
          archive: null,
          sinks: [],
        }),
      });
      const { app, mockEnv } = createTestApp({
        kv: mockKV,
        defaultAuditProfileId: 'mysql-primary',
        extraEnv: {
          HYPERDRIVE_AUDIT_PRIMARY_MYSQL: {
            connectionString: 'mysql://example',
            host: 'mysql.example.com',
            user: 'audit',
            password: 'secret',
            database: 'authrim',
            port: 3306,
          },
        },
      });

      const res = await app.request(
        '/api/admin/settings/audit-storage/stats',
        { method: 'GET' },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.profile_id).toBe('mysql-primary');
      expect(body.targets.primary.type).toBe('mysql');
      expect(body.hot_query.status).toBe('supported');
      expect(body.hot_query.supported).toBe(true);
      expect(body.operational_policy.cleanup.primaryRetentionDeleteSupported).toBe(true);
    });
  });
});
