import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfigurationRepository, AgentConfigurationPlanRecord } from '../../../core';
import { createAdminToolCatalog, McpSdkJsonSchemaValidator } from '../../../protocol/mcp';
import type {
  AgentAuthorizationPort,
  AgentConfigurationOperationRequest,
  ManagementApiPort,
} from '../../ports';
import { CloudflareAgentConfigurationPlanAdapter } from '../configuration-plans';

const now = 1_800_000_000_000;
const definition = {
  schemaVersion: 'authrim-agent-plan-v1' as const,
  goal: 'Apply an approved Authrim configuration change',
  steps: [
    {
      id: 'step-1',
      operation: 'admin.write.clients.metadata',
      toolContractVersion: '1',
      input: { client_id: 'client-target', client_name: 'Updated name' },
      resourcePrecondition: 'resource-v1',
    },
  ],
};

const plan: AgentConfigurationPlanRecord = {
  id: 'acp-1',
  version: 1,
  tenantId: 'tenant-1',
  grantId: 'grant-1',
  grantGeneration: 1,
  consentVersion: 1,
  actorSub: 'client:client-1',
  clientId: 'client-1',
  definition,
  definitionDigest: 'plan-digest',
  status: 'ready',
  stage: 'apply',
  diff: { changes: [] },
  appliedStepCount: 0,
  expiresAt: now + 60_000,
  payloadPurgeAt: now + 100_000,
  createdAt: now,
  updatedAt: now,
};

function request(mode: 'mode_a' | 'mode_b', operation: string): AgentConfigurationOperationRequest {
  return {
    operation,
    actor: {
      mode,
      sub: mode === 'mode_b' ? 'machine:amp-1' : 'client:client-1',
      assurance: mode === 'mode_b' ? 'machine_key' : 'public_client_transaction',
      tokenBinding: mode === 'mode_b' ? 'dpop' : 'bearer',
      clientId: 'client-1',
      ...(mode === 'mode_b' ? { machinePrincipalId: 'amp-1', machineCredentialId: 'cred-1' } : {}),
    },
    grant: {
      grantId: 'grant-1',
      tenantId: 'tenant-1',
      clientId: 'client-1',
      machinePrincipalId: mode === 'mode_b' ? 'amp-1' : undefined,
      grantorId: 'admin-1',
      delegatorId: 'admin-2',
      permissions: [
        'admin:auth_config_plans:read',
        'admin:auth_config_plans:create',
        'admin:auth_config_plans:apply',
        'admin:clients:read',
        'admin:clients:write',
      ],
      scopes: ['agent:read', 'agent:write'],
      resolvedScopeConstraints: { tenantIds: ['tenant-1'], maxPerPlan: 10 },
      consentVersion: 1,
      generation: 1,
      status: 'active',
      delegationMode: mode === 'mode_b' ? 'admin_pre_authorized' : 'user_consent',
    },
    issuerOrigin: 'https://tenant.example',
    correlationId: 'correlation-1',
    input: { plan_id: 'acp-1', version: 1 },
  };
}

describe('Cloudflare Agent configuration Plan adapter', () => {
  const repository = {
    listTaskSets: vi.fn(),
    listScopePolicies: vi.fn(),
    createPlan: vi.fn(),
    getPlan: vi.fn(),
    markPlanReady: vi.fn(),
    getPlanConfirmation: vi.fn(),
    ensurePlanConfirmation: vi.fn(),
    claimPlanApply: vi.fn(),
    completePlan: vi.fn(),
    cancelPlan: vi.fn(),
    failCancelledRunningPlan: vi.fn(),
    writeAudit: vi.fn(),
  };
  const managementApi = { execute: vi.fn() };
  const authorization: AgentAuthorizationPort = { authorize: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    repository.listTaskSets.mockResolvedValue([]);
    repository.listScopePolicies.mockResolvedValue([]);
    repository.getPlan.mockResolvedValue(plan);
    repository.markPlanReady.mockResolvedValue(true);
    repository.getPlanConfirmation.mockResolvedValue(null);
    repository.ensurePlanConfirmation.mockResolvedValue({
      id: 'apc-1',
      tenantId: 'tenant-1',
      planId: 'acp-1',
      planVersion: 1,
      planDigest: 'plan-digest',
      grantId: 'grant-1',
      actorSub: 'client:client-1',
      status: 'pending',
      expiresAt: now + 60_000,
    });
    repository.claimPlanApply.mockResolvedValue(true);
    repository.completePlan.mockResolvedValue(true);
    repository.cancelPlan.mockResolvedValue(true);
    repository.failCancelledRunningPlan.mockResolvedValue(true);
    repository.writeAudit.mockResolvedValue(undefined);
    vi.mocked(authorization.authorize).mockResolvedValue({
      allowed: true,
      requiresElevation: false,
    });
    managementApi.execute.mockImplementation(async (incoming: { operation: string }) =>
      incoming.operation === 'admin.read.clients.get'
        ? {
            status: 200,
            body: {
              client: { client_id: 'client-target', client_name: 'Old' },
              resource_version: 'resource-v1',
            },
          }
        : {
            status: 200,
            body: { client: { client_id: 'client-target', client_name: 'Updated name' } },
          }
    );
  });

  function adapter(schemaValidator = { validate: () => ({ valid: true }) }) {
    return new CloudflareAgentConfigurationPlanAdapter(
      repository as unknown as AgentConfigurationRepository,
      createAdminToolCatalog(),
      managementApi as unknown as ManagementApiPort,
      { now: () => now },
      authorization,
      schemaValidator
    );
  }

  it('validates Plan input without duplicating the separately bound resource precondition', async () => {
    const incoming = request('mode_b', 'admin.write.configuration.plan.create');
    incoming.input = {
      definition: {
        schemaVersion: 'authrim-agent-plan-v1',
        goal: 'Apply an approved Authrim configuration change',
        steps: [
          {
            id: 'step-1',
            operation: 'admin.write.clients.metadata',
            toolContractVersion: '1',
            input: { client_id: 'client-target', client_name: 'Updated name' },
            resourcePrecondition: 'resource-v1',
          },
        ],
      },
    };
    await expect(adapter(new McpSdkJsonSchemaValidator()).execute(incoming)).resolves.toMatchObject(
      {
        status: 201,
        body: { status: 'draft' },
      }
    );
    expect(repository.createPlan).toHaveBeenCalledTimes(1);

    incoming.input = {
      definition: {
        schemaVersion: 'authrim-agent-plan-v1',
        goal: 'Apply an approved Authrim configuration change',
        steps: [
          {
            id: 'step-1',
            operation: 'admin.write.clients.metadata',
            toolContractVersion: '1',
            input: {
              client_id: 'client-target',
              client_name: 'Updated name',
              resource_version: 'resource-v1',
            },
            resourcePrecondition: 'resource-v1',
          },
        ],
      },
    };
    await expect(adapter(new McpSdkJsonSchemaValidator()).execute(incoming)).resolves.toMatchObject(
      {
        status: 400,
        body: { error: 'AGENT_PLAN_INVALID_DEFINITION' },
      }
    );
    expect(repository.createPlan).toHaveBeenCalledTimes(1);
  });

  it('requires a digest-bound human confirmation for Mode A apply', async () => {
    const result = await adapter().execute(
      request('mode_a', 'admin.write.configuration.plan.apply')
    );
    expect(result).toMatchObject({
      status: 403,
      body: { error: 'AGENT_PLAN_CONFIRMATION_REQUIRED' },
      urlElicitation: { elicitationId: 'apc-1' },
    });
    expect(repository.claimPlanApply).not.toHaveBeenCalled();
    expect(managementApi.execute).not.toHaveBeenCalled();
  });

  it('applies a preauthorized Mode B standard Plan with a live precondition and fixed operation', async () => {
    repository.getPlan.mockResolvedValue({ ...plan, actorSub: 'machine:amp-1' });
    const result = await adapter().execute(
      request('mode_b', 'admin.write.configuration.plan.apply')
    );
    expect(result).toMatchObject({ status: 200, body: { plan: { status: 'completed' } } });
    expect(repository.claimPlanApply).toHaveBeenCalledWith(
      expect.objectContaining({ definitionDigest: 'plan-digest', confirmationId: undefined })
    );
    expect(managementApi.execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        operation: 'admin.write.clients.metadata',
        idempotencyKey: expect.stringContaining('acp-1:1:step-1'),
      })
    );
    expect(repository.completePlan).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed', appliedStepCount: 1 })
    );
    expect(repository.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'agent.configuration.plan.step.executed' })
    );
  });

  it('fails closed before claiming apply when the target resource changed', async () => {
    repository.getPlan.mockResolvedValue({ ...plan, actorSub: 'machine:amp-1' });
    managementApi.execute.mockResolvedValueOnce({
      status: 200,
      body: { client: { client_id: 'client-target' }, resource_version: 'resource-v2' },
    });
    await expect(
      adapter().execute(request('mode_b', 'admin.write.configuration.plan.apply'))
    ).resolves.toMatchObject({ status: 409, body: { error: 'AGENT_PLAN_PRECONDITION_FAILED' } });
    expect(repository.claimPlanApply).not.toHaveBeenCalled();
  });

  it('rejects raw secrets and non-catalogued Plan steps before persistence', async () => {
    const createRequest = request('mode_b', 'admin.write.configuration.plan.create');
    createRequest.input = {
      definition: {
        schemaVersion: 'authrim-agent-plan-v1',
        goal: 'Apply an approved Authrim configuration change',
        steps: [
          {
            id: 'step-1',
            operation: 'admin.write.clients.metadata',
            toolContractVersion: '1',
            input: { client_id: 'client-target', client_secret: 'plaintext' },
            resourcePrecondition: 'resource-v1',
          },
        ],
      },
    };
    await expect(adapter().execute(createRequest)).resolves.toEqual({
      status: 400,
      body: { error: 'AGENT_PLAN_INVALID_DEFINITION' },
      executionStatus: 'definite',
    });
    expect(repository.createPlan).not.toHaveBeenCalled();
  });

  it('re-authorizes each persisted step against its concrete resource and fields', async () => {
    repository.getPlan.mockResolvedValue({ ...plan, actorSub: 'machine:amp-1' });
    vi.mocked(authorization.authorize).mockResolvedValueOnce({
      allowed: false,
      requiresElevation: false,
      deniedAxis: 'resource',
      code: 'AGENT_RESOURCE_CONSTRAINT',
    });

    await expect(
      adapter().execute(request('mode_b', 'admin.write.configuration.plan.apply'))
    ).resolves.toMatchObject({
      status: 403,
      body: { error: 'AGENT_RESOURCE_CONSTRAINT', denied_axis: 'resource' },
    });
    expect(authorization.authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: expect.objectContaining({
          tenantId: 'tenant-1',
          domain: 'clients',
          resourceId: 'client-target',
          requestedFields: ['client_name'],
        }),
      })
    );
    expect(repository.claimPlanApply).not.toHaveBeenCalled();
  });

  it('does not reuse a Plan after the Grant generation changes', async () => {
    const incoming = request('mode_b', 'admin.write.configuration.plan.apply');
    incoming.grant.generation = 2;

    await expect(adapter().execute(incoming)).resolves.toMatchObject({
      status: 404,
      body: { error: 'AGENT_PLAN_NOT_FOUND' },
    });
    expect(authorization.authorize).not.toHaveBeenCalled();
    expect(repository.claimPlanApply).not.toHaveBeenCalled();
  });

  it('cancels a Plan idempotently and prevents a later apply', async () => {
    const cancelRequest = request('mode_a', 'admin.write.configuration.plan.cancel');
    await expect(adapter().execute(cancelRequest)).resolves.toMatchObject({
      status: 200,
      body: { plan: expect.any(Object) },
    });
    expect(repository.cancelPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'acp-1',
        version: 1,
        cancelledBy: 'client:client-1',
        audit: expect.objectContaining({ action: 'agent.configuration.plan.cancelled' }),
      })
    );

    repository.getPlan.mockResolvedValue({ ...plan, cancelledAt: now });
    await expect(adapter().execute(cancelRequest)).resolves.toMatchObject({ status: 200 });
    expect(repository.cancelPlan).toHaveBeenCalledTimes(1);
    await expect(
      adapter().execute(request('mode_a', 'admin.write.configuration.plan.apply'))
    ).resolves.toMatchObject({ status: 409, body: { error: 'AGENT_PLAN_CANCELLED' } });
  });

  it('does not misreport an unrelated completion race as cancellation', async () => {
    repository.getPlan.mockResolvedValue({ ...plan, actorSub: 'machine:amp-1' });
    repository.completePlan.mockResolvedValue(false);

    await expect(
      adapter().execute(request('mode_b', 'admin.write.configuration.plan.apply'))
    ).resolves.toMatchObject({ status: 409, body: { error: 'AGENT_PLAN_STATE_CONFLICT' } });
    expect(repository.failCancelledRunningPlan).not.toHaveBeenCalled();
  });

  it('uses the versioned Login UI snapshot when applying a standard branding Plan step', async () => {
    const loginPlan: AgentConfigurationPlanRecord = {
      ...plan,
      actorSub: 'machine:amp-1',
      definition: {
        schemaVersion: 'authrim-agent-plan-v1',
        goal: 'Apply an approved Authrim configuration change',
        steps: [
          {
            id: 'step-brand',
            operation: 'admin.write.login-ui.update',
            toolContractVersion: '1',
            input: { brandName: 'Example' },
            resourcePrecondition: 'settings-v1',
          },
        ],
      },
    };
    repository.getPlan.mockResolvedValue(loginPlan);
    managementApi.execute.mockImplementation(async (incoming: { operation: string }) =>
      incoming.operation === 'admin.read.login-ui.inspect'
        ? {
            status: 200,
            body: {
              snapshot: {
                version: 'settings-v1',
                values: { 'login-ui.brand_name': 'Old' },
              },
            },
          }
        : { status: 200, body: { snapshot: { applied: ['login-ui.brand_name'] } } }
    );
    const incoming = request('mode_b', 'admin.write.configuration.plan.apply');
    incoming.grant.permissions.push('admin:settings:read', 'admin:settings:login_ui:update');

    await expect(adapter().execute(incoming)).resolves.toMatchObject({
      status: 200,
      body: { plan: { status: 'completed', applied_step_count: 1 } },
    });
    expect(managementApi.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: 'admin.write.login-ui.update',
        input: { brandName: 'Example', resource_version: 'settings-v1' },
      })
    );
  });

  it('verifies a completed Login UI Plan against the mapped Settings v2 fields', async () => {
    repository.getPlan.mockResolvedValue({
      ...plan,
      actorSub: 'machine:amp-1',
      status: 'completed',
      stage: 'verify',
      appliedStepCount: 1,
      definition: {
        schemaVersion: 'authrim-agent-plan-v1',
        goal: 'Apply an approved Authrim configuration change',
        steps: [
          {
            id: 'step-brand',
            operation: 'admin.write.login-ui.update',
            toolContractVersion: '1',
            input: { brandName: 'Example', supportedLocales: ['ja', 'en'] },
            resourcePrecondition: 'settings-v1',
          },
        ],
      },
    });
    managementApi.execute.mockResolvedValue({
      status: 200,
      body: {
        snapshot: {
          version: 'settings-v2',
          values: {
            'login-ui.brand_name': 'Example',
            'login-ui.supported_locales': 'ja,en',
          },
        },
      },
    });
    const incoming = request('mode_b', 'admin.read.configuration.plan.verify');
    incoming.grant.permissions.push('admin:settings:read', 'admin:settings:login_ui:update');

    await expect(adapter().execute(incoming)).resolves.toMatchObject({
      status: 200,
      body: {
        plan: {
          id: 'acp-1',
          version: 1,
          verified: true,
          checks: [{ step_id: 'step-brand', verified: true }],
        },
      },
    });
    expect(managementApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'admin.read.login-ui.inspect', input: {} })
    );
  });
});
