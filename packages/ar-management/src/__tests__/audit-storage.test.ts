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
import { createSettingsCanonicalD1 } from './helpers/settings-canonical-d1';
import type { Env } from '@authrim/ar-lib-core';
import {
  DEFAULT_AUDIT_PROFILE_ID,
  resolveTenantAuditRetentionFromEnv,
  resolveAuditRoutingTargets,
  DEFAULT_AUDIT_STORAGE_CONFIG,
} from '@authrim/ar-lib-core';
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
    AUTHRIM_LOG_ARCHIVE_MODE: 'scheduled',
    AUTHRIM_LOG_ARCHIVE_STORAGE_GENERATION: 'storage-generation',
    AUTHRIM_LOG_ARCHIVE_SCHEMA_VERSION: '1',
    AUTHRIM_LOG_ARCHIVE_ACTIVATED_AT: '2026-10-01T00:00:00.000Z',
    AUTHRIM_LOG_ARCHIVE_ACCOUNT_ID: 'a'.repeat(32),
    AUTHRIM_LOG_ARCHIVE_BUCKET: 'test-logs',
    AUTHRIM_LOG_ARCHIVE_WAREHOUSE: `${'a'.repeat(32)}_test-logs`,
    AUTHRIM_LOG_ARCHIVE_CATALOG_URI: `https://catalog.cloudflarestorage.com/${'a'.repeat(32)}/test-logs`,
    AUTHRIM_LOG_ARCHIVE_NAMESPACE: 'authrim',
    AUTHRIM_LOG_ARCHIVE_TABLE: 'logs_v1',
    AUTHRIM_LOG_ARCHIVE_TABLE_UUID: 'bba2d8f7-861e-4b6e-9df1-48faea8ae805',
    AUTHRIM_LOG_ARCHIVE_PHYSICAL_FINGERPRINT: 'a'.repeat(64),
    AUTHRIM_LOG_ARCHIVE_DB_RETENTION_DAYS: '7',
    AUTHRIM_LOG_ARCHIVE_EXPORT_INTERVAL_MINUTES: '10',
    AUTHRIM_CONFIG: mockKV,
    SETTINGS: mockSettingsKV,
    DB: mockDB,
    DB_ADMIN: createSettingsCanonicalD1(),
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

  return {
    app,
    mockEnv,
    mockKV,
    mockSettingsKV,
    mockDB,
    kvPut: vi.spyOn(mockKV, 'put'),
    settingsPut: vi.spyOn(mockSettingsKV, 'put'),
    dbBatch: vi.spyOn(mockDB, 'batch'),
  };
}

const PATH = '/api/admin/settings/audit-storage';
const rule = (overrides: Record<string, unknown> = {}) => ({
  name: 'tenant-retention',
  priority: 10,
  enabled: true,
  conditions: { tenantId: 'tenant-a' },
  retention: { eventLogRetentionDays: 30 },
  ...overrides,
});
async function request(
  f: ReturnType<typeof createTestApp>,
  suffix = '',
  method = 'GET',
  body?: unknown
) {
  return f.app.request(
    PATH + suffix,
    {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    },
    f.mockEnv
  );
}
describe('Setup-owned audit storage and editable retention', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(['', '/stats'])('reports only the new Setup configuration at %s', async (suffix) => {
    const f = createTestApp({
      kv: createMockKV({
        audit_storage_config: JSON.stringify({
          defaultEventBackend: 'wrong',
          batchConfig: { maxBatchSize: 999 },
        }),
      }),
    });
    const res = await request(f, suffix);
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    if (!body || typeof body !== 'object' || !('storage' in body))
      throw new Error('storage response missing');
    expect(body.storage).toMatchObject({
      source: 'setup',
      read_only: true,
      mode: 'scheduled',
      generation: 'storage-generation',
      db_retention_days: 7,
      export_interval_minutes: 10,
      local_staging_only: false,
    });
    expect(JSON.stringify(body)).not.toContain('maxBatchSize');
    expect(JSON.stringify(body)).not.toContain('defaultEventBackend');
    expect(JSON.stringify(body)).not.toContain('total_logs');
    expect(f.kvPut).not.toHaveBeenCalled();
  });
  it('reports pipeline without a DB retention or export schedule', async () => {
    const f = createTestApp({
      extraEnv: {
        AUTHRIM_LOG_ARCHIVE_MODE: 'pipeline',
        AUTHRIM_LOG_ARCHIVE_DB_RETENTION_DAYS: undefined,
        AUTHRIM_LOG_ARCHIVE_EXPORT_INTERVAL_MINUTES: undefined,
      },
    });
    expect(await (await request(f)).json()).toMatchObject({
      storage: { mode: 'pipeline', db_retention_days: null, export_interval_minutes: null },
    });
  });
  it('reports local staging without implying a cold archive is connected', async () => {
    const extraEnv: Record<string, unknown> = {
      AUTHRIM_LOG_ARCHIVE_LOCAL_STAGING_ONLY: 'true',
      ISSUER_URL: 'http://localhost:8787',
    };
    for (const key of [
      'ACCOUNT_ID',
      'BUCKET',
      'WAREHOUSE',
      'CATALOG_URI',
      'NAMESPACE',
      'TABLE',
      'TABLE_UUID',
      'PHYSICAL_FINGERPRINT',
    ])
      extraEnv['AUTHRIM_LOG_ARCHIVE_' + key] = undefined;
    const f = createTestApp({ extraEnv });
    expect(await (await request(f)).json()).toMatchObject({
      storage: { mode: 'scheduled', local_staging_only: true },
    });
  });
  it.each(['', '/stats'])('fails explicitly when new mode is absent at %s', async (suffix) => {
    const f = createTestApp({ extraEnv: { AUTHRIM_LOG_ARCHIVE_MODE: undefined } });
    expect((await request(f, suffix)).status).toBe(503);
    expect(f.kvPut).not.toHaveBeenCalled();
  });
  it.each([
    { defaultEventBackend: 'd1-core' },
    { defaultPiiBackend: 'r2' },
    { batchConfig: { maxBatchSize: 10 } },
    { backends: [] },
    { auditProfileId: 'builtin:audit:archive-only' },
    {},
  ])('rejects storage mutations without changing KV or profile: %j', async (body) => {
    const f = createTestApp();
    const adminPrepare = vi.spyOn(f.mockEnv.DB_ADMIN, 'prepare');
    expect((await request(f, '', 'PUT', body)).status).toBe(501);
    expect(f.kvPut).not.toHaveBeenCalled();
    expect(f.settingsPut).not.toHaveBeenCalled();
    expect(adminPrepare).not.toHaveBeenCalled();
  });
  it('does not claim a manual cleanup ran', async () => {
    const f = createTestApp();
    const res = await request(f, '/cleanup', 'POST', {});
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({
      error: 'not_supported',
      executed: false,
      managed: true,
      schedule: 'every_minute',
    });
    expect(f.dbBatch).not.toHaveBeenCalled();
  });
  it('keeps the event and PII day settings in the audit profile', async () => {
    const f = createTestApp();
    const res = await request(f, '/retention', 'PUT', {
      eventLogRetentionDays: 180,
      piiLogRetentionDays: 730,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      config: { eventLogRetentionDays: 180, piiLogRetentionDays: 730 },
    });
    const after = await request(f, '/retention');
    expect(await after.json()).toMatchObject({
      config: { eventLogRetentionDays: 180, piiLogRetentionDays: 730 },
    });
    expect(await f.mockKV.get('audit_storage_config')).toBeNull();
  });
  it.each([
    { archiveBeforeDelete: true },
    { archiveBeforeDelete: false },
    { minimumRetentionDays: 90 },
    { eventLogRetentionDays: 0 },
    { piiLogRetentionDays: 2556 },
    { eventLogRetentionDays: 1.5 },
    { piiLogRetentionDays: '30' },
    {},
  ])('rejects ineffective or invalid retention without any write: %j', async (body) => {
    const f = createTestApp();
    expect((await request(f, '/retention', 'PUT', body)).status).toBe(400);
    expect(f.kvPut).not.toHaveBeenCalled();
    expect(f.settingsPut).not.toHaveBeenCalled();
  });
  it('stores only conditions and days, preserving priority and applying tenant-scoped retention', async () => {
    const f = createTestApp();
    const rules = [
      rule({
        name: 'client',
        priority: 1,
        conditions: { tenantId: 'tenant-a', clientId: 'app' },
        retention: { eventLogRetentionDays: 7 },
      }),
      rule(),
    ];
    expect((await request(f, '/routing-rules', 'PUT', { rules })).status).toBe(200);
    const stored = JSON.parse(
      (await f.mockKV.get('audit_routing_rules')) as string
    ) as typeof rules;
    expect(stored).toEqual(rules);
    expect(stored.every((r) => !('targets' in r) && !('backend' in r))).toBe(true);
    const profile = {
      id: 'audit',
      kind: 'audit' as const,
      label: 'Audit',
      primary: null,
      archive: null,
      sinks: [],
    };
    const a = await resolveTenantAuditRetentionFromEnv(f.mockEnv, 'tenant-a', {
      auditProfile: profile,
    });
    const b = await resolveTenantAuditRetentionFromEnv(f.mockEnv, 'tenant-b', {
      auditProfile: profile,
    });
    expect(a.event).toMatchObject({ days: 30, variesByRoute: true, source: 'delivery_plan' });
    expect(b.event.days).toBe(90);
    const app = resolveAuditRoutingTargets(
      { ...DEFAULT_AUDIT_STORAGE_CONFIG, routingRules: stored },
      { tenantId: 'tenant-a', logType: 'event', clientId: 'app' }
    );
    expect(app.retention.eventLogRetentionDays).toBe(7);
    expect(app.archiveStores).toEqual([]);
  });
  it('creates, reads and deletes retention-only rules', async () => {
    const f = createTestApp();
    expect((await request(f, '/routing-rules', 'POST', rule())).status).toBe(200);
    expect((await request(f, '/routing-rules', 'POST', rule())).status).toBe(400);
    expect(await (await request(f, '/routing-rules')).json()).toMatchObject({
      count: 1,
      rules: [rule()],
    });
    expect((await request(f, '/routing-rules/tenant-retention', 'DELETE')).status).toBe(200);
    expect(await f.mockKV.get('audit_routing_rules')).toBe('[]');
    expect((await request(f, '/routing-rules/tenant-retention', 'DELETE')).status).toBe(404);
  });
  it.each([
    { targets: {} },
    { targets: { primaryStore: 'other' } },
    { backend: 'd1-core' },
    { retention: { archiveBeforeDelete: true } },
    { retention: { minimumRetentionDays: 1 } },
    { retention: {} },
    { conditions: { logType: 'bad' } },
    { conditions: { logType: ['event'] } },
    { conditions: { region: 42 } },
    { conditions: { region: 'EU' } },
    { conditions: { region: ['EU'] } },
  ])(
    'rejects old targets and invalid retention on POST and PUT without storing %j',
    async (override) => {
      for (const method of ['POST', 'PUT']) {
        const f = createTestApp();
        expect(
          (
            await request(
              f,
              '/routing-rules',
              method,
              method === 'POST' ? rule(override) : { rules: [rule(override)] }
            )
          ).status
        ).toBe(400);
        expect(f.kvPut).not.toHaveBeenCalled();
      }
    }
  );
  it('accepts the explicit any-region condition', async () => {
    const f = createTestApp();
    expect(
      (await request(f, '/routing-rules', 'POST', rule({ conditions: { region: '*' } }))).status
    ).toBe(200);
  });
  it('does not overwrite unreadable stored rules or report them as an empty configuration', async () => {
    const f = createTestApp({ kv: createMockKV({ audit_routing_rules: '{broken' }) });
    expect((await request(f, '/routing-rules')).status).toBe(503);
    expect((await request(f, '/routing-rules', 'POST', rule())).status).toBe(503);
    expect((await request(f, '/routing-rules/name', 'DELETE')).status).toBe(503);
    expect(f.kvPut).not.toHaveBeenCalled();
  });
});
