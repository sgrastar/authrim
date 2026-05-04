import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';

const { mockAdapter, mockAuditRepo, mockUserRepo, mockLoadAdminAuditDetail, mockGrantRepo } = vi.hoisted(() => ({
  mockAdapter: {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
  } satisfies Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>,
  mockAuditRepo: {
    getAuditLogWithDetailReference: vi.fn(),
    searchAuditLogs: vi.fn(),
  },
  mockUserRepo: {
    getAdminUser: vi.fn(),
  },
  mockLoadAdminAuditDetail: vi.fn(),
  mockGrantRepo: {
    getElevationGrantByPublicId: vi.fn(),
    listActiveElevationGrants: vi.fn(),
  },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    adminAuthMiddleware:
      vi.fn((options?: { requirePermissions?: string[] }) =>
        async (c: any, next: () => Promise<void>) => {
          const permissionsHeader = c.req.header('X-Admin-Permissions') || '';
          const permissions = permissionsHeader
            .split(',')
            .map((entry: string) => entry.trim())
            .filter(Boolean);
          c.set('adminAuth', {
            userId: 'admin-1',
            authMethod: 'password',
            permissions,
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
    AdminAuditLogRepository: vi.fn(function MockAdminAuditLogRepository() {
      return mockAuditRepo;
    }),
    AdminUserRepository: vi.fn(function MockAdminUserRepository() {
      return mockUserRepo;
    }),
    ElevationGrantRepository: vi.fn(function MockElevationGrantRepository() {
      return mockGrantRepo;
    }),
  };
});

vi.mock('../admin-shared', () => ({
  loadAdminAuditDetail: mockLoadAdminAuditDetail,
}));

import { adminAuditRouter } from '../routes/admin-management/admin-audit';

const mockEnv = {
  AUTHRIM_CONFIG: {
    get: vi.fn().mockResolvedValue(null),
  },
} as unknown as Env;

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/admin/admin-audit-log', adminAuditRouter);
  return app;
}

describe('adminAuditRouter detail permission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuditRepo.getAuditLogWithDetailReference.mockResolvedValue({
      entry: {
        id: 'audit-1',
        tenant_id: 'tenant-a',
        admin_user_id: 'admin-1',
        admin_email: 'admin@example.com',
        admin_name: 'Admin',
        action: 'admin.user.update',
        resource_type: 'admin_user',
        resource_id: 'admin-1',
        result: 'success',
        severity: 'info',
        reason_code: null,
        reason_note: null,
        reference_id: null,
        ip_address: null,
        user_agent: null,
        created_at: 1714550400000,
        before: undefined,
        after: undefined,
        metadata: undefined,
        has_detail: true,
        detail_artifact_id: 'oa_audit123',
      },
      detailObjectCatalogId: 'catalog-123',
      detailArtifactId: 'oa_audit123',
    });
    mockUserRepo.getAdminUser.mockResolvedValue({
      id: 'admin-1',
      email: 'admin@example.com',
      name: 'Admin',
    });
    mockGrantRepo.listActiveElevationGrants.mockResolvedValue([]);
    mockLoadAdminAuditDetail.mockResolvedValue({
      before: { name: 'before' },
      after: { name: 'after' },
      metadata: { reason: 'test' },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects detail reads without admin_audit detail permission', async () => {
    const app = createApp();
    const res = await app.request(
      '/api/admin/admin-audit-log/audit-1',
      {
        method: 'GET',
        headers: {
          'X-Admin-Permissions': 'admin:admin_audit:read',
        },
      },
      mockEnv
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('approval_required');
    expect(mockLoadAdminAuditDetail).not.toHaveBeenCalled();
  });

  it('loads full detail when admin_audit detail permission is present', async () => {
    const app = createApp();
    const res = await app.request(
      '/api/admin/admin-audit-log/audit-1',
      {
        method: 'GET',
        headers: {
          'X-Admin-Permissions':
            'admin:admin_audit:read,admin:admin_audit:detail:read',
        },
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe('audit-1');
    expect(body.before).toEqual({ name: 'before' });
    expect(body.after).toEqual({ name: 'after' });
    expect(body.admin_user).toEqual({
      id: 'admin-1',
      email: 'admin@example.com',
      name: 'Admin',
    });
    expect(mockLoadAdminAuditDetail).toHaveBeenCalledWith(
      expect.anything(),
      mockAdapter,
      'tenant-a',
      'oa_audit123',
      'catalog-123'
    );
  });

  it('loads full detail with a matching elevation grant when detail permission is absent', async () => {
    const app = createApp();
    mockGrantRepo.listActiveElevationGrants.mockResolvedValue([
      {
        id: 'grant-1',
        public_grant_id: 'egr_public_1',
        approval_request_id: 'req-1',
        tenant_id: 'tenant-a',
        status: 'active',
        target_audience: 'admin_api',
        resource_class: 'admin_audit_detail',
        redaction_level: 'masked',
        scope_canonical: '{"version":1}',
        scope_json: {
          version: 1,
          surface: 'admin_audit',
          action: 'detail_read',
          tenant_id: 'tenant-a',
          resource_class: 'admin_audit_detail',
          resource_ids: ['audit-1'],
          detail_classes: ['before_after_metadata'],
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

    const res = await app.request(
      '/api/admin/admin-audit-log/audit-1',
      {
        method: 'GET',
        headers: {
          'X-Admin-Permissions': 'admin:admin_audit:read',
        },
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    expect(mockLoadAdminAuditDetail).toHaveBeenCalled();
  });
});
