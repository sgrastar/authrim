import { describe, expect, it } from 'vitest';
import { AGENT_ACCESS_INTERNAL_CONTEXT_HEADER } from '../platform/cloudflare/mcp-request-context';
import {
  harness,
  jsonRpcError,
  mcpCall,
  mcpPost,
  sha256Prefix,
  type HarnessOptions,
} from './helpers/mut-worker-admission-harness';

async function run(request: Request, options: HarnessOptions = {}) {
  const h = harness(options);
  const response = await h.fetch(request);
  return { h, response, event: h.lastEvent() };
}

describe('pre-authentication rate limit', () => {
  it('keys the limit by host and hashed client IP over a 60 second window', async () => {
    const { h } = await run(mcpPost(undefined, { 'cf-connecting-ip': '203.0.113.9' }));
    const ipHash = await sha256Prefix('ip', '203.0.113.9');
    expect(h.consume.mock.calls[0]?.[0]).toEqual({
      key: `mcp-preauth:auth.example:${ipHash}`,
      limit: 1200,
      windowSeconds: 60,
    });
    expect(h.events()[0]).toMatchObject({ clientIpHash: ipHash, sessionIdHash: undefined });
  });

  it('uses ip_unknown without a connecting IP', async () => {
    const { h } = await run(mcpPost());
    expect(h.consume.mock.calls[0]?.[0].key).toBe('mcp-preauth:auth.example:ip_unknown');
  });

  it.each([
    [60, 60],
    [60_000, 60_000],
    [59, 1200],
    [60_001, 1200],
    [120.5, 1200],
  ])('applies a configured limit of %s as %s', async (configured, applied) => {
    const { h } = await run(mcpPost(), { preAuthLimit: configured });
    expect(h.consume.mock.calls[0]?.[0].limit).toBe(applied);
  });

  it('rejects with a JSON-RPC rate-limit error and Retry-After', async () => {
    const { h, response, event } = await run(mcpPost(), { rateLimits: { preauth: false } });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await jsonRpcError(response)).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32002, message: 'MCP pre-authentication rate limit exceeded' },
    });
    expect(event).toMatchObject({
      eventType: 'agent.mcp.admission.rate_limited',
      outcome: 'denied',
      details: { code: 'AGENT_MCP_PREAUTH_RATE_LIMITED' },
      tenantId: undefined,
    });
    expect(h.authenticate).not.toHaveBeenCalled();
  });

  it('fails closed when the limiter is unavailable', async () => {
    const { response, event } = await run(mcpPost(), { rateLimits: { preauth: 'throw' } });
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await jsonRpcError(response)).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: 'MCP admission control is unavailable' },
    });
    expect(event).toMatchObject({
      eventType: 'agent.mcp.admission.failed',
      outcome: 'failed',
      details: { code: 'AGENT_MCP_PREAUTH_RATE_LIMIT_UNAVAILABLE' },
    });
  });
});

describe('origin policy and preflight', () => {
  it('fails closed when the origin policy throws', async () => {
    const { response, event } = await run(mcpPost(), { originPolicyFails: true });
    expect(response.status).toBe(503);
    expect(event).toMatchObject({
      outcome: 'failed',
      details: { code: 'AGENT_MCP_ORIGIN_POLICY_UNAVAILABLE' },
    });
  });

  it('denies a disallowed Origin before authentication', async () => {
    const { h, response, event } = await run(
      mcpPost(undefined, { origin: 'https://evil.example' }),
      { allowedOrigin: null }
    );
    expect(response.status).toBe(403);
    expect(event).toMatchObject({
      eventType: 'agent.mcp.admission.origin_denied',
      details: { code: 'AGENT_MCP_ORIGIN_DENIED' },
    });
    expect(h.authenticate).not.toHaveBeenCalled();
  });

  it('answers an allowed preflight with the CORS contract and never authenticates', async () => {
    const { h, response } = await run(mcpCall('OPTIONS', { origin: 'https://app.example' }));
    expect(response.status).toBe(204);
    expect(Object.fromEntries(response.headers)).toEqual({
      'access-control-allow-origin': 'https://app.example',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      'access-control-allow-headers':
        'Authorization, DPoP, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID',
      'access-control-max-age': '86400',
      vary: 'Origin',
    });
    expect(h.authenticate).not.toHaveBeenCalled();
  });

  it('omits Allow-Origin from a preflight without an allowed origin', async () => {
    const { response } = await run(mcpCall('OPTIONS'));
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
  });

  it('rejects unsupported methods with 405 and an Allow header', async () => {
    const { h, response, event } = await run(mcpCall('PUT'));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, POST, DELETE, OPTIONS');
    expect((await jsonRpcError(response)).error).toEqual({
      code: -32600,
      message: 'Method is not supported by Streamable HTTP',
    });
    expect(event).toMatchObject({
      eventType: 'agent.mcp.admission.transport_denied',
      details: { code: 'AGENT_MCP_METHOD_UNSUPPORTED' },
    });
    expect(h.authenticate).not.toHaveBeenCalled();
  });
});

describe('authentication outcome', () => {
  it('fails closed when the authenticator throws', async () => {
    const { response, event } = await run(mcpPost(), {
      authenticate: async () => {
        throw new Error('auth down');
      },
    });
    expect(response.status).toBe(503);
    expect(event).toMatchObject({
      eventType: 'agent.mcp.authentication.failed',
      outcome: 'failed',
      details: { code: 'AGENT_MCP_AUTHENTICATION_UNAVAILABLE' },
    });
  });

  it('records the authenticator denial code and tenant, or a generic denial code', async () => {
    const challenge = () => new Response(null, { status: 401 });
    const withContext = await run(mcpPost(), {
      authenticate: async () => ({
        allowed: false,
        response: challenge(),
        auditContext: { code: 'AGENT_MCP_TOKEN_INVALID', tenantId: 'tenant-7' },
      }),
    });
    expect(withContext.response.status).toBe(401);
    expect(withContext.event).toMatchObject({
      eventType: 'agent.mcp.authentication.denied',
      outcome: 'denied',
      httpStatus: 401,
      tenantId: 'tenant-7',
      details: { code: 'AGENT_MCP_TOKEN_INVALID' },
    });
    const bare = await run(mcpPost(), {
      authenticate: async () => ({ allowed: false, response: challenge() }),
    });
    expect(bare.event).toMatchObject({ details: { code: 'AGENT_MCP_AUTHENTICATION_DENIED' } });
  });

  it('audits a successful authentication with assurance, binding and Grant', async () => {
    const { h } = await run(mcpPost(undefined, { 'x-correlation-id': 'corr-1' }));
    expect(h.events()[0]).toEqual({
      eventType: 'agent.mcp.authentication.succeeded',
      occurredAt: 1_000_000,
      correlationId: 'corr-1',
      outcome: 'success',
      httpStatus: 200,
      method: 'POST',
      host: 'auth.example',
      tenantId: 'tenant-1',
      clientIpHash: 'ip_unknown',
      sessionIdHash: undefined,
      details: {
        actor_assurance: 'public_client_transaction',
        token_binding: 'bearer',
        grant_id: 'grant-1',
      },
    });
  });
});

describe('post-authentication limits', () => {
  it('limits requests and initializations per tenant, Grant and client', async () => {
    const { h } = await run(mcpPost());
    expect(h.consume.mock.calls.slice(1).map(([input]) => input)).toEqual([
      { key: 'mcp-request:tenant-1:grant-1:client-1', limit: 11, windowSeconds: 60 },
      { key: 'mcp-initialize:tenant-1:grant-1:client-1', limit: 7, windowSeconds: 60 },
    ]);
  });

  it.each([
    ['request', 'MCP request rate limit exceeded', 'AGENT_MCP_REQUEST_RATE_LIMITED'],
    [
      'initialize',
      'MCP session initialization rate limit exceeded',
      'AGENT_MCP_INITIALIZATION_RATE_LIMITED',
    ],
  ] as const)('rejects when the %s limit is exhausted', async (kind, message, code) => {
    const { h, response, event } = await run(mcpPost(), { rateLimits: { [kind]: false } });
    expect(response.status).toBe(429);
    expect((await jsonRpcError(response)).error).toEqual({ code: -32002, message });
    expect(event).toMatchObject({
      eventType: 'agent.mcp.admission.rate_limited',
      tenantId: 'tenant-1',
      details: { code },
    });
    expect(h.forward).not.toHaveBeenCalled();
  });

  it.each([
    ['settings', { settingsFail: true }, 'AGENT_MCP_ADMISSION_CONTROL_UNAVAILABLE'],
    [
      'request limiter',
      { rateLimits: { request: 'throw' } },
      'AGENT_MCP_ADMISSION_CONTROL_UNAVAILABLE',
    ],
    [
      'initialization limiter',
      { rateLimits: { initialize: 'throw' } },
      'AGENT_MCP_INITIALIZATION_RATE_LIMIT_UNAVAILABLE',
    ],
  ] as const)('fails closed when the %s is unavailable', async (_name, options, code) => {
    const { response, event } = await run(mcpPost(), options);
    expect(response.status).toBe(503);
    expect(event).toMatchObject({
      eventType: 'agent.mcp.admission.failed',
      outcome: 'failed',
      tenantId: 'tenant-1',
      details: { code },
    });
  });
});

describe('request sanitization and correlation', () => {
  it('strips the internal context header and pins the correlation id for every stage', async () => {
    const { h } = await run(
      mcpPost(undefined, {
        [AGENT_ACCESS_INTERNAL_CONTEXT_HEADER]: 'forged',
        'x-correlation-id': 'A.b_c~-1',
      })
    );
    const authenticated = h.authenticate.mock.calls[0]?.[0];
    const originChecked = h.resolveAllowedOrigin.mock.calls[0]?.[0];
    const forwarded = h.forward.mock.calls[0]?.[0];
    for (const request of [authenticated, originChecked, forwarded]) {
      expect(request.headers.has(AGENT_ACCESS_INTERNAL_CONTEXT_HEADER)).toBe(false);
      expect(request.headers.get('x-correlation-id')).toBe('A.b_c~-1');
    }
  });

  it.each(['has space', 'x'.repeat(129)])('replaces an unsafe correlation id %#', async (value) => {
    const { h } = await run(mcpPost(undefined, { 'x-correlation-id': value }));
    const forwarded = h.forward.mock.calls[0]?.[0];
    expect(forwarded.headers.get('x-correlation-id')).toMatch(/^mcp_[0-9a-f-]{36}$/u);
    expect(h.events()[0]?.correlationId).toBe(forwarded.headers.get('x-correlation-id'));
  });

  it('keeps a 128-character correlation id', async () => {
    const value = 'c'.repeat(128);
    const { h } = await run(mcpPost(undefined, { 'x-correlation-id': value }));
    expect(h.events()[0]?.correlationId).toBe(value);
  });

  it('hashes the presented session id and truncates the audited host to 255 characters', async () => {
    const host = `${'a'.repeat(300)}.example`;
    const request = new Request(`https://${host}/mcp`, mcpCall('GET', { 'mcp-session-id': 's-1' }));
    const { h } = await run(request);
    expect(h.events()[0]).toMatchObject({
      host: host.slice(0, 255),
      sessionIdHash: await sha256Prefix('sid', 's-1'),
    });
    expect(h.consume.mock.calls[0]?.[0].key).toBe(`mcp-preauth:${host.slice(0, 255)}:ip_unknown`);
  });
});
