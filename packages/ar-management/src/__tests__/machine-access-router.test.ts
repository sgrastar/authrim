import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const { mockRepo, mockWriteAdminAuditLog } = vi.hoisted(() => ({
  mockRepo: {
    listPrincipals: vi.fn(),
    findPrincipalById: vi.fn(),
    createPrincipal: vi.fn(),
    updatePrincipal: vi.fn(),
    createCredential: vi.fn(),
    findCredentialById: vi.fn(),
    updateCredential: vi.fn(),
    getPrincipalPermissions: vi.fn(),
    setPrincipalPermissions: vi.fn(),
    getPrincipalTenantScopes: vi.fn(),
    setPrincipalTenantScopes: vi.fn(),
    getCredentialPermissions: vi.fn(),
    getCredentialTenantScopes: vi.fn(),
    listCredentials: vi.fn(),
    setCredentialPermissions: vi.fn(),
    setCredentialTenantScopes: vi.fn(),
  },
  mockWriteAdminAuditLog: vi.fn(),
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
            .map((entry: string) => entry.trim())
            .filter(Boolean);
          const tenantScope = (c.req.header('X-Admin-Tenant-Scope') || 'tenant-a')
            .split(',')
            .map((entry: string) => entry.trim())
            .filter(Boolean);
          c.set('adminAuth', {
            userId: 'admin-1',
            authMethod: 'session',
            actorType: 'human',
            actorId: 'admin-1',
            roles: [],
            permissions,
            tenantId: 'tenant-a',
            tenantScope,
          });

          if (
            options?.requirePermissions?.some(
              (permission) => !actual.hasAdminPermission(permissions, permission)
            )
          ) {
            return c.json({ error: 'insufficient_permissions' }, 403);
          }

          return next();
        }
    ),
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => ({})),
    AdminMachineAccessRepository: vi.fn(function MockAdminMachineAccessRepository() {
      return mockRepo;
    }),
  };
});

vi.mock('../admin-shared', () => ({
  writeAdminAuditLog: mockWriteAdminAuditLog,
}));

import { machineAccessRouter } from '../routes/admin-management/machine-access';

const mockEnv = {} as Env;

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/admin/machine-access', machineAccessRouter);
  return app;
}

describe('machineAccessRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRepo.getPrincipalPermissions.mockResolvedValue(['admin:ai_grants:*']);
    mockRepo.getPrincipalTenantScopes.mockResolvedValue([{ scopeMode: 'all', tenantId: null }]);
    mockRepo.getCredentialPermissions.mockResolvedValue(['admin:ai_grants:*']);
    mockRepo.getCredentialTenantScopes.mockResolvedValue([{ scopeMode: 'all', tenantId: null }]);
    mockRepo.listCredentials.mockResolvedValue([]);
  });

  it('creates a machine principal with permissions and tenant scopes', async () => {
    mockRepo.createPrincipal.mockResolvedValue({
      id: 'amp_mcp',
      clientId: 'mcp-admin',
      displayName: 'MCP Admin',
      principalType: 'mcp_server',
      status: 'active',
      tokenTtlSeconds: 600,
    });
    mockRepo.findPrincipalById.mockResolvedValue({
      id: 'amp_mcp',
      clientId: 'mcp-admin',
      displayName: 'MCP Admin',
      principalType: 'mcp_server',
      status: 'active',
      tokenTtlSeconds: 600,
    });

    const res = await createApp().request(
      '/api/admin/machine-access/principals',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Permissions':
            'admin:machine_access:read,admin:machine_access:write,admin:ai_grants:*',
          'X-Admin-Tenant-Scope': '*',
        },
        body: JSON.stringify({
          client_id: 'mcp-admin',
          display_name: 'MCP Admin',
          principal_type: 'mcp_server',
          permissions: ['admin:ai_grants:*'],
          tenant_scopes: [{ scope_mode: 'all' }],
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(201);
    expect(mockRepo.createPrincipal).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'mcp-admin',
        principalType: 'mcp_server',
      })
    );
    expect(mockRepo.setPrincipalPermissions).toHaveBeenCalledWith(
      'amp_mcp',
      ['admin:ai_grants:*'],
      expect.objectContaining({ actorId: 'admin-1' })
    );
    expect(mockRepo.setPrincipalTenantScopes).toHaveBeenCalledWith(
      'amp_mcp',
      [{ scopeMode: 'all', tenantId: null }],
      expect.objectContaining({ actorId: 'admin-1' })
    );
    expect(mockWriteAdminAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'admin_machine_access.principal.created',
        resourceId: 'amp_mcp',
      })
    );
  });

  it('rejects writes without machine access write permission', async () => {
    const res = await createApp().request(
      '/api/admin/machine-access/principals',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Permissions': 'admin:machine_access:read',
        },
        body: JSON.stringify({
          client_id: 'mcp-admin',
          display_name: 'MCP Admin',
          principal_type: 'mcp_server',
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(403);
    expect(mockRepo.createPrincipal).not.toHaveBeenCalled();
  });

  it('filters machine principals outside the admin tenant scope', async () => {
    mockRepo.listPrincipals.mockResolvedValue([
      { id: 'amp_a', clientId: 'tenant-a-client', displayName: 'Tenant A' },
      { id: 'amp_b', clientId: 'tenant-b-client', displayName: 'Tenant B' },
    ]);
    mockRepo.findPrincipalById.mockImplementation(async (id: string) => ({
      id,
      clientId: `${id}-client`,
      displayName: id,
      principalType: 'automation',
      status: 'active',
      tokenTtlSeconds: 600,
    }));
    mockRepo.getPrincipalTenantScopes.mockImplementation(async (id: string) =>
      id === 'amp_a'
        ? [{ scopeMode: 'allow', tenantId: 'tenant-a' }]
        : [{ scopeMode: 'allow', tenantId: 'tenant-b' }]
    );

    const res = await createApp().request(
      '/api/admin/machine-access/principals',
      {
        headers: {
          'X-Admin-Permissions': 'admin:machine_access:read',
          'X-Admin-Tenant-Scope': 'tenant-a',
        },
      },
      mockEnv
    );
    const body = (await res.json()) as { items: Array<{ id: string }> };

    expect(res.status).toBe(200);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe('amp_a');
  });

  it('rejects granting machine permissions the admin actor does not have', async () => {
    const res = await createApp().request(
      '/api/admin/machine-access/principals',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Permissions': 'admin:machine_access:read,admin:machine_access:write',
          'X-Admin-Tenant-Scope': 'tenant-a',
        },
        body: JSON.stringify({
          client_id: 'automation-admin',
          display_name: 'Automation Admin',
          principal_type: 'automation',
          permissions: ['admin:clients:*'],
          tenant_scopes: [{ scope_mode: 'allow', tenant_id: 'tenant-a' }],
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(400);
    expect(mockRepo.createPrincipal).not.toHaveBeenCalled();
  });

  it('rejects all-tenant machine scopes from tenant-scoped admins', async () => {
    mockRepo.createPrincipal.mockResolvedValue({
      id: 'amp_mcp',
      clientId: 'mcp-admin',
      displayName: 'MCP Admin',
      principalType: 'mcp_server',
      status: 'active',
      tokenTtlSeconds: 600,
    });

    const res = await createApp().request(
      '/api/admin/machine-access/principals',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Permissions': 'admin:machine_access:read,admin:machine_access:write',
        },
        body: JSON.stringify({
          client_id: 'mcp-admin',
          display_name: 'MCP Admin',
          principal_type: 'mcp_server',
          permissions: ['admin:ai_grants:*'],
          tenant_scopes: [{ scope_mode: 'all' }],
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(400);
    expect(mockRepo.createPrincipal).not.toHaveBeenCalled();
  });

  it('rejects mutations for machine principals outside the admin tenant scope', async () => {
    mockRepo.findPrincipalById.mockResolvedValue({
      id: 'amp_other',
      clientId: 'other-admin',
      status: 'active',
    });
    mockRepo.getPrincipalTenantScopes.mockResolvedValue([
      { scopeMode: 'allow', tenantId: 'tenant-b' },
    ]);

    const res = await createApp().request(
      '/api/admin/machine-access/principals/amp_other/disable',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Permissions': 'admin:machine_access:*',
          'X-Admin-Tenant-Scope': 'tenant-a',
        },
        body: JSON.stringify({ reason: 'out of scope' }),
      },
      mockEnv
    );

    expect(res.status).toBe(404);
    expect(mockRepo.updatePrincipal).not.toHaveBeenCalled();
  });

  it('rejects credential public JWKs that contain private key material', async () => {
    mockRepo.findPrincipalById.mockResolvedValue({
      id: 'amp_mcp',
      clientId: 'mcp-admin',
      status: 'active',
    });

    const res = await createApp().request(
      '/api/admin/machine-access/principals/amp_mcp/credentials',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Permissions': 'admin:machine_access:*',
          'X-Admin-Tenant-Scope': '*',
        },
        body: JSON.stringify({
          kid: 'leaked-key',
          display_name: 'Leaked key',
          alg: 'ES256',
          public_jwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'secret' },
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(400);
    expect(mockRepo.createCredential).not.toHaveBeenCalled();
  });

  it('rotates credentials with an overlap window', async () => {
    mockRepo.findPrincipalById.mockResolvedValue({
      id: 'amp_mcp',
      clientId: 'mcp-admin',
      status: 'active',
    });
    mockRepo.findCredentialById.mockImplementation(async (id: string) => ({
      id,
      principalId: 'amp_mcp',
      kid: id === 'amk_old' ? 'old-kid' : 'new-kid',
      status: id === 'amk_old' ? 'rotating' : 'active',
    }));
    mockRepo.createCredential.mockResolvedValue({
      id: 'amk_new',
      principalId: 'amp_mcp',
      kid: 'new-kid',
      status: 'active',
    });

    const res = await createApp().request(
      '/api/admin/machine-access/principals/amp_mcp/credentials/amk_old/rotate',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Permissions': 'admin:machine_access:*',
          'X-Admin-Tenant-Scope': '*',
        },
        body: JSON.stringify({
          kid: 'new-kid',
          display_name: 'New key',
          alg: 'ES256',
          public_jwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
          overlap_seconds: 60,
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(201);
    expect(mockRepo.updateCredential).toHaveBeenCalledWith(
      'amk_old',
      expect.objectContaining({
        status: 'rotating',
        revokeReason: 'rotation_overlap',
      })
    );
    expect(mockRepo.createCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        principalId: 'amp_mcp',
        kid: 'new-kid',
      })
    );
    expect(mockRepo.setCredentialPermissions).toHaveBeenCalledWith(
      'amk_new',
      ['admin:ai_grants:*'],
      expect.objectContaining({ actorId: 'admin-1' })
    );
    expect(mockWriteAdminAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'admin_machine_access.credential.rotated',
        resourceId: 'amk_new',
        severity: 'warn',
      })
    );
  });

  it('emergency revokes credentials with critical audit severity', async () => {
    mockRepo.findCredentialById.mockResolvedValue({
      id: 'amk_mcp',
      principalId: 'amp_mcp',
      status: 'active',
    });
    mockRepo.updateCredential.mockResolvedValue({
      id: 'amk_mcp',
      principalId: 'amp_mcp',
      status: 'revoked',
    });

    const res = await createApp().request(
      '/api/admin/machine-access/principals/amp_mcp/credentials/amk_mcp/emergency-revoke',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Permissions': 'admin:machine_access:*',
          'X-Admin-Tenant-Scope': '*',
        },
        body: JSON.stringify({ reason: 'suspected compromise' }),
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    expect(mockRepo.updateCredential).toHaveBeenCalledWith(
      'amk_mcp',
      expect.objectContaining({
        status: 'revoked',
        revokeReason: 'suspected compromise',
      })
    );
    expect(mockWriteAdminAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'admin_machine_access.credential.emergency_revoked',
        severity: 'critical',
      })
    );
  });

  it('disables principals without deleting their audit history', async () => {
    mockRepo.findPrincipalById.mockResolvedValue({
      id: 'amp_mcp',
      clientId: 'mcp-admin',
      status: 'active',
    });
    mockRepo.updatePrincipal.mockResolvedValue({
      id: 'amp_mcp',
      clientId: 'mcp-admin',
      status: 'disabled',
    });

    const res = await createApp().request(
      '/api/admin/machine-access/principals/amp_mcp/disable',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Permissions': 'admin:machine_access:*',
          'X-Admin-Tenant-Scope': '*',
        },
        body: JSON.stringify({ reason: 'incident response' }),
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    expect(mockRepo.updatePrincipal).toHaveBeenCalledWith(
      'amp_mcp',
      expect.objectContaining({
        status: 'disabled',
      })
    );
    expect(mockWriteAdminAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'admin_machine_access.principal.disabled',
        severity: 'warn',
      })
    );
  });
});
