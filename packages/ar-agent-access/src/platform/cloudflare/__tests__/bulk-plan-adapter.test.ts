import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_PERMISSIONS, type DatabaseAdapter } from '@authrim/ar-lib-core';
import { createAdminToolCatalog } from '../../../protocol/mcp';
import type { AgentConfigurationOperationRequest, AgentSettingsPort } from '../../ports';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  listTenantExecutions: vi.fn(),
  transition: vi.fn(),
  getGrant: vi.fn(),
  getActiveDelegatorPermissions: vi.fn(),
  findPrincipalById: vi.fn(),
  findCredentialById: vi.fn(),
  getPrincipalTenantScopes: vi.fn(),
  getCredentialTenantScopes: vi.fn(),
  getPrincipalPermissions: vi.fn(),
  getCredentialPermissions: vi.fn(),
}));

vi.mock('../../../core/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/repositories')>();
  return {
    ...actual,
    AgentBulkRepository: class {
      create = mocks.create;
      get = mocks.get;
      listTenantExecutions = mocks.listTenantExecutions;
      transition = mocks.transition;
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

import { CloudflareAgentBulkPlanAdapter } from '../bulk-plan-adapter';

const permissions = [
  ADMIN_PERMISSIONS.BULK_PLANS_CREATE,
  ADMIN_PERMISSIONS.BULK_PLANS_APPLY,
  ADMIN_PERMISSIONS.BULK_PLANS_READ,
  ADMIN_PERMISSIONS.CLIENTS_READ,
  ADMIN_PERMISSIONS.CLIENTS_WRITE,
];

function request(): AgentConfigurationOperationRequest {
  const catalog = createAdminToolCatalog();
  const write = catalog.list().find((tool) => tool.id === 'admin.write.clients.metadata')!;
  return {
    operation: 'admin.write.bulk.plan.create',
    actor: {
      mode: 'mode_b',
      sub: 'machine:principal-1',
      assurance: 'machine_key',
      tokenBinding: 'dpop',
      clientId: 'client-agent',
      machinePrincipalId: 'principal-1',
      machineCredentialId: 'credential-1',
    },
    grant: {
      grantId: 'grant-1',
      tenantId: 'platform',
      clientId: 'client-agent',
      machinePrincipalId: 'principal-1',
      grantorId: 'admin-1',
      delegatorId: 'admin-1',
      permissions: [...permissions],
      scopes: ['agent:read', 'agent:write'],
      resolvedScopeConstraints: {
        tenantIds: ['platform', 'tenant-1'],
        maxPerBulkPlan: 2,
      },
      consentVersion: 1,
      generation: 2,
      status: 'active',
      delegationMode: 'admin_pre_authorized',
      taskSetId: 'ats-bulk-client-write',
      taskSetVersion: 1,
      scopePolicyId: 'asp-bulk-tenant-1',
      scopePolicyVersion: 1,
      accessSnapshotHash: 'a'.repeat(43),
      resolvedTools: [
        {
          toolId: write.id,
          toolName: write.name,
          contractVersion: write.contractVersion,
          schemaDigest: write.schemaDigest,
          permissions: [...write.requiredPermissions],
          requiredScope: write.requiredScope,
          riskLevel: write.riskLevel,
          requiresElevation: false,
        },
      ],
    },
    issuerOrigin: 'https://platform.example',
    correlationId: 'correlation-1',
    input: {
      definition: {
        schemaVersion: 'authrim-agent-bulk-plan-v1',
        targetTenantIds: ['platform', 'tenant-1'],
        canaryTenantIds: ['tenant-1'],
        plan: {
          schemaVersion: 'authrim-agent-plan-v1',
          goal: 'Apply an approved Authrim configuration change',
          steps: [
            {
              id: 'step-1',
              operation: write.id,
              toolContractVersion: write.contractVersion,
              input: { client_id: 'client-1', client_name: 'Updated' },
              resourcePrecondition: 'per-tenant-validation',
            },
          ],
        },
      },
    },
  };
}

describe('CloudflareAgentBulkPlanAdapter', () => {
  const database = {
    query: vi.fn(),
  } as unknown as DatabaseAdapter;
  const tenantDirectoryDatabase = {
    query: vi.fn(),
  } as unknown as DatabaseAdapter;
  let protectedCanary = false;
  const settings: AgentSettingsPort = {
    get: vi.fn(async (tenantId) => ({
      enabled: true,
      maxTokenTtlSeconds: 900,
      elevationMode: 'self_reauth',
      elevationTtlSeconds: 300,
      rateLimitPerMinute: 60,
      highRiskPermissionsAdditional: [],
      bulkCanaryProtected: protectedCanary && tenantId === 'tenant-1',
    })),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    protectedCanary = false;
    vi.mocked(database.query).mockResolvedValue([
      { id: 'platform', lifecycle_state: 'active' },
      { id: 'tenant-1', lifecycle_state: 'active' },
    ]);
    vi.mocked(tenantDirectoryDatabase.query).mockResolvedValue([
      { id: 'platform', lifecycle_state: 'active' },
      { id: 'tenant-1', lifecycle_state: 'active' },
    ]);
    mocks.getGrant.mockResolvedValue(request().grant);
    mocks.getActiveDelegatorPermissions.mockResolvedValue([...permissions]);
    mocks.findPrincipalById.mockResolvedValue({ id: 'principal-1', status: 'active' });
    mocks.findCredentialById.mockResolvedValue({
      id: 'credential-1',
      principalId: 'principal-1',
      status: 'active',
    });
    mocks.getPrincipalTenantScopes.mockResolvedValue([
      { tenantId: 'platform', scopeMode: 'allow' },
      { tenantId: 'tenant-1', scopeMode: 'allow' },
    ]);
    mocks.getCredentialTenantScopes.mockResolvedValue([]);
    mocks.getPrincipalPermissions.mockResolvedValue([...permissions]);
    mocks.getCredentialPermissions.mockResolvedValue([]);
  });

  it('creates a draft using only the verified Mode B context', async () => {
    const adapter = new CloudflareAgentBulkPlanAdapter(
      database,
      createAdminToolCatalog(),
      settings,
      { validate: () => ({ valid: true }) },
      () => 1_000,
      tenantDirectoryDatabase
    );
    const response = await adapter.execute(request());
    expect(response.status).toBe(201);
    expect(tenantDirectoryDatabase.query).toHaveBeenCalledTimes(1);
    expect(database.query).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        controlTenantId: 'platform',
        grantId: 'grant-1',
        machineCredentialId: 'credential-1',
        audit: expect.objectContaining({ actorType: 'agent' }),
      })
    );
  });

  it('rejects a protected tenant selected as canary', async () => {
    protectedCanary = true;
    const adapter = new CloudflareAgentBulkPlanAdapter(
      database,
      createAdminToolCatalog(),
      settings,
      { validate: () => ({ valid: true }) }
    );
    const response = await adapter.execute(request());
    expect(response).toMatchObject({
      status: 409,
      body: { error: 'AGENT_BULK_PLAN_CANARY_PROTECTED' },
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rejects a step outside the Grant field constraints before persistence', async () => {
    const incoming = request();
    incoming.grant.resolvedScopeConstraints = {
      ...incoming.grant.resolvedScopeConstraints,
      domains: ['clients'],
      resourceSelector: { kind: 'ids', ids: ['client-1'] },
      allowedFields: ['description'],
    };
    mocks.getGrant.mockResolvedValue(incoming.grant);
    const adapter = new CloudflareAgentBulkPlanAdapter(
      database,
      createAdminToolCatalog(),
      settings,
      { validate: () => ({ valid: true }) }
    );

    await expect(adapter.execute(incoming)).resolves.toMatchObject({
      status: 403,
      body: { error: 'AGENT_BULK_PLAN_RESOURCE_SCOPE_REQUIRED' },
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
