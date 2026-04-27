import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from '@authrim/ar-lib-core';

const policyRepoMocks = vi.hoisted(() => ({
  listPolicies: vi.fn(),
  getPolicy: vi.fn(),
  getPolicyByName: vi.fn(),
  createPolicy: vi.fn(),
  updatePolicy: vi.fn(),
  setActive: vi.fn(),
  deletePolicy: vi.fn(),
  getPoliciesForResource: vi.fn(),
  createAuditLog: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();

  type MockContext = {
    req: { header: (name: string) => string | undefined };
    set: (key: string, value: unknown) => void;
  };

  const mockAdminAdapter = {};

  class MockAdminPolicyRepository {
    listPolicies = policyRepoMocks.listPolicies;
    getPolicy = policyRepoMocks.getPolicy;
    getPolicyByName = policyRepoMocks.getPolicyByName;
    createPolicy = policyRepoMocks.createPolicy;
    updatePolicy = policyRepoMocks.updatePolicy;
    setActive = policyRepoMocks.setActive;
    deletePolicy = policyRepoMocks.deletePolicy;
    getPoliciesForResource = policyRepoMocks.getPoliciesForResource;
  }

  class MockAdminAuditLogRepository {
    createAuditLog = policyRepoMocks.createAuditLog;
  }

  return {
    ...actual,
    requireDedicatedAdminDatabaseAdapter: vi.fn().mockReturnValue(mockAdminAdapter),
    AdminPolicyRepository: MockAdminPolicyRepository,
    AdminAuditLogRepository: MockAdminAuditLogRepository,
    adminAuthMiddleware: () => {
      return async (c: MockContext, next: () => Promise<void>) => {
        c.set('adminAuth', {
          userId: 'admin_1',
          email: 'admin@example.com',
          roles: (c.req.header('x-test-roles') ?? 'system_admin').split(',').filter(Boolean),
          permissions: (c.req.header('x-test-permissions') ?? '').split(',').filter(Boolean),
          org_id: c.req.header('x-test-org-id') ?? undefined,
        });
        c.set('tenantId', c.req.header('x-test-tenant-id') ?? 'tenant_123');
        await next();
      };
    },
    getTenantIdFromContext: vi.fn((c: { get: (key: string) => unknown }) => {
      return (c.get('tenantId') as string) ?? 'tenant_123';
    }),
    createErrorResponse: vi.fn((c: { json: (body: unknown, status?: number) => Response }) => {
      return c.json({ error: 'internal_error' }, 500);
    }),
  };
});

import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { adminPoliciesRouter } from '../routes/admin-management/admin-policies';

function createTestApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/admin', adminPoliciesRouter);
  return {
    app,
    env: {
      DB_ADMIN: {} as D1Database,
    } as unknown as Env,
  };
}

describe('adminPoliciesRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should list admin policies with pagination metadata', async () => {
    policyRepoMocks.listPolicies.mockResolvedValue({
      policies: [
        {
          id: 'policy_1',
          tenant_id: 'tenant_123',
          name: 'allow-users-read',
          effect: 'allow',
          priority: 100,
        },
      ],
      total: 1,
    });

    const { app, env } = createTestApp();
    const response = await app.request('/api/admin/admin-policies?limit=25&offset=5', {}, env);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(policyRepoMocks.listPolicies).toHaveBeenCalledWith('tenant_123', {
      activeOnly: false,
      resourcePattern: undefined,
      limit: 25,
      offset: 5,
    });
    expect(body).toEqual(
      expect.objectContaining({
        total: 1,
        limit: 25,
        offset: 5,
      })
    );
  });

  it('should hide policies from another tenant', async () => {
    policyRepoMocks.getPolicy.mockResolvedValue({
      id: 'policy_foreign',
      tenant_id: 'tenant_other',
      is_system: false,
    });

    const { app, env } = createTestApp();
    const response = await app.request('/api/admin/admin-policies/policy_foreign', {}, env);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual(
      expect.objectContaining({
        error: 'not_found',
      })
    );
  });

  it('should require write permission to create a policy', async () => {
    const { app, env } = createTestApp();
    const response = await app.request(
      '/api/admin/admin-policies',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-permissions': '',
        },
        body: JSON.stringify({
          name: 'deny-sensitive-write',
          resource_pattern: 'admin:*',
        }),
      },
      env
    );

    expect(response.status).toBe(403);
  });

  it('should reject duplicate policy names', async () => {
    policyRepoMocks.getPolicyByName.mockResolvedValue({
      id: 'policy_existing',
      tenant_id: 'tenant_123',
      name: 'deny-sensitive-write',
    });

    const { app, env } = createTestApp();
    const response = await app.request(
      '/api/admin/admin-policies',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-permissions': ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE,
        },
        body: JSON.stringify({
          name: 'deny-sensitive-write',
          resource_pattern: 'admin:*',
        }),
      },
      env
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual(
      expect.objectContaining({
        error: 'conflict',
      })
    );
  });

  it('should validate required fields for evaluate', async () => {
    const { app, env } = createTestApp();
    const response = await app.request(
      '/api/admin/admin-policies/evaluate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resource: 'admin:users' }),
      },
      env
    );

    expect(response.status).toBe(400);
  });

  it('should stop on deny during simulation', async () => {
    policyRepoMocks.getPoliciesForResource.mockResolvedValue([
      {
        id: 'policy_allow',
        name: 'allow-admin-read',
        effect: 'allow',
        priority: 100,
        conditions: {
          roles: ['admin'],
          condition_type: 'all',
        },
      },
      {
        id: 'policy_deny',
        name: 'deny-suspended-admins',
        effect: 'deny',
        priority: 200,
        conditions: {
          attributes: {
            account_status: {
              equals: 'suspended',
            },
          },
          condition_type: 'all',
        },
      },
    ]);

    const { app, env } = createTestApp();
    const response = await app.request(
      '/api/admin/admin-policies/simulate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resource: 'admin:users',
          action: 'read',
          admin_user_context: {
            roles: ['admin'],
            attributes: {
              account_status: 'suspended',
            },
          },
        }),
      },
      env
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(
      expect.objectContaining({
        decision: 'deny',
        total_policies_evaluated: 2,
      })
    );
  });
});
