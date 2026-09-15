/**
 * Settings Migration API Tests
 *
 * Tests for the settings migration endpoints:
 * - POST /api/admin/settings/migrate
 * - GET /api/admin/settings/migrate/status
 * - DELETE /api/admin/settings/migrate/lock
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import settingsV2 from '../routes/settings-v2';

// Response types
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type ApiResponse = Record<string, JsonValue>;

interface MigrationResult {
  dryRun: boolean;
  timestamp: string;
  changes: Array<{
    scope: string;
    scopeId: string | null;
    category: string;
    oldKey: string;
    newKey: string;
    oldValue: string | null;
    newValue: unknown;
    action: string;
    reason?: string;
  }>;
  summary: {
    total: number;
    set: number;
    skipped: number;
    conflicts: number;
  };
  warnings: string[];
  errors: string[];
}

interface MigrationStatus {
  migrated: boolean;
  migratedAt: string | null;
  migratedBy: string | null;
  version: string | null;
}

// Mock KV namespace with full functionality
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
      const keys: Array<{ name: string }> = [];
      for (const key of store.keys()) {
        if (!options?.prefix || key.startsWith(options.prefix)) {
          keys.push({ name: key });
        }
      }
      return { keys, list_complete: true, cursor: '' };
    }),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

// Create test app with settings-v2 routes
function createTestApp(
  options: { kv?: KVNamespace; env?: Record<string, string>; roles?: string[] } = {}
) {
  const mockKV = options.kv ?? createMockKV();

  const app = new Hono<{
    Bindings: Env;
    Variables: {
      adminUser?: { id: string; role?: string };
      adminAuth?: { userId: string; roles: string[]; authMethod: string };
    };
  }>();

  // Mock admin auth middleware with system_admin role
  // (Migration API requires super_admin or system_admin per spec)
  app.use('*', async (c, next) => {
    c.set('adminUser', { id: 'test_admin', role: 'system_admin' });
    c.set('adminAuth', {
      userId: 'test_admin',
      roles: options.roles ?? ['system_admin'],
      authMethod: 'bearer',
    });
    await next();
  });

  // Mount settings-v2 routes
  app.route('/api/admin', settingsV2);

  // Create mock env
  const mockEnv = {
    AUTHRIM_CONFIG: mockKV,
    ...options.env,
  } as unknown as Env;

  return { app, mockEnv, mockKV };
}

describe('Settings Migration API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /settings/migrate', () => {
    it('should require dryRun parameter', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request(
        '/api/admin/settings/migrate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
        mockEnv
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as ApiResponse;
      expect(body.error).toBe('bad_request');
      expect((body.message as string).toLowerCase()).toContain('dryrun');
    });

    it('should perform dry-run scan without applying changes', async () => {
      const mockKV = createMockKV({
        error_locale: 'en',
        error_response_format: 'detailed',
      });
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/settings/migrate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dryRun: true }),
        },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as MigrationResult;

      expect(body.dryRun).toBe(true);
      expect(body.changes.length).toBeGreaterThan(0);
      expect(body.summary.total).toBeGreaterThan(0);

      // Verify changes include expected keys
      const keys = body.changes.map((c) => c.oldKey);
      expect(keys).toContain('error_locale');
      expect(keys).toContain('error_response_format');

      // Verify no actual KV writes occurred
      expect(mockKV.put).not.toHaveBeenCalledWith(
        expect.stringContaining('settings:tenant:'),
        expect.anything()
      );
    });

    it('should apply migration when dryRun is false', async () => {
      const mockKV = createMockKV({
        error_locale: 'ja',
      });
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/settings/migrate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dryRun: false }),
        },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as MigrationResult;

      expect(body.dryRun).toBe(false);
      expect(body.summary.set).toBeGreaterThan(0);

      // Verify migration lock was set
      expect(mockKV.put).toHaveBeenCalledWith(
        'settings:migration:status',
        expect.stringContaining('migrated')
      );
    });

    it('should prevent re-running migration after completion', async () => {
      const mockKV = createMockKV({
        'settings:migration:status': JSON.stringify({
          migrated: true,
          migratedAt: '2025-12-25T00:00:00Z',
          migratedBy: 'admin',
          version: 'v2',
        }),
      });
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/settings/migrate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dryRun: false }),
        },
        mockEnv
      );

      expect(res.status).toBe(409);
      const body = (await res.json()) as ApiResponse;
      expect(body.error).toBe('already_migrated');
    });

    it('should allow dry-run even after migration', async () => {
      const mockKV = createMockKV({
        'settings:migration:status': JSON.stringify({
          migrated: true,
          migratedAt: '2025-12-25T00:00:00Z',
          migratedBy: 'admin',
          version: 'v2',
        }),
        error_locale: 'en',
      });
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/settings/migrate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dryRun: true }),
        },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as MigrationResult;
      expect(body.dryRun).toBe(true);
    });

    it('should migrate rate limit keys', async () => {
      const mockKV = createMockKV({
        'rate-limit:default:maxRequests': '100',
        'rate-limit:default:windowSeconds': '60',
      });
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/settings/migrate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dryRun: true }),
        },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as MigrationResult;

      const rateLimitChanges = body.changes.filter((c) => c.category === 'rate-limit');
      expect(rateLimitChanges.length).toBe(2);
      expect(rateLimitChanges.map((c) => c.newKey)).toContain('rate-limit.default_max_requests');
      expect(rateLimitChanges.map((c) => c.newKey)).toContain('rate-limit.default_window_seconds');
    });

    it('should transform boolean policy flags', async () => {
      const mockKV = createMockKV({
        REQUIRE_PKCE_FOR_PUBLIC_CLIENTS: 'true',
        STRICT_REDIRECT_URI_MATCHING: 'false',
      });
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/settings/migrate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dryRun: true }),
        },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as MigrationResult;

      const pkceChange = body.changes.find((c) => c.oldKey === 'REQUIRE_PKCE_FOR_PUBLIC_CLIENTS');
      expect(pkceChange?.newValue).toBe(true);

      const strictChange = body.changes.find((c) => c.oldKey === 'STRICT_REDIRECT_URI_MATCHING');
      expect(strictChange?.newValue).toBe(false);
    });

    it('should filter by category when specified', async () => {
      const mockKV = createMockKV({
        error_locale: 'en',
        security_cloud_provider: 'cloudflare',
      });
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/settings/migrate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dryRun: true, categories: ['oauth'] }),
        },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as MigrationResult;

      // Should only include oauth category
      const categories = [...new Set(body.changes.map((c) => c.category))];
      expect(categories).toContain('oauth');
      expect(categories).not.toContain('security');
    });
  });

  describe('GET /settings/migrate/status', () => {
    it('should return not migrated status initially', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request(
        '/api/admin/settings/migrate/status',
        { method: 'GET' },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as MigrationStatus;

      expect(body.migrated).toBe(false);
      expect(body.migratedAt).toBeNull();
      expect(body.migratedBy).toBeNull();
    });

    it('should return migration status after migration', async () => {
      const mockKV = createMockKV({
        'settings:migration:status': JSON.stringify({
          migrated: true,
          migratedAt: '2025-12-25T10:00:00Z',
          migratedBy: 'admin_user',
          version: 'v2',
        }),
      });
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/settings/migrate/status',
        { method: 'GET' },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as MigrationStatus;

      expect(body.migrated).toBe(true);
      expect(body.migratedAt).toBe('2025-12-25T10:00:00Z');
      expect(body.migratedBy).toBe('admin_user');
      expect(body.version).toBe('v2');
    });
  });

  describe('DELETE /settings/migrate/lock', () => {
    it('should clear migration lock', async () => {
      const mockKV = createMockKV({
        'settings:migration:status': JSON.stringify({
          migrated: true,
          migratedAt: '2025-12-25T10:00:00Z',
          migratedBy: 'admin',
          version: 'v2',
        }),
      });
      const { app, mockEnv } = createTestApp({ kv: mockKV });

      const res = await app.request(
        '/api/admin/settings/migrate/lock',
        { method: 'DELETE' },
        mockEnv
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as ApiResponse;
      expect(body.success).toBe(true);

      // Verify lock was deleted
      expect(mockKV.delete).toHaveBeenCalledWith('settings:migration:status');
    });

    it('should succeed even if no lock exists', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request(
        '/api/admin/settings/migrate/lock',
        { method: 'DELETE' },
        mockEnv
      );

      expect(res.status).toBe(200);
    });
  });

  describe('Error Handling', () => {
    it('should handle KV not configured', async () => {
      const app = new Hono<{
        Bindings: Env;
        Variables: {
          adminUser?: { id: string; role?: string };
          adminAuth?: { userId: string; roles: string[]; authMethod: string };
        };
      }>();

      app.use('*', async (c, next) => {
        c.set('adminUser', { id: 'test_admin', role: 'system_admin' });
        c.set('adminAuth', { userId: 'test_admin', roles: ['system_admin'], authMethod: 'bearer' });
        await next();
      });

      app.route('/api/admin', settingsV2);

      // No AUTHRIM_CONFIG in env
      const mockEnv = {} as unknown as Env;

      const res = await app.request(
        '/api/admin/settings/migrate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dryRun: true }),
        },
        mockEnv
      );

      expect(res.status).toBe(500);
      const body = (await res.json()) as ApiResponse;
      expect(body.error).toBe('kv_not_configured');
    });

    it('should handle invalid JSON body', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request(
        '/api/admin/settings/migrate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'invalid json',
        },
        mockEnv
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as ApiResponse;
      expect(body.error).toBe('bad_request');
    });

    it('should reject non-system-admin users', async () => {
      const mockKV = createMockKV();

      // Create app with non-system-admin user
      const app = new Hono<{
        Bindings: Env;
        Variables: {
          adminUser?: { id: string; role?: string };
          adminAuth?: { userId: string; roles: string[]; authMethod: string };
        };
      }>();

      app.use('*', async (c, next) => {
        c.set('adminUser', { id: 'test_admin', role: 'tenant_admin' }); // Not system_admin
        c.set('adminAuth', { userId: 'test_admin', roles: ['tenant_admin'], authMethod: 'bearer' });
        await next();
      });

      app.route('/api/admin', settingsV2);

      const mockEnv = {
        AUTHRIM_CONFIG: mockKV,
      } as unknown as Env;

      const res = await app.request(
        '/api/admin/settings/migrate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dryRun: true }),
        },
        mockEnv
      );

      expect(res.status).toBe(403);
      const body = (await res.json()) as ApiResponse;
      expect(body.error).toBe('forbidden');
      expect(body.message).toContain('system admin');
    });

    it('should reject users without role', async () => {
      const mockKV = createMockKV();

      // Create app with user without role
      const app = new Hono<{
        Bindings: Env;
        Variables: {
          adminUser?: { id: string; role?: string };
          adminAuth?: { userId: string; roles: string[]; authMethod: string };
        };
      }>();

      app.use('*', async (c, next) => {
        c.set('adminUser', { id: 'test_admin' }); // No role
        c.set('adminAuth', { userId: 'test_admin', roles: [], authMethod: 'bearer' }); // Empty roles
        await next();
      });

      app.route('/api/admin', settingsV2);

      const mockEnv = {
        AUTHRIM_CONFIG: mockKV,
      } as unknown as Env;

      const res = await app.request(
        '/api/admin/settings/migrate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dryRun: true }),
        },
        mockEnv
      );

      expect(res.status).toBe(403);
      const body = (await res.json()) as ApiResponse;
      expect(body.error).toBe('forbidden');
    });
  });
});

it('admits actual migration and lock deletion but leaves dry-run available', async () => {
  const { app, mockEnv, mockKV } = createTestApp({ kv: createMockKV({ error_locale: 'ja' }) });
  const acquire = vi.fn().mockResolvedValue({ admitted: false });
  const complete = vi.fn().mockResolvedValue(undefined);
  mockEnv.TENANT_BACKUP_WRAPPING_KEY = 'ab'.repeat(32);
  mockEnv.CONTROL = {
    acquireEnvironmentBackupMutationPermit: acquire,
    completeEnvironmentBackupMutationPermit: complete,
  } as unknown as Env['CONTROL'];
  const url = '/api/admin/settings/migrate';
  const post = (dryRun: boolean) =>
    app.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun }),
      },
      mockEnv
    );
  expect((await post(true)).status).toBe(200);
  expect(acquire).not.toHaveBeenCalled();
  expect((await post(false)).status).toBe(503);
  expect(vi.mocked(mockKV).put.mock.calls).toHaveLength(0);
  acquire.mockResolvedValue({ admitted: true });
  complete.mockImplementation(async () => {
    expect(await mockKV.get('settings:migration:status')).not.toBeNull();
  });
  expect((await post(false)).status).toBe(200);
  expect(complete).toHaveBeenCalledTimes(1);
  acquire.mockResolvedValue({ admitted: false });
  expect((await app.request(url + '/lock', { method: 'DELETE' }, mockEnv)).status).toBe(503);
  expect(await mockKV.get('settings:migration:status')).not.toBeNull();
  acquire.mockResolvedValue({ admitted: true });
  complete.mockImplementation(async () => {
    expect(await mockKV.get('settings:migration:status')).toBeNull();
  });
  expect((await app.request(url + '/lock', { method: 'DELETE' }, mockEnv)).status).toBe(200);
  expect(complete).toHaveBeenCalledTimes(2);
});
it('completes the permit and reports an uncertain partial settings migration', async () => {
  const kv = createMockKV({ error_locale: 'ja' });
  const original = vi.mocked(kv).put.getMockImplementation();
  if (!original) throw new Error('missing KV mock');
  vi.mocked(kv).put.mockImplementation(async (key, value, options) => {
    if (key.startsWith('settings:tenant:')) throw new Error('uncertain write');
    await original(key, value, options);
  });
  const { app, mockEnv } = createTestApp({ kv });
  const complete = vi.fn().mockResolvedValue(undefined);
  mockEnv.TENANT_BACKUP_WRAPPING_KEY = 'ab'.repeat(32);
  mockEnv.CONTROL = {
    acquireEnvironmentBackupMutationPermit: vi.fn().mockResolvedValue({ admitted: true }),
    completeEnvironmentBackupMutationPermit: complete,
  } as unknown as Env['CONTROL'];
  const response = await app.request(
    '/api/admin/settings/migrate',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dryRun: false }),
    },
    mockEnv
  );
  expect(response.status).toBe(503);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(complete).toHaveBeenCalledTimes(1);
});
it('requires system admin for migration status and lock operations before admission', async () => {
  const { app, mockEnv } = createTestApp({ roles: ['viewer'] });
  const acquire = vi.fn();
  mockEnv.TENANT_BACKUP_WRAPPING_KEY = 'ab'.repeat(32);
  mockEnv.CONTROL = {
    acquireEnvironmentBackupMutationPermit: acquire,
  } as unknown as Env['CONTROL'];
  expect(
    (await app.request('/api/admin/settings/migrate/lock', { method: 'DELETE' }, mockEnv)).status
  ).toBe(403);
  expect(
    (await app.request('/api/admin/settings/migrate/status', { method: 'GET' }, mockEnv)).status
  ).toBe(403);
  expect(acquire).not.toHaveBeenCalled();
});
