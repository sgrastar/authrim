import { describe, expect, it, vi } from 'vitest';
import { CloudflareAgentMcpAdmissionAuditAdapter } from '../mcp-admission-audit';

describe('CloudflareAgentMcpAdmissionAuditAdapter', () => {
  it('persists tenant-bound admission evidence with a system actor and sanitized identifiers', async () => {
    const writeAudit = vi.fn(async () => undefined);
    const adapter = new CloudflareAgentMcpAdmissionAuditAdapter(
      { writeAudit },
      () => 'audit-fixed'
    );

    await adapter.write({
      eventType: 'agent.mcp.authentication.denied',
      occurredAt: 1_000,
      correlationId: 'corr-1',
      outcome: 'denied',
      httpStatus: 401,
      method: 'POST',
      host: 'tenant.example',
      tenantId: 'tenant-1',
      clientIpHash: 'ip_0123456789abcdef01234567',
      sessionIdHash: 'sid_0123456789abcdef01234567',
      details: { code: 'AGENT_MCP_TOKEN_INVALID' },
    });

    expect(writeAudit).toHaveBeenCalledWith({
      id: 'audit-fixed',
      tenantId: 'tenant-1',
      action: 'agent.mcp.authentication.denied',
      resourceType: 'agent_mcp_transport',
      resourceId: 'sid_0123456789abcdef01234567',
      severity: 'warn',
      result: 'failure',
      requestId: 'corr-1',
      actorType: 'system',
      actorSub: 'mcp_admission',
      metadata: expect.objectContaining({
        method: 'POST',
        host: 'tenant.example',
        http_status: 401,
        client_ip_hash: 'ip_0123456789abcdef01234567',
        session_id_hash: 'sid_0123456789abcdef01234567',
        code: 'AGENT_MCP_TOKEN_INVALID',
        event_digest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        integrity_profile: 'authrim-agent-admission-audit-v1',
      }),
      createdAt: 1_000,
    });
  });

  it('does not write a tenant audit row until the canonical tenant is known', async () => {
    const writeAudit = vi.fn(async () => undefined);
    const adapter = new CloudflareAgentMcpAdmissionAuditAdapter({ writeAudit });

    await adapter.write({
      eventType: 'agent.mcp.admission.rate_limited',
      occurredAt: 1_000,
      correlationId: 'corr-1',
      outcome: 'denied',
      httpStatus: 429,
      method: 'POST',
      host: 'unknown.example',
      clientIpHash: 'ip_0123456789abcdef01234567',
      details: { code: 'AGENT_MCP_PREAUTH_RATE_LIMITED' },
    });

    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('accepts an explicitly undefined session hash for a new Streamable HTTP session', async () => {
    const writeAudit = vi.fn(async () => undefined);
    const adapter = new CloudflareAgentMcpAdmissionAuditAdapter(
      { writeAudit },
      () => 'audit-new-session'
    );

    await expect(
      adapter.write({
        eventType: 'agent.mcp.authentication.succeeded',
        occurredAt: 2_000,
        correlationId: 'corr-new-session',
        outcome: 'success',
        httpStatus: 200,
        method: 'POST',
        host: 'tenant.example',
        tenantId: 'tenant-1',
        clientIpHash: 'ip_0123456789abcdef01234567',
        sessionIdHash: undefined,
        details: {
          actor_assurance: 'public_client_transaction',
          token_binding: 'bearer',
          grant_id: 'grant-1',
        },
      })
    ).resolves.toBeUndefined();

    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'audit-new-session',
        tenantId: 'tenant-1',
        metadata: expect.objectContaining({
          session_id_hash: null,
          event_digest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        }),
      })
    );
  });
});
