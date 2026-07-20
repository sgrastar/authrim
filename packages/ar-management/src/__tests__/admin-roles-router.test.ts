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
  getAssignmentsByRole: vi.fn(),
  assignRole: vi.fn(),
  assignmentExists: vi.fn(),
  getAssignment: vi.fn(),
  updateAssignment: vi.fn(),
  removeAssignmentById: vi.fn(),
  findAdminUserByTenantAndId: vi.fn(),
  getEffectivePermissions: vi.fn(),
  createAuditLog: vi.fn(),
  adminAdapterQueryOne: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const mockAdminAdapter = {
    queryOne: repoMocks.adminAdapterQueryOne,
  };

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
    getAssignmentsByRole = repoMocks.getAssignmentsByRole;
    assignRole = repoMocks.assignRole;
    assignmentExists = repoMocks.assignmentExists;
    getAssignment = repoMocks.getAssignment;
    updateAssignment = repoMocks.updateAssignment;
    removeAssignmentById = repoMocks.removeAssignmentById;
  }

  class MockAdminUserRepository {
    findByTenantAndId = repoMocks.findAdminUserByTenantAndId;
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
    requireDedicatedAdminDatabaseAdapter: vi.fn().mockReturnValue(mockAdminAdapter),
    AdminUserRepository: MockAdminUserRepository,
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
          permissions: (c.req.header('x-test-permissions') ?? '').split(',').filter(Boolean),
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
      (c: { json: (body: unknown, status?: number) => Response }, errorCode: string) =>
        c.json({ error: 'error', error_code: errorCode }, statusByCode[errorCode] ?? 500)
    ),
  };
});

import { ADMIN_PERMISSIONS, AR_ERROR_CODES } from '@authrim/ar-lib-core';
import { adminRolesRouter } from '../routes/admin-management/admin-roles';

type ErrorResponseBody = {
  error_code?: string;
  assigned_user_count?: number;
  scope_type?: string;
  scope_id?: string;
  total?: number;
};

type RoleListResponseBody = {
  items: Array<{
    id: string;
    tenant_id: string;
    name: string;
    hierarchy_level: number;
    is_system: boolean;
  }>;
  total: number;
};

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
    repoMocks.adminAdapterQueryOne.mockResolvedValue(null);
  });

  it('should hide tenant-scoped system role copies when listing roles', async () => {
    repoMocks.getRolesByTenant.mockResolvedValue([
      {
        id: 'role_super_admin__first',
        tenant_id: 'first',
        name: 'super_admin',
        hierarchy_level: 100,
        is_system: true,
      },
      {
        id: 'role_security_admin__first',
        tenant_id: 'first',
        name: 'security_admin',
        hierarchy_level: 90,
        is_system: true,
      },
      {
        id: 'role_custom_billing',
        tenant_id: 'first',
        name: 'billing_admin',
        hierarchy_level: 30,
        is_system: false,
      },
    ]);
    repoMocks.getSystemRoles.mockResolvedValue([
      {
        id: 'role_super_admin',
        tenant_id: 'default',
        name: 'super_admin',
        hierarchy_level: 100,
        is_system: true,
      },
      {
        id: 'role_security_admin',
        tenant_id: 'default',
        name: 'security_admin',
        hierarchy_level: 90,
        is_system: true,
      },
      {
        id: 'role_viewer',
        tenant_id: 'default',
        name: 'viewer',
        hierarchy_level: 20,
        is_system: true,
      },
    ]);

    const { app, env } = createTestApp();
    const response = await app.request(
      '/api/admin/admin-roles',
      {
        headers: {
          'x-test-tenant-id': 'first',
        },
      },
      env
    );
    const body = (await response.json()) as RoleListResponseBody;

    expect(response.status).toBe(200);
    expect(body.total).toBe(4);
    expect(body.items.map((role) => role.name)).toEqual([
      'super_admin',
      'security_admin',
      'billing_admin',
      'viewer',
    ]);
    expect(body.items.find((role) => role.name === 'super_admin')?.id).toBe('role_super_admin');
    expect(body.items.find((role) => role.name === 'security_admin')?.id).toBe(
      'role_security_admin'
    );
  });

  it('should return 404 for a custom role from another tenant', async () => {
    repoMocks.getRole.mockResolvedValue({
      id: 'role_foreign',
      tenant_id: 'tenant_other',
      is_system: false,
    });

    const { app, env } = createTestApp();
    const response = await app.request('/api/admin/admin-roles/role_foreign', {}, env);
    const body = (await response.json()) as ErrorResponseBody;

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
    const body = (await response.json()) as ErrorResponseBody;

    expect(response.status).toBe(200);
    expect(body.assigned_user_count).toBe(1);
  });

  it('should list role assignments inside the caller tenant scope', async () => {
    repoMocks.getRole.mockResolvedValue({
      id: 'role_support',
      tenant_id: 'tenant_123',
      is_system: false,
      permissions: ['admin:users:read'],
      name: 'support',
    });
    repoMocks.getAssignmentsByRole.mockResolvedValue([
      {
        id: 'assignment_1',
        tenant_id: 'tenant_123',
        admin_user_id: 'admin_1',
        admin_role_id: 'role_support',
        scope_type: 'tenant',
        scope_id: 'tenant_123',
        expires_at: null,
        assigned_by: 'admin_root',
        created_at: 1000,
        user: {
          id: 'admin_1',
          email: 'admin@example.com',
          name: null,
          status: 'active',
          is_active: true,
        },
      },
    ]);

    const { app, env } = createTestApp();
    const response = await app.request('/api/admin/admin-roles/role_support/assignments', {}, env);
    const body = (await response.json()) as ErrorResponseBody;

    expect(response.status).toBe(200);
    expect(body.total).toBe(1);
    expect(repoMocks.getAssignmentsByRole).toHaveBeenCalledWith('role_support', false);
  });

  it('should create a tenant-scoped role assignment', async () => {
    repoMocks.getRole.mockResolvedValue({
      id: 'role_support',
      tenant_id: 'tenant_123',
      is_system: false,
      permissions: ['admin:users:read'],
      hierarchy_level: 10,
      name: 'support',
    });
    repoMocks.findAdminUserByTenantAndId.mockResolvedValue({
      id: 'admin_2',
      tenant_id: 'tenant_123',
      email: 'support@example.com',
    });
    repoMocks.assignmentExists.mockResolvedValue(false);
    repoMocks.assignRole.mockResolvedValue({
      id: 'assignment_1',
      tenant_id: 'tenant_123',
      admin_user_id: 'admin_2',
      admin_role_id: 'role_support',
      scope_type: 'tenant',
      scope_id: 'tenant_123',
      expires_at: null,
      assigned_by: 'admin_1',
      created_at: 1000,
    });

    const { app, env } = createTestApp();
    const response = await app.request(
      '/api/admin/admin-roles/role_support/assignments',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-permissions': `${ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE},${ADMIN_PERMISSIONS.ADMIN_ROLES_READ}`,
          'x-test-hierarchy-level': '50',
        },
        body: JSON.stringify({
          admin_user_id: 'admin_2',
          scope_type: 'tenant',
        }),
      },
      env
    );
    const body = (await response.json()) as ErrorResponseBody;

    expect(response.status).toBe(201);
    expect(body.scope_type).toBe('tenant');
    expect(body.scope_id).toBe('tenant_123');
    expect(repoMocks.assignRole).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant_123',
        admin_user_id: 'admin_2',
        admin_role_id: 'role_support',
        scope_type: 'tenant',
        scope_id: 'tenant_123',
      })
    );
  });

  it('should reject duplicate role assignments for the same scope binding', async () => {
    repoMocks.getRole.mockResolvedValue({
      id: 'role_support',
      tenant_id: 'tenant_123',
      is_system: false,
      permissions: ['admin:users:read'],
      hierarchy_level: 10,
      name: 'support',
    });
    repoMocks.findAdminUserByTenantAndId.mockResolvedValue({
      id: 'admin_2',
      tenant_id: 'tenant_123',
      email: 'support@example.com',
    });
    repoMocks.assignmentExists.mockResolvedValue(true);

    const { app, env } = createTestApp();
    const response = await app.request(
      '/api/admin/admin-roles/role_support/assignments',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-permissions': `${ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE},${ADMIN_PERMISSIONS.ADMIN_ROLES_READ}`,
          'x-test-hierarchy-level': '50',
        },
        body: JSON.stringify({
          admin_user_id: 'admin_2',
          scope_type: 'tenant',
        }),
      },
      env
    );
    const body = (await response.json()) as ErrorResponseBody;

    expect(response.status).toBe(409);
    expect(body.error_code).toBe(AR_ERROR_CODES.ADMIN_CONFLICT);
    expect(repoMocks.assignRole).not.toHaveBeenCalled();
  });

  it('should reject tenant-scoped role assignment for another tenant', async () => {
    repoMocks.getRole.mockResolvedValue({
      id: 'role_support',
      tenant_id: 'tenant_123',
      is_system: false,
      permissions: ['admin:users:read'],
      hierarchy_level: 10,
      name: 'support',
    });
    repoMocks.findAdminUserByTenantAndId.mockResolvedValue({
      id: 'admin_2',
      tenant_id: 'tenant_123',
      email: 'support@example.com',
    });

    const { app, env } = createTestApp();
    const response = await app.request(
      '/api/admin/admin-roles/role_support/assignments',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-permissions': `${ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE},${ADMIN_PERMISSIONS.ADMIN_ROLES_READ}`,
          'x-test-hierarchy-level': '50',
        },
        body: JSON.stringify({
          admin_user_id: 'admin_2',
          scope_type: 'tenant',
          scope_id: 'tenant_other',
        }),
      },
      env
    );
    const body = (await response.json()) as ErrorResponseBody;

    expect(response.status).toBe(400);
    expect(body.error_code).toBe(AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    expect(repoMocks.assignRole).not.toHaveBeenCalled();
  });

  it('should reject global role assignment without platform authority', async () => {
    repoMocks.getRole.mockResolvedValue({
      id: 'role_support',
      tenant_id: 'tenant_123',
      is_system: false,
      permissions: ['admin:users:read'],
      hierarchy_level: 10,
      name: 'support',
    });
    repoMocks.findAdminUserByTenantAndId.mockResolvedValue({
      id: 'admin_2',
      tenant_id: 'tenant_123',
      email: 'support@example.com',
    });

    const { app, env } = createTestApp();
    const response = await app.request(
      '/api/admin/admin-roles/role_support/assignments',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-permissions': `${ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE},${ADMIN_PERMISSIONS.ADMIN_ROLES_READ}`,
          'x-test-hierarchy-level': '50',
        },
        body: JSON.stringify({
          admin_user_id: 'admin_2',
          scope_type: 'global',
        }),
      },
      env
    );
    const body = (await response.json()) as ErrorResponseBody;

    expect(response.status).toBe(403);
    expect(body.error_code).toBe(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    expect(repoMocks.assignRole).not.toHaveBeenCalled();
  });

  it('should allow global role assignment with platform authority', async () => {
    repoMocks.getRole.mockResolvedValue({
      id: 'role_support',
      tenant_id: 'tenant_123',
      is_system: false,
      permissions: ['admin:users:read'],
      hierarchy_level: 10,
      name: 'support',
    });
    repoMocks.findAdminUserByTenantAndId.mockResolvedValue({
      id: 'admin_2',
      tenant_id: 'tenant_123',
      email: 'support@example.com',
    });
    repoMocks.assignmentExists.mockResolvedValue(false);
    repoMocks.assignRole.mockResolvedValue({
      id: 'assignment_global',
      tenant_id: 'tenant_123',
      admin_user_id: 'admin_2',
      admin_role_id: 'role_support',
      scope_type: 'global',
      scope_id: null,
      expires_at: null,
      assigned_by: 'admin_1',
      created_at: 1000,
    });

    const { app, env } = createTestApp();
    const response = await app.request(
      '/api/admin/admin-roles/role_support/assignments',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-permissions': `*,${ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE},${ADMIN_PERMISSIONS.ADMIN_ROLES_READ}`,
          'x-test-hierarchy-level': '50',
        },
        body: JSON.stringify({
          admin_user_id: 'admin_2',
          scope_type: 'global',
        }),
      },
      env
    );
    const body = (await response.json()) as ErrorResponseBody;

    expect(response.status).toBe(201);
    expect(body.scope_type).toBe('global');
    expect(repoMocks.assignRole).toHaveBeenCalledWith(
      expect.objectContaining({
        scope_type: 'global',
        scope_id: undefined,
      })
    );
  });

  it('should reject org-scoped admin role assignment creation for now', async () => {
    repoMocks.getRole.mockResolvedValue({
      id: 'role_support',
      tenant_id: 'tenant_123',
      is_system: false,
      permissions: ['admin:users:read'],
      hierarchy_level: 10,
      name: 'support',
    });
    repoMocks.findAdminUserByTenantAndId.mockResolvedValue({
      id: 'admin_2',
      tenant_id: 'tenant_123',
      email: 'support@example.com',
    });

    const { app, env } = createTestApp();
    const response = await app.request(
      '/api/admin/admin-roles/role_support/assignments',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-permissions': `${ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE},${ADMIN_PERMISSIONS.ADMIN_ROLES_READ}`,
          'x-test-hierarchy-level': '50',
        },
        body: JSON.stringify({
          admin_user_id: 'admin_2',
          scope_type: 'org',
          scope_id: 'org_1',
        }),
      },
      env
    );
    const body = (await response.json()) as ErrorResponseBody;

    expect(response.status).toBe(400);
    expect(body.error_code).toBe(AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    expect(repoMocks.assignRole).not.toHaveBeenCalled();
  });

  it('should update role assignment scope binding', async () => {
    repoMocks.getRole.mockResolvedValue({
      id: 'role_support',
      tenant_id: 'tenant_123',
      is_system: false,
      permissions: ['admin:users:read'],
      hierarchy_level: 10,
      name: 'support',
    });
    repoMocks.getAssignment.mockResolvedValue({
      id: 'assignment_1',
      tenant_id: 'tenant_123',
      admin_user_id: 'admin_2',
      admin_role_id: 'role_support',
      scope_type: 'tenant',
      scope_id: 'tenant_123',
      expires_at: null,
      assigned_by: 'admin_1',
      created_at: 1000,
    });
    repoMocks.assignmentExists.mockResolvedValue(false);
    repoMocks.updateAssignment.mockResolvedValue({
      id: 'assignment_1',
      tenant_id: 'tenant_123',
      admin_user_id: 'admin_2',
      admin_role_id: 'role_support',
      scope_type: 'tenant',
      scope_id: 'tenant_123',
      expires_at: 2000,
      assigned_by: 'admin_1',
      created_at: 1000,
    });

    const { app, env } = createTestApp();
    const response = await app.request(
      '/api/admin/admin-roles/role_support/assignments/assignment_1',
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-test-permissions': `${ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE},${ADMIN_PERMISSIONS.ADMIN_ROLES_READ}`,
          'x-test-hierarchy-level': '50',
        },
        body: JSON.stringify({
          scope_type: 'tenant',
          scope_id: 'tenant_123',
          expires_at: 2000,
        }),
      },
      env
    );

    expect(response.status).toBe(200);
    expect(repoMocks.updateAssignment).toHaveBeenCalledWith(
      'assignment_1',
      expect.objectContaining({
        scope_type: 'tenant',
        scope_id: 'tenant_123',
        expires_at: 2000,
      })
    );
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
    const body = (await response.json()) as ErrorResponseBody;

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
    const body = (await response.json()) as ErrorResponseBody;

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
    const body = (await response.json()) as ErrorResponseBody;

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
    const body = (await response.json()) as ErrorResponseBody;

    expect(response.status).toBe(403);
    expect(body.error_code).toBe(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    expect(repoMocks.deleteRole).not.toHaveBeenCalled();
  });

  it('should list tenant-only roles deterministically when system roles are excluded', async () => {
    repoMocks.getRolesByTenant.mockResolvedValue([
      { id: 'b', name: 'beta', hierarchy_level: 10 },
      { id: 'a', name: 'alpha', hierarchy_level: 10 },
      { id: 'top', name: 'top', hierarchy_level: 20 },
    ]);
    const { app, env } = createTestApp();

    const response = await app.request('/api/admin/admin-roles?include_system=false', {}, env);
    const body = (await response.json()) as RoleListResponseBody;

    expect(response.status).toBe(200);
    expect(body.items.map((role) => role.name)).toEqual(['top', 'alpha', 'beta']);
    expect(repoMocks.getSystemRoles).not.toHaveBeenCalled();
  });

  it('should expose the permission catalog as a stable public contract', async () => {
    const { app, env } = createTestApp();

    const response = await app.request('/api/admin/admin-roles/permissions/list', {}, env);
    const body = (await response.json()) as { items: Array<{ key: string }>; total: number };

    expect(response.status).toBe(200);
    expect(body.total).toBe(body.items.length);
    expect(body.items.map((item) => item.key)).toEqual(
      expect.arrayContaining(['*', ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE])
    );
  });

  it('should return effective permissions only for a tenant-accessible role', async () => {
    repoMocks.getRole.mockResolvedValue({
      id: 'role_support',
      tenant_id: 'tenant_123',
      is_system: false,
      name: 'support',
      permissions: ['admin:users:read'],
      inherits_from: 'role_viewer',
    });
    repoMocks.getEffectivePermissions.mockResolvedValue(['admin:users:read', 'admin:clients:read']);
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admin-roles/role_support/effective-permissions',
      {},
      env
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.effective_permissions).toEqual(['admin:users:read', 'admin:clients:read']);
  });

  it.each([
    ['missing role', null],
    ['foreign custom role', { id: 'foreign', tenant_id: 'other', is_system: false }],
  ])('should hide effective permissions for a %s', async (_label, role) => {
    repoMocks.getRole.mockResolvedValue(role);
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admin-roles/foreign/effective-permissions',
      {},
      env
    );

    expect(response.status).toBe(404);
    expect(repoMocks.getEffectivePermissions).not.toHaveBeenCalled();
  });

  it('should create a custom role without exceeding the caller permissions', async () => {
    repoMocks.findByName.mockResolvedValue(null);
    repoMocks.createRole.mockResolvedValue({
      id: 'role_auditor',
      tenant_id: 'tenant_123',
      name: 'auditor',
      permissions: [ADMIN_PERMISSIONS.ADMIN_USERS_READ],
      hierarchy_level: 5,
    });
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admin-roles',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-permissions': `${ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE},${ADMIN_PERMISSIONS.ADMIN_USERS_READ}`,
          'x-test-hierarchy-level': '10',
        },
        body: JSON.stringify({
          name: 'auditor',
          permissions: [ADMIN_PERMISSIONS.ADMIN_USERS_READ],
          hierarchy_level: 5,
        }),
      },
      env
    );

    expect(response.status).toBe(201);
    expect(repoMocks.createRole).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: 'tenant_123', role_type: 'custom' })
    );
    expect(repoMocks.createAuditLog).toHaveBeenCalled();
  });

  it.each([
    ['missing name', { permissions: [] }, 400],
    ['non-array permissions', { name: 'bad', permissions: 'admin:users:read' }, 400],
    ['duplicate name', { name: 'duplicate', permissions: [] }, 409],
  ])('should reject role creation with %s', async (_label, body, status) => {
    repoMocks.findByName.mockResolvedValue({ id: 'existing' });
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admin-roles',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-permissions': '*',
        },
        body: JSON.stringify(body),
      },
      env
    );

    expect(response.status).toBe(status);
    expect(repoMocks.createRole).not.toHaveBeenCalled();
  });

  it('should update a tenant custom role and audit the exact changes', async () => {
    repoMocks.getRole.mockResolvedValue({
      id: 'role_custom',
      tenant_id: 'tenant_123',
      is_system: false,
      role_type: 'custom',
    });
    repoMocks.updateRole.mockResolvedValue({ id: 'role_custom', display_name: 'Updated' });
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admin-roles/role_custom',
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-test-permissions': '*',
          'x-test-hierarchy-level': '50',
        },
        body: JSON.stringify({ display_name: 'Updated', hierarchy_level: 10 }),
      },
      env
    );

    expect(response.status).toBe(200);
    expect(repoMocks.updateRole).toHaveBeenCalledWith(
      'role_custom',
      expect.objectContaining({ display_name: 'Updated', hierarchy_level: 10 })
    );
    expect(repoMocks.createAuditLog).toHaveBeenCalled();
  });

  it.each([
    ['missing role', null, 404],
    ['foreign role', { id: 'role_foreign', tenant_id: 'other', is_system: false }, 404],
    ['system role', { id: 'role_system', tenant_id: 'tenant_123', is_system: true }, 403],
  ])('should reject updates to a %s', async (_label, role, status) => {
    repoMocks.getRole.mockResolvedValue(role);
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admin-roles/role_target',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-test-permissions': '*' },
        body: JSON.stringify({ display_name: 'Updated' }),
      },
      env
    );

    expect(response.status).toBe(status);
    expect(repoMocks.updateRole).not.toHaveBeenCalled();
  });

  it('should delete only an unassigned tenant custom role and audit it', async () => {
    repoMocks.getRole.mockResolvedValue({
      id: 'role_custom',
      tenant_id: 'tenant_123',
      is_system: false,
      role_type: 'custom',
      name: 'custom',
    });
    repoMocks.getUsersByRole.mockResolvedValue([]);
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admin-roles/role_custom',
      { method: 'DELETE', headers: { 'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE } },
      env
    );

    expect(response.status).toBe(200);
    expect(repoMocks.deleteRole).toHaveBeenCalledWith('role_custom');
    expect(repoMocks.createAuditLog).toHaveBeenCalled();
  });

  it('should reject deletion while a custom role remains assigned', async () => {
    repoMocks.getRole.mockResolvedValue({
      id: 'role_custom',
      tenant_id: 'tenant_123',
      is_system: false,
      role_type: 'custom',
    });
    repoMocks.getUsersByRole.mockResolvedValue(['admin_2']);
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admin-roles/role_custom',
      { method: 'DELETE', headers: { 'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE } },
      env
    );

    expect(response.status).toBe(409);
    expect(repoMocks.deleteRole).not.toHaveBeenCalled();
  });

  it('should reject deletion while a pending invitation still targets the role', async () => {
    repoMocks.getRole.mockResolvedValue({
      id: 'role_custom',
      tenant_id: 'tenant_123',
      is_system: false,
      role_type: 'custom',
    });
    repoMocks.getUsersByRole.mockResolvedValue([]);
    repoMocks.adminAdapterQueryOne.mockResolvedValue({ id: 'invitation_1' });
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admin-roles/role_custom',
      { method: 'DELETE', headers: { 'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE } },
      env
    );

    expect(response.status).toBe(409);
    expect(repoMocks.adminAdapterQueryOne).toHaveBeenCalledWith(
      expect.stringContaining("status = 'pending'"),
      ['tenant_123', 'role_custom', expect.any(Number)]
    );
    expect(repoMocks.deleteRole).not.toHaveBeenCalled();
  });

  it('should remove a non-platform assignment and leave audit evidence', async () => {
    repoMocks.getRole.mockResolvedValue({
      id: 'role_support',
      tenant_id: 'tenant_123',
      is_system: false,
      name: 'support',
    });
    repoMocks.getAssignment.mockResolvedValue({
      id: 'assignment_1',
      admin_role_id: 'role_support',
      admin_user_id: 'admin_2',
      scope_type: 'tenant',
      scope_id: 'tenant_123',
    });
    repoMocks.removeAssignmentById.mockResolvedValue(true);
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admin-roles/role_support/assignments/assignment_1',
      { method: 'DELETE', headers: { 'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE } },
      env
    );

    expect(response.status).toBe(200);
    expect(repoMocks.removeAssignmentById).toHaveBeenCalledWith('assignment_1');
    expect(repoMocks.createAuditLog).toHaveBeenCalled();
  });

  it('should protect the final platform role assignment from deletion', async () => {
    repoMocks.getRole.mockResolvedValue({
      id: 'role_super_admin',
      tenant_id: 'default',
      is_system: true,
      name: 'super_admin',
    });
    repoMocks.getAssignment.mockResolvedValue({
      id: 'assignment_1',
      admin_role_id: 'role_super_admin',
      admin_user_id: 'admin_2',
    });
    repoMocks.adminAdapterQueryOne.mockResolvedValue({ count: 1 });
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admin-roles/role_super_admin/assignments/assignment_1',
      { method: 'DELETE', headers: { 'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE } },
      env
    );

    expect(response.status).toBe(409);
    expect(repoMocks.removeAssignmentById).not.toHaveBeenCalled();
  });

  it.each([
    ['POST', '/api/admin/admin-roles/role_support/assignments'],
    ['PATCH', '/api/admin/admin-roles/role_support/assignments/assignment_1'],
    ['DELETE', '/api/admin/admin-roles/role_support/assignments/assignment_1'],
    ['POST', '/api/admin/admin-roles'],
    ['PATCH', '/api/admin/admin-roles/role_support'],
    ['DELETE', '/api/admin/admin-roles/role_support'],
  ])('should reject %s %s without role-write authority', async (method, path) => {
    const { app, env } = createTestApp();
    const response = await app.request(
      path,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'POST' || method === 'PATCH' ? '{}' : undefined,
      },
      env
    );

    expect(response.status).toBe(403);
  });

  it.each([
    ['missing role', null, { admin_user_id: 'admin_2' }, { id: 'admin_2' }, 404],
    [
      'foreign role',
      { id: 'foreign', tenant_id: 'other', is_system: false },
      { admin_user_id: 'admin_2' },
      { id: 'admin_2' },
      404,
    ],
    [
      'missing user id',
      { id: 'role_support', tenant_id: 'tenant_123', hierarchy_level: 1 },
      {},
      null,
      400,
    ],
    [
      'foreign user',
      { id: 'role_support', tenant_id: 'tenant_123', hierarchy_level: 1 },
      { admin_user_id: 'admin_foreign' },
      null,
      404,
    ],
    [
      'peer hierarchy role',
      { id: 'role_support', tenant_id: 'tenant_123', hierarchy_level: 50 },
      { admin_user_id: 'admin_2' },
      { id: 'admin_2' },
      403,
    ],
    [
      'invalid expiry',
      { id: 'role_support', tenant_id: 'tenant_123', hierarchy_level: 1 },
      { admin_user_id: 'admin_2', expires_at: 0 },
      { id: 'admin_2' },
      400,
    ],
  ])('should reject assignment creation for %s', async (_label, role, body, user, status) => {
    repoMocks.getRole.mockResolvedValue(role);
    repoMocks.findAdminUserByTenantAndId.mockResolvedValue(user);
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admin-roles/role_support/assignments',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE,
          'x-test-hierarchy-level': '50',
        },
        body: JSON.stringify(body),
      },
      env
    );

    expect(response.status).toBe(status);
    expect(repoMocks.assignRole).not.toHaveBeenCalled();
  });

  it.each([
    ['missing role', null, null, {}, 404],
    [
      'assignment for another role',
      { id: 'role_support', tenant_id: 'tenant_123' },
      { id: 'assignment_1', admin_role_id: 'other', admin_user_id: 'admin_2' },
      {},
      404,
    ],
    [
      'foreign tenant scope',
      { id: 'role_support', tenant_id: 'tenant_123' },
      {
        id: 'assignment_1',
        admin_role_id: 'role_support',
        admin_user_id: 'admin_2',
        scope_type: 'tenant',
        scope_id: 'tenant_123',
      },
      { scope_id: 'other' },
      400,
    ],
    [
      'global escalation',
      { id: 'role_support', tenant_id: 'tenant_123' },
      {
        id: 'assignment_1',
        admin_role_id: 'role_support',
        admin_user_id: 'admin_2',
        scope_type: 'tenant',
        scope_id: 'tenant_123',
      },
      { scope_type: 'global' },
      403,
    ],
    [
      'invalid expiry',
      { id: 'role_support', tenant_id: 'tenant_123' },
      {
        id: 'assignment_1',
        admin_role_id: 'role_support',
        admin_user_id: 'admin_2',
        scope_type: 'tenant',
        scope_id: 'tenant_123',
      },
      { expires_at: -1 },
      400,
    ],
  ])('should reject assignment update for %s', async (_label, role, assignment, body, status) => {
    repoMocks.getRole.mockResolvedValue(role);
    repoMocks.getAssignment.mockResolvedValue(assignment);
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admin-roles/role_support/assignments/assignment_1',
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE,
        },
        body: JSON.stringify(body),
      },
      env
    );

    expect(response.status).toBe(status);
    expect(repoMocks.updateAssignment).not.toHaveBeenCalled();
  });

  it('should reject an assignment update that duplicates another scope binding', async () => {
    repoMocks.getRole.mockResolvedValue({ id: 'role_support', tenant_id: 'tenant_123' });
    repoMocks.getAssignment.mockResolvedValue({
      id: 'assignment_1',
      admin_role_id: 'role_support',
      admin_user_id: 'admin_2',
      scope_type: 'tenant',
      scope_id: 'tenant_123',
    });
    repoMocks.assignmentExists.mockResolvedValue(true);
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admin-roles/role_support/assignments/assignment_1',
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE,
        },
        body: JSON.stringify({ expires_at: null }),
      },
      env
    );

    expect(response.status).toBe(409);
    expect(repoMocks.updateAssignment).not.toHaveBeenCalled();
  });

  it('should pass the explicit expired-assignment flag to the tenant-scoped repository', async () => {
    repoMocks.getRole.mockResolvedValue({
      id: 'role_support',
      tenant_id: 'tenant_123',
      is_system: false,
    });
    repoMocks.getAssignmentsByRole.mockResolvedValue([]);
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admin-roles/role_support/assignments?include_expired=true',
      {},
      env
    );

    expect(response.status).toBe(200);
    expect(repoMocks.getAssignmentsByRole).toHaveBeenCalledWith('role_support', true);
  });

  it('should report a concurrently removed assignment instead of claiming an update', async () => {
    repoMocks.getRole.mockResolvedValue({ id: 'role_support', tenant_id: 'tenant_123' });
    repoMocks.getAssignment.mockResolvedValue({
      id: 'assignment_1',
      admin_role_id: 'role_support',
      admin_user_id: 'admin_2',
      scope_type: 'tenant',
      scope_id: 'tenant_123',
    });
    repoMocks.assignmentExists.mockResolvedValue(false);
    repoMocks.updateAssignment.mockResolvedValue(null);
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admin-roles/role_support/assignments/assignment_1',
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE,
        },
        body: JSON.stringify({ expires_at: null }),
      },
      env
    );

    expect(response.status).toBe(404);
    expect(repoMocks.createAuditLog).not.toHaveBeenCalled();
  });

  it('should map repository-protected role deletion to insufficient permissions', async () => {
    repoMocks.getRole.mockResolvedValue({
      id: 'role_protected',
      tenant_id: 'tenant_123',
      is_system: false,
      role_type: 'custom',
      name: 'protected',
    });
    repoMocks.getUsersByRole.mockResolvedValue([]);
    repoMocks.deleteRole.mockRejectedValue(new Error('Cannot delete protected role'));
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admin-roles/role_protected',
      { method: 'DELETE', headers: { 'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE } },
      env
    );

    expect(response.status).toBe(403);
    expect(repoMocks.createAuditLog).not.toHaveBeenCalled();
  });
});
