import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from '@authrim/ar-lib-core';

const repoMocks = vi.hoisted(() => ({
  getRolesByTenant: vi.fn(),
  getSystemRoles: vi.fn(),
  getRole: vi.fn(),
  findByName: vi.fn(),
  createRole: vi.fn(),
  updateRole: vi.fn(),
  deleteRole: vi.fn(),
  getUsersByRole: vi.fn(),
  getEffectivePermissions: vi.fn(),
  createAuditLog: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();

  class MockD1Adapter {
    constructor(_options: unknown) {}
  }

  class MockAdminRoleRepository {
    getRolesByTenant = repoMocks.getRolesByTenant;
    getSystemRoles = repoMocks.getSystemRoles;
    getRole = repoMocks.getRole;
    findByName = repoMocks.findByName;
    createRole = repoMocks.createRole;
    updateRole = repoMocks.updateRole;
    deleteRole = repoMocks.deleteRole;
    getEffectivePermissions = repoMocks.getEffectivePermissions;
  }

  class MockAdminRoleAssignmentRepository {
    getUsersByRole = repoMocks.getUsersByRole;
  }

  class MockAdminAuditLogRepository {
    createAuditLog = repoMocks.createAuditLog;
  }

  const statusByCode: Record<string, number> = {
    [actual.AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS]: 403,
    [actual.AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND]: 404,
    [actual.AR_ERROR_CODES.ADMIN_INVALID_REQUEST]: 400,
    [actual.AR_ERROR_CODES.ADMIN_CONFLICT]: 409,
    [actual.AR_ERROR_CODES.INTERNAL_ERROR]: 500,
  };

  return {
    ...actual,
    D1Adapter: MockD1Adapter,
    AdminRoleRepository: MockAdminRoleRepository,
    AdminRoleAssignmentRepository: MockAdminRoleAssignmentRepository,
    AdminAuditLogRepository: MockAdminAuditLogRepository,
    adminAuthMiddleware:
      () =>
      async (
        c: {
          req: { header: (name: string) => string | undefined };
          set: (key: string, value: unknown) => void;
        },
        next: () => Promise<void>
      ) => {
        c.set('adminAuth', {
          userId: c.req.header('x-test-user-id') ?? 'admin_1',
          email: 'admin@example.com',
          permissions: (c.req.header('x-test-permissions') ?? '')
            .split(',')
            .filter(Boolean),
          roles: (c.req.header('x-test-roles') ?? 'admin').split(',').filter(Boolean),
          hierarchyLevel: c.req.header('x-test-hierarchy-level')
            ? Number(c.req.header('x-test-hierarchy-level'))
            : undefined,
        });
        c.set('tenantId', c.req.header('x-test-tenant-id') ?? 'tenant_123');
        await next();
      },
    getTenantIdFromContext: vi.fn((c: { get: (key: string) => unknown }) => c.get('tenantId')),
    createErrorResponse: vi.fn(
      (
        c: { json: (body: unknown, status?: number) => Response },
        errorCode: string
      ) => c.json({ error: 'error', error_code: errorCode }, statusByCode[errorCode] ?? 500)
    ),
  };
});

import { ADMIN_PERMISSIONS, AR_ERROR_CODES } from '@authrim/ar-lib-core';
import { adminRolesRouter } from '../routes/admin-management/admin-roles';

function createTestApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/admin/admin-roles', adminRolesRouter);
  return {
    app,
    env: {
      DB_ADMIN: {} as D1Database,
    } as unknown as Env,
  };
}

describe('adminRolesRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 404 for a custom role from another tenant', async () => {
    repoMocks.getRole.mockResolvedValue({
      id: 'role_foreign',
      tenant_id: 'tenant_other',
      is_system: false,
    });

    const { app, env } = createTestApp();
    const response = await app.request('/api/admin/admin-roles/role_foreign', {}, env);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error_code).toBe(AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  });

  it('should allow reading a system role across tenants', async () => {
    repoMocks.getRole.mockResolvedValue({
      id: 'role_system',
      tenant_id: 'system',
      is_system: true,
      permissions: ['*'],
      name: 'super_admin',
    });
    repoMocks.getUsersByRole.mockResolvedValue(['admin_1']);

    const { app, env } = createTestApp();
    const response = await app.request('/api/admin/admin-roles/role_system', {}, env);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.assigned_user_count).toBe(1);
  });

  it('should reject creating a role at or above the caller hierarchy level', async () => {
    repoMocks.findByName.mockResolvedValue(null);

    const { app, env } = createTestApp();
    const response = await app.request(
      '/api/admin/admin-roles',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-permissions': `${ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE},${ADMIN_PERMISSIONS.ADMIN_ROLES_READ}`,
          'x-test-hierarchy-level': '10',
        },
        body: JSON.stringify({
          name: 'peer-admin',
          permissions: [ADMIN_PERMISSIONS.ADMIN_USERS_READ],
          hierarchy_level: 10,
        }),
      },
      env
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error_code).toBe(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    expect(repoMocks.createRole).not.toHaveBeenCalled();
  });

  it('should reject granting permissions the caller does not possess', async () => {
    repoMocks.findByName.mockResolvedValue(null);

    const { app, env } = createTestApp();
    const response = await app.request(
      '/api/admin/admin-roles',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-permissions': `${ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE},${ADMIN_PERMISSIONS.ADMIN_ROLES_READ}`,
          'x-test-hierarchy-level': '50',
        },
        body: JSON.stringify({
          name: 'dangerous-admin',
          permissions: [ADMIN_PERMISSIONS.SECURITY_WRITE],
          hierarchy_level: 1,
        }),
      },
      env
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error_code).toBe(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    expect(repoMocks.createRole).not.toHaveBeenCalled();
  });

  it('should reject privilege-escalating role updates', async () => {
    repoMocks.getRole.mockResolvedValue({
      id: 'role_custom',
      tenant_id: 'tenant_123',
      is_system: false,
      role_type: 'custom',
    });

    const { app, env } = createTestApp();
    const response = await app.request(
      '/api/admin/admin-roles/role_custom',
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-test-permissions': `${ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE},${ADMIN_PERMISSIONS.ADMIN_ROLES_READ}`,
          'x-test-hierarchy-level': '50',
        },
        body: JSON.stringify({
          permissions: [ADMIN_PERMISSIONS.SECURITY_WRITE],
        }),
      },
      env
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error_code).toBe(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    expect(repoMocks.updateRole).not.toHaveBeenCalled();
  });

  it('should reject deleting builtin or system roles', async () => {
    repoMocks.getRole.mockResolvedValue({
      id: 'role_builtin',
      tenant_id: 'tenant_123',
      is_system: true,
      role_type: 'builtin',
      name: 'super_admin',
    });

    const { app, env } = createTestApp();
    const response = await app.request(
      '/api/admin/admin-roles/role_builtin',
      {
        method: 'DELETE',
        headers: {
          'x-test-permissions': `${ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE},${ADMIN_PERMISSIONS.ADMIN_ROLES_READ}`,
        },
      },
      env
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error_code).toBe(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    expect(repoMocks.deleteRole).not.toHaveBeenCalled();
  });
});
