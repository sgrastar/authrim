import { describe, expect, it } from 'vitest';
import { evaluateAgentAuthorization, validateAgentGrantPermissions } from '../authorization';
import type { AgentAuthorizationInput, AgentToolDefinition } from '../types';

const tool: AgentToolDefinition = {
  id: 'users.get',
  name: 'get_user',
  title: 'Get user',
  description: 'Returns a masked user record.',
  contractVersion: '1',
  requiredPermissions: ['admin:users:read'],
  riskLevel: 'low',
  requiredScope: 'agent:read',
  schemaDigest: 'sha256:test',
  inputSchema: { type: 'object' },
};

const base: AgentAuthorizationInput = {
  featureEnabled: true,
  now: 100,
  actor: {
    mode: 'mode_a',
    sub: 'client:client-1',
    assurance: 'public_client_transaction',
    tokenBinding: 'bearer',
    clientId: 'client-1',
  },
  grant: {
    grantId: 'grant-1',
    tenantId: 'tenant-1',
    clientId: 'client-1',
    grantorId: 'admin-1',
    delegatorId: 'admin-1',
    permissions: ['admin:users:read'],
    scopes: ['agent:read'],
    consentVersion: 1,
    generation: 1,
    status: 'active',
    delegationMode: 'user_consent',
    expiresAt: 1_000,
    taskSetId: 'ats_read-only',
    taskSetVersion: 1,
    scopePolicyId: 'asp_tenant-1',
    scopePolicyVersion: 1,
    resolvedTools: [
      {
        toolId: tool.id,
        toolName: tool.name,
        contractVersion: tool.contractVersion,
        schemaDigest: tool.schemaDigest,
        permissions: [...tool.requiredPermissions],
        requiredScope: tool.requiredScope,
        riskLevel: tool.riskLevel,
        requiresElevation: false,
      },
    ],
    accessSnapshotHash: 'a'.repeat(43),
  },
  tool,
  delegatorCurrentPermissions: ['admin:users:read'],
  constraints: { tenantIds: ['tenant-1'], piiMode: 'masked' },
  resource: { tenantId: 'tenant-1' },
  riskPolicy: {
    allowedRiskByAssurance: {
      public_client_transaction: ['low'],
      confidential_client: ['standard'],
      machine_key: ['high'],
    },
    highRiskRequiresElevation: true,
    dpopRequiredForModeB: true,
  },
};

describe('evaluateAgentAuthorization', () => {
  it('allows only when each independent authorization axis passes', () => {
    expect(evaluateAgentAuthorization(base)).toEqual({ allowed: true, requiresElevation: false });
  });

  it('fails closed when an active Grant has no recertification deadline', () => {
    expect(
      evaluateAgentAuthorization({
        ...base,
        grant: { ...base.grant, expiresAt: undefined },
      })
    ).toMatchObject({
      allowed: false,
      deniedAxis: 'grant',
      code: 'AGENT_GRANT_INACTIVE',
    });
  });

  it.each([
    ['feature flag', { featureEnabled: false }, 'feature_flag'],
    ['actor', { actor: { ...base.actor, clientId: 'other' } }, 'identity'],
    ['grant', { grant: { ...base.grant, status: 'suspended' as const } }, 'grant'],
    ['permission', { delegatorCurrentPermissions: [] }, 'permission'],
    ['scope', { grant: { ...base.grant, scopes: [] } }, 'scope'],
    ['resource', { resource: { tenantId: 'other' } }, 'resource'],
  ])('fails closed on the %s axis', (_label, override, deniedAxis) => {
    expect(evaluateAgentAuthorization({ ...base, ...override })).toMatchObject({
      allowed: false,
      deniedAxis,
    });
  });

  it('does not let agent:write implicitly satisfy agent:read', () => {
    expect(
      evaluateAgentAuthorization({
        ...base,
        grant: { ...base.grant, scopes: ['agent:write'] },
      })
    ).toMatchObject({ allowed: false, deniedAxis: 'scope' });
  });

  it('fails closed when the versioned configuration snapshot is absent', () => {
    const incomplete = { ...base.grant, accessSnapshotHash: undefined };
    expect(evaluateAgentAuthorization({ ...base, grant: incomplete })).toMatchObject({
      allowed: false,
      deniedAxis: 'grant',
      code: 'AGENT_CONFIGURATION_SNAPSHOT_UNAVAILABLE',
    });
  });

  it('denies a Tool that is not the exact contract pinned by the Grant Task Set', () => {
    const pinned = {
      ...base.grant,
      resolvedTools: [
        {
          toolId: tool.id,
          toolName: tool.name,
          contractVersion: tool.contractVersion,
          schemaDigest: 'sha256:different-contract',
          permissions: [...tool.requiredPermissions],
          requiredScope: tool.requiredScope,
          riskLevel: tool.riskLevel,
          requiresElevation: false,
        },
      ],
    };
    expect(evaluateAgentAuthorization({ ...base, grant: pinned })).toMatchObject({
      allowed: false,
      deniedAxis: 'grant',
      code: 'AGENT_TOOL_NOT_IN_TASK_SET',
    });
  });

  it('requires a DPoP-bound Mode B actor matching the grant principal', () => {
    const decision = evaluateAgentAuthorization({
      ...base,
      actor: {
        mode: 'mode_b',
        sub: 'amp_principal-1',
        assurance: 'machine_key',
        tokenBinding: 'bearer',
        clientId: 'client-1',
        machinePrincipalId: 'principal-1',
      },
      grant: { ...base.grant, machinePrincipalId: 'principal-1' },
      principalPermissionLimit: ['admin:users:read'],
    });
    expect(decision).toMatchObject({ allowed: false, code: 'AGENT_DPOP_REQUIRED' });
  });

  it('rejects machine assurance on a Mode A actor', () => {
    expect(
      evaluateAgentAuthorization({
        ...base,
        actor: { ...base.actor, assurance: 'machine_key' },
      })
    ).toMatchObject({ allowed: false, code: 'AGENT_CLIENT_ACTOR_INVALID' });
  });

  it('treats a Mode A Machine Principal link only as a live permission ceiling', () => {
    const linked = { ...base.grant, machinePrincipalId: 'principal-1' };
    expect(
      evaluateAgentAuthorization({
        ...base,
        grant: linked,
        principalPermissionLimit: ['admin:users:read'],
      })
    ).toMatchObject({ allowed: true });
    expect(
      evaluateAgentAuthorization({ ...base, grant: linked, principalPermissionLimit: [] })
    ).toMatchObject({ allowed: false, deniedAxis: 'permission' });
  });

  it('allows high-risk work for a low-assurance actor only with an operation-bound capability', () => {
    const highRiskInput: AgentAuthorizationInput = {
      ...base,
      grant: {
        ...base.grant,
        permissions: ['admin:users:suspend'],
        scopes: ['agent:write'],
        resolvedTools: [
          {
            toolId: tool.id,
            toolName: tool.name,
            contractVersion: tool.contractVersion,
            schemaDigest: tool.schemaDigest,
            permissions: ['admin:users:suspend'],
            requiredScope: 'agent:write',
            riskLevel: 'high',
            requiresElevation: true,
          },
        ],
      },
      tool: {
        ...tool,
        requiredPermissions: ['admin:users:suspend'],
        requiredScope: 'agent:write',
        riskLevel: 'high',
      },
      delegatorCurrentPermissions: ['admin:users:suspend'],
    };

    expect(evaluateAgentAuthorization(highRiskInput)).toMatchObject({
      allowed: false,
      requiresElevation: true,
      code: 'AGENT_ELEVATION_REQUIRED',
    });
    expect(
      evaluateAgentAuthorization({ ...highRiskInput, elevationCapabilityValid: true })
    ).toEqual({ allowed: true, requiresElevation: false });
  });

  it('lets tenant Risk Policy raise a standard Tool permission to high risk', () => {
    const decision = evaluateAgentAuthorization({
      ...base,
      riskPolicy: {
        ...base.riskPolicy,
        highRiskPermissionsAdditional: ['admin:users:read'],
      },
    });
    expect(decision).toMatchObject({
      allowed: false,
      requiresElevation: true,
      deniedAxis: 'risk',
      code: 'AGENT_ELEVATION_REQUIRED',
    });
  });

  it('allows only an explicitly opted-in standard Tool for a public Mode A client', () => {
    const standardTool: AgentToolDefinition = {
      ...tool,
      id: 'admin.write.clients.metadata',
      name: 'update_client_metadata',
      requiredPermissions: ['admin:clients:write'],
      requiredScope: 'agent:write',
      riskLevel: 'standard',
    };
    const standardInput: AgentAuthorizationInput = {
      ...base,
      grant: {
        ...base.grant,
        permissions: ['admin:clients:write'],
        scopes: ['agent:write'],
        resolvedTools: [
          {
            toolId: standardTool.id,
            toolName: standardTool.name,
            contractVersion: standardTool.contractVersion,
            schemaDigest: standardTool.schemaDigest,
            permissions: [...standardTool.requiredPermissions],
            requiredScope: standardTool.requiredScope,
            riskLevel: standardTool.riskLevel,
            requiresElevation: false,
          },
        ],
      },
      tool: standardTool,
      resource: { ...base.resource, quantity: 1 },
      delegatorCurrentPermissions: ['admin:clients:write'],
    };

    expect(evaluateAgentAuthorization(standardInput)).toMatchObject({
      allowed: false,
      deniedAxis: 'risk',
      code: 'AGENT_RISK_POLICY_DENIED',
    });
    expect(
      evaluateAgentAuthorization({
        ...standardInput,
        riskPolicy: {
          ...standardInput.riskPolicy,
          publicClientStandardToolIds: [standardTool.id],
        },
      })
    ).toEqual({ allowed: true, requiresElevation: false });
    expect(
      evaluateAgentAuthorization({
        ...standardInput,
        riskPolicy: {
          ...standardInput.riskPolicy,
          publicClientStandardToolIds: ['admin.write.other'],
        },
      })
    ).toMatchObject({ allowed: false, code: 'AGENT_RISK_POLICY_DENIED' });
    expect(
      evaluateAgentAuthorization({
        ...standardInput,
        resource: { ...standardInput.resource, quantity: 2 },
        riskPolicy: {
          ...standardInput.riskPolicy,
          publicClientStandardToolIds: [standardTool.id],
        },
      })
    ).toMatchObject({
      allowed: false,
      deniedAxis: 'resource',
      code: 'AGENT_PUBLIC_CLIENT_SINGLE_SUBJECT_REQUIRED',
    });
  });
});

describe('validateAgentGrantPermissions', () => {
  it.each([
    ['client tenant', { clientTenantId: 'tenant-2' }],
    ['grantor tenant', { grantorTenantId: 'tenant-2' }],
    ['delegator tenant', { delegatorTenantId: 'tenant-2' }],
  ])('rejects a cross-tenant %s at Grant creation', (_label, boundaryOverride) => {
    expect(
      validateAgentGrantPermissions({
        tenantBoundary: {
          tenantId: 'tenant-1',
          clientTenantId: 'tenant-1',
          grantorTenantId: 'tenant-1',
          delegatorTenantId: 'tenant-1',
          ...boundaryOverride,
        },
        requestedPermissions: ['admin:users:read'],
        grantorPermissions: ['admin:users:read'],
        delegatorPermissions: ['admin:users:read'],
      })
    ).toEqual({ valid: false, code: 'AGENT_GRANT_TENANT_BOUNDARY' });
  });

  it.each([
    ['grantor', { grantorPermissions: [] }, 'AGENT_GRANT_PERMISSION_EXCEEDS_GRANTOR'],
    ['delegator', { delegatorPermissions: [] }, 'AGENT_GRANT_PERMISSION_EXCEEDS_DELEGATOR'],
    ['principal', { principalPermissions: [] }, 'AGENT_GRANT_PERMISSION_EXCEEDS_PRINCIPAL'],
  ])('rejects a permission above the %s ceiling', (_label, override, code) => {
    expect(
      validateAgentGrantPermissions({
        tenantBoundary: {
          tenantId: 'tenant-1',
          clientTenantId: 'tenant-1',
          grantorTenantId: 'tenant-1',
          delegatorTenantId: 'tenant-1',
          principalTenantScopes: [{ scopeMode: 'allow', tenantId: 'tenant-1' }],
        },
        requestedPermissions: ['admin:users:read'],
        grantorPermissions: ['admin:users:read'],
        delegatorPermissions: ['admin:users:read'],
        machinePrincipalId: 'principal-1',
        principalPermissions: ['admin:users:read'],
        ...override,
      })
    ).toEqual({ valid: false, code, permission: 'admin:users:read' });
  });

  it('rejects scope_mode=all for an Agent principal', () => {
    expect(
      validateAgentGrantPermissions({
        tenantBoundary: {
          tenantId: 'tenant-1',
          clientTenantId: 'tenant-1',
          grantorTenantId: 'tenant-1',
          delegatorTenantId: 'tenant-1',
          principalTenantScopes: [{ scopeMode: 'all', tenantId: null }],
        },
        requestedPermissions: ['admin:users:read'],
        grantorPermissions: ['admin:users:read'],
        delegatorPermissions: ['admin:users:read'],
        machinePrincipalId: 'principal-1',
        principalPermissions: ['admin:users:read'],
      })
    ).toEqual({ valid: false, code: 'AGENT_GRANT_TENANT_BOUNDARY' });
  });

  it('rejects a Machine Principal grant without explicit tenant scopes', () => {
    expect(
      validateAgentGrantPermissions({
        tenantBoundary: {
          tenantId: 'tenant-1',
          clientTenantId: 'tenant-1',
          grantorTenantId: 'tenant-1',
          delegatorTenantId: 'tenant-1',
        },
        requestedPermissions: ['admin:users:read'],
        grantorPermissions: ['admin:users:read'],
        delegatorPermissions: ['admin:users:read'],
        machinePrincipalId: 'principal-1',
        principalPermissions: ['admin:users:read'],
      })
    ).toEqual({ valid: false, code: 'AGENT_GRANT_TENANT_BOUNDARY' });
  });
});
