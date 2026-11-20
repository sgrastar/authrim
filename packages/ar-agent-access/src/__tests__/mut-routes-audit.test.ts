import { beforeEach, describe, expect, it, vi } from 'vitest';

interface PreparedInput {
  tenantId: string;
  overview: Record<string, unknown>;
  adminInlineMetadata: Record<string, unknown>;
  row: Record<string, unknown>;
}
type PrepareFn = (
  env: unknown,
  database: unknown,
  input: PreparedInput,
  guard: (record: { payload_hmac: string }) => unknown
) => Promise<{ record: unknown; statements: unknown[] }>;
type ReceiptFn = (record: unknown, tenantId: string, guard: unknown) => unknown;

const mocks = vi.hoisted(() => ({
  prepareLogIcebergRowWrite: vi.fn<PrepareFn>(),
  adminAuditReceiptStatement: vi.fn<ReceiptFn>(),
}));

vi.mock('@authrim/ar-lib-core/services/log-iceberg-emitter', () => ({
  prepareLogIcebergRowWrite: mocks.prepareLogIcebergRowWrite,
}));
vi.mock('@authrim/ar-lib-core/services/admin-audit-receipts', () => ({
  adminAuditReceiptStatement: mocks.adminAuditReceiptStatement,
}));

import { canonicalizeJson, sha256Base64Url, type AgentAuditEvent } from '../core';
import type { AdminAgentAuditWrite } from '../core/audit';
import {
  CloudflareAdminAgentAuditAdapter,
  type CloudflareAdminAgentAuditRepository,
} from '../platform/cloudflare/admin-agent-audit';
import { createCloudflareAdminAgentAuditWriter } from '../platform/cloudflare/admin-agent-audit-writer';

const fullAudit: AdminAgentAuditWrite = {
  id: 'audit-1',
  tenantId: 'tenant-1',
  adminUserId: 'admin-1',
  action: 'agent_grant.update',
  resourceType: 'agent_grant',
  resourceId: 'grant-1',
  severity: 'warn',
  result: 'failure',
  requestId: 'request-1',
  actorType: 'agent',
  actorSub: 'client:client-1',
  actorMode: 'mode_b',
  actorAssurance: 'confidential_client',
  tokenBinding: 'dpop',
  actClientId: 'client-1',
  actPrincipalId: 'principal-1',
  grantId: 'grant-1',
  elevationId: 'ael-1',
  mcpTool: 'admin.write.users.suspend',
  metadata: { reason: 'x' },
  createdAt: 1_000,
};

describe('createCloudflareAdminAgentAuditWriter record contents', () => {
  beforeEach(() => {
    mocks.prepareLogIcebergRowWrite.mockReset();
    mocks.adminAuditReceiptStatement.mockReset();
    mocks.prepareLogIcebergRowWrite.mockResolvedValue({
      record: { payload_hmac: 'hmac-1' },
      statements: [{ sql: 'S1' }, { sql: 'S2' }],
    });
    mocks.adminAuditReceiptStatement.mockReturnValue({ sql: 'RECEIPT' });
  });

  it('maps every populated audit field into the overview, inline metadata and row', async () => {
    const env = { marker: 'env' };
    const database = { marker: 'db' };
    const write = createCloudflareAdminAgentAuditWriter(env as never);
    const guard = { from: 'grants', where: 'id=? AND version=?', params: ['g', 2] };
    const statements = await write(database as never, fullAudit, guard);

    expect(statements).toEqual([{ sql: 'RECEIPT' }, { sql: 'S1' }, { sql: 'S2' }]);
    const [calledEnv, calledDb, input, guardFactory] =
      mocks.prepareLogIcebergRowWrite.mock.calls[0];
    expect(calledEnv).toBe(env);
    expect(calledDb).toBe(database);
    expect(input).toEqual({
      tenantId: 'tenant-1',
      sourceDataset: 'admin.admin_audit_log',
      logType: 'admin_audit',
      eventAt: 1_000,
      expiresAt: null,
      overview: {
        action: 'agent_grant.update',
        result: 'failure',
        severity: 'warn',
        resource_id: 'grant-1',
        subject_id: 'admin-1',
        request_id: 'request-1',
      },
      adminInlineMetadata: {
        admin_actor_type: 'agent',
        admin_actor_id: 'client:client-1',
        admin_agent_client_id: 'client-1',
        admin_agent_mode: 'mode_b',
        admin_agent_assurance: 'confidential_client',
        admin_agent_grant_id: 'grant-1',
        admin_machine_principal_id: 'principal-1',
        admin_agent_correlation_id: 'request-1',
      },
      row: {
        id: 'audit-1',
        tenant_id: 'tenant-1',
        admin_user_id: 'admin-1',
        action: 'agent_grant.update',
        resource_type: 'agent_grant',
        resource_id: 'grant-1',
        result: 'failure',
        severity: 'warn',
        request_id: 'request-1',
        metadata_json: '{"reason":"x"}',
        created_at: 1_000,
        actor_type: 'agent',
        actor_sub: 'client:client-1',
        actor_mode: 'mode_b',
        actor_assurance: 'confidential_client',
        token_binding: 'dpop',
        act_client_id: 'client-1',
        act_principal_id: 'principal-1',
        grant_id: 'grant-1',
        elevation_id: 'ael-1',
        mcp_tool: 'admin.write.users.suspend',
      },
    });
    expect(guardFactory({ payload_hmac: 'hmac-9' })).toEqual({
      where:
        'EXISTS(SELECT 1 FROM admin_audit_receipts WHERE id=? AND tenant_id=? AND payload_hmac=?)',
      params: ['audit-1', 'tenant-1', 'hmac-9'],
    });
    expect(mocks.adminAuditReceiptStatement).toHaveBeenCalledWith(
      { payload_hmac: 'hmac-1' },
      'tenant-1',
      { where: 'EXISTS(SELECT 1 FROM grants WHERE id=? AND version=?)', params: ['g', 2] }
    );
  });

  it('defaults optional fields to success/null and passes no receipt guard without one', async () => {
    const minimal: AdminAgentAuditWrite = {
      id: 'audit-2',
      tenantId: 'tenant-2',
      action: 'agent.elevation.expired',
      resourceType: 'agent_elevation',
      resourceId: 'ael-2',
      severity: 'info',
      actorType: 'system',
      actorSub: 'system:expiry',
      metadata: {},
      createdAt: 5,
    };
    await createCloudflareAdminAgentAuditWriter({})({} as never, minimal);
    const input = mocks.prepareLogIcebergRowWrite.mock.calls[0][2];
    expect(input.overview).toEqual({
      action: 'agent.elevation.expired',
      result: 'success',
      severity: 'info',
      resource_id: 'ael-2',
      subject_id: 'system:expiry',
      request_id: null,
    });
    expect(input.adminInlineMetadata).toEqual({
      admin_actor_type: 'system',
      admin_actor_id: 'system:expiry',
      admin_agent_client_id: null,
      admin_agent_mode: null,
      admin_agent_assurance: null,
      admin_agent_grant_id: null,
      admin_machine_principal_id: null,
      admin_agent_correlation_id: null,
    });
    expect(input.row).toMatchObject({
      admin_user_id: null,
      result: 'success',
      request_id: null,
      metadata_json: '{}',
      actor_mode: null,
      actor_assurance: null,
      token_binding: null,
      act_client_id: null,
      act_principal_id: null,
      grant_id: null,
      elevation_id: null,
      mcp_tool: null,
    });
    expect(mocks.adminAuditReceiptStatement).toHaveBeenCalledWith(
      { payload_hmac: 'hmac-1' },
      'tenant-2',
      undefined
    );
  });

  it('snapshots the audit and guard params so later caller mutation cannot change them', async () => {
    const audit = structuredClone(fullAudit);
    const guard = { from: 't', where: 'id=?', params: ['p1'] as unknown[] };
    let release: () => void = () => undefined;
    mocks.prepareLogIcebergRowWrite.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ record: { payload_hmac: 'h' }, statements: [] });
        })
    );
    const pending = createCloudflareAdminAgentAuditWriter({})({} as never, audit, guard);
    audit.tenantId = 'tenant-mutated';
    guard.params.push('p2');
    await Promise.resolve();
    release();
    await pending;
    expect(mocks.prepareLogIcebergRowWrite.mock.calls[0][2].tenantId).toBe('tenant-1');
    expect(mocks.adminAuditReceiptStatement).toHaveBeenCalledWith(
      { payload_hmac: 'h' },
      'tenant-1',
      { where: 'EXISTS(SELECT 1 FROM t WHERE id=?)', params: ['p1'] }
    );
  });
});

function event(overrides: Partial<AgentAuditEvent> = {}): AgentAuditEvent {
  return {
    eventType: 'agent.mcp.tool.denied',
    tenantId: 'tenant-1',
    occurredAt: 100,
    correlationId: 'corr-1',
    actor: {
      actorSub: 'machine:principal-1',
      actorMode: 'mode_b',
      actorAssurance: 'confidential_client',
      tokenBinding: 'dpop',
      clientId: 'client-1',
      principalId: 'principal-1',
      delegatorId: 'admin-1',
      grantId: 'grant-1',
    },
    outcome: 'denied',
    details: { tool_id: 'admin.read.users.get', reason: 'scope' },
    ...overrides,
  };
}

describe('CloudflareAdminAgentAuditAdapter record contents', () => {
  it('writes the exact DB_ADMIN record with a digest over the canonical event', async () => {
    const writeAudit = vi
      .fn<CloudflareAdminAgentAuditRepository['writeAudit']>()
      .mockResolvedValue(undefined);
    await new CloudflareAdminAgentAuditAdapter({ writeAudit }, () => 'audit-9').write(event());
    const expectedDigest = await sha256Base64Url(
      canonicalizeJson({
        purpose: 'authrim-agent-audit-event-v1',
        event_type: 'agent.mcp.tool.denied',
        tenant_id: 'tenant-1',
        occurred_at: 100,
        correlation_id: 'corr-1',
        actor: {
          actorSub: 'machine:principal-1',
          actorMode: 'mode_b',
          actorAssurance: 'confidential_client',
          tokenBinding: 'dpop',
          clientId: 'client-1',
          principalId: 'principal-1',
          delegatorId: 'admin-1',
          grantId: 'grant-1',
        },
        outcome: 'denied',
        details: { tool_id: 'admin.read.users.get', reason: 'scope' },
      })
    );
    expect(writeAudit).toHaveBeenCalledWith({
      id: 'audit-9',
      tenantId: 'tenant-1',
      adminUserId: 'admin-1',
      action: 'agent.mcp.tool.denied',
      resourceType: 'agent_mcp_tool',
      resourceId: 'admin.read.users.get',
      severity: 'warn',
      result: 'failure',
      requestId: 'corr-1',
      actorType: 'agent',
      actorSub: 'machine:principal-1',
      actorMode: 'mode_b',
      actorAssurance: 'confidential_client',
      tokenBinding: 'dpop',
      actClientId: 'client-1',
      actPrincipalId: 'principal-1',
      grantId: 'grant-1',
      mcpTool: 'admin.read.users.get',
      metadata: {
        tool_id: 'admin.read.users.get',
        reason: 'scope',
        correlation_id: 'corr-1',
        outcome: 'denied',
        event_digest: expectedDigest,
        integrity_profile: 'authrim-agent-audit-event-v1',
      },
      createdAt: 100,
    });
  });

  it('maps outcomes to severity/result and falls back to the grant without a tool id', async () => {
    const writeAudit = vi
      .fn<CloudflareAdminAgentAuditRepository['writeAudit']>()
      .mockResolvedValue(undefined);
    const adapter = new CloudflareAdminAgentAuditAdapter({ writeAudit }, () => 'a');
    await adapter.write(event({ outcome: 'success', details: { tool_id: '' } }));
    await adapter.write(event({ outcome: 'failed', details: { tool_id: 7 } }));
    await adapter.write(event({ outcome: 'indeterminate', details: {} }));
    const calls = writeAudit.mock.calls.map(([input]) => input);
    expect(calls.map((c) => [c.severity, c.result, c.resourceId, c.mcpTool])).toEqual([
      ['info', 'success', 'grant-1', undefined],
      ['error', 'failure', 'grant-1', undefined],
      ['error', 'failure', 'grant-1', undefined],
    ]);
  });

  it('digests a Mode A actor without principalId the same whether omitted or undefined', async () => {
    const writeAudit = vi
      .fn<CloudflareAdminAgentAuditRepository['writeAudit']>()
      .mockResolvedValue(undefined);
    const adapter = new CloudflareAdminAgentAuditAdapter({ writeAudit }, () => 'a');
    const base = event();
    const { principalId: _p, ...actorWithout } = base.actor;
    await adapter.write({ ...base, actor: actorWithout });
    await adapter.write({ ...base, actor: { ...actorWithout, principalId: undefined } });
    await adapter.write(base);
    const digests = writeAudit.mock.calls.map(([input]) => input.metadata.event_digest);
    expect(digests[0]).toBe(digests[1]);
    expect(digests[2]).not.toBe(digests[0]);
    expect(digests[0]).toBe(
      await sha256Base64Url(
        canonicalizeJson({
          purpose: 'authrim-agent-audit-event-v1',
          event_type: base.eventType,
          tenant_id: base.tenantId,
          occurred_at: base.occurredAt,
          correlation_id: base.correlationId,
          actor: actorWithout,
          outcome: base.outcome,
          details: base.details,
        })
      )
    );
  });

  it('uses a random audit_ prefixed id by default', async () => {
    const writeAudit = vi
      .fn<CloudflareAdminAgentAuditRepository['writeAudit']>()
      .mockResolvedValue(undefined);
    await new CloudflareAdminAgentAuditAdapter({ writeAudit }).write(event());
    expect(writeAudit.mock.calls[0][0].id).toMatch(/^audit_[0-9a-f-]{36}$/u);
  });
});
