import { describe, expect, it, vi } from 'vitest';
import type {
  AgentBulkChildTokenRequest,
  AgentDownscopeExchangeRequest,
  AgentGrantContract,
} from '@authrim/ar-agent-access/core';
import { computeAgentBulkChildCapabilityDigest } from '@authrim/ar-agent-access/core';
import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { exchangeAgentAccessToken, issueAgentBulkChildToken } from '../AgentDownscopeEntrypoint';

const grant: AgentGrantContract = {
  grantId: 'grant-1',
  tenantId: 'tenant-1',
  clientId: 'client-1',
  grantorId: 'admin-1',
  delegatorId: 'admin-1',
  permissions: ['admin:users:read'],
  scopes: ['agent:read'],
  resolvedScopeConstraints: { tenantIds: ['tenant-1'] },
  consentVersion: 2,
  generation: 3,
  status: 'active',
  delegationMode: 'user_consent',
  taskSetId: 'ats-read-only',
  taskSetVersion: 1,
  scopePolicyId: 'asp-tenant-1',
  scopePolicyVersion: 1,
  resolvedTools: [
    {
      toolId: 'admin.read.users.get',
      toolName: 'get_user',
      contractVersion: '1',
      schemaDigest: 'digest',
      permissions: ['admin:users:read'],
      requiredScope: 'agent:read',
      riskLevel: 'low',
      requiresElevation: false,
    },
  ],
  accessSnapshotHash: 'a'.repeat(43),
};

const input: AgentDownscopeExchangeRequest = {
  subjectToken: 'mcp-token',
  tenantId: 'tenant-1',
  issuerOrigin: 'https://tenant-1.authrim.example',
  audience: 'authrim:admin-api',
  permissions: ['admin:users:read'],
  grantId: 'grant-1',
  grantGeneration: 3,
  delegatorId: 'admin-1',
  consentVersion: 2,
  actorSub: 'client:client-1',
  actorMode: 'mode_a',
  actorAssurance: 'public_client_transaction',
  clientId: 'client-1',
  correlationId: 'correlation-1',
};

const invalidDownscopeRequests: Array<{
  name: string;
  overrides: Record<string, unknown>;
}> = [
  { name: 'an unsupported audience', overrides: { audience: 'other-api' } },
  { name: 'an invalid tenant identifier', overrides: { tenantId: '../tenant-1' } },
  { name: 'an empty issuer origin', overrides: { issuerOrigin: '' } },
  { name: 'an empty subject token', overrides: { subjectToken: '' } },
  { name: 'an empty grant identifier', overrides: { grantId: '' } },
  { name: 'an empty delegator identifier', overrides: { delegatorId: '' } },
  { name: 'an empty actor subject', overrides: { actorSub: '' } },
  { name: 'an empty client identifier', overrides: { clientId: '' } },
  { name: 'an empty correlation identifier', overrides: { correlationId: '' } },
  { name: 'a zero grant generation', overrides: { grantGeneration: 0 } },
  { name: 'a fractional grant generation', overrides: { grantGeneration: 1.5 } },
  { name: 'a zero consent version', overrides: { consentVersion: 0 } },
  { name: 'a fractional consent version', overrides: { consentVersion: 1.5 } },
  { name: 'an empty permission list', overrides: { permissions: [] } },
  {
    name: 'more than 64 permissions',
    overrides: {
      permissions: Array.from({ length: 65 }, (_, index) => `admin:test:${index}`),
    },
  },
  {
    name: 'duplicate permissions',
    overrides: { permissions: ['admin:users:read', 'admin:users:read'] },
  },
  { name: 'a malformed permission', overrides: { permissions: ['admin:users/read'] } },
];

function subject(overrides: Record<string, unknown> = {}) {
  return {
    sub: 'admin_user:admin-1',
    jti: 'source-jti',
    scope: 'agent:read',
    client_id: 'client-1',
    tenant_id: 'tenant-1',
    grant_id: 'grant-1',
    grant_generation: 3,
    consent_version: 2,
    actor_mode: 'mode_a',
    actor_assurance: 'public_client_transaction',
    token_binding: 'bearer',
    act: { sub: 'client:client-1' },
    ...overrides,
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    now: () => 100,
    isFeatureEnabled: vi.fn().mockResolvedValue(true),
    verifySubjectToken: vi.fn().mockResolvedValue(subject()),
    createRepository: () => ({
      getGrant: vi.fn().mockResolvedValue(grant),
      getActiveDelegatorPermissions: vi.fn().mockResolvedValue(['admin:*']),
      hasCurrentConsent: vi.fn().mockResolvedValue(true),
    }),
    signToken: vi.fn().mockResolvedValue({
      accessToken: 'admin-api-token',
      expiresAt: 160,
    }),
    ...overrides,
  };
}

const env = { ISSUER_URL: 'https://auth.example' } as never;

describe('AgentDownscopeEntrypoint', () => {
  it('re-verifies mutable authorization and signs only the requested Tool permission', async () => {
    const deps = dependencies();
    await expect(exchangeAgentAccessToken(env, input, deps)).resolves.toEqual({
      accessToken: 'admin-api-token',
      expiresAt: 160,
    });

    expect(deps.signToken).toHaveBeenCalledWith(
      env,
      'tenant-1',
      expect.objectContaining({
        aud: 'authrim:admin-api',
        iss: 'https://tenant-1.authrim.example/oauth/admin-agent',
        scope: 'admin:users:read',
        permissions: ['admin:users:read'],
        grant_id: 'grant-1',
        grant_generation: 3,
        consent_version: 2,
        actor_type: 'agent',
        act: { sub: 'client:client-1' },
        source_token_jti: 'source-jti',
      })
    );
  });

  it('rejects a permission that is not covered by the current Grant', async () => {
    const deps = dependencies();
    await expect(
      exchangeAgentAccessToken(env, { ...input, permissions: ['admin:users:delete'] }, deps)
    ).rejects.toThrow('authorization_changed');
    expect(deps.signToken).not.toHaveBeenCalled();
  });

  it('rechecks a Mode A linked principal without changing the client actor claim', async () => {
    const limit = vi.fn().mockResolvedValue(['admin:users:read']);
    const deps = dependencies({
      createRepository: () => ({
        getGrant: vi.fn().mockResolvedValue({ ...grant, machinePrincipalId: 'amp-policy' }),
        getActiveDelegatorPermissions: vi.fn().mockResolvedValue(['admin:*']),
        hasCurrentConsent: vi.fn().mockResolvedValue(true),
      }),
      getModeBPermissionLimit: limit,
    });
    await expect(exchangeAgentAccessToken(env, input, deps)).resolves.toEqual({
      accessToken: 'admin-api-token',
      expiresAt: 160,
    });
    expect(limit).toHaveBeenCalledWith(env, 'tenant-1', 'amp-policy', undefined);
    expect(deps.signToken).toHaveBeenCalledWith(
      env,
      'tenant-1',
      expect.objectContaining({ actor_mode: 'mode_a', act: { sub: 'client:client-1' } })
    );

    limit.mockResolvedValueOnce(null);
    await expect(exchangeAgentAccessToken(env, input, deps)).rejects.toThrow(
      'authorization_changed'
    );
  });

  it('rejects a source token whose actor binding differs from the RPC request', async () => {
    const deps = dependencies({
      verifySubjectToken: vi.fn().mockResolvedValue(subject({ act: { sub: 'client:other' } })),
    });
    await expect(exchangeAgentAccessToken(env, input, deps)).rejects.toThrow(
      'subject_token_binding'
    );
  });

  it('preserves Mode B identity and rechecks the machine credential permission ceiling', async () => {
    const modeBGrant: AgentGrantContract = {
      ...grant,
      delegationMode: 'admin_pre_authorized',
      machinePrincipalId: 'amp-1',
    };
    const deps = dependencies({
      verifySubjectToken: vi.fn().mockResolvedValue(
        subject({
          actor_mode: 'mode_b',
          actor_assurance: 'machine_key',
          token_binding: 'dpop',
          act: { sub: 'machine:amp-1' },
          act_principal_id: 'amp-1',
          act_credential_id: 'amk-1',
          cnf: { jkt: 'thumbprint' },
        })
      ),
      createRepository: () => ({
        getGrant: vi.fn().mockResolvedValue(modeBGrant),
        getActiveDelegatorPermissions: vi.fn().mockResolvedValue(['admin:*']),
        hasCurrentConsent: vi.fn().mockResolvedValue(true),
      }),
      getModeBPermissionLimit: vi.fn().mockResolvedValue(['admin:users:read']),
    });
    await exchangeAgentAccessToken(
      env,
      {
        ...input,
        actorSub: 'machine:amp-1',
        actorMode: 'mode_b',
        actorAssurance: 'machine_key',
        machinePrincipalId: 'amp-1',
        machineCredentialId: 'amk-1',
      },
      deps
    );

    expect(deps.signToken).toHaveBeenCalledWith(
      env,
      'tenant-1',
      expect.objectContaining({
        actor_mode: 'mode_b',
        actor_assurance: 'machine_key',
        act: { sub: 'machine:amp-1' },
        act_principal_id: 'amp-1',
        act_credential_id: 'amk-1',
      })
    );
  });

  it('fails Mode B downscope when the machine credential is revoked', async () => {
    const deps = dependencies({
      verifySubjectToken: vi.fn().mockResolvedValue(
        subject({
          actor_mode: 'mode_b',
          actor_assurance: 'machine_key',
          token_binding: 'dpop',
          act: { sub: 'machine:amp-1' },
          act_principal_id: 'amp-1',
          act_credential_id: 'amk-1',
          cnf: { jkt: 'thumbprint' },
        })
      ),
      createRepository: () => ({
        getGrant: vi.fn().mockResolvedValue({ ...grant, machinePrincipalId: 'amp-1' }),
        getActiveDelegatorPermissions: vi.fn().mockResolvedValue(['admin:*']),
        hasCurrentConsent: vi.fn().mockResolvedValue(true),
      }),
      getModeBPermissionLimit: vi.fn().mockResolvedValue(null),
    });
    await expect(
      exchangeAgentAccessToken(
        env,
        {
          ...input,
          actorSub: 'machine:amp-1',
          actorMode: 'mode_b',
          actorAssurance: 'machine_key',
          machinePrincipalId: 'amp-1',
          machineCredentialId: 'amk-1',
        },
        deps
      )
    ).rejects.toThrow('authorization_changed');
  });

  it('evaluates the feature flag before verifying or signing a token', async () => {
    const deps = dependencies({ isFeatureEnabled: vi.fn().mockResolvedValue(false) });
    await expect(exchangeAgentAccessToken(env, input, deps)).rejects.toThrow('agent_mcp_disabled');
    expect(deps.verifySubjectToken).not.toHaveBeenCalled();
    expect(deps.signToken).not.toHaveBeenCalled();
  });

  it.each(invalidDownscopeRequests)(
    'rejects $name before repository access',
    async ({ overrides }) => {
      const deps = dependencies();
      await expect(
        exchangeAgentAccessToken(
          env,
          { ...input, ...overrides } as AgentDownscopeExchangeRequest,
          deps
        )
      ).rejects.toThrow('invalid_agent_downscope_request');
      expect(deps.isFeatureEnabled).not.toHaveBeenCalled();
    }
  );

  it('issues a target-only Bulk child token from the live Plan and tenant precondition', async () => {
    const binding = {
      purpose: 'authrim-agent-bulk-child-v1' as const,
      controlTenantId: 'platform',
      targetTenantId: 'tenant-1',
      bulkPlanId: 'bulk-1',
      bulkPlanVersion: 1,
      executionId: 'execution-1',
      executionAttempt: 1,
      executionFence: 1,
      stage: 'apply' as const,
      planDigest: 'plan-digest',
      approvalDigest: 'approval-digest',
      preconditionSnapshotDigest: 'snapshot-digest',
      expiresAt: 1_100,
    };
    const childCapabilityDigest = await computeAgentBulkChildCapabilityDigest(binding);
    const request: AgentBulkChildTokenRequest = {
      issuerOrigin: 'https://tenant-1.authrim.example',
      audience: 'authrim:admin-api',
      controlTenantId: 'platform',
      targetTenantId: 'tenant-1',
      bulkPlanId: 'bulk-1',
      bulkPlanVersion: 1,
      executionId: 'execution-1',
      executionAttempt: 1,
      executionFence: 1,
      stage: 'apply',
      planDigest: 'plan-digest',
      approvalDigest: 'approval-digest',
      childCapabilityDigest,
      correlationId: 'correlation-bulk-1',
    };
    const bulkGrant: AgentGrantContract = {
      ...grant,
      tenantId: 'platform',
      clientId: 'client-agent',
      machinePrincipalId: 'principal-1',
      delegationMode: 'admin_pre_authorized',
      permissions: [ADMIN_PERMISSIONS.BULK_PLANS_APPLY, ADMIN_PERMISSIONS.CLIENTS_WRITE],
      scopes: ['agent:read', 'agent:write'],
      resolvedScopeConstraints: { tenantIds: ['platform', 'tenant-1'] },
      taskSetId: 'ats-bulk-client-write',
      taskSetVersion: 1,
      scopePolicyId: 'asp-bulk-tenant-1',
      scopePolicyVersion: 1,
      accessSnapshotHash: 'b'.repeat(43),
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
    };
    const currentPlan = {
      id: 'bulk-1',
      version: 1,
      controlTenantId: 'platform',
      grantId: 'grant-1',
      actorSub: 'machine:principal-1',
      clientId: 'client-agent',
      definition: {
        schemaVersion: 'authrim-agent-bulk-plan-v1',
        targetTenantIds: ['tenant-1'],
        canaryTenantIds: ['tenant-1'],
        plan: {
          schemaVersion: 'authrim-agent-plan-v1',
          steps: [
            {
              id: 'step-1',
              operation: 'admin.write.clients.metadata',
              toolContractVersion: '1',
              input: { client_id: 'client-1', client_name: 'Updated' },
              resourcePrecondition: 'per-tenant-validation',
            },
          ],
        },
      },
      definitionDigest: 'plan-digest',
      status: 'running',
      approvalDigest: 'approval-digest',
      actorMode: 'mode_b',
      actorAssurance: 'machine_key',
      tokenBinding: 'dpop',
      delegatorId: 'admin-1',
      machinePrincipalId: 'principal-1',
      machineCredentialId: 'credential-1',
      grantGeneration: 3,
      consentVersion: 2,
    };
    const currentExecution = {
      id: 'execution-1',
      targetTenantId: 'tenant-1',
      status: 'running',
      stage: 'apply',
      executionAttempt: 1,
      executionFence: 1,
      planDigest: 'plan-digest',
      childCapabilityDigest,
      childCapabilityExpiresAt: 1_100,
      preconditionSnapshotDigest: 'snapshot-digest',
    };
    const signToken = vi.fn().mockResolvedValue({ accessToken: 'child-token', expiresAt: 1_060 });
    await expect(
      issueAgentBulkChildToken(env, request, {
        now: () => 1_000,
        isFeatureEnabled: vi.fn().mockResolvedValue(true),
        createBulkRepository: () => ({
          get: vi.fn().mockResolvedValue(currentPlan),
          getTenantExecution: vi.fn().mockResolvedValue(currentExecution),
        }),
        createRepository: () => ({
          getGrant: vi.fn().mockResolvedValue(bulkGrant),
          getActiveDelegatorPermissions: vi.fn().mockResolvedValue(['admin:*']),
          hasCurrentConsent: vi.fn().mockResolvedValue(true),
        }),
        getModeBPermissionLimit: vi.fn().mockResolvedValue(['admin:*']),
        signToken,
      })
    ).resolves.toEqual({ accessToken: 'child-token', expiresAt: 1_060 });
    expect(signToken).toHaveBeenCalledWith(
      env,
      'tenant-1',
      expect.objectContaining({
        tenant_id: 'tenant-1',
        permissions: [ADMIN_PERMISSIONS.BULK_PLANS_APPLY, ADMIN_PERMISSIONS.CLIENTS_WRITE],
        bulk: expect.objectContaining({ child_capability_digest: childCapabilityDigest }),
      })
    );

    const { preconditionSnapshotDigest: _applySnapshot, ...bindingWithoutSnapshot } = binding;
    const loginBinding = {
      ...bindingWithoutSnapshot,
      stage: 'validate' as const,
    };
    const loginDigest = await computeAgentBulkChildCapabilityDigest(loginBinding);
    const loginRequest: AgentBulkChildTokenRequest = {
      ...request,
      stage: 'validate',
      childCapabilityDigest: loginDigest,
    };
    const loginPlan = {
      ...currentPlan,
      definition: {
        ...currentPlan.definition,
        plan: {
          schemaVersion: 'authrim-agent-plan-v1',
          steps: [
            {
              id: 'step-brand',
              operation: 'admin.write.login-ui.update',
              toolContractVersion: '1',
              input: { brandName: 'Example' },
              resourcePrecondition: 'per-tenant-validation',
            },
          ],
        },
      },
    };
    const loginExecution = {
      ...currentExecution,
      stage: 'validate',
      childCapabilityDigest: loginDigest,
      preconditionSnapshotDigest: undefined,
    };
    const loginGrant: AgentGrantContract = {
      ...bulkGrant,
      permissions: [
        ADMIN_PERMISSIONS.BULK_PLANS_APPLY,
        ADMIN_PERMISSIONS.SETTINGS_READ,
        ADMIN_PERMISSIONS.SETTINGS_LOGIN_UI_UPDATE,
      ],
      resolvedTools: [
        {
          toolId: 'admin.write.login-ui.update',
          toolName: 'update_login_ui_branding',
          contractVersion: '1',
          schemaDigest: 'sha256:2597c9387616264fe4dc7df2a9c80fa2de14d05a92cb8fe1edb9715123318675',
          permissions: [ADMIN_PERMISSIONS.SETTINGS_LOGIN_UI_UPDATE],
          requiredScope: 'agent:write',
          riskLevel: 'standard',
          requiresElevation: false,
        },
      ],
    };
    const loginSignToken = vi
      .fn()
      .mockResolvedValue({ accessToken: 'login-child-token', expiresAt: 1_060 });
    await expect(
      issueAgentBulkChildToken(env, loginRequest, {
        now: () => 1_000,
        isFeatureEnabled: vi.fn().mockResolvedValue(true),
        createBulkRepository: () => ({
          get: vi.fn().mockResolvedValue(loginPlan),
          getTenantExecution: vi.fn().mockResolvedValue(loginExecution),
        }),
        createRepository: () => ({
          getGrant: vi.fn().mockResolvedValue(loginGrant),
          getActiveDelegatorPermissions: vi.fn().mockResolvedValue(['admin:*']),
          hasCurrentConsent: vi.fn().mockResolvedValue(true),
        }),
        getModeBPermissionLimit: vi.fn().mockResolvedValue(['admin:*']),
        signToken: loginSignToken,
      })
    ).resolves.toEqual({ accessToken: 'login-child-token', expiresAt: 1_060 });
    expect(loginSignToken).toHaveBeenCalledWith(
      env,
      'tenant-1',
      expect.objectContaining({
        permissions: [ADMIN_PERMISSIONS.BULK_PLANS_APPLY, ADMIN_PERMISSIONS.SETTINGS_READ],
      })
    );

    await expect(
      issueAgentBulkChildToken(env, request, {
        now: () => 1_000,
        isFeatureEnabled: vi.fn().mockResolvedValue(true),
        createBulkRepository: () => ({
          get: vi.fn().mockResolvedValue({ ...currentPlan, grantGeneration: 2 }),
          getTenantExecution: vi.fn().mockResolvedValue(currentExecution),
        }),
        createRepository: () => ({
          getGrant: vi.fn().mockResolvedValue(bulkGrant),
          getActiveDelegatorPermissions: vi.fn().mockResolvedValue(['admin:*']),
          hasCurrentConsent: vi.fn().mockResolvedValue(true),
        }),
        getModeBPermissionLimit: vi.fn().mockResolvedValue(['admin:*']),
        signToken,
      })
    ).rejects.toThrow('authorization_changed');

    await expect(
      issueAgentBulkChildToken(env, request, {
        now: () => 1_000,
        isFeatureEnabled: vi.fn().mockResolvedValue(true),
        createBulkRepository: () => ({
          get: vi.fn().mockResolvedValue({ ...currentPlan, cancelledAt: 999 }),
          getTenantExecution: vi.fn().mockResolvedValue(currentExecution),
        }),
        createRepository: () => ({
          getGrant: vi.fn().mockResolvedValue(bulkGrant),
          getActiveDelegatorPermissions: vi.fn().mockResolvedValue(['admin:*']),
          hasCurrentConsent: vi.fn().mockResolvedValue(true),
        }),
        getModeBPermissionLimit: vi.fn().mockResolvedValue(['admin:*']),
        signToken,
      })
    ).rejects.toThrow('binding_changed');

    await expect(
      issueAgentBulkChildToken(env, request, {
        now: () => 1_000,
        isFeatureEnabled: vi.fn().mockResolvedValue(true),
        createBulkRepository: () => ({
          get: vi.fn().mockResolvedValue(currentPlan),
          getTenantExecution: vi.fn().mockResolvedValue(currentExecution),
        }),
        createRepository: () => ({
          getGrant: vi.fn().mockResolvedValue({
            ...bulkGrant,
            resolvedScopeConstraints: { tenantIds: ['platform'] },
          }),
          getActiveDelegatorPermissions: vi.fn().mockResolvedValue(['admin:*']),
          hasCurrentConsent: vi.fn().mockResolvedValue(true),
        }),
        getModeBPermissionLimit: vi.fn().mockResolvedValue(['admin:*']),
        signToken,
      })
    ).rejects.toThrow('authorization_changed');
  });
});
