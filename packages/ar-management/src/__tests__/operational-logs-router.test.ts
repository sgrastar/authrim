import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';

const { mockAdapter, mockGetOperationalLog, mockGrantRepo } = vi.hoisted(() => ({
  mockAdapter: {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
  } satisfies Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>,
  mockGetOperationalLog: vi.fn(),
  mockGrantRepo: {
    getElevationGrantByPublicId: vi.fn(),
    listActiveElevationGrants: vi.fn(),
  },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    adminAuthMiddleware: vi.fn(
      (options?: { requirePermissions?: string[] }) =>
        async (c: any, next: () => Promise<void>) => {
          const permissions = (c.req.header('X-Admin-Permissions') || '')
            .split(',')
            .map((value: string) => value.trim())
            .filter(Boolean);
          c.set('adminAuth', {
            userId: 'admin-1',
            authMethod: 'session',
            tenantId: 'tenant-a',
            permissions,
            roles: ['tenant_admin'],
            hierarchyLevel: 50,
            mfaVerified: true,
          });

          if (options?.requirePermissions?.length) {
            const hasAll = options.requirePermissions.every((required) =>
              actual.hasAdminPermission(permissions, required)
            );
            if (!hasAll) {
              return c.json(
                {
                  error: 'insufficient_permissions',
                  error_description: 'You do not have the required permissions for this operation.',
                },
                403
              );
            }
          }

          await next();
        }
    ),
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mockAdapter),
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    getOperationalLog: mockGetOperationalLog,
    ElevationGrantRepository: vi.fn(function MockElevationGrantRepository() {
      return mockGrantRepo;
    }),
  };
});

import { operationalLogsRouter } from '../routes/admin-management/operational-logs';

const mockEnv = {
  DB_ADMIN: {},
  PII_ENCRYPTION_KEY: 'test-key',
} as unknown as Env;

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/admin/operational-logs', operationalLogsRouter);
  return app;
}

describe('operational logs router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGrantRepo.listActiveElevationGrants.mockResolvedValue([]);
    mockAdapter.query.mockResolvedValue([
      {
        id: 'op-1',
        tenant_id: 'tenant-a',
        subject_type: 'user',
        subject_id: 'user-1',
        actor_id: 'admin-1',
        action: 'user.suspend.reason',
        request_id: 'req-1',
        created_at: 1714550400,
        expires_at: 1717152400,
        detail_object_catalog_id: 'catalog-1',
      },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists operational log summaries with read permission', async () => {
    const app = createApp();
    const res = await app.request(
      '/api/admin/operational-logs?subject_type=user&subject_id=user-1',
      {
        method: 'GET',
        headers: {
          'X-Admin-Permissions': 'admin:operational_logs:read',
        },
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items[0]?.has_detail).toBe(true);
    expect(mockAdapter.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM operational_logs'),
      expect.arrayContaining(['tenant-a', expect.any(Number), 'user', 'user-1'])
    );
  });

  it('requires detail permission for full reason detail', async () => {
    const app = createApp();
    const res = await app.request(
      '/api/admin/operational-logs/op-1',
      {
        method: 'GET',
        headers: {
          'X-Admin-Permissions': 'admin:operational_logs:read',
        },
      },
      mockEnv
    );

    expect(res.status).toBe(403);
    expect(mockGetOperationalLog).not.toHaveBeenCalled();
  });

  it('returns decrypted operational log detail with detail permission', async () => {
    const app = createApp();
    mockGetOperationalLog.mockResolvedValue({
      id: 'op-1',
      tenant_id: 'tenant-a',
      subject_type: 'user',
      subject_id: 'user-1',
      actor_id: 'admin-1',
      action: 'user.suspend.reason',
      reason_detail: 'Customer requested immediate suspension.',
      request_id: 'req-1',
      encryption_key_version: 0,
      detail_object_catalog_id: 'catalog-1',
      created_at: 1714550400,
      expires_at: 1717152400,
    });

    const res = await app.request(
      '/api/admin/operational-logs/op-1',
      {
        method: 'GET',
        headers: {
          'X-Admin-Permissions': 'admin:operational_logs:read,admin:operational_logs:detail:read',
        },
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { reason_detail: string };
    expect(body.reason_detail).toContain('immediate suspension');
    expect(mockGetOperationalLog).toHaveBeenCalled();
  });

  it('returns operational log detail with a matching elevation grant', async () => {
    const app = createApp();
    mockGrantRepo.listActiveElevationGrants.mockResolvedValue([
      {
        id: 'grant-1',
        public_grant_id: 'egr_public_1',
        approval_request_id: 'req-1',
        tenant_id: 'tenant-a',
        status: 'active',
        target_audience: 'admin_api',
        resource_class: 'operational_log_detail',
        redaction_level: 'masked',
        scope_canonical: '{"version":1}',
        scope_json: {
          version: 1,
          surface: 'operational_logs',
          action: 'detail_read',
          tenant_id: 'tenant-a',
          resource_class: 'operational_log_detail',
          resource_ids: ['op-1'],
          detail_classes: ['reason_detail'],
        },
        authorization_details_json: null,
        requester_subject_type: 'admin_user',
        requester_subject_id: 'admin-1',
        actor_subject_type: 'admin_user',
        actor_subject_id: 'admin-1',
        issued_at: Date.now(),
        expires_at: Date.now() + 60000,
        revoked_at: null,
        revoke_reason: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    ]);
    mockGetOperationalLog.mockResolvedValue({
      id: 'op-1',
      tenant_id: 'tenant-a',
      subject_type: 'user',
      subject_id: 'user-1',
      actor_id: 'admin-1',
      action: 'user.suspend.reason',
      reason_detail: 'Customer requested immediate suspension.',
      request_id: 'req-1',
      encryption_key_version: 0,
      detail_object_catalog_id: 'catalog-1',
      created_at: 1714550400,
      expires_at: 1717152400,
    });

    const res = await app.request(
      '/api/admin/operational-logs/op-1',
      {
        method: 'GET',
        headers: {
          'X-Admin-Permissions': 'admin:operational_logs:read',
        },
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    expect(mockGetOperationalLog).toHaveBeenCalled();
  });
});
