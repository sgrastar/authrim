import { describe, expect, it, vi } from 'vitest';
import { CloudflareAdminAgentAuditAdapter } from '../admin-agent-audit';

describe('CloudflareAdminAgentAuditAdapter', () => {
  it('preserves Agent actor evidence when writing DB_ADMIN audit', async () => {
    const writeAudit = vi.fn().mockResolvedValue(undefined);
    const adapter = new CloudflareAdminAgentAuditAdapter({ writeAudit }, () => 'audit-1');

    await adapter.write({
      eventType: 'agent.mcp.tool.executed',
      tenantId: 'tenant-1',
      occurredAt: 100,
      correlationId: 'request-1',
      actor: {
        actorSub: 'client:client-1',
        actorMode: 'mode_a',
        actorAssurance: 'public_client_transaction',
        tokenBinding: 'bearer',
        clientId: 'client-1',
        delegatorId: 'admin-1',
        grantId: 'grant-1',
      },
      outcome: 'success',
      details: { tool_id: 'authrim.admin.users.list.v1', management_status: 200 },
    });

    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'audit-1',
        tenantId: 'tenant-1',
        adminUserId: 'admin-1',
        actorType: 'agent',
        actorSub: 'client:client-1',
        actClientId: 'client-1',
        grantId: 'grant-1',
        mcpTool: 'authrim.admin.users.list.v1',
        requestId: 'request-1',
        result: 'success',
      })
    );
  });
});
