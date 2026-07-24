import { createLogger } from '@authrim/ar-lib-core';
import { canonicalizeJson, sha256Base64Url, type AdminAgentAuditWrite } from '../../core';
import type { AgentMcpAdmissionAuditEvent, AgentMcpAdmissionAuditPort } from '../ports';

interface AdmissionAuditRepository {
  writeAudit(audit: AdminAgentAuditWrite): Promise<void>;
}

const log = createLogger().module('AGENT-MCP-ADMISSION');

/**
 * Emits every boundary event to Workers telemetry. Once a tenant has been resolved from the
 * canonical host, it also records the event in DB_ADMIN. No credential or request body is accepted.
 */
export class CloudflareAgentMcpAdmissionAuditAdapter implements AgentMcpAdmissionAuditPort {
  constructor(
    private readonly repository: AdmissionAuditRepository,
    private readonly createId: () => string = () => `audit_${crypto.randomUUID()}`
  ) {}

  async write(event: AgentMcpAdmissionAuditEvent): Promise<void> {
    // Optional transport identifiers are represented by omitted properties. Do not pass explicit
    // `undefined` values into RFC 8785 canonicalization: a new Streamable HTTP session has no
    // MCP-Session-Id yet, and that legitimate state must not turn admission telemetry into a 500.
    const digestEvent = Object.fromEntries(
      Object.entries({
        purpose: 'authrim-agent-admission-audit-v1',
        ...event,
      }).filter((entry): entry is [string, Exclude<(typeof entry)[1], undefined>] => {
        return entry[1] !== undefined;
      })
    );
    const eventDigest = await sha256Base64Url(canonicalizeJson(digestEvent as never));
    const safe = {
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      correlationId: event.correlationId,
      outcome: event.outcome,
      httpStatus: event.httpStatus,
      method: event.method,
      host: event.host,
      tenantId: event.tenantId,
      clientIpHash: event.clientIpHash,
      sessionIdHash: event.sessionIdHash,
      details: event.details,
    };
    if (event.outcome === 'success') log.info('MCP admission security event', safe);
    else log.warn('MCP admission security event', safe);

    if (!event.tenantId) return;
    try {
      await this.repository.writeAudit({
        id: this.createId(),
        tenantId: event.tenantId,
        action: event.eventType,
        resourceType: 'agent_mcp_transport',
        resourceId: event.sessionIdHash ?? event.host,
        severity:
          event.outcome === 'failed' ? 'error' : event.outcome === 'denied' ? 'warn' : 'info',
        result: event.outcome === 'success' ? 'success' : 'failure',
        requestId: event.correlationId,
        actorType: 'system',
        actorSub: 'mcp_admission',
        metadata: {
          method: event.method,
          host: event.host,
          http_status: event.httpStatus,
          client_ip_hash: event.clientIpHash ?? null,
          session_id_hash: event.sessionIdHash ?? null,
          event_digest: eventDigest,
          integrity_profile: 'authrim-agent-admission-audit-v1',
          ...event.details,
        },
        createdAt: event.occurredAt,
      });
    } catch (error) {
      log.error(
        'Failed to persist MCP admission security event',
        {
          eventType: event.eventType,
          tenantId: event.tenantId,
          correlationId: event.correlationId,
        },
        error as Error
      );
    }
  }
}
