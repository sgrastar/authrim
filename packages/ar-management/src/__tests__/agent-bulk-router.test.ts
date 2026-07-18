import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_PERMISSIONS, type AdminAuthContext, type Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  auth: {} as AdminAuthContext,
  create: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  listTenantExecutions: vi.fn(),
  transition: vi.fn(),
  startApproved: vi.fn(),
  cancel: vi.fn(),
  getGrant: vi.fn(),
  getActiveDelegatorPermissions: vi.fn(),
  query: vi.fn(),
  adminQuery: vi.fn(),
  findPrincipalById: vi.fn(),
  findCredentialById: vi.fn(),
  getPrincipalTenantScopes: vi.fn(),
  getCredentialTenantScopes: vi.fn(),
  getPrincipalPermissions: vi.fn(),
  getCredentialPermissions: vi.fn(),
}));

vi.mock('@authrim/ar-agent-access/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-agent-access/core')>();
  return {
    ...actual,
    AgentBulkRepository: class {
      create = mocks.create;
      get = mocks.get;
      list = mocks.list;
      listTenantExecutions = mocks.listTenantExecutions;
      transition = mocks.transition;
      startApproved = mocks.startApproved;
      cancel = mocks.cancel;
    },
    AdminAgentAccessRepository: class {
      getGrant = mocks.getGrant;
      getActiveDelegatorPermissions = mocks.getActiveDelegatorPermissions;
    },
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    adminAuthMiddleware:
      () =>
      async (
        c: { set(key: 'adminAuth', value: AdminAuthContext): void },
        next: () => Promise<void>
      ) => {
        c.set('adminAuth', mocks.auth);
        await next();
      },
    requireDedicatedAdminDatabaseAdapter: () => ({ query: mocks.adminQuery }),
    ensureDatabaseAdapter: () => ({ query: mocks.query }),
    AdminMachineAccessRepository: class {
      findPrincipalById = mocks.findPrincipalById;
      findCredentialById = mocks.findCredentialById;
      getPrincipalTenantScopes = mocks.getPrincipalTenantScopes;
      getCredentialTenantScopes = mocks.getCredentialTenantScopes;
      getPrincipalPermissions = mocks.getPrincipalPermissions;
      getCredentialPermissions = mocks.getCredentialPermissions;
    },
  };
});

import { agentBulkPlansRouter } from '../routes/admin-management/agent-bulk';

function app() {
  const result = new Hono<{ Bindings: Env }>();
  result.route('/api/admin/agent-bulk-plans', agentBulkPlansRouter as never);
  return result;
}

const env = { DB: {}, DB_ADMIN: {}, ENABLE_AGENT_MCP: 'true' } as unknown as Env;
const definition = {
  schemaVersion: 'authrim-agent-bulk-plan-v1',
  targetTenantIds: ['tenant-1', 'tenant-2'],
  canaryTenantIds: ['tenant-1'],
  plan: {
    schemaVersion: 'authrim-agent-plan-v1',
    steps: [
      {
        id: 'step-1',
        operation: 'admin.write.clients.metadata',
        toolContractVersion: '1',
        input: {
          client_id: 'client-1',
          client_name: 'Updated',
        },
        resourcePrecondition: 'per-tenant-validation',
      },
    ],
  },
};

describe('Agent Bulk Plan management routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth = {
      userId: 'admin-1',
      tenantId: 'platform',
      tenantScope: ['*'],
      roles: ['platform_admin'],
      authMethod: 'session',
      actorType: 'human',
      mfaVerified: true,
      authenticationTimeMs: Date.now(),
      permissions: [
        ADMIN_PERMISSIONS.BULK_PLANS_CREATE,
        ADMIN_PERMISSIONS.BULK_PLANS_APPLY,
        ADMIN_PERMISSIONS.BULK_PLANS_PAUSE,
        ADMIN_PERMISSIONS.BULK_PLANS_RESUME,
        ADMIN_PERMISSIONS.CLIENTS_READ,
        ADMIN_PERMISSIONS.CLIENTS_WRITE,
      ],
    };
    mocks.query.mockResolvedValue([
      { id: 'tenant-1', lifecycle_state: 'active' },
      { id: 'tenant-2', lifecycle_state: 'active' },
    ]);
    mocks.getGrant.mockResolvedValue({
      status: 'active',
      delegatorId: 'admin-1',
      clientId: 'client-agent',
      machinePrincipalId: 'principal-1',
      generation: 2,
      consentVersion: 3,
      permissions: [
        ADMIN_PERMISSIONS.BULK_PLANS_CREATE,
        ADMIN_PERMISSIONS.BULK_PLANS_APPLY,
        ADMIN_PERMISSIONS.CLIENTS_READ,
        ADMIN_PERMISSIONS.CLIENTS_WRITE,
      ],
      resolvedScopeConstraints: {
        tenantIds: ['tenant-1', 'tenant-2'],
        maxPerBulkPlan: 2,
      },
      scopes: ['agent:read', 'agent:write'],
      taskSetId: 'ats-bulk-client-write',
      taskSetVersion: 1,
      scopePolicyId: 'asp-bulk-two-tenants',
      scopePolicyVersion: 1,
      accessSnapshotHash: 'a'.repeat(43),
      resolvedTools: [
        {
          toolId: 'admin.write.clients.metadata',
          toolName: 'update_client_metadata',
          contractVersion: '1',
          schemaDigest: 'sha256:855fae1148b9949986c9cad7e1f63bc17e14ae20beb5128437f35d90c6d811c5',
          permissions: [ADMIN_PERMISSIONS.CLIENTS_WRITE],
          requiredScope: 'agent:write',
          riskLevel: 'standard',
          requiresElevation: false,
        },
      ],
    });
    mocks.findPrincipalById.mockResolvedValue({ id: 'principal-1', status: 'active' });
    mocks.findCredentialById.mockResolvedValue({
      id: 'credential-1',
      principalId: 'principal-1',
      status: 'active',
    });
    mocks.getPrincipalTenantScopes.mockResolvedValue([
      { tenantId: 'tenant-1', scopeMode: 'allow' },
      { tenantId: 'tenant-2', scopeMode: 'allow' },
    ]);
    mocks.getCredentialTenantScopes.mockResolvedValue([]);
    mocks.getPrincipalPermissions.mockResolvedValue([
      ADMIN_PERMISSIONS.BULK_PLANS_CREATE,
      ADMIN_PERMISSIONS.BULK_PLANS_APPLY,
      ADMIN_PERMISSIONS.CLIENTS_READ,
      ADMIN_PERMISSIONS.CLIENTS_WRITE,
    ]);
    mocks.getActiveDelegatorPermissions.mockResolvedValue([
      ADMIN_PERMISSIONS.BULK_PLANS_CREATE,
      ADMIN_PERMISSIONS.BULK_PLANS_APPLY,
      ADMIN_PERMISSIONS.CLIENTS_READ,
      ADMIN_PERMISSIONS.CLIENTS_WRITE,
    ]);
    mocks.getCredentialPermissions.mockResolvedValue([]);
    mocks.create.mockResolvedValue(undefined);
    mocks.transition.mockResolvedValue(true);
    mocks.startApproved.mockResolvedValue(true);
    mocks.cancel.mockResolvedValue(true);
  });

  it('creates immutable target and canary snapshots only with Bulk and base permissions', async () => {
    const response = await app().request(
      '/api/admin/agent-bulk-plans',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_id: 'grant-1',
          machine_credential_id: 'credential-1',
          definition,
        }),
      },
      env
    );
    expect(response.status, await response.clone().text()).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        controlTenantId: 'platform',
        grantId: 'grant-1',
        actorSub: 'machine:principal-1',
        actorMode: 'mode_b',
        resolved: expect.objectContaining({
          definition: expect.objectContaining({
            targetTenantIds: ['tenant-1', 'tenant-2'],
            canaryTenantIds: ['tenant-1'],
          }),
        }),
        audit: expect.objectContaining({ action: 'agent.bulk_plan.created' }),
      })
    );
    expect(mocks.query).toHaveBeenCalledWith(
      'SELECT id, lifecycle_state FROM tenants WHERE id IN (?, ?)',
      ['tenant-1', 'tenant-2']
    );
    expect(mocks.adminQuery).not.toHaveBeenCalled();
  });

  it('rejects a broad rollout override and a non-platform session', async () => {
    const broad = await app().request(
      '/api/admin/agent-bulk-plans',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_id: 'grant-1',
          machine_credential_id: 'credential-1',
          definition: { ...definition, rollout: { waveSize: 2 } },
        }),
      },
      env
    );
    expect(broad.status).toBe(400);

    mocks.auth = { ...mocks.auth, roles: ['platform_admin'], permissions: [] };
    const denied = await app().request(
      '/api/admin/agent-bulk-plans',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_id: 'grant-1',
          machine_credential_id: 'credential-1',
          definition,
        }),
      },
      env
    );
    expect(denied.status).toBe(403);
  });

  it('starts only a digest-bound ready snapshot with MFA', async () => {
    mocks.get.mockResolvedValue({
      id: 'abp-1',
      version: 1,
      definitionDigest: 'digest-1',
      targetTenantIds: ['tenant-1', 'tenant-2'],
      targetSnapshotDigest: 'targets-1',
      canaryDigest: 'canary-1',
    });
    const response = await app().request(
      '/api/admin/agent-bulk-plans/abp-1/1/start',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan_digest: 'digest-1' }),
      },
      env
    );
    expect(response.status).toBe(200);
    expect(mocks.startApproved).toHaveBeenCalledWith(
      expect.objectContaining({
        definitionDigest: 'digest-1',
        targetSnapshotDigest: 'targets-1',
        canaryDigest: 'canary-1',
        audit: expect.objectContaining({ action: 'agent.bulk_plan.started' }),
      })
    );
  });

  it('rechecks the immutable target snapshot against current tenant scope', async () => {
    mocks.auth = { ...mocks.auth, tenantScope: ['tenant-1'] };
    mocks.get.mockResolvedValue({
      id: 'abp-1',
      version: 1,
      definitionDigest: 'digest-1',
      targetTenantIds: ['tenant-1', 'tenant-2'],
      targetSnapshotDigest: 'targets-1',
      canaryDigest: 'canary-1',
    });
    const response = await app().request(
      '/api/admin/agent-bulk-plans/abp-1/1/start',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan_digest: 'digest-1' }),
      },
      env
    );
    expect(response.status).toBe(403);
    expect(mocks.startApproved).not.toHaveBeenCalled();
  });

  it('records cancellation without adding another lifecycle state', async () => {
    mocks.get.mockResolvedValue({
      id: 'abp-1',
      version: 1,
      targetTenantIds: ['tenant-1', 'tenant-2'],
      succeededCount: 1,
      failedCount: 0,
      indeterminateCount: 0,
    });
    const response = await app().request(
      '/api/admin/agent-bulk-plans/abp-1/1/cancel',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'Deployment superseded' }),
      },
      env
    );
    expect(response.status).toBe(200);
    expect(mocks.cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        cancelledBy: 'admin-1',
        reason: 'Deployment superseded',
        audit: expect.objectContaining({ action: 'agent.bulk_plan.cancelled' }),
      })
    );
  });
});
