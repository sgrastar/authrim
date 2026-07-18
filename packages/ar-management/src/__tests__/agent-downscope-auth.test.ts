import type { Context } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AgentGrantContract } from '@authrim/ar-agent-access/core';
import type { Env } from '@authrim/ar-lib-core';
import {
  authenticateAgentDownscopeBearer,
  type AgentDownscopeAuthDependencies,
} from '../agent-downscope-auth';

const grant: AgentGrantContract = {
  grantId: 'grant-1',
  tenantId: 'tenant-1',
  clientId: 'client-1',
  grantorId: 'admin-1',
  delegatorId: 'admin-1',
  permissions: ['admin:users:read'],
  scopes: ['agent:read'],
  resolvedScopeConstraints: { tenantIds: ['tenant-1'], piiMode: 'masked' },
  consentVersion: 3,
  generation: 2,
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
  expiresAt: 1_000,
};

const claims = {
  sub: 'admin_user:admin-1',
  jti: 'downscope-jti',
  scope: 'admin:users:read',
  permissions: ['admin:users:read'],
  client_id: 'client-1',
  tenant_id: 'tenant-1',
  grant_id: 'grant-1',
  grant_generation: 2,
  consent_version: 3,
  actor_type: 'agent',
  actor_mode: 'mode_a',
  actor_assurance: 'public_client_transaction',
  act: { sub: 'client:client-1' },
  source_token_jti: 'source-jti',
  correlation_id: 'correlation-1',
};

function context(): Context<{ Bindings: Env & { ENABLE_AGENT_MCP?: string } }> {
  return {
    env: {} as Env,
    req: { raw: new Request('https://tenant-1.authrim.example/api/admin/users') },
  } as Context<{ Bindings: Env & { ENABLE_AGENT_MCP?: string } }>;
}

function dependencies(
  override: Partial<{
    grant: AgentGrantContract | null;
    permissions: string[] | null;
    consent: boolean;
    claims: unknown;
    featureEnabled: boolean;
    machinePermissions: string[] | null;
  }> = {}
): Partial<AgentDownscopeAuthDependencies> {
  return {
    now: () => 100,
    isFeatureEnabled: async () => override.featureEnabled ?? true,
    verifyJwt: async () => override.claims ?? claims,
    createRepository: () => ({
      getGrant: vi.fn(async () => (override.grant === undefined ? grant : override.grant)),
      getActiveDelegatorPermissions: vi.fn(async () =>
        override.permissions === undefined ? ['admin:users:read'] : override.permissions
      ),
      hasCurrentConsent: vi.fn(async () => override.consent ?? true),
    }),
    getModeBPermissionLimit: vi.fn(async () =>
      override.machinePermissions === undefined ? ['admin:users:read'] : override.machinePermissions
    ),
  };
}

describe('authenticateAgentDownscopeBearer', () => {
  it('returns a permission-bounded Agent admin context after all live fences pass', async () => {
    await expect(
      authenticateAgentDownscopeBearer(context(), 'token', 'tenant-1', dependencies())
    ).resolves.toMatchObject({
      userId: 'admin-1',
      actorType: 'agent',
      actorId: 'client:client-1',
      tenantScope: ['tenant-1'],
      permissions: ['admin:users:read'],
      agentGrantId: 'grant-1',
      agentGrantGeneration: 2,
      sourceTokenJti: 'source-jti',
    });
  });

  it('accepts Mode B only while the principal and credential remain live', async () => {
    const modeBClaims = {
      ...claims,
      actor_mode: 'mode_b',
      actor_assurance: 'machine_key',
      act: { sub: 'machine:amp-1' },
      act_principal_id: 'amp-1',
      act_credential_id: 'amk-1',
    };
    await expect(
      authenticateAgentDownscopeBearer(
        context(),
        'token',
        'tenant-1',
        dependencies({
          claims: modeBClaims,
          grant: { ...grant, machinePrincipalId: 'amp-1' },
        })
      )
    ).resolves.toMatchObject({
      actorId: 'machine:amp-1',
      agentMode: 'mode_b',
      agentAssurance: 'machine_key',
    });

    await expect(
      authenticateAgentDownscopeBearer(
        context(),
        'token',
        'tenant-1',
        dependencies({
          claims: modeBClaims,
          grant: { ...grant, machinePrincipalId: 'amp-1' },
          machinePermissions: null,
        })
      )
    ).resolves.toBeNull();
  });

  it('rechecks a Mode A linked principal as an owner-side permission ceiling', async () => {
    const linkedGrant = { ...grant, machinePrincipalId: 'amp-policy' };
    await expect(
      authenticateAgentDownscopeBearer(
        context(),
        'token',
        'tenant-1',
        dependencies({ grant: linkedGrant, machinePermissions: ['admin:users:read'] })
      )
    ).resolves.toMatchObject({ actorId: 'client:client-1', permissions: ['admin:users:read'] });

    await expect(
      authenticateAgentDownscopeBearer(
        context(),
        'token',
        'tenant-1',
        dependencies({ grant: linkedGrant, machinePermissions: null })
      )
    ).resolves.toBeNull();
  });

  it.each([
    ['disabled feature', { featureEnabled: false }],
    ['cross-tenant claim', { claims: { ...claims, tenant_id: 'tenant-2' } }],
    ['stale generation', { grant: { ...grant, generation: 3 } }],
    ['revoked consent', { consent: false }],
    ['delegator permission removal', { permissions: [] }],
    ['Mode B actor binding mismatch', { claims: { ...claims, actor_mode: 'mode_b' } }],
  ])('fails closed for %s', async (_label, override) => {
    await expect(
      authenticateAgentDownscopeBearer(context(), 'token', 'tenant-1', dependencies(override))
    ).resolves.toBeNull();
  });
});
