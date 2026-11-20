import { describe, expect, it, vi } from 'vitest';
import { canonicalizeJson } from '../core/canonical-json';
import {
  LiveAgentAuthorizationService,
  type LiveAgentAuthorizationDependencies,
} from '../core/live-authorization';
import type {
  AgentActorContext,
  AgentGrantContract,
  AgentToolDefinition,
  JsonValue,
} from '../core/types';

describe('canonicalizeJson unicode and structure checks', () => {
  it.each([['😀'], ['x😀'], ['􏿿'], ['𐀀'], [''], ['퟿']])(
    'accepts well-formed string %j',
    (value) => {
      expect(canonicalizeJson(value)).toBe(JSON.stringify(value));
    }
  );

  it.each([['\ud800'], ['x\ud800'], ['\ud800a'], ['\ud800'], ['\ud800\ud800']])(
    'rejects lone high surrogate %j',
    (value) => {
      expect(() => canonicalizeJson(value)).toThrow('JCS input contains a lone high surrogate');
    }
  );

  it.each([['\udc00'], ['\udfff'], ['a\udc00b']])('rejects lone low surrogate %j', (value) => {
    expect(() => canonicalizeJson(value)).toThrow('JCS input contains a lone low surrogate');
  });

  it('checks object keys for well-formed unicode', () => {
    expect(() => canonicalizeJson({ ['\udc00']: 1 })).toThrow(
      'JCS input contains a lone low surrogate'
    );
  });

  it('rejects cycles but allows repeated non-cyclic references', () => {
    const cyclic: JsonValue[] = [];
    cyclic.push(cyclic);
    expect(() => canonicalizeJson(cyclic)).toThrow('JCS input must not contain cycles');
    const obj: { [key: string]: JsonValue } = {};
    obj.self = obj;
    expect(() => canonicalizeJson(obj)).toThrow('JCS input must not contain cycles');
    const shared = { a: 1 };
    expect(canonicalizeJson({ x: shared, y: [shared] })).toBe('{"x":{"a":1},"y":[{"a":1}]}');
  });

  it('accepts null-prototype objects and rejects class instances', () => {
    const bare = Object.create(null) as { [key: string]: JsonValue };
    bare.b = 1;
    bare.a = 2;
    expect(canonicalizeJson(bare)).toBe('{"a":2,"b":1}');
    expect(() => canonicalizeJson(new Date(0) as unknown as JsonValue)).toThrow(
      'JCS objects must be plain JSON objects'
    );
    expect(() => canonicalizeJson(new Map() as unknown as JsonValue)).toThrow(
      'JCS objects must be plain JSON objects'
    );
  });
});

const tool: AgentToolDefinition = {
  id: 'users.list.v1',
  name: 'list_users',
  title: 'List users',
  description: 'Lists users',
  contractVersion: '1',
  requiredPermissions: ['admin:users:read'],
  riskLevel: 'low',
  requiredScope: 'agent:read',
  schemaDigest: 'digest',
  inputSchema: { type: 'object' },
};
const grant: AgentGrantContract = {
  grantId: 'grant-1',
  tenantId: 'tenant-1',
  clientId: 'client-1',
  grantorId: 'admin-1',
  delegatorId: 'admin-1',
  permissions: ['admin:users:read'],
  scopes: ['agent:read'],
  resolvedScopeConstraints: { tenantIds: ['tenant-1'] },
  consentVersion: 1,
  generation: 1,
  status: 'active',
  delegationMode: 'user_consent',
  expiresAt: 1_000,
  taskSetId: 'ats_1',
  taskSetVersion: 2,
  scopePolicyId: 'asp_1',
  scopePolicyVersion: 3,
  resolvedTools: [
    {
      toolId: tool.id,
      toolName: tool.name,
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
const actor: AgentActorContext = {
  mode: 'mode_a',
  sub: 'client:client-1',
  assurance: 'confidential_client',
  tokenBinding: 'bearer',
  clientId: 'client-1',
  machineCredentialId: 'cred-1',
};

function deps(
  overrides: Partial<LiveAgentAuthorizationDependencies> = {}
): LiveAgentAuthorizationDependencies {
  return {
    now: () => 100,
    isFeatureEnabled: vi.fn().mockResolvedValue(true),
    getDelegatorPermissions: vi.fn().mockResolvedValue(['admin:users:read']),
    isConfigurationSnapshotActive: vi.fn().mockResolvedValue(true),
    getRiskPolicy: vi.fn().mockResolvedValue({
      allowedRiskByAssurance: {
        public_client_transaction: ['low'],
        confidential_client: ['low'],
        machine_key: ['high'],
      },
      highRiskRequiresElevation: true,
      dpopRequiredForModeB: true,
    }),
    ...overrides,
  };
}
const deny = (deniedAxis: string, code: string) => ({
  allowed: false,
  requiresElevation: false,
  deniedAxis,
  code,
});
const request = { actor, grant, tool, resource: { tenantId: 'tenant-1' } };
const linked = { ...request, grant: { ...grant, machinePrincipalId: 'p1' } };

describe('LiveAgentAuthorizationService exact decisions', () => {
  it('allows and passes the live snapshot identity to the store', async () => {
    const d = deps();
    await expect(new LiveAgentAuthorizationService(d).authorize(request)).resolves.toEqual({
      allowed: true,
      requiresElevation: false,
    });
    expect(d.isConfigurationSnapshotActive).toHaveBeenCalledWith('tenant-1', {
      taskSetId: 'ats_1',
      taskSetVersion: 2,
      scopePolicyId: 'asp_1',
      scopePolicyVersion: 3,
    });
    expect(d.getDelegatorPermissions).toHaveBeenCalledWith('tenant-1', 'admin-1', 100);
  });

  it('denies an inactive delegator', async () => {
    const d = deps({ getDelegatorPermissions: vi.fn().mockResolvedValue(null) });
    await expect(new LiveAgentAuthorizationService(d).authorize(request)).resolves.toEqual(
      deny('permission', 'AGENT_DELEGATOR_INACTIVE')
    );
  });

  it('denies when the snapshot cannot be checked or is inactive', async () => {
    await expect(
      new LiveAgentAuthorizationService(
        deps({ isConfigurationSnapshotActive: undefined })
      ).authorize(request)
    ).resolves.toEqual(deny('grant', 'AGENT_CONFIGURATION_SNAPSHOT_UNAVAILABLE'));
    await expect(
      new LiveAgentAuthorizationService(deps()).authorize({
        ...request,
        grant: { ...grant, taskSetId: undefined },
      })
    ).resolves.toEqual(deny('grant', 'AGENT_CONFIGURATION_SNAPSHOT_UNAVAILABLE'));
    await expect(
      new LiveAgentAuthorizationService(
        deps({ isConfigurationSnapshotActive: vi.fn().mockResolvedValue(false) })
      ).authorize(request)
    ).resolves.toEqual(deny('grant', 'AGENT_CONFIGURATION_SNAPSHOT_INACTIVE'));
  });

  it('fails closed when a dependency throws', async () => {
    const d = deps({ getRiskPolicy: vi.fn().mockRejectedValue(new Error('down')) });
    await expect(new LiveAgentAuthorizationService(d).authorize(request)).resolves.toEqual(
      deny('grant', 'AGENT_AUTHORIZATION_STATE_UNAVAILABLE')
    );
  });

  it('requires a principal resolver for principal-linked grants', async () => {
    await expect(new LiveAgentAuthorizationService(deps()).authorize(linked)).resolves.toEqual(
      deny('identity', 'AGENT_PRINCIPAL_STATE_UNAVAILABLE')
    );
  });

  it('denies an inactive principal and passes the credential to the resolver', async () => {
    const getPrincipalPermissionLimit = vi.fn().mockResolvedValue(null);
    await expect(
      new LiveAgentAuthorizationService(deps({ getPrincipalPermissionLimit })).authorize(linked)
    ).resolves.toEqual(deny('identity', 'AGENT_PRINCIPAL_INACTIVE'));
    expect(getPrincipalPermissionLimit).toHaveBeenCalledWith('tenant-1', 'p1', 'cred-1', 100);
  });

  it('uses the resolved principal permissions as the live ceiling', async () => {
    const allow = vi.fn().mockResolvedValue(['admin:users:read']);
    await expect(
      new LiveAgentAuthorizationService(deps({ getPrincipalPermissionLimit: allow })).authorize(
        linked
      )
    ).resolves.toEqual({ allowed: true, requiresElevation: false });
    const narrow = vi.fn().mockResolvedValue(['admin:clients:read']);
    await expect(
      new LiveAgentAuthorizationService(deps({ getPrincipalPermissionLimit: narrow })).authorize(
        linked
      )
    ).resolves.toEqual(deny('permission', 'AGENT_INSUFFICIENT_PERMISSION'));
  });

  it('does not consult the principal resolver for unlinked grants', async () => {
    const resolver = vi.fn().mockResolvedValue(null);
    await expect(
      new LiveAgentAuthorizationService(deps({ getPrincipalPermissionLimit: resolver })).authorize(
        request
      )
    ).resolves.toEqual({ allowed: true, requiresElevation: false });
    expect(resolver).not.toHaveBeenCalled();
  });
});
