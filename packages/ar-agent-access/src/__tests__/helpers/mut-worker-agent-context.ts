import type { AgentAccessMcpRequestContext } from '../../protocol/mcp';

export const agentContext: AgentAccessMcpRequestContext = {
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
    resolvedScopeConstraints: { tenantIds: ['tenant-1'] },
    consentVersion: 1,
    generation: 1,
    status: 'active',
    delegationMode: 'user_consent',
  },
  resource: { tenantId: 'tenant-1' },
  issuerOrigin: 'https://auth.example',
  correlationId: 'correlation-1',
};

export function otherGrantContext(): AgentAccessMcpRequestContext {
  return { ...agentContext, grant: { ...agentContext.grant, grantId: 'grant-2' } };
}
