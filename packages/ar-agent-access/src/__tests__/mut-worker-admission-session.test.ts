import { describe, expect, it } from 'vitest';
import {
  AGENT_ACCESS_MCP_SESSION_ABSOLUTE_MS,
  AGENT_ACCESS_MCP_SESSION_IDLE_MS,
} from '../platform/cloudflare/mcp-session-policy';
import {
  NOW,
  harness,
  jsonRpcError,
  mcpCall,
  mcpPost,
  sha256Prefix,
  toolsCall,
  type HarnessOptions,
} from './helpers/mut-worker-admission-harness';

const SESSION = { 'mcp-session-id': 'session-1' };
const BINDING = { tenantId: 'tenant-1', grantId: 'grant-1', clientId: 'client-1' };

async function run(request: Request, options: HarnessOptions = {}) {
  const h = harness(options);
  const response = await h.fetch(request);
  return { h, response, event: h.lastEvent() };
}

describe('MCP-Session-Id validation', () => {
  it('rejects an empty or over-long session id with a transport error', async () => {
    for (const id of ['', 's'.repeat(129), 'has space']) {
      const { response, event } = await run(mcpPost(toolsCall, { 'mcp-session-id': id }));
      expect(response.status).toBe(400);
      expect((await jsonRpcError(response)).error.message).toBe(
        'MCP-Session-Id must contain 1-128 visible ASCII characters'
      );
      expect(event).toMatchObject({
        eventType: 'agent.mcp.admission.session_denied',
        details: { code: 'AGENT_MCP_SESSION_ID_INVALID' },
        tenantId: 'tenant-1',
      });
    }
  });

  it('accepts one-character and 128-character session ids', async () => {
    for (const id of ['a', 's'.repeat(128)]) {
      const { response, h } = await run(mcpPost(toolsCall, { 'mcp-session-id': id }));
      expect(response.status).toBe(200);
      expect(h.registry.touch).toHaveBeenCalledWith(expect.objectContaining({ sessionId: id }));
    }
  });

  it.each(['GET', 'DELETE'])('requires a session id for %s', async (method) => {
    const { response, event } = await run(mcpCall(method));
    expect(response.status).toBe(400);
    expect((await jsonRpcError(response)).error.message).toBe(`${method} requires MCP-Session-Id`);
    expect(event).toMatchObject({
      eventType: 'agent.mcp.admission.session_denied',
      details: { code: 'AGENT_MCP_SESSION_ID_REQUIRED' },
    });
  });
});

describe('existing session revalidation', () => {
  it('touches the registry with the verified binding and a fresh idle deadline', async () => {
    const { h, response } = await run(mcpPost(toolsCall, SESSION));
    expect(response.status).toBe(200);
    expect(h.registry.touch).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'session-1',
      ...BINDING,
      now: NOW,
      idleExpiresAt: NOW + AGENT_ACCESS_MCP_SESSION_IDLE_MS,
    });
    expect(h.registry.register).not.toHaveBeenCalled();
    expect(h.consume.mock.calls.map(([input]) => input.key)).not.toContain(
      'mcp-initialize:tenant-1:grant-1:client-1'
    );
  });

  it('answers an expired session with JSON-RPC -32001 and 404', async () => {
    const { response, event } = await run(mcpCall('GET', SESSION), { touch: false });
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await jsonRpcError(response)).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32001, message: 'MCP session not found or expired' },
    });
    expect(event).toMatchObject({
      eventType: 'agent.mcp.admission.session_denied',
      outcome: 'denied',
      details: { code: 'AGENT_MCP_SESSION_EXPIRED' },
    });
  });

  it.each([
    ['not_found', 404, -32001, 'MCP session not found or expired', 'denied'],
    ['expired', 404, -32001, 'MCP session not found or expired', 'denied'],
    ['context_mismatch', 403, -32003, 'MCP session authorization context does not match', 'denied'],
    ['unavailable', 503, -32603, 'MCP session validation is unavailable', 'failed'],
  ] as const)(
    'maps a %s session validation to %s',
    async (status, httpStatus, code, message, outcome) => {
      const { response, event } = await run(mcpCall('GET', SESSION), {
        validateSession: async () => status,
      });
      expect(response.status).toBe(httpStatus);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect((await jsonRpcError(response)).error).toEqual({ code, message });
      expect(event).toMatchObject({
        outcome,
        httpStatus,
        details: { code: `AGENT_MCP_SESSION_${status.toUpperCase()}` },
      });
    }
  );

  it('treats a throwing session validator as unavailable', async () => {
    const { response, event } = await run(mcpCall('GET', SESSION), {
      validateSession: async () => {
        throw new Error('DO down');
      },
    });
    expect(response.status).toBe(503);
    expect(event).toMatchObject({
      outcome: 'failed',
      details: { code: 'AGENT_MCP_SESSION_UNAVAILABLE' },
    });
  });

  it('forwards when the session validator confirms the session', async () => {
    const { response, h } = await run(mcpCall('GET', SESSION), {
      validateSession: async () => 'active',
    });
    expect(response.status).toBe(200);
    expect(h.forward).toHaveBeenCalledOnce();
  });

  it('fails closed when the session registry is unavailable', async () => {
    const { response, event, h } = await run(mcpCall('GET', SESSION), { touch: 'throw' });
    expect(response.status).toBe(503);
    expect((await jsonRpcError(response)).error).toEqual({
      code: -32603,
      message: 'MCP admission control is unavailable',
    });
    expect(event).toMatchObject({
      eventType: 'agent.mcp.admission.failed',
      outcome: 'failed',
      details: { code: 'AGENT_MCP_SESSION_REGISTRY_UNAVAILABLE' },
    });
    expect(h.forward).not.toHaveBeenCalled();
  });
});

describe('session initialization and registration', () => {
  it('registers the created session with idle and absolute deadlines and audits it', async () => {
    const { h, response } = await run(mcpPost());
    expect(response.status).toBe(200);
    expect(h.registry.register).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'session-created',
      ...BINDING,
      actorSub: 'client:client-1',
      createdAt: NOW,
      idleExpiresAt: NOW + AGENT_ACCESS_MCP_SESSION_IDLE_MS,
      absoluteExpiresAt: NOW + AGENT_ACCESS_MCP_SESSION_ABSOLUTE_MS,
      maxConcurrentSessions: 3,
    });
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.mcp.session.created',
      outcome: 'success',
      httpStatus: 200,
      method: 'POST',
      tenantId: 'tenant-1',
      sessionIdHash: await sha256Prefix('sid', 'session-created'),
      details: { grant_id: 'grant-1' },
    });
  });

  it.each([300, 400, 500])(
    'does not register a session for a %s initialize response',
    async (status) => {
      const { h, response } = await run(mcpPost(), {
        forward: () => new Response(null, { status, headers: { 'mcp-session-id': 'created' } }),
      });
      expect(response.status).toBe(status);
      expect(h.registry.register).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['missing', {}],
    ['invalid', { 'mcp-session-id': 'bad id' }],
  ])('fails when the agent returns a %s session id', async (_name, headers) => {
    const { h, response, event } = await run(mcpPost(), {
      forward: () => new Response('ok', { headers }),
    });
    expect(response.status).toBe(503);
    expect(event).toMatchObject({
      outcome: 'failed',
      details: { code: 'AGENT_MCP_SESSION_RESPONSE_INVALID' },
    });
    expect(h.registry.register).not.toHaveBeenCalled();
  });

  it('destroys the new session and rate-limits when the concurrent limit is exceeded', async () => {
    const { h, response, event } = await run(mcpPost(), { register: 'limit_exceeded' });
    expect(response.status).toBe(429);
    expect((await jsonRpcError(response)).error).toEqual({
      code: -32002,
      message: 'Concurrent MCP session limit exceeded',
    });
    expect(h.destroySession).toHaveBeenCalledWith('session-created', {});
    expect(event).toMatchObject({
      eventType: 'agent.mcp.admission.rate_limited',
      details: { code: 'AGENT_MCP_CONCURRENT_SESSION_LIMITED' },
    });
  });

  it('reports a session id conflict without destroying the other session', async () => {
    const { h, response, event } = await run(mcpPost(), { register: 'conflict' });
    expect(response.status).toBe(503);
    expect(h.destroySession).not.toHaveBeenCalled();
    expect(event).toMatchObject({
      eventType: 'agent.mcp.admission.failed',
      outcome: 'failed',
      details: { code: 'AGENT_MCP_SESSION_REGISTRATION_CONFLICT' },
    });
  });

  it('destroys the new session when registration is unavailable', async () => {
    const { h, response, event } = await run(mcpPost(), { register: 'throw' });
    expect(response.status).toBe(503);
    expect(h.destroySession).toHaveBeenCalledWith('session-created', {});
    expect(event).toMatchObject({
      outcome: 'failed',
      details: { code: 'AGENT_MCP_SESSION_REGISTRATION_UNAVAILABLE' },
    });
  });
});

describe('session deletion', () => {
  it('removes the registry entry and audits the closure after a successful DELETE', async () => {
    const { h, response } = await run(mcpCall('DELETE', SESSION));
    expect(response.status).toBe(200);
    expect(h.registry.delete).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'session-1',
      ...BINDING,
    });
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.mcp.session.closed',
      outcome: 'success',
      httpStatus: 200,
      tenantId: 'tenant-1',
      details: { grant_id: 'grant-1' },
    });
  });

  it.each([399, 404])('handles an agent DELETE response of %s', async (status) => {
    const { h } = await run(mcpCall('DELETE', SESSION), {
      forward: () => new Response(null, { status }),
    });
    expect(h.registry.delete).toHaveBeenCalledTimes(status < 400 ? 1 : 0);
  });

  it('does not delete registry state for GET', async () => {
    const { h } = await run(mcpCall('GET', SESSION));
    expect(h.registry.delete).not.toHaveBeenCalled();
  });

  it('fails closed when the registry delete is unavailable', async () => {
    const { response, event } = await run(mcpCall('DELETE', SESSION), { deleteFails: true });
    expect(response.status).toBe(503);
    expect(event).toMatchObject({
      eventType: 'agent.mcp.admission.failed',
      outcome: 'failed',
      details: { code: 'AGENT_MCP_SESSION_DELETE_UNAVAILABLE' },
    });
  });
});
