import { describe, expect, it } from 'vitest';
import {
  createHarness,
  LOW_TOOL,
  makeCatalog,
  makeContext,
  SECOND_TOOL,
} from './helpers/mut-mcp-harness';

describe('MCP callTool admission gates', () => {
  it('rejects an unknown tool with an audited denial that carries no tool contract', async () => {
    const h = createHarness();
    const result = await h.server.callTool(makeContext(), 'no_such_tool', {});

    expect(result).toStrictEqual({
      content: [{ type: 'text', text: 'Unknown tool' }],
      isError: true,
    });
    expect(h.authorize).not.toHaveBeenCalled();
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      eventType: 'agent.mcp.tool.denied',
      outcome: 'denied',
      details: { reason: 'unknown_tool', tool_contract_digest: null },
    });
  });

  it('writes a complete audit envelope with the actor machine principal preferred', async () => {
    const h = createHarness();
    const context = makeContext({
      actor: { machinePrincipalId: 'mp-actor' },
      grant: {
        machinePrincipalId: 'mp-grant',
        taskSetId: 'ts-1',
        taskSetVersion: 2,
        accessSnapshotHash: 'snap-hash',
      },
    });
    await h.server.callTool(context, 'get_client', { user_id: 7 });

    const tool = h.catalog.get('get_client')!;
    expect(h.events[0]).toStrictEqual({
      eventType: 'agent.mcp.tool.denied',
      tenantId: 'tenant-1',
      occurredAt: 1234,
      correlationId: 'correlation-1',
      actor: {
        actorSub: 'client:client-1',
        actorMode: 'mode_a',
        actorAssurance: 'public_client_transaction',
        tokenBinding: 'bearer',
        clientId: 'client-1',
        principalId: 'mp-actor',
        delegatorId: 'admin-2',
        grantId: 'grant-1',
      },
      outcome: 'denied',
      details: {
        catalog_version: 'catalog-7',
        grant_generation: 4,
        consent_version: 3,
        task_set_id: 'ts-1',
        task_set_version: 2,
        access_snapshot_hash: 'snap-hash',
        tool_contract_digest: tool.schemaDigest,
        tool_id: 'clients.get',
        denied_axis: 'input_schema',
        code: 'AGENT_INVALID_TOOL_ARGUMENTS',
      },
    });
    expect(tool.schemaDigest).not.toBe(h.catalog.get('get_user')!.schemaDigest);
  });

  it('falls back to the grant machine principal and omits principalId when neither is set', async () => {
    const h = createHarness();
    await h.server.callTool(
      makeContext({ grant: { machinePrincipalId: 'mp-grant' } }),
      'get_user',
      { user_id: 1 }
    );
    await h.server.callTool(makeContext(), 'get_user', { user_id: 1 });

    expect(h.events[0]?.actor.principalId).toBe('mp-grant');
    expect(h.events[1]?.actor).not.toHaveProperty('principalId');
    expect(h.events[1]?.details).toMatchObject({
      task_set_id: null,
      task_set_version: null,
      access_snapshot_hash: null,
    });
  });

  it('rejects schema-invalid arguments before authorization', async () => {
    const h = createHarness();
    const result = await h.server.callTool(makeContext(), 'get_user', { extra: true });
    expect(result).toStrictEqual({
      content: [{ type: 'text', text: 'Invalid tool arguments' }],
      isError: true,
    });
    expect(h.authorize).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('returns the authorization code and audits the denied axis', async () => {
    const h = createHarness({
      authorize: async () => ({
        allowed: false,
        requiresElevation: false,
        deniedAxis: 'scope',
        code: 'AGENT_SCOPE_DENIED',
      }),
    });
    const result = await h.server.callTool(makeContext(), 'get_user', {});
    expect(result).toStrictEqual({
      content: [{ type: 'text', text: 'AGENT_SCOPE_DENIED' }],
      isError: true,
    });
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.mcp.tool.denied',
      outcome: 'denied',
      details: { tool_id: 'users.get', denied_axis: 'scope', code: 'AGENT_SCOPE_DENIED' },
    });
    expect(h.settingsGet).not.toHaveBeenCalled();
  });

  it('uses generic denial defaults when the decision has no axis or code', async () => {
    const h = createHarness({
      authorize: async () => ({ allowed: false, requiresElevation: false }),
    });
    const result = await h.server.callTool(makeContext(), 'get_user', {});
    expect(result.content).toEqual([{ type: 'text', text: 'Access denied' }]);
    expect(h.lastEvent()?.details).toMatchObject({
      denied_axis: 'unknown',
      code: 'AGENT_ACCESS_DENIED',
    });
  });

  it('passes the tool-derived resource to authorization', async () => {
    const h = createHarness();
    await h.server.callTool(makeContext(), 'get_user', { user_id: 'user-9' });
    const input = h.authorize.mock.calls[0]?.[0];
    expect(input?.tool.id).toBe('users.get');
    expect(input?.grant.grantId).toBe('grant-1');
    expect(input?.resource.tenantId).toBe('tenant-1');
  });

  it('fails closed when settings cannot be read', async () => {
    const h = createHarness({
      settingsGet: async () => {
        throw new Error('kv down');
      },
    });
    const result = await h.server.callTool(makeContext(), 'get_user', {});
    expect(result).toStrictEqual({
      content: [{ type: 'text', text: 'Agent settings unavailable' }],
      isError: true,
    });
    expect(h.settingsGet).toHaveBeenCalledWith('tenant-1');
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.mcp.tool.denied',
      outcome: 'denied',
      details: {
        tool_id: 'users.get',
        denied_axis: 'settings',
        code: 'AGENT_SETTINGS_UNAVAILABLE',
      },
    });
    expect(h.consume).not.toHaveBeenCalled();
  });

  it('refuses every call when the tenant feature flag is off', async () => {
    const h = createHarness({ settings: { enabled: false } });
    const result = await h.server.callTool(makeContext(), 'get_user', {});
    expect(result).toStrictEqual({
      content: [{ type: 'text', text: 'Agent access disabled' }],
      isError: true,
    });
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.mcp.tool.denied',
      outcome: 'denied',
      details: { tool_id: 'users.get', denied_axis: 'feature_flag', code: 'AGENT_MCP_DISABLED' },
    });
    expect(h.consume).not.toHaveBeenCalled();
  });

  it('fails closed when the rate limiter is unavailable', async () => {
    const h = createHarness({
      consume: async () => {
        throw new Error('do down');
      },
    });
    const result = await h.server.callTool(makeContext(), 'get_user', {});
    expect(result).toStrictEqual({
      content: [{ type: 'text', text: 'Rate limit unavailable' }],
      isError: true,
    });
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.mcp.tool.failed',
      outcome: 'failed',
      details: { tool_id: 'users.get', code: 'AGENT_RATE_LIMIT_UNAVAILABLE' },
    });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('rejects calls over the rate limit and audits the reset time', async () => {
    const h = createHarness({
      consume: async () => ({ allowed: false, remaining: 0, resetAt: 999 }),
    });
    const result = await h.server.callTool(makeContext(), 'get_user', {});
    expect(result).toStrictEqual({
      content: [{ type: 'text', text: 'Rate limit exceeded' }],
      isError: true,
    });
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.mcp.tool.rate_limited',
      outcome: 'denied',
      details: { tool_id: 'users.get', reset_at: 999 },
    });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('keys the rate limit per tenant, grant and tool with the general limit for normal calls', async () => {
    const h = createHarness({ settings: { rateLimitPerMinute: 42 } });
    await h.server.callTool(makeContext(), 'get_user', {});
    expect(h.consume).toHaveBeenCalledWith({
      key: 'tenant-1:grant-1:users.get',
      limit: 42,
      windowSeconds: 60,
    });
    expect(h.execute.mock.calls[0]?.[0].idempotencyKey).toBeUndefined();
  });
});

describe('public client standard opt-in', () => {
  const standard = {
    ...LOW_TOOL,
    id: 'admin.write.clients.metadata',
    name: 'update_client_metadata',
    riskLevel: 'standard' as const,
    requiredScope: 'agent:write' as const,
    publicClientStandardOptInEligible: true,
  };
  const catalog = makeCatalog([standard, SECOND_TOOL]);
  const optIn = {
    rateLimitPerMinute: 30,
    publicClientStandardRateLimitPerMinute: 4,
    publicClientStandardToolIds: ['admin.write.clients.metadata'],
  };

  it('applies the stricter limit and derives a stable idempotency key bound to the grant', async () => {
    const h = createHarness({ catalog, settings: optIn });
    await h.server.callTool(makeContext(), 'update_client_metadata', { user_id: 'a' });
    await h.server.callTool(makeContext({ grant: { generation: 5 } }), 'update_client_metadata', {
      user_id: 'a',
    });
    await h.server.callTool(makeContext(), 'update_client_metadata', { user_id: 'b' });

    expect(h.consume).toHaveBeenCalledWith(expect.objectContaining({ limit: 4 }));
    const keys = h.execute.mock.calls.map((call) => call[0].idempotencyKey);
    expect(keys[0]).toMatch(/^agent-mode-a:[A-Za-z0-9_-]{43}$/u);
    expect(new Set(keys).size).toBe(3);
  });

  it('never raises the general limit above the configured rate', async () => {
    const h = createHarness({
      catalog,
      settings: { ...optIn, rateLimitPerMinute: 2, publicClientStandardRateLimitPerMinute: 8 },
    });
    await h.server.callTool(makeContext(), 'update_client_metadata', {}, { idempotencyKey: 'k1' });
    expect(h.consume).toHaveBeenCalledWith(expect.objectContaining({ limit: 2 }));
    expect(h.execute.mock.calls[0]?.[0].idempotencyKey).not.toBe('k1');
  });

  it.each([
    ['confidential actors', { actor: { assurance: 'confidential_client' as const } }, optIn],
    ['tools not opted in', {}, { ...optIn, publicClientStandardToolIds: ['other.tool'] }],
  ])('uses the general limit and caller idempotency key for %s', async (_label, ctx, settings) => {
    const h = createHarness({ catalog, settings });
    await h.server.callTool(
      makeContext(ctx),
      'update_client_metadata',
      {},
      { idempotencyKey: 'k1' }
    );
    expect(h.consume).toHaveBeenCalledWith(expect.objectContaining({ limit: 30 }));
    expect(h.execute.mock.calls[0]?.[0].idempotencyKey).toBe('k1');
  });

  it('does not treat low-risk tools as standard opt-in calls', async () => {
    const lowCatalog = makeCatalog([{ ...standard, riskLevel: 'low' }]);
    const h = createHarness({ catalog: lowCatalog, settings: optIn });
    await h.server.callTool(makeContext(), 'update_client_metadata', {}, { idempotencyKey: 'k1' });
    expect(h.consume).toHaveBeenCalledWith(expect.objectContaining({ limit: 30 }));
    expect(h.execute.mock.calls[0]?.[0].idempotencyKey).toBe('k1');
  });
});
