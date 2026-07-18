import type { AgentAuditEvent, JsonObject } from '../../core';
import type { AgentAuditPort } from '../ports';

export interface CloudflareAdminAgentAuditRepository {
  writeAudit(input: {
    id: string;
    tenantId: string;
    adminUserId?: string;
    action: string;
    resourceType: string;
    resourceId: string;
    severity: 'debug' | 'info' | 'warn' | 'error' | 'critical';
    result: 'success' | 'failure';
    requestId?: string;
    actorType: 'agent';
    actorSub: string;
    actorMode: AgentAuditEvent['actor']['actorMode'];
    actorAssurance: AgentAuditEvent['actor']['actorAssurance'];
    tokenBinding: AgentAuditEvent['actor']['tokenBinding'];
    actClientId: string;
    actPrincipalId?: string;
    grantId: string;
    mcpTool?: string;
    metadata: JsonObject;
    createdAt: number;
  }): Promise<void>;
}

function detailString(details: JsonObject, key: string): string | undefined {
  const value = details[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Maps platform-neutral Agent audit events to the DB_ADMIN audit repository. */
export class CloudflareAdminAgentAuditAdapter implements AgentAuditPort {
  constructor(
    private readonly repository: CloudflareAdminAgentAuditRepository,
    private readonly createId: () => string = () => `audit_${crypto.randomUUID()}`
  ) {}

  async write(event: AgentAuditEvent): Promise<void> {
    await this.repository.writeAudit({
      id: this.createId(),
      tenantId: event.tenantId,
      adminUserId: event.actor.delegatorId,
      action: event.eventType,
      resourceType: 'agent_mcp_tool',
      resourceId: detailString(event.details, 'tool_id') ?? event.actor.grantId,
      severity:
        event.outcome === 'success' ? 'info' : event.outcome === 'denied' ? 'warn' : 'error',
      result: event.outcome === 'success' ? 'success' : 'failure',
      requestId: event.correlationId,
      actorType: 'agent',
      actorSub: event.actor.actorSub,
      actorMode: event.actor.actorMode,
      actorAssurance: event.actor.actorAssurance,
      tokenBinding: event.actor.tokenBinding,
      actClientId: event.actor.clientId,
      actPrincipalId: event.actor.principalId,
      grantId: event.actor.grantId,
      mcpTool: detailString(event.details, 'tool_id'),
      metadata: {
        ...event.details,
        correlation_id: event.correlationId,
        outcome: event.outcome,
      },
      createdAt: event.occurredAt,
    });
  }
}
