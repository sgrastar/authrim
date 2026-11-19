import { describe, expect, it } from 'vitest';
import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { issueAgentBulkChildToken } from '../entrypoints/AgentDownscopeEntrypoint';
import { bulkScenario, NOW } from './helpers/mut-entrypoint-fixtures';

const env = {} as never;

describe('issueAgentBulkChildToken request validation', () => {
  it.each([
    ['audience', { audience: 'other' }],
    ['controlTenantId', { controlTenantId: '../platform' }],
    ['targetTenantId', { targetTenantId: '../tenant-1' }],
    ['issuerOrigin', { issuerOrigin: '' }],
    ['bulkPlanId', { bulkPlanId: '' }],
    ['executionId', { executionId: '' }],
    ['planDigest', { planDigest: '' }],
    ['approvalDigest', { approvalDigest: '' }],
    ['childCapabilityDigest', { childCapabilityDigest: '' }],
    ['correlationId', { correlationId: '' }],
    ['bulkPlanVersion (fractional)', { bulkPlanVersion: 1.5 }],
    ['bulkPlanVersion (zero)', { bulkPlanVersion: 0 }],
    ['executionAttempt (fractional)', { executionAttempt: 1.5 }],
    ['executionAttempt (zero)', { executionAttempt: 0 }],
    ['executionFence (fractional)', { executionFence: 1.5 }],
    ['executionFence (zero)', { executionFence: 0 }],
    ['stage', { stage: 'rollback' }],
  ])('rejects an invalid %s before any feature or repository lookup', async (_field, request) => {
    const scenario = await bulkScenario({ request: request as never });
    await expect(issueAgentBulkChildToken(env, scenario.request, scenario.deps)).rejects.toThrow(
      'invalid_agent_bulk_child_request'
    );
    expect(scenario.deps.isFeatureEnabled).not.toHaveBeenCalled();
    expect(scenario.deps.createBulkRepository).not.toHaveBeenCalled();
  });

  it('accepts the minimum version, attempt, and fence of 1', async () => {
    const scenario = await bulkScenario();
    const request = {
      ...scenario.request,
      bulkPlanVersion: 1,
      executionAttempt: 1,
      executionFence: 1,
    };
    // Values are valid; the binding to the stored execution then fails.
    await expect(issueAgentBulkChildToken(env, request, scenario.deps)).rejects.toThrow(
      'agent_bulk_child_binding_changed'
    );
  });

  it.each([
    ['control', 'platform'],
    ['target', 'tenant-1'],
  ])('refuses when the feature is disabled for the %s tenant', async (_name, disabledTenant) => {
    const scenario = await bulkScenario();
    scenario.deps.isFeatureEnabled.mockImplementation(
      async (_env: unknown, tenantId: string) => tenantId !== disabledTenant
    );
    await expect(issueAgentBulkChildToken(env, scenario.request, scenario.deps)).rejects.toThrow(
      'agent_mcp_disabled'
    );
    expect(scenario.deps.createBulkRepository).not.toHaveBeenCalled();
  });

  it('requires the admin database when only one repository is injected', async () => {
    const scenario = await bulkScenario();
    const { createRepository: _omit, ...deps } = scenario.deps;
    await expect(issueAgentBulkChildToken(env, scenario.request, deps)).rejects.toThrow(
      'DB_ADMIN is not configured'
    );
  });
});

describe('issueAgentBulkChildToken live Plan and execution binding', () => {
  it.each([
    ['plan status', { plan: { status: 'paused' } }],
    ['plan definition digest', { plan: { definitionDigest: 'other' } }],
    ['plan approval digest', { plan: { approvalDigest: 'other' } }],
    ['plan actor mode', { plan: { actorMode: 'mode_a' } }],
    ['plan actor assurance', { plan: { actorAssurance: 'confidential_client' } }],
    ['plan token binding', { plan: { tokenBinding: 'bearer' } }],
    ['plan actor subject', { plan: { actorSub: 'machine:someone-else' } }],
    ['execution target tenant', { execution: { targetTenantId: 'tenant-2' } }],
    ['execution status', { execution: { status: 'completed' } }],
    ['execution stage', { execution: { stage: 'verify' } }],
    ['execution attempt', { execution: { executionAttempt: 1 } }],
    ['execution fence', { execution: { executionFence: 2 } }],
    ['execution plan digest', { execution: { planDigest: 'other' } }],
    ['capability expiry equal to now', { execution: { childCapabilityExpiresAt: NOW } }],
  ])('rejects a changed %s', async (_name, options) => {
    const scenario = await bulkScenario(options);
    await expect(issueAgentBulkChildToken(env, scenario.request, scenario.deps)).rejects.toThrow(
      'agent_bulk_child_binding_changed'
    );
    expect(scenario.repo.getGrant).not.toHaveBeenCalled();
  });

  it('rejects a request digest that differs from the stored execution digest', async () => {
    const scenario = await bulkScenario();
    scenario.repo.getTenantExecution.mockResolvedValue({
      ...scenario.execution,
      childCapabilityDigest: 'other-digest',
    });
    await expect(issueAgentBulkChildToken(env, scenario.request, scenario.deps)).rejects.toThrow(
      'agent_bulk_child_binding_changed'
    );
  });

  it('rejects a stored digest that does not match the recomputed capability', async () => {
    const scenario = await bulkScenario({ request: { childCapabilityDigest: 'forged' } });
    scenario.repo.getTenantExecution.mockResolvedValue({
      ...scenario.execution,
      childCapabilityDigest: 'forged',
    });
    await expect(issueAgentBulkChildToken(env, scenario.request, scenario.deps)).rejects.toThrow(
      'agent_bulk_child_capability_invalid'
    );
    expect(scenario.repo.getGrant).not.toHaveBeenCalled();
  });

  it('binds the stored precondition snapshot into the capability digest', async () => {
    const scenario = await bulkScenario();
    scenario.repo.getTenantExecution.mockResolvedValue({
      ...scenario.execution,
      childCapabilityDigest: scenario.childCapabilityDigest,
      preconditionSnapshotDigest: 'another-snapshot',
    });
    await expect(issueAgentBulkChildToken(env, scenario.request, scenario.deps)).rejects.toThrow(
      'agent_bulk_child_capability_invalid'
    );
  });

  it('looks up the plan and execution by the requested identifiers', async () => {
    const scenario = await bulkScenario();
    await issueAgentBulkChildToken(env, scenario.request, scenario.deps);
    expect(scenario.repo.get).toHaveBeenCalledWith('platform', 'bulk-1', 4);
    expect(scenario.repo.getTenantExecution).toHaveBeenCalledWith(
      'platform',
      'bulk-1',
      4,
      'execution-1'
    );
    expect(scenario.repo.getGrant).toHaveBeenCalledWith('platform', 'grant-bulk');
  });

  it('signs the complete child-token claim set for the target tenant only', async () => {
    const scenario = await bulkScenario();
    await expect(issueAgentBulkChildToken(env, scenario.request, scenario.deps)).resolves.toEqual({
      accessToken: 'child-token',
      expiresAt: 1_060,
    });
    expect(scenario.deps.signToken).toHaveBeenCalledWith(env, 'tenant-1', {
      iss: 'https://tenant-1.authrim.example/oauth/admin-agent',
      sub: 'admin_user:admin-1',
      aud: 'authrim:admin-api',
      scope: `${ADMIN_PERMISSIONS.BULK_PLANS_APPLY} ${ADMIN_PERMISSIONS.CLIENTS_WRITE}`,
      permissions: [ADMIN_PERMISSIONS.BULK_PLANS_APPLY, ADMIN_PERMISSIONS.CLIENTS_WRITE],
      client_id: 'client-agent',
      tenant_id: 'tenant-1',
      grant_id: 'grant-bulk',
      grant_generation: 3,
      consent_version: 2,
      actor_type: 'agent',
      actor_mode: 'mode_b',
      actor_assurance: 'machine_key',
      act: { sub: 'machine:principal-1' },
      act_principal_id: 'principal-1',
      act_credential_id: 'credential-1',
      source_token_jti: 'bulk:execution-1:2:3',
      correlation_id: 'correlation-bulk',
      bulk: {
        control_tenant_id: 'platform',
        target_tenant_id: 'tenant-1',
        plan_id: 'bulk-1',
        plan_version: 4,
        execution_id: 'execution-1',
        execution_attempt: 2,
        execution_fence: 3,
        stage: 'apply',
        plan_digest: 'plan-digest',
        approval_digest: 'approval-digest',
        child_capability_digest: scenario.childCapabilityDigest,
      },
    });
  });

  it('rejects an issuer origin that is not a bare HTTPS origin before signing', async () => {
    const scenario = await bulkScenario({
      request: { issuerOrigin: 'https://tenant-1.authrim.example/path' },
    });
    await expect(issueAgentBulkChildToken(env, scenario.request, scenario.deps)).rejects.toThrow(
      'agent_downscope_issuer_unavailable'
    );
    expect(scenario.deps.signToken).not.toHaveBeenCalled();
  });
});
