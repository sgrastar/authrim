import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  featureEnabled: vi.fn(),
  getDelegatorPermissions: vi.fn(),
  createGrantWithAudit: vi.fn(),
  createGrantWithPreauthorization: vi.fn(),
  grantConsentPair: vi.fn(),
  hasCurrentConsent: vi.fn(),
  listGrants: vi.fn(),
  getGrantRecord: vi.fn(),
  getGrant: vi.fn(),
  invalidateGrant: vi.fn(),
  updateGrant: vi.fn(),
  replaceSelfServiceAuthorization: vi.fn(),
  findPrincipalById: vi.fn(),
  getPrincipalPermissions: vi.fn(),
  getPrincipalTenantScopes: vi.fn(),
  queryOne: vi.fn(),
  getTaskSetVersion: vi.fn(),
  getScopePolicyVersion: vi.fn(),
}));

vi.mock('../agent-downscope-auth', () => ({
  isAgentMcpEnabled: mocks.featureEnabled,
}));

vi.mock('@authrim/ar-agent-access/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-agent-access/core')>();
  return {
    ...actual,
    PHASE_ONE_ADMIN_READ_PERMISSIONS: {
      users: 'admin:users:read',
      clients: 'admin:clients:read',
      audit: 'admin:admin_audit:read',
      settings: 'admin:agent_settings:read',
      grants: 'admin:agent_grants:read',
    },
    AdminAgentAccessRepository: class {
      getActiveDelegatorPermissions = mocks.getDelegatorPermissions;
      createGrantWithAudit = mocks.createGrantWithAudit;
      createGrantWithPreauthorization = mocks.createGrantWithPreauthorization;
      grantConsentPair = mocks.grantConsentPair;
      hasCurrentConsent = mocks.hasCurrentConsent;
      listGrants = mocks.listGrants;
      getGrantRecord = mocks.getGrantRecord;
      getGrant = mocks.getGrant;
      invalidateGrantAndQueueTokenRevocation = mocks.invalidateGrant;
      updateGrantAndQueueTokenRevocation = mocks.updateGrant;
      replaceSelfServiceAuthorization = mocks.replaceSelfServiceAuthorization;
    },
    AgentConfigurationRepository: class {
      getTaskSetVersion = mocks.getTaskSetVersion;
      getScopePolicyVersion = mocks.getScopePolicyVersion;
    },
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    adminAuthMiddleware: () => async (c: any, next: () => Promise<void>) => {
      c.set('adminAuth', {
        userId: 'admin-1',
        actorType: 'human',
        authMethod: 'session',
        roles: ['tenant_admin'],
        tenantId: 'tenant-a',
        permissions: (c.req.header('x-test-permissions') ?? '').split(',').filter(Boolean),
      });
      await next();
    },
    ensureDatabaseAdapter: () => ({ queryOne: mocks.queryOne }),
    createAuthContextFromHono: () => ({ coreAdapter: { queryOne: mocks.queryOne } }),
    requireDedicatedAdminDatabaseAdapter: () => ({}),
    AdminMachineAccessRepository: class {
      findPrincipalById = mocks.findPrincipalById;
      getPrincipalPermissions = mocks.getPrincipalPermissions;
      getPrincipalTenantScopes = mocks.getPrincipalTenantScopes;
    },
  };
});

import { agentGrantsRouter } from '../routes/admin-management/agent-grants';

function app() {
  const result = new Hono<{ Bindings: Env }>();
  result.route('/api/admin/agent-grants', agentGrantsRouter as any);
  return result;
}

function request(body: Record<string, unknown>, permissions = '*') {
  return app().request(
    '/api/admin/agent-grants',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-permissions': permissions },
      body: JSON.stringify(body),
    },
    { DB: {}, DB_ADMIN: {}, DEFAULT_TENANT_ID: 'default' } as Env
  );
}

const validBody = {
  client_id: 'mcp-client',
  delegator_id: 'admin-2',
  task_set_id: 'ats-1',
  task_set_version: 1,
  scope_policy_id: 'asp-1',
  scope_policy_version: 1,
  purpose: 'Test automation',
};

const activeTaskSet = {
  id: 'ats-1',
  status: 'active',
  version: {
    catalogVersion: 'catalog-v2',
    digest: 'task-digest',
    permissions: ['admin:users:read'],
    tools: [
      {
        toolId: 'admin.read.users.search',
        toolName: 'search_users',
        contractVersion: '1',
        schemaDigest: 'schema-digest',
        permissions: ['admin:users:read'],
        requiredScope: 'agent:read',
        riskLevel: 'low',
        requiresElevation: false,
      },
    ],
  },
};

const activeScopePolicy = {
  id: 'asp-1',
  status: 'active',
  definitionDigest: 'scope-digest',
  definition: {
    tenantIds: ['tenant-a'],
    environmentIds: [],
    domains: ['users'],
    resourceIds: [],
    selectors: [],
    allowedFields: [],
    piiMode: 'masked',
    maxPerCall: 10,
    maxPlanOperations: 5,
    maxBulkTenants: 1,
  },
};

describe('Agent Grant management router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.featureEnabled.mockResolvedValue(true);
    mocks.queryOne.mockResolvedValue({
      client_id: 'mcp-client',
      tenant_id: 'tenant-a',
      requestable_scopes: JSON.stringify(['agent:read', 'agent:execute']),
    });
    mocks.getDelegatorPermissions.mockResolvedValue(['admin:agent:use', 'admin:users:read']);
    mocks.createGrantWithAudit.mockResolvedValue(undefined);
    mocks.createGrantWithPreauthorization.mockResolvedValue(undefined);
    mocks.grantConsentPair.mockResolvedValue(undefined);
    mocks.hasCurrentConsent.mockResolvedValue(true);
    mocks.listGrants.mockResolvedValue({ grants: [], total: 0 });
    mocks.invalidateGrant.mockResolvedValue({ familyCount: 2, nextGeneration: 2 });
    mocks.updateGrant.mockResolvedValue({
      familyCount: 1,
      nextGeneration: 2,
      nextConsentVersion: 2,
    });
    mocks.replaceSelfServiceAuthorization.mockResolvedValue({ familyCount: 2 });
    mocks.getTaskSetVersion.mockResolvedValue(activeTaskSet);
    mocks.getScopePolicyVersion.mockResolvedValue(activeScopePolicy);
  });

  it('atomically creates a Mode B Grant with both preauthorization records', async () => {
    mocks.findPrincipalById.mockResolvedValue({
      id: 'amp-1',
      status: 'active',
      principalType: 'mcp_server',
    });
    mocks.getPrincipalPermissions.mockResolvedValue(['admin:users:read']);
    mocks.getPrincipalTenantScopes.mockResolvedValue([
      { scopeMode: 'allow', tenantId: 'tenant-a' },
    ]);
    const response = await request({
      ...validBody,
      machine_principal_id: 'amp-1',
      delegation_mode: 'admin_pre_authorized',
    });
    expect(response.status).toBe(201);
    expect(mocks.createGrantWithAudit).not.toHaveBeenCalled();
    expect(mocks.createGrantWithPreauthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        grant: expect.objectContaining({
          machinePrincipalId: 'amp-1',
          delegationMode: 'admin_pre_authorized',
        }),
        delegationConsent: expect.objectContaining({ type: 'delegation' }),
        oauthClientConsent: expect.objectContaining({ type: 'oauth_client' }),
        consentAudit: expect.objectContaining({
          action: 'agent.consent.granted',
          metadata: expect.objectContaining({ authorization_basis: 'admin_pre_authorized' }),
        }),
      })
    );
    await expect(response.json()).resolves.toMatchObject({ consent_required: false });
  });

  it('resolves a pinned Task Set and Scope Policy into the immutable Grant snapshot', async () => {
    const response = await request({
      client_id: 'mcp-client',
      delegator_id: 'admin-2',
      task_set_id: 'ats-1',
      task_set_version: 1,
      scope_policy_id: 'asp-1',
      scope_policy_version: 1,
      purpose: 'Pinned automation',
    });
    expect(response.status, await response.clone().text()).toBe(201);
    expect(mocks.createGrantWithAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        grant: expect.objectContaining({
          permissions: ['admin:users:read'],
          scopes: ['agent:read'],
          taskSetId: 'ats-1',
          taskSetVersion: 1,
          scopePolicyId: 'asp-1',
          scopePolicyVersion: 1,
          accessSnapshotHash: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
          resolvedScopeConstraints: expect.objectContaining({ domains: ['users'], maxPerPlan: 5 }),
        }),
      })
    );
  });

  it('rejects Mode B preauthorization without a Machine Principal', async () => {
    const response = await request({ ...validBody, delegation_mode: 'admin_pre_authorized' });
    expect(response.status).toBe(400);
    expect(mocks.createGrantWithPreauthorization).not.toHaveBeenCalled();
  });

  it('rejects the removed raw permission and scope Grant contract', async () => {
    const response = await request({
      client_id: 'mcp-client',
      delegator_id: 'admin-2',
      permissions: ['admin:users:read'],
      scopes: ['agent:read'],
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'AGENT_GRANT_INVALID_REQUEST' });
    expect(mocks.createGrantWithAudit).not.toHaveBeenCalled();
  });

  it('renews Mode B preauthorization only after all live boundaries pass', async () => {
    mocks.getGrantRecord.mockResolvedValue({
      grantId: 'grant-mode-b',
      tenantId: 'tenant-a',
      clientId: 'mcp-client',
      machinePrincipalId: 'amp-1',
      grantorId: 'admin-1',
      delegatorId: 'admin-2',
      permissions: ['admin:users:read'],
      scopes: ['agent:read'],
      resolvedScopeConstraints: { tenantIds: ['tenant-a'] },
      consentVersion: 2,
      generation: 2,
      status: 'active',
      delegationMode: 'admin_pre_authorized',
      taskSetId: 'ats-1',
      taskSetVersion: 1,
      scopePolicyId: 'asp-1',
      scopePolicyVersion: 1,
      resolvedTools: activeTaskSet.version.tools,
      accessSnapshotHash: 'a'.repeat(43),
      createdAt: 1,
      updatedAt: 2,
    });
    mocks.findPrincipalById.mockResolvedValue({
      id: 'amp-1',
      status: 'active',
      principalType: 'mcp_server',
    });
    mocks.getPrincipalPermissions.mockResolvedValue(['admin:users:read']);
    mocks.getPrincipalTenantScopes.mockResolvedValue([
      { scopeMode: 'allow', tenantId: 'tenant-a' },
    ]);
    const response = await app().request(
      '/api/admin/agent-grants/grant-mode-b/preauthorize',
      {
        method: 'POST',
        headers: { 'x-test-permissions': 'admin:agent_grants:write,admin:users:read' },
      },
      { DB: {}, DB_ADMIN: {}, DEFAULT_TENANT_ID: 'default' } as Env
    );
    expect(response.status).toBe(200);
    expect(mocks.grantConsentPair).toHaveBeenCalledWith(
      expect.objectContaining({
        delegation: expect.objectContaining({ type: 'delegation', consentVersion: 2 }),
        oauthClient: expect.objectContaining({ type: 'oauth_client', consentVersion: 2 }),
        audit: expect.objectContaining({
          metadata: expect.objectContaining({ authorization_basis: 'admin_pre_authorized' }),
        }),
      })
    );
  });

  it('creates an audited tenant-bound Grant from the authenticated grantor', async () => {
    const response = await request(validBody);
    expect(response.status).toBe(201);
    expect(mocks.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('tenant_id = ? AND client_id = ?'),
      ['tenant-a', 'mcp-client']
    );
    expect(mocks.createGrantWithAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        grant: expect.objectContaining({
          tenantId: 'tenant-a',
          grantorId: 'admin-1',
          delegatorId: 'admin-2',
          resolvedScopeConstraints: expect.objectContaining({ tenantIds: ['tenant-a'] }),
        }),
        audit: expect.objectContaining({ action: 'agent.grant.created' }),
      })
    );
  });

  it('fails closed when the Agent feature is disabled', async () => {
    mocks.featureEnabled.mockResolvedValue(false);
    const response = await request(validBody);
    expect(response.status).toBe(404);
    expect(mocks.queryOne).not.toHaveBeenCalled();
  });

  it('rejects a client not found under the compound tenant key', async () => {
    mocks.queryOne.mockResolvedValue(null);
    const response = await request(validBody);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'AGENT_GRANT_CLIENT_NOT_FOUND' });
  });

  it('rejects a client that is not registered for every requested Agent scope', async () => {
    mocks.queryOne.mockResolvedValue({
      client_id: 'mcp-client',
      tenant_id: 'tenant-a',
      requestable_scopes: JSON.stringify([]),
    });
    const response = await request(validBody);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'AGENT_GRANT_CLIENT_SCOPE_NOT_ALLOWED',
    });
    expect(mocks.createGrantWithAudit).not.toHaveBeenCalled();
  });

  it('rejects permissions above the grantor or delegator ceiling', async () => {
    const response = await request(validBody, 'admin:agent_grants:write');
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'AGENT_GRANT_PERMISSION_EXCEEDS_GRANTOR',
    });
    expect(mocks.createGrantWithAudit).not.toHaveBeenCalled();
  });

  it('rejects a Machine Principal with scope_mode=all', async () => {
    mocks.findPrincipalById.mockResolvedValue({
      id: 'amp-1',
      status: 'active',
      principalType: 'mcp_server',
    });
    mocks.getPrincipalPermissions.mockResolvedValue(['admin:users:read']);
    mocks.getPrincipalTenantScopes.mockResolvedValue([{ scopeMode: 'all', tenantId: null }]);
    const response = await request({ ...validBody, machine_principal_id: 'amp-1' });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'AGENT_GRANT_TENANT_BOUNDARY' });
  });

  it('lists only tenant-scoped grants with bounded pagination', async () => {
    const response = await app().request(
      '/api/admin/agent-grants?status=active&limit=500&offset=2',
      { headers: { 'x-test-permissions': 'admin:agent_grants:read' } },
      { DB_ADMIN: {}, DEFAULT_TENANT_ID: 'default' } as Env
    );
    expect(response.status).toBe(200);
    expect(mocks.listGrants).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', status: 'active', limit: 500, offset: 2 })
    );
    await expect(response.json()).resolves.toMatchObject({
      pagination: { total: 0, limit: 100, offset: 2 },
    });
  });

  it('returns only current catalog permissions within the live grantor and delegator ceilings', async () => {
    mocks.getDelegatorPermissions.mockResolvedValue([
      'admin:agent:use',
      'admin:users:read',
      'admin:clients:create',
    ]);
    const response = await app().request(
      '/api/admin/agent-grants/eligible-permissions?delegator_id=admin-2',
      {
        headers: {
          'x-test-permissions': 'admin:agent_grants:write,admin:users:read,admin:clients:create',
        },
      },
      { DB_ADMIN: {}, DEFAULT_TENANT_ID: 'default' } as Env
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      delegator_id: 'admin-2',
      principal_id: null,
      permissions: ['admin:clients:create', 'admin:users:read'],
    });
  });

  it('suspends a live Grant and synchronously records the revocation outbox', async () => {
    mocks.getGrant.mockResolvedValue({
      grantId: 'grant-1',
      tenantId: 'tenant-a',
      clientId: 'mcp-client',
      generation: 1,
      status: 'active',
    });
    const response = await app().request(
      '/api/admin/agent-grants/grant-1/suspend',
      { method: 'POST', headers: { 'x-test-permissions': 'admin:agent_grants:write' } },
      { DB_ADMIN: {}, DEFAULT_TENANT_ID: 'default' } as Env
    );
    expect(response.status).toBe(200);
    expect(mocks.invalidateGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        grantId: 'grant-1',
        status: 'suspended',
        expectedGeneration: 1,
      })
    );
  });

  it('revalidates all ceilings and invalidates prior consent when updating authorization', async () => {
    mocks.getGrantRecord.mockResolvedValue({
      grantId: 'grant-1',
      tenantId: 'tenant-a',
      clientId: 'mcp-client',
      grantorId: 'admin-1',
      delegatorId: 'admin-2',
      permissions: ['admin:users:read'],
      scopes: ['agent:read'],
      resolvedScopeConstraints: { tenantIds: ['tenant-a'] },
      consentVersion: 1,
      generation: 1,
      status: 'active',
      delegationMode: 'user_consent',
      taskSetId: 'ats-1',
      taskSetVersion: 1,
      scopePolicyId: 'asp-1',
      scopePolicyVersion: 1,
      resolvedTools: activeTaskSet.version.tools,
      accessSnapshotHash: 'a'.repeat(43),
      createdAt: 1,
      updatedAt: 1,
    });
    mocks.getDelegatorPermissions
      .mockResolvedValueOnce(['*'])
      .mockResolvedValueOnce(['admin:agent:use', 'admin:users:read']);
    const response = await app().request(
      '/api/admin/agent-grants/grant-1',
      {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'x-test-permissions': 'admin:agent_grants:write,admin:users:read',
        },
        body: JSON.stringify({ purpose: 'updated' }),
      },
      { DB: {}, DB_ADMIN: {}, DEFAULT_TENANT_ID: 'default' } as Env
    );
    expect(response.status).toBe(200);
    expect(mocks.updateGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedGeneration: 1,
        permissions: ['admin:users:read'],
        purpose: 'updated',
        audit: expect.objectContaining({ action: 'agent.grant.updated' }),
      })
    );
    await expect(response.json()).resolves.toMatchObject({
      generation: 2,
      consent_version: 2,
      consent_required: true,
    });
  });

  it('atomically replaces a system-managed connection when its owner changes scopes', async () => {
    mocks.getGrantRecord.mockResolvedValue({
      grantId: 'grant-self-service',
      tenantId: 'tenant-a',
      clientId: 'mcp-client',
      grantorId: 'admin-1',
      delegatorId: 'admin-1',
      permissions: ['admin:clients:read'],
      scopes: ['agent:read'],
      authorizationDetails: [{ type: 'authrim_admin_agent', max_subjects_per_call: 2 }],
      resolvedScopeConstraints: { tenantIds: ['tenant-a'], piiMode: 'masked', maxPerCall: 2 },
      consentVersion: 1,
      generation: 1,
      status: 'active',
      delegationMode: 'user_consent',
      taskSetId: 'system-task-1',
      taskSetVersion: 1,
      scopePolicyId: 'system-policy-1',
      scopePolicyVersion: 1,
      resolvedTools: activeTaskSet.version.tools,
      accessSnapshotHash: 'a'.repeat(43),
      purpose: 'interactive_self_service',
      managementMode: 'system_managed',
      expiresAt: Date.now() + 60_000,
      createdAt: 1,
      updatedAt: 1,
    });
    mocks.queryOne.mockResolvedValue({
      tenant_id: 'tenant-a',
      requestable_scopes: JSON.stringify(['agent:read', 'agent:user-data:read', 'agent:write']),
    });
    mocks.getDelegatorPermissions.mockResolvedValue(['*']);
    const response = await app().request(
      '/api/admin/agent-grants/grant-self-service/self-service-scopes',
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-test-permissions': '*',
        },
        body: JSON.stringify({ scopes: ['agent:read', 'agent:user-data:read'] }),
      },
      { DB: {}, DB_ADMIN: {}, DEFAULT_TENANT_ID: 'default' } as Env
    );
    expect(response.status).toBe(200);
    expect(mocks.replaceSelfServiceAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedGeneration: 1,
        grant: expect.objectContaining({
          managementMode: 'system_managed',
          generation: 2,
          consentVersion: 2,
          scopes: ['agent:read', 'agent:user-data:read'],
          authorizationDetails: [{ type: 'authrim_admin_agent', max_subjects_per_call: 2 }],
          resolvedScopeConstraints: expect.objectContaining({ maxPerCall: 2 }),
        }),
        grantAudit: expect.objectContaining({
          action: 'agent.grant.updated',
          metadata: expect.objectContaining({
            source: 'connected_agents_ui',
            max_subjects_per_call: 2,
          }),
        }),
      })
    );
    await expect(response.json()).resolves.toMatchObject({
      changed: true,
      token_families_pending_revocation: 2,
      grant: {
        id: 'grant-self-service',
        management_mode: 'system_managed',
        generation: 2,
        consent_version: 2,
      },
    });
  });

  it('does not let another Admin edit self-service connection consent', async () => {
    mocks.getGrantRecord.mockResolvedValue({
      grantId: 'grant-other-owner',
      tenantId: 'tenant-a',
      clientId: 'mcp-client',
      grantorId: 'admin-2',
      delegatorId: 'admin-2',
      permissions: [],
      scopes: ['agent:read'],
      resolvedScopeConstraints: { tenantIds: ['tenant-a'], piiMode: 'masked' },
      consentVersion: 1,
      generation: 1,
      status: 'active',
      delegationMode: 'user_consent',
      taskSetId: 'system-task-other',
      taskSetVersion: 1,
      scopePolicyId: 'system-policy-other',
      scopePolicyVersion: 1,
      resolvedTools: activeTaskSet.version.tools,
      accessSnapshotHash: 'a'.repeat(43),
      purpose: 'interactive_self_service',
      managementMode: 'system_managed',
      createdAt: 1,
      updatedAt: 1,
    });
    const response = await app().request(
      '/api/admin/agent-grants/grant-other-owner/self-service-scopes',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-test-permissions': '*' },
        body: JSON.stringify({ scopes: ['agent:read'] }),
      },
      { DB: {}, DB_ADMIN: {}, DEFAULT_TENANT_ID: 'default' } as Env
    );
    expect(response.status).toBe(403);
    expect(mocks.replaceSelfServiceAuthorization).not.toHaveBeenCalled();
  });
});
