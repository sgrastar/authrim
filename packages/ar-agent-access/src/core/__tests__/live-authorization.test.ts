import { describe, expect, it, vi } from 'vitest';
import type { AgentGrantContract, AgentToolDefinition } from '../types';
import { LiveAgentAuthorizationService } from '../live-authorization';

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
  taskSetId: 'ats_read-only',
  taskSetVersion: 1,
  scopePolicyId: 'asp_tenant-1',
  scopePolicyVersion: 1,
  resolvedTools: [
    {
      toolId: 'users.list.v1',
      toolName: 'list_users',
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

function service(overrides: Record<string, unknown> = {}) {
  return new LiveAgentAuthorizationService({
    now: () => 100,
    isFeatureEnabled: vi.fn().mockResolvedValue(true),
    getDelegatorPermissions: vi.fn().mockResolvedValue(['admin:users:read']),
    isConfigurationSnapshotActive: vi.fn().mockResolvedValue(true),
    getRiskPolicy: vi.fn().mockResolvedValue({
      allowedRiskByAssurance: {
        public_client_transaction: ['low'],
        confidential_client: ['low', 'standard'],
        machine_key: ['low', 'standard', 'high'],
      },
      highRiskRequiresElevation: true,
      dpopRequiredForModeB: true,
    }),
    ...overrides,
  });
}

const request = {
  actor: {
    mode: 'mode_a' as const,
    sub: 'client:client-1',
    assurance: 'public_client_transaction' as const,
    tokenBinding: 'bearer' as const,
    clientId: 'client-1',
  },
  grant,
  tool,
  resource: { tenantId: 'tenant-1' },
};

describe('LiveAgentAuthorizationService', () => {
  it('evaluates the four authorization axes with mutable inputs', async () => {
    await expect(service().authorize(request)).resolves.toEqual({
      allowed: true,
      requiresElevation: false,
    });
  });

  it('fails closed when the current delegator no longer exists', async () => {
    const authorization = service({
      getDelegatorPermissions: vi.fn().mockResolvedValue(null),
    });
    await expect(authorization.authorize(request)).resolves.toMatchObject({
      allowed: false,
      deniedAxis: 'permission',
      code: 'AGENT_DELEGATOR_INACTIVE',
    });
  });

  it('uses the token-downscoped Grant scopes instead of restoring stored scope', async () => {
    const authorization = service();
    await expect(
      authorization.authorize({
        ...request,
        grant: { ...grant, scopes: [] },
      })
    ).resolves.toMatchObject({
      allowed: false,
      deniedAxis: 'scope',
    });
  });

  it('turns dependency failure into a stable fail-closed decision', async () => {
    const authorization = service({
      getRiskPolicy: vi.fn().mockRejectedValue(new Error('settings unavailable')),
    });
    await expect(authorization.authorize(request)).resolves.toMatchObject({
      allowed: false,
      code: 'AGENT_AUTHORIZATION_STATE_UNAVAILABLE',
    });
  });

  it('fails closed when a pinned Task Set or Scope Policy is inactive', async () => {
    const authorization = service({
      isConfigurationSnapshotActive: vi.fn().mockResolvedValue(false),
    });
    await expect(
      authorization.authorize({
        ...request,
        grant: {
          ...grant,
          taskSetId: 'ats_1',
          taskSetVersion: 1,
          scopePolicyId: 'asp_1',
          scopePolicyVersion: 1,
        },
      })
    ).resolves.toMatchObject({
      allowed: false,
      deniedAxis: 'grant',
      code: 'AGENT_CONFIGURATION_SNAPSHOT_INACTIVE',
    });
  });

  it('fails closed when only part of the versioned configuration snapshot is present', async () => {
    await expect(
      service().authorize({
        ...request,
        grant: { ...grant, scopePolicyId: undefined },
      })
    ).resolves.toMatchObject({
      allowed: false,
      code: 'AGENT_CONFIGURATION_SNAPSHOT_UNAVAILABLE',
    });
  });
});
