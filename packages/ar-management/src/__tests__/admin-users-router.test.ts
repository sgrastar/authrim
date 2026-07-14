import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from '@authrim/ar-lib-core';

const { repoMocks, mockAdminAdapter } = vi.hoisted(() => ({
  repoMocks: {
    findByTenantAndId: vi.fn(),
    findByEmail: vi.fn(),
    searchAdminUsers: vi.fn(),
    createAdminUser: vi.fn(),
    updateAdminUser: vi.fn(),
    suspendAccount: vi.fn(),
    activateAccount: vi.fn(),
    unlockAccount: vi.fn(),
    getRole: vi.fn(),
    assignRole: vi.fn(),
    assignmentExists: vi.fn(),
    getAssignment: vi.fn(),
    removeAssignment: vi.fn(),
    removeAssignmentById: vi.fn(),
    countByUser: vi.fn(),
    getPasskeysByUser: vi.fn(),
    getAssignmentsByUser: vi.fn(),
    getUsersByRole: vi.fn(),
    createAuditLog: vi.fn(),
  },
  mockAdminAdapter: {
    queryOne: vi.fn(),
  },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();

  class MockAdminUserRepository {
    findByTenantAndId = repoMocks.findByTenantAndId;
    findByEmail = repoMocks.findByEmail;
    createAdminUser = repoMocks.createAdminUser;
    updateAdminUser = repoMocks.updateAdminUser;
    suspendAccount = repoMocks.suspendAccount;
    activateAccount = repoMocks.activateAccount;
    unlockAccount = repoMocks.unlockAccount;
    searchAdminUsers = repoMocks.searchAdminUsers;
  }

  class MockAdminRoleRepository {
    getRole = repoMocks.getRole;
  }

  class MockAdminRoleAssignmentRepository {
    assignRole = repoMocks.assignRole;
    assignmentExists = repoMocks.assignmentExists;
    getAssignment = repoMocks.getAssignment;
    removeAssignment = repoMocks.removeAssignment;
    removeAssignmentById = repoMocks.removeAssignmentById;
    getAssignmentsByUser = repoMocks.getAssignmentsByUser;
    getUsersByRole = repoMocks.getUsersByRole;
  }

  class MockAdminPasskeyRepository {
    countByUser = repoMocks.countByUser;
    getPasskeysByUser = repoMocks.getPasskeysByUser;
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
    mockAdminAdapter.queryOne.mockResolvedValue({ count: 2 });
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

  it('should prevent deleting the last active platform admin account', async () => {
    repoMocks.findByTenantAndId.mockResolvedValue({
      id: 'admin_target',
      email: 'target@example.com',
    });
    mockAdminAdapter.queryOne
      .mockResolvedValueOnce({ id: 'assignment_super_admin' })
      .mockResolvedValueOnce({ id: 'role_super_admin' })
      .mockResolvedValueOnce({ count: 1 });

    const { app, env } = createTestApp();
    const response = await app.request(
      '/api/admin/admins/admin_target',
      {
        method: 'DELETE',
        headers: {
          'x-test-user-id': 'admin_1',
          'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_USERS_DELETE,
        },
      },
      env
    );
    const body = (await response.json()) as { error?: string; error_description?: string };

    expect(response.status).toBe(409);
    expect(body.error).toBe('last_platform_admin');
    expect(repoMocks.updateAdminUser).not.toHaveBeenCalled();
  });

  it('should prevent suspending the last active platform admin account', async () => {
    repoMocks.findByTenantAndId.mockResolvedValue({
      id: 'admin_target',
      email: 'target@example.com',
    });
    mockAdminAdapter.queryOne
      .mockResolvedValueOnce({ id: 'assignment_super_admin' })
      .mockResolvedValueOnce({ id: 'role_super_admin' })
      .mockResolvedValueOnce({ count: 1 });

    const { app, env } = createTestApp();
    const response = await app.request(
      '/api/admin/admins/admin_target/suspend',
      {
        method: 'POST',
        headers: {
          'x-test-user-id': 'admin_1',
          'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_USERS_WRITE,
        },
      },
      env
    );
    const body = (await response.json()) as { error?: string; error_description?: string };

    expect(response.status).toBe(409);
    expect(body.error).toBe('last_platform_admin');
    expect(repoMocks.suspendAccount).not.toHaveBeenCalled();
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

  it('should reject assigning a tenant-scoped role for another tenant', async () => {
    repoMocks.findByTenantAndId.mockResolvedValue({
      id: 'admin_target',
      email: 'target@example.com',
    });
    repoMocks.getRole.mockResolvedValue({
      id: 'role_support',
      tenant_id: 'tenant_123',
      is_system: false,
      hierarchy_level: 1,
      name: 'support',
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
        body: JSON.stringify({
          role_id: 'role_support',
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

  it('should prevent removing the last active platform admin role', async () => {
    repoMocks.findByTenantAndId.mockResolvedValue({
      id: 'admin_target',
      email: 'target@example.com',
    });
    repoMocks.getRole.mockResolvedValue({
      id: 'role_super_admin',
      name: 'super_admin',
    });
    mockAdminAdapter.queryOne.mockResolvedValue({ count: 1 });

    const { app, env } = createTestApp();
    const response = await app.request(
      '/api/admin/admins/admin_target/roles/role_super_admin',
      {
        method: 'DELETE',
        headers: {
          'x-test-user-id': 'admin_1',
          'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE,
        },
      },
      env
    );
    const body = (await response.json()) as { error?: string; error_description?: string };

    expect(response.status).toBe(409);
    expect(body.error).toBe('last_platform_admin');
    expect(body.error_description).toContain('At least one active platform administrator');
    expect(repoMocks.removeAssignment).not.toHaveBeenCalled();
  });

  it('lists only tenant-scoped users and strips password and TOTP secrets', async () => {
    repoMocks.searchAdminUsers.mockResolvedValue({
      items: [
        {
          id: 'admin_1',
          tenant_id: 'tenant_123',
          email: 'admin@example.com',
          password_hash: 'secret-hash',
          totp_secret_encrypted: 'secret-totp',
        },
      ],
      total: 1,
      page: 2,
      limit: 10,
      totalPages: 1,
    });
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admins?page=2&limit=10&status=active&email=admin%40example.com&mfa_enabled=false',
      {},
      env
    );
    const body = (await response.json()) as { items: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(repoMocks.searchAdminUsers).toHaveBeenCalledWith(
      {
        tenant_id: 'tenant_123',
        status: 'active',
        email: 'admin@example.com',
        mfa_enabled: false,
      },
      { page: 2, limit: 10, sortBy: 'created_at', sortOrder: 'desc' }
    );
    expect(body.items[0]).not.toHaveProperty('password_hash');
    expect(body.items[0]).not.toHaveProperty('totp_secret_encrypted');
  });

  it('caps list size and preserves an explicit MFA-enabled filter', async () => {
    repoMocks.searchAdminUsers.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      limit: 100,
      totalPages: 0,
    });
    const { app, env } = createTestApp();

    const response = await app.request('/api/admin/admins?limit=1000&mfa_enabled=true', {}, env);

    expect(response.status).toBe(200);
    expect(repoMocks.searchAdminUsers).toHaveBeenCalledWith(
      expect.objectContaining({ mfa_enabled: true }),
      expect.objectContaining({ limit: 100 })
    );
  });

  it('returns user details with roles and non-secret passkey metadata', async () => {
    repoMocks.findByTenantAndId.mockResolvedValue({
      id: 'admin_target',
      tenant_id: 'tenant_123',
      email: 'target@example.com',
      password_hash: 'secret-hash',
      totp_secret_encrypted: 'secret-totp',
    });
    repoMocks.getAssignmentsByUser.mockResolvedValue([
      {
        id: 'assignment_1',
        admin_role_id: 'role_1',
        role: { name: 'auditor', display_name: 'Auditor' },
        scope_type: 'tenant',
        scope_id: 'tenant_123',
        created_at: 10,
        expires_at: null,
        assigned_by: 'admin_1',
      },
    ]);
    repoMocks.getPasskeysByUser.mockResolvedValue([
      {
        id: 'passkey_1',
        device_name: 'Security key',
        aaguid: 'unknown-aaguid',
        public_key: 'must-not-leak',
        created_at: 20,
        last_used_at: null,
      },
    ]);
    const { app, env } = createTestApp();

    const response = await app.request('/api/admin/admins/admin_target', {}, env);
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty('password_hash');
    expect(body.roles[0]).toMatchObject({ role_id: 'role_1', name: 'auditor' });
    expect(body.passkeys[0]).not.toHaveProperty('public_key');
    expect(body.passkey_count).toBe(1);
  });

  it.each([
    ['POST', '/api/admin/admins', ADMIN_PERMISSIONS.ADMIN_USERS_READ],
    ['PATCH', '/api/admin/admins/admin_target', ADMIN_PERMISSIONS.ADMIN_USERS_READ],
    ['POST', '/api/admin/admins/admin_target/suspend', ADMIN_PERMISSIONS.ADMIN_USERS_READ],
    ['POST', '/api/admin/admins/admin_target/activate', ADMIN_PERMISSIONS.ADMIN_USERS_READ],
    ['POST', '/api/admin/admins/admin_target/unlock', ADMIN_PERMISSIONS.ADMIN_USERS_READ],
    ['DELETE', '/api/admin/admins/admin_target', ADMIN_PERMISSIONS.ADMIN_USERS_WRITE],
    ['POST', '/api/admin/admins/admin_target/roles', ADMIN_PERMISSIONS.ADMIN_USERS_WRITE],
    [
      'DELETE',
      '/api/admin/admins/admin_target/role-assignments/assignment_1',
      ADMIN_PERMISSIONS.ADMIN_USERS_WRITE,
    ],
  ])('rejects %s %s without its dedicated permission', async (method, path, permission) => {
    const { app, env } = createTestApp();
    const response = await app.request(
      path,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-test-permissions': permission,
        },
        body: method === 'POST' || method === 'PATCH' ? '{}' : undefined,
      },
      env
    );

    expect(response.status).toBe(403);
  });

  it('creates a normalized tenant admin and records an audit event', async () => {
    repoMocks.findByEmail.mockResolvedValue(null);
    repoMocks.createAdminUser.mockImplementation(async (input) => ({
      id: 'admin_new',
      ...input,
      password_hash: input.password,
      totp_secret_encrypted: null,
    }));
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admins',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_USERS_WRITE,
        },
        body: JSON.stringify({
          email: 'NEW@EXAMPLE.COM',
          name: 'New Admin',
          password: 'a long test password',
          mfa_enabled: true,
        }),
      },
      env
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(repoMocks.createAdminUser).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant_123',
        email: 'new@example.com',
        created_by: 'admin_1',
        password: expect.stringMatching(/^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/),
      })
    );
    expect(body).not.toHaveProperty('password_hash');
    expect(repoMocks.createAuditLog).toHaveBeenCalled();
  });

  it.each([
    ['missing email', {}, 400],
    ['duplicate email', { email: 'exists@example.com' }, 409],
  ])('rejects admin creation with %s', async (_label, requestBody, expectedStatus) => {
    repoMocks.findByEmail.mockResolvedValue({ id: 'existing' });
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admins',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_USERS_WRITE,
        },
        body: JSON.stringify(requestBody),
      },
      env
    );

    expect(response.status).toBe(expectedStatus);
    expect(repoMocks.createAdminUser).not.toHaveBeenCalled();
  });

  it('updates the caller account and normalizes its email', async () => {
    repoMocks.findByTenantAndId.mockResolvedValue({ id: 'admin_1', email: 'old@example.com' });
    repoMocks.updateAdminUser.mockResolvedValue({
      id: 'admin_1',
      email: 'new@example.com',
      password_hash: 'secret',
    });
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admins/admin_1',
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_USERS_WRITE,
        },
        body: JSON.stringify({ email: 'NEW@EXAMPLE.COM', name: 'Updated' }),
      },
      env
    );

    expect(response.status).toBe(200);
    expect(repoMocks.updateAdminUser).toHaveBeenCalledWith(
      'admin_1',
      expect.objectContaining({ email: 'new@example.com', name: 'Updated' })
    );
    expect(repoMocks.createAuditLog).toHaveBeenCalled();
  });

  it.each([
    ['activate', 'activateAccount', 'admin_user.activate'],
    ['unlock', 'unlockAccount', 'admin_user.unlock'],
  ])(
    'performs %s only for a user in the current tenant',
    async (action, repoMethod, auditAction) => {
      repoMocks.findByTenantAndId.mockResolvedValue({
        id: 'admin_target',
        email: 'target@example.com',
      });
      const { app, env } = createTestApp();

      const response = await app.request(
        `/api/admin/admins/admin_target/${action}`,
        {
          method: 'POST',
          headers: { 'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_USERS_WRITE },
        },
        env
      );

      expect(response.status).toBe(200);
      expect(repoMocks[repoMethod as 'activateAccount']).toHaveBeenCalledWith('admin_target');
      expect(repoMocks.createAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: auditAction })
      );
    }
  );

  it('deletes a non-platform admin and leaves audit evidence', async () => {
    repoMocks.findByTenantAndId.mockResolvedValue({
      id: 'admin_target',
      email: 'target@example.com',
    });
    mockAdminAdapter.queryOne.mockResolvedValue(null);
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admins/admin_target',
      {
        method: 'DELETE',
        headers: {
          'x-test-user-id': 'admin_actor',
          'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_USERS_DELETE,
        },
      },
      env
    );

    expect(response.status).toBe(200);
    expect(repoMocks.updateAdminUser).toHaveBeenCalledWith('admin_target', { is_active: false });
    expect(repoMocks.createAuditLog).toHaveBeenCalled();
  });

  it('assigns a lower tenant role once and records its normalized scope', async () => {
    repoMocks.findByTenantAndId.mockResolvedValue({ id: 'admin_target' });
    repoMocks.getRole.mockResolvedValue({
      id: 'role_support',
      tenant_id: 'tenant_123',
      is_system: false,
      hierarchy_level: 5,
      name: 'support',
    });
    repoMocks.assignmentExists.mockResolvedValue(false);
    repoMocks.assignRole.mockResolvedValue({ id: 'assignment_1' });
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admins/admin_target/roles',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-user-id': 'admin_actor',
          'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE,
          'x-test-hierarchy-level': '10',
        },
        body: JSON.stringify({ role_id: 'role_support', expires_at: Date.now() + 60_000 }),
      },
      env
    );

    expect(response.status).toBe(201);
    expect(repoMocks.assignRole).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant_123',
        admin_user_id: 'admin_target',
        scope_type: 'tenant',
        scope_id: 'tenant_123',
        assigned_by: 'admin_actor',
      })
    );
  });

  it.each([
    ['reserved org scope', { role_id: 'role_support', scope_type: 'org' }, 400],
    ['invalid expiry', { role_id: 'role_support', expires_at: 0 }, 400],
    [
      'global scope without platform authority',
      { role_id: 'role_support', scope_type: 'global' },
      403,
    ],
  ])('rejects role assignment with %s', async (_label, requestBody, expectedStatus) => {
    repoMocks.findByTenantAndId.mockResolvedValue({ id: 'admin_target' });
    repoMocks.getRole.mockResolvedValue({
      id: 'role_support',
      tenant_id: 'tenant_123',
      is_system: false,
      hierarchy_level: 5,
      name: 'support',
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
        body: JSON.stringify(requestBody),
      },
      env
    );

    expect(response.status).toBe(expectedStatus);
    expect(repoMocks.assignRole).not.toHaveBeenCalled();
  });

  it('rejects a duplicate role assignment without writing another grant', async () => {
    repoMocks.findByTenantAndId.mockResolvedValue({ id: 'admin_target' });
    repoMocks.getRole.mockResolvedValue({
      id: 'role_support',
      tenant_id: 'tenant_123',
      is_system: false,
      hierarchy_level: 5,
      name: 'support',
    });
    repoMocks.assignmentExists.mockResolvedValue(true);
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
        body: JSON.stringify({ role_id: 'role_support' }),
      },
      env
    );

    expect(response.status).toBe(409);
    expect(repoMocks.assignRole).not.toHaveBeenCalled();
  });

  it('prevents self-suspension even with user-write permission', async () => {
    repoMocks.findByTenantAndId.mockResolvedValue({ id: 'admin_1' });
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admins/admin_1/suspend',
      {
        method: 'POST',
        headers: {
          'x-test-user-id': 'admin_1',
          'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_USERS_WRITE,
        },
      },
      env
    );

    expect(response.status).toBe(403);
    expect(repoMocks.suspendAccount).not.toHaveBeenCalled();
  });

  it('suspends a non-platform admin and records the state transition', async () => {
    repoMocks.findByTenantAndId.mockResolvedValue({ id: 'admin_target' });
    mockAdminAdapter.queryOne.mockResolvedValue(null);
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admins/admin_target/suspend',
      {
        method: 'POST',
        headers: {
          'x-test-user-id': 'admin_actor',
          'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_USERS_WRITE,
        },
      },
      env
    );

    expect(response.status).toBe(200);
    expect(repoMocks.suspendAccount).toHaveBeenCalledWith('admin_target');
    expect(repoMocks.createAuditLog).toHaveBeenCalled();
  });

  it.each(['activate', 'unlock'])(
    'does not %s an admin outside the current tenant',
    async (action) => {
      repoMocks.findByTenantAndId.mockResolvedValue(null);
      const { app, env } = createTestApp();

      const response = await app.request(
        `/api/admin/admins/admin_target/${action}`,
        {
          method: 'POST',
          headers: { 'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_USERS_WRITE },
        },
        env
      );

      expect(response.status).toBe(404);
    }
  );

  it('allows a platform-authorized caller to assign a shared system role globally', async () => {
    repoMocks.findByTenantAndId.mockResolvedValue({ id: 'admin_target' });
    repoMocks.getRole.mockResolvedValue({
      id: 'role_system',
      tenant_id: 'default',
      is_system: true,
      hierarchy_level: 100,
      name: 'system-auditor',
    });
    repoMocks.assignmentExists.mockResolvedValue(false);
    repoMocks.assignRole.mockResolvedValue({ id: 'assignment_global' });
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admins/admin_target/roles',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-permissions': '*',
        },
        body: JSON.stringify({ role_id: 'role_system', scope_type: 'global' }),
      },
      env
    );

    expect(response.status).toBe(201);
    expect(repoMocks.assignRole).toHaveBeenCalledWith(
      expect.objectContaining({ scope_type: 'global', scope_id: undefined })
    );
  });

  it.each([
    ['missing user', null, { id: 'role_support' }, { role_id: 'role_support' }, 404],
    ['missing role id', { id: 'admin_target' }, null, {}, 400],
    ['unknown role', { id: 'admin_target' }, null, { role_id: 'missing' }, 404],
    [
      'non-finite expiry',
      { id: 'admin_target' },
      {
        id: 'role_support',
        tenant_id: 'tenant_123',
        is_system: false,
        hierarchy_level: 1,
      },
      { role_id: 'role_support', expires_at: 'tomorrow' },
      400,
    ],
  ])('rejects role assignment for %s', async (_label, user, role, body, expectedStatus) => {
    repoMocks.findByTenantAndId.mockResolvedValue(user);
    repoMocks.getRole.mockResolvedValue(role);
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admins/admin_target/roles',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE,
        },
        body: JSON.stringify(body),
      },
      env
    );

    expect(response.status).toBe(expectedStatus);
    expect(repoMocks.assignRole).not.toHaveBeenCalled();
  });

  it('removes a specific non-platform role assignment only from its owning user', async () => {
    repoMocks.findByTenantAndId.mockResolvedValue({ id: 'admin_target' });
    repoMocks.getAssignment.mockResolvedValue({
      id: 'assignment_1',
      admin_user_id: 'admin_target',
      admin_role_id: 'role_support',
      scope_type: 'tenant',
      scope_id: 'tenant_123',
    });
    repoMocks.getRole.mockResolvedValue({ id: 'role_support', name: 'support' });
    repoMocks.removeAssignmentById.mockResolvedValue(true);
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admins/admin_target/role-assignments/assignment_1',
      {
        method: 'DELETE',
        headers: { 'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE },
      },
      env
    );

    expect(response.status).toBe(200);
    expect(repoMocks.removeAssignmentById).toHaveBeenCalledWith('assignment_1');
    expect(repoMocks.createAuditLog).toHaveBeenCalled();
  });

  it.each([
    ['unknown assignment', null],
    [
      'assignment owned by another admin',
      { id: 'assignment_1', admin_user_id: 'admin_other', admin_role_id: 'role_support' },
    ],
  ])('does not remove an %s', async (_label, assignment) => {
    repoMocks.findByTenantAndId.mockResolvedValue({ id: 'admin_target' });
    repoMocks.getAssignment.mockResolvedValue(assignment);
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admins/admin_target/role-assignments/assignment_1',
      {
        method: 'DELETE',
        headers: { 'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE },
      },
      env
    );

    expect(response.status).toBe(404);
    expect(repoMocks.removeAssignmentById).not.toHaveBeenCalled();
  });

  it('prevents removing the caller platform role by assignment id even with redundancy', async () => {
    repoMocks.findByTenantAndId.mockResolvedValue({ id: 'admin_1' });
    repoMocks.getAssignment.mockResolvedValue({
      id: 'assignment_1',
      admin_user_id: 'admin_1',
      admin_role_id: 'role_super_admin',
    });
    repoMocks.getRole.mockResolvedValue({ id: 'role_super_admin', name: 'super_admin' });
    mockAdminAdapter.queryOne.mockResolvedValue({ count: 2 });
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admins/admin_1/role-assignments/assignment_1',
      {
        method: 'DELETE',
        headers: {
          'x-test-user-id': 'admin_1',
          'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE,
        },
      },
      env
    );

    expect(response.status).toBe(403);
    expect(repoMocks.removeAssignmentById).not.toHaveBeenCalled();
  });

  it('removes a normal role by role id and audits it', async () => {
    repoMocks.findByTenantAndId.mockResolvedValue({ id: 'admin_target' });
    repoMocks.getRole.mockResolvedValue({ id: 'role_support', name: 'support' });
    repoMocks.removeAssignment.mockResolvedValue(true);
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admins/admin_target/roles/role_support',
      {
        method: 'DELETE',
        headers: { 'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE },
      },
      env
    );

    expect(response.status).toBe(200);
    expect(repoMocks.removeAssignment).toHaveBeenCalledWith('admin_target', 'role_support');
    expect(repoMocks.createAuditLog).toHaveBeenCalled();
  });

  it('returns not found when a role removal did not delete an assignment', async () => {
    repoMocks.findByTenantAndId.mockResolvedValue({ id: 'admin_target' });
    repoMocks.getRole.mockResolvedValue({ id: 'role_support', name: 'support' });
    repoMocks.removeAssignment.mockResolvedValue(false);
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admins/admin_target/roles/role_support',
      {
        method: 'DELETE',
        headers: { 'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE },
      },
      env
    );

    expect(response.status).toBe(404);
  });

  it('returns not found without exposing another tenant user detail', async () => {
    repoMocks.findByTenantAndId.mockResolvedValue(null);
    const { app, env } = createTestApp();

    const response = await app.request('/api/admin/admins/admin_foreign', {}, env);

    expect(response.status).toBe(404);
    expect(repoMocks.getAssignmentsByUser).not.toHaveBeenCalled();
    expect(repoMocks.getPasskeysByUser).not.toHaveBeenCalled();
  });

  it.each([
    ['missing target', null, { id: 'unused' }],
    ['concurrently removed target', { id: 'admin_1' }, null],
  ])('returns not found when updating a %s', async (_label, existing, updated) => {
    repoMocks.findByTenantAndId.mockResolvedValue(existing);
    repoMocks.updateAdminUser.mockResolvedValue(updated);
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admins/admin_1',
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_USERS_WRITE,
        },
        body: JSON.stringify({ name: 'Updated' }),
      },
      env
    );

    expect(response.status).toBe(404);
  });

  it('permits deleting one of multiple active platform admins', async () => {
    repoMocks.findByTenantAndId.mockResolvedValue({
      id: 'admin_target',
      email: 'target@example.com',
    });
    mockAdminAdapter.queryOne
      .mockResolvedValueOnce({ id: 'assignment_super_admin' })
      .mockResolvedValueOnce({ id: 'role_super_admin' })
      .mockResolvedValueOnce({ count: 2 });
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admins/admin_target',
      {
        method: 'DELETE',
        headers: {
          'x-test-user-id': 'admin_actor',
          'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_USERS_DELETE,
        },
      },
      env
    );

    expect(response.status).toBe(200);
    expect(repoMocks.updateAdminUser).toHaveBeenCalledWith('admin_target', { is_active: false });
  });

  it.each([
    ['missing role', null, true],
    ['already removed assignment', { id: 'role_support', name: 'support' }, false],
  ])('returns not found for a role assignment with %s', async (_label, role, removed) => {
    repoMocks.findByTenantAndId.mockResolvedValue({ id: 'admin_target' });
    repoMocks.getAssignment.mockResolvedValue({
      id: 'assignment_1',
      admin_user_id: 'admin_target',
      admin_role_id: 'role_support',
    });
    repoMocks.getRole.mockResolvedValue(role);
    repoMocks.removeAssignmentById.mockResolvedValue(removed);
    const { app, env } = createTestApp();

    const response = await app.request(
      '/api/admin/admins/admin_target/role-assignments/assignment_1',
      {
        method: 'DELETE',
        headers: { 'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE },
      },
      env
    );

    expect(response.status).toBe(404);
  });
});
