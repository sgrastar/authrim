import type { AgentActorAssurance, AgentMode, JsonObject } from './types';

export interface AgentAuditActor {
  actorSub: string;
  actorMode: AgentMode;
  actorAssurance: AgentActorAssurance;
  tokenBinding: 'bearer' | 'dpop';
  clientId: string;
  principalId?: string;
  delegatorId: string;
  grantId: string;
}

export interface AgentAuditEvent {
  eventType: string;
  tenantId: string;
  occurredAt: number;
  correlationId: string;
  actor: AgentAuditActor;
  outcome: 'success' | 'denied' | 'failed' | 'indeterminate';
  details: JsonObject;
}

export interface AdminAgentAuditWrite {
  id: string;
  tenantId: string;
  adminUserId?: string;
  action: string;
  resourceType: string;
  resourceId: string;
  severity: 'debug' | 'info' | 'warn' | 'error' | 'critical';
  result?: 'success' | 'failure';
  requestId?: string;
  actorType: 'admin_user' | 'agent' | 'system';
  actorSub: string;
  actorMode?: AgentMode;
  actorAssurance?: AgentActorAssurance;
  tokenBinding?: 'bearer' | 'dpop';
  actClientId?: string;
  actPrincipalId?: string;
  grantId?: string;
  elevationId?: string;
  mcpTool?: string;
  metadata: JsonObject;
  createdAt: number;
}
