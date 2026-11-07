import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const { mockRepo, mockWriteAdminAuditLog, mockRequireAdminStepUp } = vi.hoisted(() => ({
  mockRequireAdminStepUp: vi.fn(),
  mockRepo: {
    listPrincipals: vi.fn(),
    findPrincipalById: vi.fn(),
    findPrincipalByClientId: vi.fn(),
    createPrincipal: vi.fn(),
    getPrincipalRevision: vi.fn(),
    getCredentialRevision: vi.fn(),
    createPrincipalWithGrant: vi.fn(),
    updatePrincipalWithGrant: vi.fn(),
    createCredentialWithGrant: vi.fn(),
    updateCredentialWithGrant: vi.fn(),
    rotateCredential: vi.fn(),
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

const stepUpParams = () =>
  (mockRequireAdminStepUp.mock.calls[0] as [unknown, { params: Record<string, unknown> }])[1]
    .params;

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
            // A global scope here stands for a global assignment that gives these permissions.
            globalPermissions: tenantScope.includes('*') ? permissions : [],
            tenantId: 'tenant-a',
            tenantScope,
          });
          c.set('tenantId', 'tenant-a');

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

vi.mock('../admin-step-up-gate', () => ({
  requireAdminStepUp: mockRequireAdminStepUp,
  refuseAdminFreshAuth: vi.fn(),
}));

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
    mockRequireAdminStepUp.mockReset();
    mockRequireAdminStepUp.mockResolvedValue(null);
    mockRepo.getPrincipalPermissions.mockResolvedValue(['admin:agent_grants:*']);
    mockRepo.getPrincipalTenantScopes.mockResolvedValue([{ scopeMode: 'all', tenantId: null }]);
    mockRepo.getCredentialPermissions.mockResolvedValue(['admin:agent_grants:*']);
    mockRepo.getCredentialTenantScopes.mockResolvedValue([{ scopeMode: 'all', tenantId: null }]);
    mockRepo.listCredentials.mockResolvedValue([]);
    mockRepo.getPrincipalRevision.mockResolvedValue('principal-revision');
    mockRepo.findPrincipalByClientId.mockResolvedValue(null);
    mockRepo.getCredentialRevision.mockResolvedValue('credential-revision');
  });

  it('creates a machine principal with permissions and tenant scopes', async () => {
    mockRepo.createPrincipalWithGrant.mockResolvedValue({
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
            'admin:machine_access:read,admin:machine_access:write,admin:agent_grants:*',
          'X-Admin-Tenant-Scope': '*',
        },
        body: JSON.stringify({
          client_id: 'mcp-admin',
          display_name: 'MCP Admin',
          principal_type: 'mcp_server',
          permissions: ['admin:agent_grants:*'],
          tenant_scopes: [{ scope_mode: 'all' }],
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(201);
    // The principal, its permissions and its tenant scopes are one write.
    expect(mockRepo.createPrincipalWithGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'mcp-admin',
        principalType: 'mcp_server',
      }),
      {
        permissions: ['admin:agent_grants:*'],
        tenantScopes: [{ scopeMode: 'all', tenantId: null }],
      },
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
          permissions: ['admin:agent_grants:*'],
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
    mockRepo.rotateCredential.mockResolvedValue({
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
          // Rotating hands the caller a key for the principal, so the caller holds what it holds.
          'X-Admin-Permissions': 'admin:machine_access:*,admin:agent_grants:*',
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
    // The old key's overlap, the new key and its rows are one write.
    expect(mockRepo.rotateCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        previousCredentialId: 'amk_old',
        previousUpdate: expect.objectContaining({
          status: 'rotating',
          revokeReason: 'rotation_overlap',
        }),
        next: expect.objectContaining({ principalId: 'amp_mcp', kid: 'new-kid' }),
        grant: expect.objectContaining({ permissions: ['admin:agent_grants:*'] }),
        actor: expect.objectContaining({ actorId: 'admin-1' }),
      })
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
      }),
      // What the revoke was decided on, checked inside the write.
      {
        principal: { id: 'amp_mcp', revision: 'principal-revision' },
        credential: { id: 'amk_mcp', revision: 'credential-revision' },
      }
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
      }),
      { principal: { id: 'amp_mcp', revision: 'principal-revision' } }
    );
    expect(mockWriteAdminAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'admin_machine_access.principal.disabled',
        severity: 'warn',
      })
    );
  });

  describe('step-up (machine.permission.grant)', () => {
    const refusal = () =>
      new Response(JSON.stringify({ error: 'step_up_required' }), { status: 403 });
    const headers = {
      'Content-Type': 'application/json',
      'X-Admin-Permissions':
        'admin:machine_access:*,admin:agent_grants:*,admin:step_up_exempt:tenant.delete',
      'X-Admin-Tenant-Scope': '*',
    };
    const send = (method: string, path: string, body: unknown) =>
      createApp().request(
        `/api/admin/machine-access${path}`,
        { method, headers, body: JSON.stringify(body) },
        mockEnv
      );
    const jwk = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' };

    beforeEach(() => {
      mockRepo.findPrincipalById.mockResolvedValue({
        id: 'amp_mcp',
        clientId: 'mcp-admin',
        principalType: 'mcp_server',
        status: 'active',
      });
      mockRepo.findCredentialById.mockImplementation(async (id: string) => ({
        id,
        principalId: 'amp_mcp',
        kid: 'old',
        status: id === 'amk_revoked' ? 'revoked' : 'active',
      }));
      mockRepo.createPrincipalWithGrant.mockResolvedValue({ id: 'amp_mcp' });
      mockRepo.updatePrincipalWithGrant.mockResolvedValue({ id: 'amp_mcp' });
      mockRepo.createCredentialWithGrant.mockResolvedValue({ id: 'amk_new' });
      mockRepo.updateCredentialWithGrant.mockResolvedValue({ id: 'amk_old' });
      mockRepo.rotateCredential.mockResolvedValue({ id: 'amk_new' });
    });

    it('principal create with permissions: refused without step-up, nothing written', async () => {
      mockRequireAdminStepUp.mockResolvedValue(refusal());
      const res = await send('POST', '/principals', {
        client_id: 'mcp-admin',
        display_name: 'MCP',
        principal_type: 'mcp_server',
        permissions: ['admin:agent_grants:*'],
        tenant_scopes: [{ scope_mode: 'all' }],
      });
      expect(res.status).toBe(403);
      expect(mockRepo.createPrincipalWithGrant).not.toHaveBeenCalled();
    });

    it('principal create: the descriptor carries the sorted grant, and a bad request skips the gate', async () => {
      const bad = await send('POST', '/principals', { client_id: 'x' });
      expect(bad.status).toBe(400);
      expect(mockRequireAdminStepUp).not.toHaveBeenCalled();

      const res = await send('POST', '/principals', {
        client_id: 'mcp-admin',
        display_name: 'MCP',
        principal_type: 'mcp_server',
        permissions: ['admin:machine_access:read', 'admin:agent_grants:*'],
        tenant_scopes: [{ scope_mode: 'allow', tenant_id: 'tenant-a' }],
      });
      expect(res.status).toBe(201);
      expect(mockRequireAdminStepUp).toHaveBeenCalledTimes(1);
      expect(mockRequireAdminStepUp.mock.calls[0][1]).toEqual({
        operation: 'machine.permission.grant',
        targetTenantId: 'tenant-a',
        targetIds: [],
        params: {
          kind: 'principal.create',
          client_id: 'mcp-admin',
          principal_type: 'mcp_server',
          permissions: ['admin:agent_grants:*', 'admin:machine_access:read'],
          tenant_scopes: ['allow:tenant-a'],
        },
      });
    });

    it('principal create without any permission is not gated', async () => {
      const res = await send('POST', '/principals', {
        client_id: 'mcp-admin',
        display_name: 'MCP',
        principal_type: 'mcp_server',
        tenant_scopes: [{ scope_mode: 'allow', tenant_id: 'tenant-a' }],
      });
      expect(res.status).toBe(201);
      expect(mockRequireAdminStepUp).not.toHaveBeenCalled();
    });

    it('principal PATCH: a changed permission set is gated, a rename is not', async () => {
      mockRequireAdminStepUp.mockResolvedValue(refusal());
      const refused = await send('PATCH', '/principals/amp_mcp', {
        permissions: ['admin:agent_grants:*', 'admin:step_up_exempt:tenant.delete'],
      });
      expect(refused.status).toBe(403);
      expect(mockRepo.updatePrincipalWithGrant).not.toHaveBeenCalled();
      expect(mockRequireAdminStepUp.mock.calls[0][1]).toEqual({
        operation: 'machine.permission.grant',
        targetTenantId: 'tenant-a',
        targetIds: ['amp_mcp'],
        params: {
          kind: 'principal.update',
          permissions: ['admin:agent_grants:*', 'admin:step_up_exempt:tenant.delete'],
        },
      });

      mockRequireAdminStepUp.mockReset();
      mockRequireAdminStepUp.mockResolvedValue(null);
      const same = await send('PATCH', '/principals/amp_mcp', {
        display_name: 'Renamed',
        permissions: ['admin:agent_grants:*'],
      });
      expect(same.status).toBe(200);
      expect(mockRequireAdminStepUp).not.toHaveBeenCalled();
    });

    it('credential create: gated, refused without step-up, validated first', async () => {
      const bad = await send('POST', '/principals/amp_mcp/credentials', { kid: 'k' });
      expect(bad.status).toBe(400);
      expect(mockRequireAdminStepUp).not.toHaveBeenCalled();

      mockRequireAdminStepUp.mockResolvedValue(refusal());
      const body = {
        kid: 'k1',
        display_name: 'Key',
        alg: 'ES256',
        public_jwk: jwk,
        permissions: ['admin:agent_grants:*'],
        tenant_scopes: [{ scope_mode: 'all' }],
      };
      const refused = await send('POST', '/principals/amp_mcp/credentials', body);
      expect(refused.status).toBe(403);
      expect(mockRepo.createCredentialWithGrant).not.toHaveBeenCalled();
      expect(mockRequireAdminStepUp.mock.calls[0][1]).toEqual({
        operation: 'machine.permission.grant',
        targetTenantId: 'tenant-a',
        targetIds: ['amp_mcp'],
        params: {
          kind: 'credential.create',
          kid: 'k1',
          alg: 'ES256',
          public_jwk_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
          not_before: null,
          expires_at: null,
          permissions: ['admin:agent_grants:*'],
          tenant_scopes: ['all'],
        },
      });
    });

    it('credential create: a different key or window changes the descriptor (digest is key-order independent)', async () => {
      const base = {
        kid: 'k1',
        display_name: 'Key',
        alg: 'ES256',
        tenant_scopes: [{ scope_mode: 'all' }],
      };
      const params = async (extra: Record<string, unknown>) => {
        mockRequireAdminStepUp.mockClear();
        await send('POST', '/principals/amp_mcp/credentials', { ...base, ...extra });
        return stepUpParams();
      };
      const first = await params({ public_jwk: jwk });
      const reordered = await params({ public_jwk: { y: 'y', x: 'x', crv: 'P-256', kty: 'EC' } });
      const other = await params({ public_jwk: { ...jwk, x: 'other' } });
      const windowed = await params({
        public_jwk: jwk,
        not_before: 1_700_000_000_000,
        expires_at: 1_800_000_000_000,
      });
      expect(reordered.public_jwk_sha256).toBe(first.public_jwk_sha256);
      expect(other.public_jwk_sha256).not.toBe(first.public_jwk_sha256);
      expect(windowed).toMatchObject({
        public_jwk_sha256: first.public_jwk_sha256,
        not_before: 1_700_000_000_000,
        expires_at: 1_800_000_000_000,
      });
    });

    it('credential PATCH: widening or reviving is gated; narrowing and revoking are not', async () => {
      const widen = await send('PATCH', '/principals/amp_mcp/credentials/amk_old', {
        permissions: ['admin:agent_grants:*', 'admin:machine_access:read'],
      });
      expect(widen.status).toBe(200);
      expect(mockRequireAdminStepUp).toHaveBeenCalledTimes(1);
      expect(mockRequireAdminStepUp.mock.calls[0][1]).toMatchObject({
        operation: 'machine.permission.grant',
        targetIds: ['amk_old'],
        params: {
          kind: 'credential.update',
          principal_id: 'amp_mcp',
          permissions: ['admin:agent_grants:*', 'admin:machine_access:read'],
        },
      });

      mockRequireAdminStepUp.mockClear();
      const revive = await send('PATCH', '/principals/amp_mcp/credentials/amk_revoked', {
        status: 'active',
      });
      expect(revive.status).toBe(200);
      expect(mockRequireAdminStepUp).toHaveBeenCalledTimes(1);

      mockRequireAdminStepUp.mockClear();
      const revoke = await send('PATCH', '/principals/amp_mcp/credentials/amk_old', {
        status: 'revoked',
      });
      expect(revoke.status).toBe(200);
      const narrow = await send('PATCH', '/principals/amp_mcp/credentials/amk_old', {
        permissions: ['admin:agent_grants:*'],
      });
      expect(narrow.status).toBe(200);
      expect(mockRequireAdminStepUp).not.toHaveBeenCalled();
    });

    it('credential PATCH widening is refused without step-up and nothing is written', async () => {
      mockRequireAdminStepUp.mockResolvedValue(refusal());
      const res = await send('PATCH', '/principals/amp_mcp/credentials/amk_old', {
        permissions: ['admin:step_up_exempt:tenant.delete'],
      });
      expect(res.status).toBe(403);
      expect(mockRepo.updateCredentialWithGrant).not.toHaveBeenCalled();
    });

    it('credential PATCH: adding the last-resort recovery permission to an inheriting key is gated', async () => {
      // An empty list inherits the principal's permissions, but no wildcard there carries this
      // exact-name-only permission: adding it widens the key and needs L2.
      mockRepo.getCredentialPermissions.mockResolvedValue([]);
      mockRequireAdminStepUp.mockResolvedValue(refusal());
      const res = await send('PATCH', '/principals/amp_mcp/credentials/amk_old', {
        permissions: ['admin:last_resort_recovery'],
      });
      expect(res.status).toBe(403);
      expect(mockRequireAdminStepUp).toHaveBeenCalledTimes(1);
      expect(mockRepo.updateCredentialWithGrant).not.toHaveBeenCalled();
    });

    it('credential PATCH: moving the window outward revives by time and is gated', async () => {
      mockRepo.findCredentialById.mockImplementation(async (id: string) => ({
        id,
        principalId: 'amp_mcp',
        kid: 'old',
        status: 'active',
        notBefore: 2_000_000_000_000,
        expiresAt: 2_100_000_000_000,
      }));
      mockRequireAdminStepUp.mockResolvedValue(refusal());
      const patch = (body: unknown) =>
        send('PATCH', '/principals/amp_mcp/credentials/amk_old', body);

      for (const body of [
        { not_before: 1_900_000_000_000 },
        { not_before: null },
        { expires_at: 2_200_000_000_000 },
        { expires_at: null },
      ]) {
        mockRequireAdminStepUp.mockClear();
        mockRepo.updateCredentialWithGrant.mockClear();
        expect((await patch(body)).status).toBe(403);
        expect(mockRepo.updateCredentialWithGrant).not.toHaveBeenCalled();
        expect(mockRequireAdminStepUp).toHaveBeenCalledTimes(1);
      }
      expect(stepUpParams()).toMatchObject({
        kind: 'credential.update',
        expires_at: null,
      });

      mockRequireAdminStepUp.mockReset();
      mockRequireAdminStepUp.mockResolvedValue(null);
      // Shortening the window (later start, earlier end) or leaving it as is stays ungated.
      expect((await patch({ not_before: 2_050_000_000_000 })).status).toBe(200);
      expect((await patch({ expires_at: 2_050_000_000_000 })).status).toBe(200);
      expect((await patch({ expires_at: 2_100_000_000_000 })).status).toBe(200);
      expect(mockRequireAdminStepUp).not.toHaveBeenCalled();
    });

    it('credential PATCH: the receipt binds the resulting window, so omitting a bound differs from lifting it', async () => {
      mockRepo.findCredentialById.mockImplementation(async (id: string) => ({
        id,
        principalId: 'amp_mcp',
        kid: 'old',
        status: 'active',
        notBefore: 2_000_000_000_000,
        expiresAt: 2_100_000_000_000,
      }));
      mockRequireAdminStepUp.mockResolvedValue(refusal());
      const paramsOf = async (body: unknown) => {
        mockRequireAdminStepUp.mockClear();
        await send('PATCH', '/principals/amp_mcp/credentials/amk_old', body);
        return stepUpParams();
      };

      const extendOnly = await paramsOf({ expires_at: 2_200_000_000_000 });
      const extendAndLift = await paramsOf({ expires_at: 2_200_000_000_000, not_before: null });
      expect(extendOnly).toMatchObject({
        not_before: 2_000_000_000_000,
        expires_at: 2_200_000_000_000,
      });
      expect(extendAndLift).toMatchObject({ not_before: null, expires_at: 2_200_000_000_000 });
    });

    it('credential PATCH: reviving binds the resulting window and grant, not only what widened', async () => {
      mockRepo.findCredentialById.mockImplementation(async (id: string) => ({
        id,
        principalId: 'amp_mcp',
        kid: 'old',
        status: 'revoked',
        notBefore: null,
        expiresAt: null,
      }));
      mockRequireAdminStepUp.mockResolvedValue(refusal());
      const paramsOf = async (body: unknown) => {
        mockRequireAdminStepUp.mockClear();
        await send('PATCH', '/principals/amp_mcp/credentials/amk_old', body);
        return stepUpParams();
      };

      const finite = await paramsOf({ status: 'active', expires_at: 2_200_000_000_000 });
      const open = await paramsOf({ status: 'active' });
      expect(finite).toMatchObject({
        status: 'active',
        not_before: null,
        expires_at: 2_200_000_000_000,
        permissions: ['admin:agent_grants:*'],
        tenant_scopes: ['all'],
      });
      expect(open.expires_at).toBeNull();
    });

    it('a kid the principal already uses is refused before the gate (create and rotate)', async () => {
      mockRepo.listCredentials.mockResolvedValue([{ id: 'amk_old', kid: 'taken' }]);
      const body = { kid: 'taken', display_name: 'Key', alg: 'ES256', public_jwk: jwk };

      expect((await send('POST', '/principals/amp_mcp/credentials', body)).status).toBe(409);
      expect(
        (await send('POST', '/principals/amp_mcp/credentials/amk_old/rotate', body)).status
      ).toBe(409);
      expect(mockRequireAdminStepUp).not.toHaveBeenCalled();
      expect(mockRepo.createCredentialWithGrant).not.toHaveBeenCalled();
      expect(mockRepo.rotateCredential).not.toHaveBeenCalled();
    });

    it('a client id already in use is refused before the gate', async () => {
      mockRepo.findPrincipalByClientId.mockResolvedValue({ id: 'amp_other' });
      const res = await send('POST', '/principals', {
        client_id: 'mcp-admin',
        display_name: 'MCP',
        principal_type: 'mcp_server',
        permissions: ['admin:agent_grants:*'],
        tenant_scopes: [{ scope_mode: 'all' }],
      });
      expect(res.status).toBe(409);
      expect(mockRequireAdminStepUp).not.toHaveBeenCalled();
      expect(mockRepo.createPrincipalWithGrant).not.toHaveBeenCalled();
    });

    it('rotate: the requested overlap is bound into the receipt', async () => {
      const body = { kid: 'new-kid', display_name: 'New key', alg: 'ES256', public_jwk: jwk };
      const paramsOf = async (extra: Record<string, unknown>) => {
        mockRequireAdminStepUp.mockClear();
        await send('POST', '/principals/amp_mcp/credentials/amk_old/rotate', { ...body, ...extra });
        return stepUpParams();
      };
      const short = await paramsOf({ overlap_seconds: 60 });
      const long = await paramsOf({ overlap_seconds: 7 * 24 * 60 * 60 });
      expect(short.overlap_seconds).toBe(60);
      expect(long.overlap_seconds).toBe(7 * 24 * 60 * 60);
    });

    it('enable: bringing a disabled principal back is gated, bound to what it holds', async () => {
      mockRepo.findPrincipalById.mockResolvedValue({
        id: 'amp_mcp',
        clientId: 'mcp-admin',
        principalType: 'mcp_server',
        status: 'disabled',
      });
      mockRequireAdminStepUp.mockResolvedValue(refusal());

      const refused = await send('POST', '/principals/amp_mcp/enable', {});
      expect(refused.status).toBe(403);
      expect(mockRepo.updatePrincipal).not.toHaveBeenCalled();
      expect(mockRequireAdminStepUp.mock.calls[0][1]).toEqual({
        operation: 'machine.permission.grant',
        targetTenantId: 'tenant-a',
        targetIds: ['amp_mcp'],
        params: {
          kind: 'principal.enable',
          permissions: ['admin:agent_grants:*'],
          tenant_scopes: [JSON.stringify({ scopeMode: 'all', tenantId: null })],
        },
      });

      mockRequireAdminStepUp.mockReset();
      mockRequireAdminStepUp.mockResolvedValue(null);
      mockRepo.updatePrincipal.mockResolvedValue({ id: 'amp_mcp', status: 'active' });
      expect((await send('POST', '/principals/amp_mcp/enable', {})).status).toBe(200);
      expect(mockRepo.updatePrincipal).toHaveBeenCalledTimes(1);
    });

    it('enable: an already active principal is not gated', async () => {
      mockRepo.updatePrincipal.mockResolvedValue({ id: 'amp_mcp', status: 'active' });
      expect((await send('POST', '/principals/amp_mcp/enable', {})).status).toBe(200);
      expect(mockRequireAdminStepUp).not.toHaveBeenCalled();
    });

    it('rotate: always gated (it registers a new key), bound to the key digest', async () => {
      const rotateBody = {
        kid: 'new-kid',
        display_name: 'New key',
        alg: 'ES256',
        public_jwk: jwk,
      };
      const same = await send('POST', '/principals/amp_mcp/credentials/amk_old/rotate', rotateBody);
      expect(same.status).toBe(201);
      expect(mockRequireAdminStepUp).toHaveBeenCalledTimes(1);
      const firstDigest = stepUpParams().public_jwk_sha256;
      expect(stepUpParams()).toMatchObject({
        kind: 'credential.rotate',
        kid: 'new-kid',
      });
      expect(firstDigest).toMatch(/^[0-9a-f]{64}$/);
      mockRequireAdminStepUp.mockClear();

      // A validation failure never reaches the gate.
      const invalid = await send('POST', '/principals/amp_mcp/credentials/amk_old/rotate', {
        ...rotateBody,
        public_jwk: undefined,
      });
      expect(invalid.status).toBe(400);
      expect(mockRequireAdminStepUp).not.toHaveBeenCalled();

      // The same request with only the key changed has a different descriptor.
      await send('POST', '/principals/amp_mcp/credentials/amk_old/rotate', {
        ...rotateBody,
        public_jwk: { ...jwk, x: 'other' },
      });
      expect(stepUpParams().public_jwk_sha256).not.toBe(firstDigest);

      mockRequireAdminStepUp.mockClear();
      mockRequireAdminStepUp.mockResolvedValue(refusal());
      mockRepo.rotateCredential.mockClear();
      const widened = await send('POST', '/principals/amp_mcp/credentials/amk_old/rotate', {
        ...rotateBody,
        permissions: ['admin:agent_grants:*', 'admin:step_up_exempt:tenant.delete'],
      });
      expect(widened.status).toBe(403);
      expect(mockRepo.rotateCredential).not.toHaveBeenCalled();
      expect(mockRequireAdminStepUp.mock.calls[0][1]).toMatchObject({
        operation: 'machine.permission.grant',
        targetIds: ['amk_old'],
        params: {
          kind: 'credential.rotate',
          principal_id: 'amp_mcp',
          permissions: ['admin:agent_grants:*', 'admin:step_up_exempt:tenant.delete'],
        },
      });
    });
  });
});
