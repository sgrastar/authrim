import { describe, expect, it, vi } from 'vitest';
import { canonicalizeJson, sha256Base64Url, type AgentToolDefinitionSource } from '../core';
import type { AgentConfigurationOperationResult } from '../platform/ports';
import { LOW_TOOL, createHarness, makeCatalog, makeContext } from './helpers/mut-mcp-harness';

const outputTool: AgentToolDefinitionSource = {
  ...LOW_TOOL,
  outputSchema: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string' } },
  },
};
const target = (id: string, executionTarget: AgentToolDefinitionSource['executionTarget']) => ({
  ...LOW_TOOL,
  id,
  name: id.replace(/\./gu, '_'),
  executionTarget,
});
const routedCatalog = makeCatalog([
  target('t.plan', 'configuration_plan'),
  target('t.bulk', 'bulk_plan'),
  target('t.diag', 'runtime_diagnostics'),
  target('t.mgmt', undefined),
]);

describe('owner execution and response handling', () => {
  it('sends the typed management request with the grant-bound authorization context', async () => {
    const h = createHarness();
    const result = await h.server.callTool(
      makeContext(),
      'get_user',
      { user_id: 'u1' },
      {
        idempotencyKey: 'idem-1',
      }
    );
    expect(h.execute).toHaveBeenCalledWith({
      operation: 'users.get',
      tenantId: 'tenant-1',
      authorization: {
        actor: makeContext().actor,
        grantId: 'grant-1',
        grantGeneration: 4,
        delegatorId: 'admin-2',
        consentVersion: 3,
        effectivePermissions: ['admin:users:read'],
        audience: 'authrim:admin-api',
        issuerOrigin: 'https://tenant-1.authrim.example',
        correlationId: 'correlation-1',
      },
      idempotencyKey: 'idem-1',
      input: { user_id: 'u1' },
    });
    expect(result).toStrictEqual({
      structuredContent: { id: 'user-1' },
      content: [{ type: 'text', text: '{"id":"user-1"}' }],
      isError: false,
      metadata: {
        'com.authrim/dataProvenance': {
          source: 'management_api',
          trust_level: 'tenant_data_untrusted',
          sensitivity: 'configuration',
          tenant_id: 'tenant-1',
          grant_id: 'grant-1',
          tool_id: 'users.get',
          correlation_id: 'correlation-1',
          observed_at: 1234,
        },
      },
    });
  });

  it('audits a domain-separated request digest bound to the grant and tool contract', async () => {
    const h = createHarness();
    const context = makeContext();
    await h.server.callTool(context, 'get_user', { user_id: 'u1' });
    const tool = h.catalog.get('get_user')!;
    const expected = await sha256Base64Url(
      canonicalizeJson({
        purpose: 'authrim-agent-tool-request-v1',
        tenant_id: 'tenant-1',
        grant_id: 'grant-1',
        grant_generation: 4,
        actor_sub: 'client:client-1',
        tool_id: 'users.get',
        tool_contract_digest: tool.schemaDigest,
        input: { user_id: 'u1' },
      })
    );
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.mcp.tool.executed',
      outcome: 'success',
      details: { tool_id: 'users.get', request_digest: expected, management_status: 200 },
    });
  });

  it('labels user-data reads as personal data', async () => {
    const catalog = makeCatalog([{ ...LOW_TOOL, requiredScope: 'agent:user-data:read' }]);
    const h = createHarness({ catalog });
    const result = await h.server.callTool(makeContext(), 'get_user', {});
    expect(result.metadata).toMatchObject({
      'com.authrim/dataProvenance': { sensitivity: 'personal_data' },
    });
  });

  it('wraps non-object owner bodies and flags non-2xx results as failed', async () => {
    const h = createHarness({ execute: async () => ({ status: 404, body: 'missing' }) });
    const result = await h.server.callTool(makeContext(), 'get_user', {});
    expect(result).toMatchObject({
      structuredContent: { result: 'missing' },
      content: [{ type: 'text', text: '"missing"' }],
      isError: true,
    });
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.mcp.tool.executed',
      outcome: 'failed',
      details: { management_status: 404 },
    });
  });

  it.each([
    [[1, 2], { result: [1, 2] }],
    [null, { result: null }],
  ])('wraps array and null owner bodies (%j)', async (body, structured) => {
    const h = createHarness({ execute: async () => ({ status: 200, body }) });
    expect((await h.server.callTool(makeContext(), 'get_user', {})).structuredContent).toEqual(
      structured
    );
  });

  it.each([
    [199, true],
    [200, false],
    [299, false],
    [300, true],
  ])('treats owner status %i as isError=%s', async (status, isError) => {
    const h = createHarness({ execute: async () => ({ status, body: {} }) });
    const result = await h.server.callTool(makeContext(), 'get_user', {});
    expect(result.isError).toBe(isError);
    expect(h.lastEvent()?.outcome).toBe(isError ? 'failed' : 'success');
  });

  it.each([200, 299])('rejects an invalid owner response body for status %i', async (status) => {
    const h = createHarness({
      catalog: makeCatalog([outputTool]),
      execute: async () => ({ status, body: { id: 5 } }),
    });
    const result = await h.server.callTool(makeContext(), 'get_user', {});
    expect(result).toStrictEqual({
      content: [{ type: 'text', text: 'Owner API returned an invalid response' }],
      isError: true,
    });
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.mcp.tool.failed',
      outcome: 'failed',
      details: { tool_id: 'users.get', code: 'AGENT_INVALID_OWNER_RESPONSE' },
    });
  });

  it.each([199, 300, 500])('passes owner error bodies through unvalidated (%i)', async (status) => {
    const h = createHarness({
      catalog: makeCatalog([outputTool]),
      execute: async () => ({ status, body: { error: 'bad' } }),
    });
    const result = await h.server.callTool(makeContext(), 'get_user', {});
    expect(result).toMatchObject({ isError: true, structuredContent: { error: 'bad' } });
  });

  it('accepts an owner response that matches the output schema', async () => {
    const h = createHarness({ catalog: makeCatalog([outputTool]) });
    const result = await h.server.callTool(makeContext(), 'get_user', {});
    expect(result).toMatchObject({ isError: false, structuredContent: { id: 'user-1' } });
  });

  it('fails closed when the management transport throws', async () => {
    const h = createHarness({
      execute: async () => {
        throw new Error('network');
      },
    });
    expect(await h.server.callTool(makeContext(), 'get_user', {})).toStrictEqual({
      content: [{ type: 'text', text: 'Management API unavailable' }],
      isError: true,
    });
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.mcp.tool.failed',
      outcome: 'failed',
      details: { tool_id: 'users.get', code: 'AGENT_MANAGEMENT_API_UNAVAILABLE' },
    });
  });
});

describe('execution target routing', () => {
  function routed() {
    const port = (label: string) =>
      vi.fn(
        async (): Promise<AgentConfigurationOperationResult> => ({
          status: 200,
          body: { via: label },
        })
      );
    const plans = port('plan');
    const bulk = port('bulk');
    const diag = port('diag');
    const h = createHarness({
      catalog: routedCatalog,
      execute: async () => ({ status: 200, body: { via: 'management' } }),
      extra: {
        configurationPlans: { execute: plans },
        bulkPlans: { execute: bulk },
        runtimeDiagnostics: { inspect: diag },
      },
    });
    return { h, plans, bulk, diag };
  }

  it.each([
    ['t_plan', 'plan'],
    ['t_bulk', 'bulk'],
    ['t_diag', 'diag'],
    ['t_mgmt', 'management'],
  ])('dispatches %s to the %s port', async (name, via) => {
    const { h, plans, bulk, diag } = routed();
    const result = await h.server.callTool(makeContext(), name, { user_id: 'x' });
    expect(result.structuredContent).toEqual({ via });
    expect(plans).toHaveBeenCalledTimes(via === 'plan' ? 1 : 0);
    expect(bulk).toHaveBeenCalledTimes(via === 'bulk' ? 1 : 0);
    expect(diag).toHaveBeenCalledTimes(via === 'diag' ? 1 : 0);
    expect(h.execute).toHaveBeenCalledTimes(via === 'management' ? 1 : 0);
  });

  it('passes the operation request without management-only fields to platform ports', async () => {
    const { h, plans } = routed();
    await h.server.callTool(makeContext(), 't_plan', { user_id: 'x' });
    expect(plans).toHaveBeenCalledWith({
      operation: 't.plan',
      actor: makeContext().actor,
      grant: makeContext().grant,
      issuerOrigin: 'https://tenant-1.authrim.example',
      correlationId: 'correlation-1',
      input: { user_id: 'x' },
    });
  });

  it('falls back to the management API when a platform port is not configured', async () => {
    const h = createHarness({ catalog: routedCatalog });
    for (const name of ['t_plan', 't_bulk', 't_diag']) {
      await h.server.callTool(makeContext(), name, {});
    }
    expect(h.execute.mock.calls.map((call) => call[0].operation)).toEqual([
      't.plan',
      't.bulk',
      't.diag',
    ]);
  });

  it('surfaces a port-issued URL elicitation without auditing execution', async () => {
    const elicitation = { elicitationId: 'e1', url: 'https://a.example/e1', message: 'Approve' };
    const h = createHarness({
      catalog: routedCatalog,
      extra: {
        configurationPlans: {
          execute: async () => ({ status: 200, body: {}, urlElicitation: elicitation }),
        },
      },
    });
    expect(await h.server.callTool(makeContext(), 't_plan', {})).toStrictEqual({
      content: [{ type: 'text', text: 'Approve' }],
      isError: true,
      urlElicitation: elicitation,
    });
    expect(h.events.map((event) => event.eventType)).not.toContain('agent.mcp.tool.executed');
  });
});

describe('public client idempotency key derivation', () => {
  it('derives the key from a domain-separated digest of grant, actor, tool and input', async () => {
    const catalog = makeCatalog([
      { ...LOW_TOOL, riskLevel: 'standard', publicClientStandardOptInEligible: true },
    ]);
    const h = createHarness({
      catalog,
      settings: { publicClientStandardToolIds: ['users.get'] },
    });
    await h.server.callTool(makeContext(), 'get_user', { user_id: 'u1' });
    const digest = await sha256Base64Url(
      canonicalizeJson({
        purpose: 'authrim-public-client-standard-write-v1',
        tenant_id: 'tenant-1',
        grant_id: 'grant-1',
        grant_generation: 4,
        actor_sub: 'client:client-1',
        tool_id: 'users.get',
        input: { user_id: 'u1' },
      })
    );
    expect(h.execute.mock.calls[0]?.[0].idempotencyKey).toBe(`agent-mode-a:${digest}`);
    expect(h.consume).toHaveBeenCalledWith(expect.objectContaining({ limit: 10 }));
  });
});
