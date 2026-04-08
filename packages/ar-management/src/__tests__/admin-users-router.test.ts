import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from '@authrim/ar-lib-core';

const repoMocks = vi.hoisted(() => ({
  findByTenantAndId: vi.fn(),
  findByEmail: vi.fn(),
  createAdminUser: vi.fn(),
  updateAdminUser: vi.fn(),
  suspendAccount: vi.fn(),
  activateAccount: vi.fn(),
  unlockAccount: vi.fn(),
  getRole: vi.fn(),
  assignRole: vi.fn(),
  removeAssignment: vi.fn(),
  countByUser: vi.fn(),
  getAssignmentsByUser: vi.fn(),
  getUsersByRole: vi.fn(),
  createAuditLog: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();

  class MockD1Adapter {
    constructor(_options: unknown) {}
  }

  class MockAdminUserRepository {
    findByTenantAndId = repoMocks.findByTenantAndId;
    findByEmail = repoMocks.findByEmail;
    createAdminUser = repoMocks.createAdminUser;
    updateAdminUser = repoMocks.updateAdminUser;
    suspendAccount = repoMocks.suspendAccount;
    activateAccount = repoMocks.activateAccount;
    unlockAccount = repoMocks.unlockAccount;
    searchAdminUsers = vi.fn();
  }

  class MockAdminRoleRepository {
    getRole = repoMocks.getRole;
  }

  class MockAdminRoleAssignmentRepository {
    assignRole = repoMocks.assignRole;
    removeAssignment = repoMocks.removeAssignment;
    getAssignmentsByUser = repoMocks.getAssignmentsByUser;
    getUsersByRole = repoMocks.getUsersByRole;
  }

  class MockAdminPasskeyRepository {
    countByUser = repoMocks.countByUser;
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
    AdminUserRepository: MockAdminUserRepository,
    AdminRoleRepository: MockAdminRoleRepository,
    AdminRoleAssignmentRepository: MockAdminRoleAssignmentRepository,
    AdminPasskeyRepository: MockAdminPasskeyRepository,
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
import { adminUsersRouter } from '../routes/admin-management/admins';

type ErrorResponseBody = {
  error_code?: string;
};

function createTestApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/admin/admins', adminUsersRouter);
  return {
    app,
    env: {
      DB_ADMIN: {} as D1Database,
    } as unknown as Env,
  };
}

describe('adminUsersRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should reject updates to another admin without wildcard authority', async () => {
    repoMocks.findByTenantAndId.mockResolvedValue({
      id: 'admin_target',
      email: 'target@example.com',
    });

    const { app, env } = createTestApp();
    const response = await app.request(
      '/api/admin/admins/admin_target',
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-test-user-id': 'admin_actor',
          'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_USERS_WRITE,
          'x-test-hierarchy-level': '10',
        },
        body: JSON.stringify({ name: 'Updated Name' }),
      },
      env
    );
    const body = (await response.json()) as ErrorResponseBody;

    expect(response.status).toBe(403);
    expect(body.error_code).toBe(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    expect(repoMocks.updateAdminUser).not.toHaveBeenCalled();
  });

  it('should prevent self-deletion', async () => {
    repoMocks.findByTenantAndId.mockResolvedValue({
      id: 'admin_1',
      email: 'self@example.com',
    });

    const { app, env } = createTestApp();
    const response = await app.request(
      '/api/admin/admins/admin_1',
      {
        method: 'DELETE',
        headers: {
          'x-test-user-id': 'admin_1',
          'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_USERS_DELETE,
        },
      },
      env
    );
    const body = (await response.json()) as ErrorResponseBody;

    expect(response.status).toBe(403);
    expect(body.error_code).toBe(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    expect(repoMocks.updateAdminUser).not.toHaveBeenCalled();
  });

  it('should reject assigning a role from another tenant', async () => {
    repoMocks.findByTenantAndId.mockResolvedValue({
      id: 'admin_target',
      email: 'target@example.com',
    });
    repoMocks.getRole.mockResolvedValue({
      id: 'role_foreign',
      tenant_id: 'tenant_other',
      is_system: false,
      hierarchy_level: 1,
      name: 'foreign-role',
    });

    const { app, env } = createTestApp();
    const response = await app.request(
      '/api/admin/admins/admin_target/roles',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE,
          'x-test-tenant-id': 'tenant_123',
          'x-test-hierarchy-level': '10',
        },
        body: JSON.stringify({ role_id: 'role_foreign' }),
      },
      env
    );
    const body = (await response.json()) as ErrorResponseBody;

    expect(response.status).toBe(404);
    expect(body.error_code).toBe(AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    expect(repoMocks.assignRole).not.toHaveBeenCalled();
  });

  it('should reject assigning a role at the caller hierarchy level', async () => {
    repoMocks.findByTenantAndId.mockResolvedValue({
      id: 'admin_target',
      email: 'target@example.com',
    });
    repoMocks.getRole.mockResolvedValue({
      id: 'role_same_level',
      tenant_id: 'tenant_123',
      is_system: false,
      hierarchy_level: 10,
      name: 'same-level-role',
    });

    const { app, env } = createTestApp();
    const response = await app.request(
      '/api/admin/admins/admin_target/roles',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE,
          'x-test-hierarchy-level': '10',
        },
        body: JSON.stringify({ role_id: 'role_same_level' }),
      },
      env
    );
    const body = (await response.json()) as ErrorResponseBody;

    expect(response.status).toBe(403);
    expect(body.error_code).toBe(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    expect(repoMocks.assignRole).not.toHaveBeenCalled();
  });

  it('should prevent removing the caller super_admin role', async () => {
    repoMocks.findByTenantAndId.mockResolvedValue({
      id: 'admin_1',
      email: 'self@example.com',
    });
    repoMocks.getRole.mockResolvedValue({
      id: 'role_super_admin',
      name: 'super_admin',
    });

    const { app, env } = createTestApp();
    const response = await app.request(
      '/api/admin/admins/admin_1/roles/role_super_admin',
      {
        method: 'DELETE',
        headers: {
          'x-test-user-id': 'admin_1',
          'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE,
        },
      },
      env
    );
    const body = (await response.json()) as ErrorResponseBody;

    expect(response.status).toBe(403);
    expect(body.error_code).toBe(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    expect(repoMocks.removeAssignment).not.toHaveBeenCalled();
  });
});
