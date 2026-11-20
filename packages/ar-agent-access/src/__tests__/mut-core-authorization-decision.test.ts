import { describe, expect, it } from 'vitest';
import { evaluateAgentAuthorization } from '../core/authorization';
import type { AgentAuthorizationInput, AgentRiskLevel, AgentToolDefinition } from '../core/types';

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

function withTool(
  input: AgentAuthorizationInput,
  risk: AgentRiskLevel,
  permission = 'admin:users:read'
) {
  const t = { ...tool, riskLevel: risk, requiredPermissions: [permission] };
  return {
    ...input,
    tool: t,
    delegatorCurrentPermissions: [permission],
    grant: {
      ...input.grant,
      permissions: [permission],
      resolvedTools: [
        {
          toolId: t.id,
          toolName: t.name,
          contractVersion: t.contractVersion,
          schemaDigest: t.schemaDigest,
          permissions: [permission],
          requiredScope: t.requiredScope,
          riskLevel: risk,
          requiresElevation: risk === 'high',
        },
      ],
    },
  } satisfies AgentAuthorizationInput;
}

const base: AgentAuthorizationInput = withTool(
  {
    featureEnabled: true,
    now: 100,
    actor: {
      mode: 'mode_a',
      sub: 'client:client-1',
      assurance: 'confidential_client',
      tokenBinding: 'bearer',
      clientId: 'client-1',
    },
    grant: {
      grantId: 'grant-1',
      tenantId: 'tenant-1',
      clientId: 'client-1',
      grantorId: 'admin-1',
      delegatorId: 'admin-1',
      permissions: [],
      scopes: ['agent:read'],
      resolvedScopeConstraints: { tenantIds: ['tenant-1'], piiMode: 'masked' },
      consentVersion: 1,
      generation: 1,
      status: 'active',
      delegationMode: 'user_consent',
      expiresAt: 1_000,
      taskSetId: 'ats_read-only',
      taskSetVersion: 1,
      scopePolicyId: 'asp_tenant-1',
      scopePolicyVersion: 1,
      resolvedTools: [],
      accessSnapshotHash: 'a'.repeat(43),
    },
    tool,
    delegatorCurrentPermissions: [],
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
  },
  'low'
);

const ALLOW = { allowed: true, requiresElevation: false };
const deny = (deniedAxis: string, code: string, requiresElevation = false) => ({
  allowed: false,
  requiresElevation,
  deniedAxis,
  code,
});

const modeB: AgentAuthorizationInput = {
  ...base,
  actor: {
    mode: 'mode_b',
    sub: 'amp_p1',
    assurance: 'machine_key',
    tokenBinding: 'dpop',
    clientId: 'client-1',
    machinePrincipalId: 'p1',
  },
  grant: { ...base.grant, machinePrincipalId: 'p1' },
  principalPermissionLimit: ['admin:users:read'],
};

describe('evaluateAgentAuthorization exact decisions', () => {
  it('allows the baseline input', () => {
    expect(evaluateAgentAuthorization(base)).toEqual(ALLOW);
  });

  it('denies when the feature flag is off', () => {
    expect(evaluateAgentAuthorization({ ...base, featureEnabled: false })).toEqual(
      deny('feature_flag', 'AGENT_MCP_DISABLED')
    );
  });

  it('denies an actor client mismatch', () => {
    expect(
      evaluateAgentAuthorization({ ...base, actor: { ...base.actor, clientId: 'client-2' } })
    ).toEqual(deny('identity', 'AGENT_ACTOR_MISMATCH'));
  });

  it('denies a Mode A actor carrying machine identity', () => {
    expect(
      evaluateAgentAuthorization({ ...base, actor: { ...base.actor, assurance: 'machine_key' } })
    ).toEqual(deny('identity', 'AGENT_CLIENT_ACTOR_INVALID'));
    expect(
      evaluateAgentAuthorization({ ...base, actor: { ...base.actor, machinePrincipalId: 'p1' } })
    ).toEqual(deny('identity', 'AGENT_CLIENT_ACTOR_INVALID'));
  });

  it('allows a valid DPoP-bound Mode B actor', () => {
    expect(evaluateAgentAuthorization(modeB)).toEqual(ALLOW);
  });

  it.each([
    ['non-machine assurance', { assurance: 'confidential_client' as const }],
    ['missing principal', { machinePrincipalId: undefined }],
    ['empty principal', { machinePrincipalId: '' }],
    ['other principal', { machinePrincipalId: 'p2' }],
  ])('denies a Mode B actor with %s', (_label, override) => {
    expect(
      evaluateAgentAuthorization({ ...modeB, actor: { ...modeB.actor, ...override } })
    ).toEqual(deny('identity', 'AGENT_MACHINE_ACTOR_INVALID'));
  });

  it('requires DPoP for Mode B only when the risk policy says so', () => {
    const bearer = { ...modeB, actor: { ...modeB.actor, tokenBinding: 'bearer' as const } };
    expect(evaluateAgentAuthorization(bearer)).toEqual(deny('identity', 'AGENT_DPOP_REQUIRED'));
    expect(
      evaluateAgentAuthorization({
        ...bearer,
        riskPolicy: { ...bearer.riskPolicy, dpopRequiredForModeB: false },
      })
    ).toEqual(ALLOW);
  });

  it.each([
    ['suspended', { status: 'suspended' as const }],
    ['no expiry', { expiresAt: undefined }],
    ['expired exactly now', { expiresAt: 100 }],
    ['expired before now', { expiresAt: 99 }],
  ])('denies an inactive grant (%s)', (_label, override) => {
    expect(evaluateAgentAuthorization({ ...base, grant: { ...base.grant, ...override } })).toEqual(
      deny('grant', 'AGENT_GRANT_INACTIVE')
    );
  });

  it('allows a grant expiring one tick after now', () => {
    expect(
      evaluateAgentAuthorization({ ...base, grant: { ...base.grant, expiresAt: 101 } })
    ).toEqual(ALLOW);
  });

  it('denies an incomplete configuration snapshot', () => {
    expect(
      evaluateAgentAuthorization({ ...base, grant: { ...base.grant, taskSetVersion: 0 } })
    ).toEqual(deny('grant', 'AGENT_CONFIGURATION_SNAPSHOT_UNAVAILABLE'));
  });

  it('denies a tool that is not pinned', () => {
    expect(
      evaluateAgentAuthorization({ ...base, tool: { ...base.tool, contractVersion: '2' } })
    ).toEqual(deny('grant', 'AGENT_TOOL_NOT_IN_TASK_SET'));
  });

  it('denies a resource outside the grant tenant on the resource axis', () => {
    expect(
      evaluateAgentAuthorization({
        ...base,
        resource: { tenantId: 'tenant-2' },
        constraints: { tenantIds: ['tenant-1', 'tenant-2'] },
      })
    ).toEqual(deny('resource', 'AGENT_GRANT_TENANT_BOUNDARY'));
  });

  it.each([
    ['grant permissions', { grant: { ...base.grant, permissions: [] } }],
    ['delegator current permissions', { delegatorCurrentPermissions: ['admin:clients:read'] }],
  ])('denies when %s do not cover the tool', (_label, override) => {
    expect(evaluateAgentAuthorization({ ...base, ...override })).toEqual(
      deny('permission', 'AGENT_INSUFFICIENT_PERMISSION')
    );
  });

  it('requires a principal limit for principal-linked grants', () => {
    const linked = { ...base, grant: { ...base.grant, machinePrincipalId: 'p1' } };
    expect(evaluateAgentAuthorization(linked)).toEqual(
      deny('permission', 'AGENT_INSUFFICIENT_PERMISSION')
    );
    expect(
      evaluateAgentAuthorization({ ...linked, principalPermissionLimit: ['admin:clients:read'] })
    ).toEqual(deny('permission', 'AGENT_INSUFFICIENT_PERMISSION'));
    expect(
      evaluateAgentAuthorization({ ...linked, principalPermissionLimit: ['admin:users:read'] })
    ).toEqual(ALLOW);
  });

  it('ignores the principal limit for grants without a principal', () => {
    expect(evaluateAgentAuthorization({ ...base, principalPermissionLimit: [] })).toEqual(ALLOW);
  });

  it('denies a missing scope', () => {
    expect(
      evaluateAgentAuthorization({ ...base, grant: { ...base.grant, scopes: ['agent:write'] } })
    ).toEqual(deny('scope', 'AGENT_INSUFFICIENT_SCOPE'));
  });

  it('denies a violated resource constraint', () => {
    expect(
      evaluateAgentAuthorization({
        ...base,
        resource: { tenantId: 'tenant-1', requestsUnmaskedPii: true },
      })
    ).toEqual(deny('resource', 'AGENT_RESOURCE_CONSTRAINT'));
    expect(
      evaluateAgentAuthorization({ ...base, constraints: { tenantIds: ['tenant-9'] } })
    ).toEqual(deny('resource', 'AGENT_RESOURCE_CONSTRAINT'));
  });
});

describe('evaluateAgentAuthorization risk handling', () => {
  const high = withTool(base, 'high', 'admin:users:suspend');

  it('requires elevation for high risk tools', () => {
    expect(evaluateAgentAuthorization(high)).toEqual(
      deny('risk', 'AGENT_ELEVATION_REQUIRED', true)
    );
    expect(evaluateAgentAuthorization({ ...high, elevationCapabilityValid: false })).toEqual(
      deny('risk', 'AGENT_ELEVATION_REQUIRED', true)
    );
  });

  it('approves high risk with a valid elevation capability even for low assurance', () => {
    expect(evaluateAgentAuthorization({ ...high, elevationCapabilityValid: true })).toEqual(ALLOW);
  });

  it('falls back to the assurance ladder when elevation is not required', () => {
    const noElevation = {
      ...high,
      riskPolicy: { ...high.riskPolicy, highRiskRequiresElevation: false },
    };
    expect(evaluateAgentAuthorization(noElevation)).toEqual(
      deny('risk', 'AGENT_RISK_POLICY_DENIED')
    );
    expect(evaluateAgentAuthorization({ ...noElevation, elevationCapabilityValid: true })).toEqual(
      deny('risk', 'AGENT_RISK_POLICY_DENIED')
    );
    expect(
      evaluateAgentAuthorization({
        ...noElevation,
        riskPolicy: {
          ...noElevation.riskPolicy,
          allowedRiskByAssurance: {
            ...noElevation.riskPolicy.allowedRiskByAssurance,
            confidential_client: ['high'],
          },
        },
      })
    ).toEqual(ALLOW);
  });

  it('ranks low < standard < high on the assurance ladder', () => {
    const standard = withTool(base, 'standard');
    expect(evaluateAgentAuthorization(standard)).toEqual(ALLOW);
    const lowOnly = {
      ...standard,
      riskPolicy: {
        ...standard.riskPolicy,
        allowedRiskByAssurance: {
          ...standard.riskPolicy.allowedRiskByAssurance,
          confidential_client: ['low' as const],
        },
      },
    };
    expect(evaluateAgentAuthorization(lowOnly)).toEqual(deny('risk', 'AGENT_RISK_POLICY_DENIED'));
    const none = {
      ...base,
      riskPolicy: {
        ...base.riskPolicy,
        allowedRiskByAssurance: {
          ...base.riskPolicy.allowedRiskByAssurance,
          confidential_client: [],
        },
      },
    };
    expect(evaluateAgentAuthorization(none)).toEqual(deny('risk', 'AGENT_RISK_POLICY_DENIED'));
  });

  it('raises a tool to high risk through tenant additional high-risk permissions', () => {
    const raised = {
      ...base,
      riskPolicy: { ...base.riskPolicy, highRiskPermissionsAdditional: ['admin:users:read'] },
    };
    expect(evaluateAgentAuthorization(raised)).toEqual(
      deny('risk', 'AGENT_ELEVATION_REQUIRED', true)
    );
    expect(
      evaluateAgentAuthorization({
        ...base,
        riskPolicy: { ...base.riskPolicy, highRiskPermissionsAdditional: ['admin:other:read'] },
      })
    ).toEqual(ALLOW);
  });

  describe('public client standard opt-in', () => {
    const publicActor = { ...base.actor, assurance: 'public_client_transaction' as const };
    const standard = { ...withTool(base, 'standard'), actor: publicActor };
    const optedIn = {
      ...standard,
      riskPolicy: { ...standard.riskPolicy, publicClientStandardToolIds: [tool.id] },
    };

    it('denies a standard tool for a public client without opt-in', () => {
      expect(
        evaluateAgentAuthorization({ ...standard, resource: { tenantId: 'tenant-1', quantity: 1 } })
      ).toEqual(deny('risk', 'AGENT_RISK_POLICY_DENIED'));
      expect(
        evaluateAgentAuthorization({
          ...standard,
          riskPolicy: { ...standard.riskPolicy, publicClientStandardToolIds: ['other.tool'] },
          resource: { tenantId: 'tenant-1', quantity: 1 },
        })
      ).toEqual(deny('risk', 'AGENT_RISK_POLICY_DENIED'));
    });

    it('allows an opted-in standard tool only for exactly one subject', () => {
      expect(
        evaluateAgentAuthorization({ ...optedIn, resource: { tenantId: 'tenant-1', quantity: 1 } })
      ).toEqual(ALLOW);
      expect(evaluateAgentAuthorization(optedIn)).toEqual(
        deny('resource', 'AGENT_PUBLIC_CLIENT_SINGLE_SUBJECT_REQUIRED')
      );
      expect(
        evaluateAgentAuthorization({ ...optedIn, resource: { tenantId: 'tenant-1', quantity: 2 } })
      ).toEqual(deny('resource', 'AGENT_PUBLIC_CLIENT_SINGLE_SUBJECT_REQUIRED'));
    });

    it('does not apply the opt-in to low-risk tools or other assurances', () => {
      const low = { ...base, actor: publicActor, riskPolicy: optedIn.riskPolicy };
      expect(evaluateAgentAuthorization(low)).toEqual(ALLOW);
      const confidential = { ...optedIn, actor: base.actor };
      expect(evaluateAgentAuthorization(confidential)).toEqual(ALLOW);
      const confidentialLowOnly = {
        ...confidential,
        riskPolicy: {
          ...confidential.riskPolicy,
          allowedRiskByAssurance: {
            ...confidential.riskPolicy.allowedRiskByAssurance,
            confidential_client: ['low' as const],
          },
        },
      };
      expect(evaluateAgentAuthorization(confidentialLowOnly)).toEqual(
        deny('risk', 'AGENT_RISK_POLICY_DENIED')
      );
    });
  });
});
