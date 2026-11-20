import { describe, expect, it } from 'vitest';
import {
  agentGrantPinsToolContract,
  agentResourceConstraintsAllow,
  hasCompleteAgentConfigurationSnapshot,
  principalExplicitlyAllowsTenant,
  validateAgentGrantPermissions,
  validateAgentTenantBoundary,
} from '../core/authorization';
import type {
  AgentAuthorizationInput,
  AgentGrantValidationInput,
  AgentResolvedToolContract,
  AgentToolDefinition,
} from '../core/types';

const tool: AgentToolDefinition = {
  id: 'users.get',
  name: 'get_user',
  title: 'Get user',
  description: 'Returns a masked user record.',
  contractVersion: '1',
  requiredPermissions: ['admin:users:read', 'admin:clients:read'],
  riskLevel: 'low',
  requiredScope: 'agent:read',
  schemaDigest: 'sha256:test',
  inputSchema: { type: 'object' },
};

const pinned: AgentResolvedToolContract = {
  toolId: tool.id,
  toolName: tool.name,
  contractVersion: tool.contractVersion,
  schemaDigest: tool.schemaDigest,
  permissions: [...tool.requiredPermissions],
  requiredScope: tool.requiredScope,
  riskLevel: tool.riskLevel,
  requiresElevation: false,
};

const snapshot = {
  taskSetId: 'ats_1',
  taskSetVersion: 1,
  scopePolicyId: 'asp_1',
  scopePolicyVersion: 1,
  resolvedTools: [pinned],
  accessSnapshotHash: 'A'.repeat(42) + '_',
};

describe('hasCompleteAgentConfigurationSnapshot', () => {
  it('accepts a fully pinned snapshot', () => {
    expect(hasCompleteAgentConfigurationSnapshot(snapshot)).toBe(true);
  });

  it.each([
    ['empty taskSetId', { taskSetId: '' }],
    ['missing taskSetVersion', { taskSetVersion: undefined }],
    ['fractional taskSetVersion', { taskSetVersion: 1.5 }],
    ['zero taskSetVersion', { taskSetVersion: 0 }],
    ['empty scopePolicyId', { scopePolicyId: '' }],
    ['missing scopePolicyVersion', { scopePolicyVersion: undefined }],
    ['unsafe scopePolicyVersion', { scopePolicyVersion: 2 ** 60 }],
    ['zero scopePolicyVersion', { scopePolicyVersion: 0 }],
    ['missing resolvedTools', { resolvedTools: undefined }],
    ['empty resolvedTools', { resolvedTools: [] }],
    ['missing hash', { accessSnapshotHash: undefined }],
    ['short hash', { accessSnapshotHash: 'a'.repeat(42) }],
    ['long hash', { accessSnapshotHash: 'a'.repeat(44) }],
    ['hash with prefix junk', { accessSnapshotHash: '!' + 'a'.repeat(43) }],
    ['hash with suffix junk', { accessSnapshotHash: 'a'.repeat(43) + '!' }],
    ['hash with padding char', { accessSnapshotHash: 'a'.repeat(42) + '=' }],
  ])('rejects %s', (_label, override) => {
    expect(hasCompleteAgentConfigurationSnapshot({ ...snapshot, ...override })).toBe(false);
  });

  it('accepts version 1 boundaries exactly and larger versions', () => {
    expect(
      hasCompleteAgentConfigurationSnapshot({
        ...snapshot,
        taskSetVersion: 7,
        scopePolicyVersion: 9,
      })
    ).toBe(true);
  });
});

describe('agentGrantPinsToolContract', () => {
  const grantWith = (contract: Partial<AgentResolvedToolContract>) =>
    ({ resolvedTools: [{ ...pinned, ...contract }] }) as AgentAuthorizationInput['grant'];

  it('matches the exact pinned contract, independent of permission order', () => {
    expect(
      agentGrantPinsToolContract(
        grantWith({ permissions: ['admin:clients:read', 'admin:users:read'] }),
        tool
      )
    ).toBe(true);
  });

  it('returns false without resolved tools', () => {
    expect(agentGrantPinsToolContract({} as AgentAuthorizationInput['grant'], tool)).toBe(false);
  });

  it.each([
    ['toolId', { toolId: 'users.other' }],
    ['toolName', { toolName: 'other' }],
    ['contractVersion', { contractVersion: '2' }],
    ['schemaDigest', { schemaDigest: 'sha256:other' }],
    ['permission subset', { permissions: ['admin:users:read'] }],
    ['permission superset', { permissions: [...tool.requiredPermissions, 'admin:x:read'] }],
    ['same length different permissions', { permissions: ['admin:users:read', 'admin:x:read'] }],
    ['duplicate permissions', { permissions: ['admin:users:read', 'admin:users:read'] }],
    ['requiredScope', { requiredScope: 'agent:write' as const }],
    ['riskLevel', { riskLevel: 'standard' as const }],
    ['requiresElevation on low risk', { requiresElevation: true }],
  ])('rejects a mismatched %s', (_label, override) => {
    expect(agentGrantPinsToolContract(grantWith(override), tool)).toBe(false);
  });

  it('requires requiresElevation=true exactly for high-risk tools', () => {
    const highTool = { ...tool, riskLevel: 'high' as const };
    expect(
      agentGrantPinsToolContract(
        grantWith({ riskLevel: 'high', requiresElevation: true }),
        highTool
      )
    ).toBe(true);
    expect(
      agentGrantPinsToolContract(
        grantWith({ riskLevel: 'high', requiresElevation: false }),
        highTool
      )
    ).toBe(false);
  });

  it('finds the matching contract among several pinned tools', () => {
    const grant = {
      resolvedTools: [{ ...pinned, toolId: 'x' }, pinned],
    } as AgentAuthorizationInput['grant'];
    expect(agentGrantPinsToolContract(grant, tool)).toBe(true);
  });
});

describe('principalExplicitlyAllowsTenant', () => {
  it('rejects an "all" scope even if an allow entry also matches', () => {
    expect(
      principalExplicitlyAllowsTenant(
        [
          { scopeMode: 'allow', tenantId: 't1' },
          { scopeMode: 'all', tenantId: null },
        ],
        't1'
      )
    ).toBe(false);
  });

  it('requires an allow entry for exactly that tenant', () => {
    expect(principalExplicitlyAllowsTenant([{ scopeMode: 'allow', tenantId: 't1' }], 't1')).toBe(
      true
    );
    expect(principalExplicitlyAllowsTenant([{ scopeMode: 'allow', tenantId: 't2' }], 't1')).toBe(
      false
    );
    expect(principalExplicitlyAllowsTenant([{ scopeMode: 'none', tenantId: 't1' }], 't1')).toBe(
      false
    );
    expect(principalExplicitlyAllowsTenant([], 't1')).toBe(false);
  });
});

describe('validateAgentTenantBoundary', () => {
  const boundary = {
    tenantId: 't1',
    clientTenantId: 't1',
    grantorTenantId: 't1',
    delegatorTenantId: 't1',
  };

  it('allows same-tenant parties without principal scopes', () => {
    expect(validateAgentTenantBoundary(boundary)).toBe(true);
  });

  it.each([['clientTenantId'], ['grantorTenantId'], ['delegatorTenantId']])(
    'rejects a cross-tenant %s',
    (field) => {
      expect(validateAgentTenantBoundary({ ...boundary, [field]: 't2' })).toBe(false);
    }
  );

  it('delegates to the explicit principal tenant scopes when present', () => {
    expect(
      validateAgentTenantBoundary({
        ...boundary,
        principalTenantScopes: [{ scopeMode: 'allow', tenantId: 't1' }],
      })
    ).toBe(true);
    expect(
      validateAgentTenantBoundary({
        ...boundary,
        principalTenantScopes: [{ scopeMode: 'all', tenantId: null }],
      })
    ).toBe(false);
  });
});

describe('validateAgentGrantPermissions', () => {
  const input: AgentGrantValidationInput = {
    tenantBoundary: {
      tenantId: 't1',
      clientTenantId: 't1',
      grantorTenantId: 't1',
      delegatorTenantId: 't1',
    },
    requestedPermissions: ['admin:users:read', 'admin:clients:read'],
    grantorPermissions: ['admin:users:read', 'admin:clients:read'],
    delegatorPermissions: ['admin:users:read', 'admin:clients:read'],
  };

  it('returns exactly { valid: true } when every ceiling covers every permission', () => {
    expect(validateAgentGrantPermissions(input)).toEqual({ valid: true });
  });

  it('requires principal tenant scopes for a machine principal', () => {
    expect(
      validateAgentGrantPermissions({
        ...input,
        machinePrincipalId: 'p1',
        principalPermissions: ['*'],
      })
    ).toEqual({ valid: false, code: 'AGENT_GRANT_TENANT_BOUNDARY' });
  });

  it('rejects a cross-tenant boundary', () => {
    expect(
      validateAgentGrantPermissions({
        ...input,
        tenantBoundary: { ...input.tenantBoundary, grantorTenantId: 't2' },
      })
    ).toEqual({ valid: false, code: 'AGENT_GRANT_TENANT_BOUNDARY' });
  });

  it('names the first permission that exceeds the grantor', () => {
    expect(
      validateAgentGrantPermissions({ ...input, grantorPermissions: ['admin:users:read'] })
    ).toEqual({
      valid: false,
      code: 'AGENT_GRANT_PERMISSION_EXCEEDS_GRANTOR',
      permission: 'admin:clients:read',
    });
  });

  it('names the permission that exceeds the delegator', () => {
    expect(
      validateAgentGrantPermissions({ ...input, delegatorPermissions: ['admin:clients:read'] })
    ).toEqual({
      valid: false,
      code: 'AGENT_GRANT_PERMISSION_EXCEEDS_DELEGATOR',
      permission: 'admin:users:read',
    });
  });

  const machine: AgentGrantValidationInput = {
    ...input,
    machinePrincipalId: 'p1',
    tenantBoundary: {
      ...input.tenantBoundary,
      principalTenantScopes: [{ scopeMode: 'allow', tenantId: 't1' }],
    },
  };

  it('caps a machine-principal grant by the principal permissions', () => {
    expect(
      validateAgentGrantPermissions({
        ...machine,
        principalPermissions: input.requestedPermissions,
      })
    ).toEqual({
      valid: true,
    });
    expect(validateAgentGrantPermissions(machine)).toEqual({
      valid: false,
      code: 'AGENT_GRANT_PERMISSION_EXCEEDS_PRINCIPAL',
      permission: 'admin:users:read',
    });
    expect(
      validateAgentGrantPermissions({ ...machine, principalPermissions: ['admin:users:read'] })
    ).toEqual({
      valid: false,
      code: 'AGENT_GRANT_PERMISSION_EXCEEDS_PRINCIPAL',
      permission: 'admin:clients:read',
    });
  });

  it('ignores principal permissions when no machine principal is linked', () => {
    expect(validateAgentGrantPermissions({ ...input, principalPermissions: [] })).toEqual({
      valid: true,
    });
  });
});

describe('agentResourceConstraintsAllow', () => {
  const base = { tenantIds: ['t1'] };

  it('allows a bare tenant match and rejects other tenants', () => {
    expect(agentResourceConstraintsAllow(base, { tenantId: 't1' })).toBe(true);
    expect(agentResourceConstraintsAllow(base, { tenantId: 't2' })).toBe(false);
  });

  it('enforces environment allow-lists', () => {
    const c = { ...base, environmentIds: ['prod'] };
    expect(agentResourceConstraintsAllow(c, { tenantId: 't1', environmentId: 'prod' })).toBe(true);
    expect(agentResourceConstraintsAllow(c, { tenantId: 't1', environmentId: 'dev' })).toBe(false);
    expect(agentResourceConstraintsAllow(c, { tenantId: 't1' })).toBe(false);
    expect(agentResourceConstraintsAllow(base, { tenantId: 't1', environmentId: 'dev' })).toBe(
      true
    );
  });

  it('enforces domain allow-lists', () => {
    const c = { ...base, domains: ['users'] };
    expect(agentResourceConstraintsAllow(c, { tenantId: 't1', domain: 'users' })).toBe(true);
    expect(agentResourceConstraintsAllow(c, { tenantId: 't1', domain: 'clients' })).toBe(false);
    expect(agentResourceConstraintsAllow(c, { tenantId: 't1' })).toBe(false);
    expect(agentResourceConstraintsAllow(base, { tenantId: 't1', domain: 'clients' })).toBe(true);
  });

  it('enforces explicit id selectors', () => {
    const c = { ...base, resourceSelector: { kind: 'ids' as const, ids: ['u1'] } };
    expect(agentResourceConstraintsAllow(c, { tenantId: 't1', resourceId: 'u1' })).toBe(true);
    expect(agentResourceConstraintsAllow(c, { tenantId: 't1', resourceId: 'u2' })).toBe(false);
    expect(agentResourceConstraintsAllow(c, { tenantId: 't1' })).toBe(false);
    expect(
      agentResourceConstraintsAllow(c, {
        tenantId: 't1',
        resourceId: 'u2',
        catalogSelectorMatched: true,
      })
    ).toBe(false);
  });

  it('requires a positive owner match for catalog selectors', () => {
    const c = {
      ...base,
      resourceSelector: { kind: 'catalog' as const, selectorId: 's', version: 1 },
    };
    expect(agentResourceConstraintsAllow(c, { tenantId: 't1', catalogSelectorMatched: true })).toBe(
      true
    );
    expect(
      agentResourceConstraintsAllow(c, { tenantId: 't1', catalogSelectorMatched: false })
    ).toBe(false);
    expect(agentResourceConstraintsAllow(c, { tenantId: 't1', resourceId: 'u1' })).toBe(false);
  });

  it('enforces allowed fields', () => {
    const c = { ...base, allowedFields: ['email', 'name'] };
    expect(agentResourceConstraintsAllow(c, { tenantId: 't1', requestedFields: ['email'] })).toBe(
      true
    );
    expect(
      agentResourceConstraintsAllow(c, { tenantId: 't1', requestedFields: ['email', 'phone'] })
    ).toBe(false);
    expect(agentResourceConstraintsAllow(c, { tenantId: 't1' })).toBe(true);
    expect(
      agentResourceConstraintsAllow(base, { tenantId: 't1', requestedFields: ['phone'] })
    ).toBe(true);
  });

  it('only exposes unmasked PII under an unmasked policy', () => {
    expect(agentResourceConstraintsAllow(base, { tenantId: 't1', requestsUnmaskedPii: true })).toBe(
      false
    );
    expect(
      agentResourceConstraintsAllow(
        { ...base, piiMode: 'masked' },
        { tenantId: 't1', requestsUnmaskedPii: true }
      )
    ).toBe(false);
    expect(
      agentResourceConstraintsAllow(
        { ...base, piiMode: 'unmasked' },
        { tenantId: 't1', requestsUnmaskedPii: true }
      )
    ).toBe(true);
    expect(
      agentResourceConstraintsAllow(
        { ...base, piiMode: 'masked' },
        { tenantId: 't1', requestsUnmaskedPii: false }
      )
    ).toBe(true);
  });

  it('caps quantity at maxPerCall inclusively', () => {
    const c = { ...base, maxPerCall: 5 };
    expect(agentResourceConstraintsAllow(c, { tenantId: 't1', quantity: 5 })).toBe(true);
    expect(agentResourceConstraintsAllow(c, { tenantId: 't1', quantity: 6 })).toBe(false);
    expect(agentResourceConstraintsAllow(c, { tenantId: 't1' })).toBe(true);
    expect(
      agentResourceConstraintsAllow({ ...base, maxPerCall: 0 }, { tenantId: 't1', quantity: 1 })
    ).toBe(false);
    expect(agentResourceConstraintsAllow(base, { tenantId: 't1', quantity: 1000 })).toBe(true);
  });
});
