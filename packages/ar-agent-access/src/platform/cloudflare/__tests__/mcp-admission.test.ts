import { describe, expect, it, vi } from 'vitest';
import type { AgentGrantContract } from '../../../core';
import { AGENT_ACCESS_SETTINGS_DEFAULTS } from '../../../core';
import type { CloudflareAgentAccessMcpProps } from '../mcp-props';
import { createCloudflareAgentAccessMcpWorker } from '../mcp-admission';
import { AGENT_ACCESS_MCP_MAX_REQUEST_BYTES } from '../mcp-admission';
import {
  AGENT_ACCESS_INTERNAL_CONTEXT_HEADER,
  decodeCloudflareAgentAccessRequestContext,
} from '../mcp-request-context';

const grant: AgentGrantContract = {
  grantId: 'grant-1',
  tenantId: 'tenant-1',
  clientId: 'client-1',
  grantorId: 'admin-1',
  delegatorId: 'admin-1',
  permissions: ['admin:users:read'],
  scopes: ['agent:read'],
  resolvedScopeConstraints: { tenantIds: ['tenant-1'] },
  consentVersion: 1,
  generation: 1,
  status: 'active',
  delegationMode: 'user_consent',
};

const props: CloudflareAgentAccessMcpProps = {
  sourceAccessToken: 'access-token',
  context: {
    actor: {
      mode: 'mode_a',
      sub: 'client:client-1',
      assurance: 'public_client_transaction',
      tokenBinding: 'bearer',
      clientId: 'client-1',
    },
    grant,
    resource: { tenantId: 'tenant-1' },
    issuerOrigin: 'https://tenant-1.authrim.example',
    correlationId: 'correlation-1',
  },
};

function executionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: undefined,
  } as unknown as ExecutionContext;
}

function forwardedResponse(): Response {
  return new Response('forwarded', { headers: { 'mcp-session-id': 'session-created' } });
}

function admissionControls(input?: {
  preAuthAllowed?: boolean;
  requestAllowed?: boolean;
  initializeAllowed?: boolean;
  sessionRegistered?: boolean;
  sessionActive?: boolean;
  audit?: ReturnType<typeof vi.fn>;
}) {
  let rateLimitCall = 0;
  const audit = input?.audit ?? vi.fn(async () => undefined);
  return {
    getSettings: vi.fn(async () => ({ ...AGENT_ACCESS_SETTINGS_DEFAULTS, enabled: true })),
    getRateLimiter: vi.fn(() => ({
      consume: vi.fn(async () => {
        rateLimitCall += 1;
        const allowed =
          rateLimitCall === 1
            ? input?.preAuthAllowed !== false
            : rateLimitCall === 2
              ? input?.requestAllowed !== false
              : input?.initializeAllowed !== false;
        return { allowed, remaining: allowed ? 10 : 0, resetAt: Date.now() + 60_000 };
      }),
    })),
    getAdmissionAudit: vi.fn(() => ({ write: audit })),
    getPreAuthRateLimitPerMinute: vi.fn(() => 1200),
    getSessionRegistry: vi.fn(() => ({
      register: vi.fn(async () =>
        input?.sessionRegistered === false ? ('limit_exceeded' as const) : ('registered' as const)
      ),
      touch: vi.fn(async () => input?.sessionActive !== false),
      delete: vi.fn(async () => undefined),
      listExpired: vi.fn(async () => []),
    })),
    destroySession: vi.fn(async () => undefined),
    now: () => 1_000_000,
  };
}

function initializeRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://auth.example/mcp', {
    method: 'POST',
    headers: {
      authorization: 'Bearer token',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
}

describe('createCloudflareAgentAccessMcpWorker', () => {
  it('rate-limits by a hashed network identifier before Origin and token processing', async () => {
    const authenticate = vi.fn(async () => ({ allowed: true as const, props }));
    const resolveAllowedOrigin = vi.fn(() => null);
    const audit = vi.fn(async () => undefined);
    const fetch = vi.fn(async () => forwardedResponse());
    const worker = createCloudflareAgentAccessMcpWorker(
      { serve: () => ({ fetch }) },
      {
        resolveAllowedOrigin,
        authenticate,
        controls: admissionControls({ preAuthAllowed: false, audit }),
      }
    );
    const response = await worker.fetch!(
      initializeRequest({
        authorization: 'Bearer secret-access-token',
        'cf-connecting-ip': '203.0.113.42',
      }),
      {},
      executionContext()
    );

    expect(response.status).toBe(429);
    expect(resolveAllowedOrigin).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'agent.mcp.admission.rate_limited',
        outcome: 'denied',
        httpStatus: 429,
        clientIpHash: expect.stringMatching(/^ip_[0-9a-f]{24}$/u),
        details: { code: 'AGENT_MCP_PREAUTH_RATE_LIMITED' },
      })
    );
    const serialized = JSON.stringify(audit.mock.calls[0]?.[0]);
    expect(serialized).not.toContain('203.0.113.42');
    expect(serialized).not.toContain('secret-access-token');
  });

  it('audits a stable authentication denial code without retaining credentials', async () => {
    const audit = vi.fn(async () => undefined);
    const authenticate = vi.fn(async () => ({
      allowed: false as const,
      response: Response.json({ error: 'invalid_token' }, { status: 401 }),
      auditContext: { tenantId: 'tenant-1', code: 'AGENT_MCP_TOKEN_INVALID' },
    }));
    const worker = createCloudflareAgentAccessMcpWorker(
      { serve: () => ({ fetch: vi.fn(async () => forwardedResponse()) }) },
      { resolveAllowedOrigin: () => null, authenticate, controls: admissionControls({ audit }) }
    );
    const response = await worker.fetch!(
      initializeRequest({ authorization: 'Bearer secret-access-token' }),
      {},
      executionContext()
    );

    expect(response.status).toBe(401);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'agent.mcp.authentication.denied',
        tenantId: 'tenant-1',
        outcome: 'denied',
        details: { code: 'AGENT_MCP_TOKEN_INVALID' },
      })
    );
    expect(JSON.stringify(audit.mock.calls)).not.toContain('secret-access-token');
  });

  it('fails closed and audits when the Origin policy cannot be evaluated', async () => {
    const audit = vi.fn(async () => undefined);
    const authenticate = vi.fn(async () => ({ allowed: true as const, props }));
    const worker = createCloudflareAgentAccessMcpWorker(
      { serve: () => ({ fetch: vi.fn(async () => forwardedResponse()) }) },
      {
        resolveAllowedOrigin: () => {
          throw new Error('policy store unavailable');
        },
        authenticate,
        controls: admissionControls({ audit }),
      }
    );
    const response = await worker.fetch!(initializeRequest(), {}, executionContext());

    expect(response.status).toBe(503);
    expect(authenticate).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'agent.mcp.admission.failed',
        outcome: 'failed',
        details: { code: 'AGENT_MCP_ORIGIN_POLICY_UNAVAILABLE' },
      })
    );
  });

  it('rejects an untrusted Origin before token processing or Durable Object routing', async () => {
    const authenticate = vi.fn(async () => ({ allowed: true as const, props }));
    const fetch = vi.fn(async () => forwardedResponse());
    const worker = createCloudflareAgentAccessMcpWorker(
      { serve: () => ({ fetch }) },
      {
        resolveAllowedOrigin: () => null,
        authenticate,
        controls: admissionControls(),
      }
    );
    const response = await worker.fetch!(
      initializeRequest({ origin: 'https://evil.example' }),
      {},
      executionContext()
    );
    expect(response.status).toBe(403);
    expect(authenticate).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the 2025-03-26 compatibility fallback when the version header is absent', async () => {
    const authenticate = vi.fn(async () => ({ allowed: true as const, props }));
    const fetch = vi.fn(async () => forwardedResponse());
    const worker = createCloudflareAgentAccessMcpWorker(
      { serve: () => ({ fetch }) },
      { resolveAllowedOrigin: () => null, authenticate, controls: admissionControls() }
    );
    const response = await worker.fetch!(
      initializeRequest({ 'mcp-session-id': 'session-1' }),
      {},
      executionContext()
    );
    expect(response.status).toBe(200);
    expect(authenticate).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('returns the OAuth challenge before validating a probe transport or protocol revision', async () => {
    const challenge = new Response(
      JSON.stringify({ error: 'invalid_token', error_description: 'Access token is invalid' }),
      {
        status: 401,
        headers: {
          'www-authenticate':
            'Bearer error="invalid_token", resource_metadata="https://auth.example/.well-known/oauth-protected-resource/mcp"',
        },
      }
    );
    const authenticate = vi.fn(async () => ({ allowed: false as const, response: challenge }));
    const fetch = vi.fn(async () => forwardedResponse());
    const worker = createCloudflareAgentAccessMcpWorker(
      { serve: () => ({ fetch }) },
      { resolveAllowedOrigin: () => null, authenticate, controls: admissionControls() }
    );
    const response = await worker.fetch!(
      new Request('https://auth.example/mcp', {
        method: 'GET',
        headers: {
          accept: '*/*',
          'mcp-protocol-version': '2024-11-05',
        },
      }),
      {},
      executionContext()
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
    expect(authenticate).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an unsupported explicit protocol revision after authentication', async () => {
    const authenticate = vi.fn(async () => ({ allowed: true as const, props }));
    const fetch = vi.fn(async () => forwardedResponse());
    const worker = createCloudflareAgentAccessMcpWorker(
      { serve: () => ({ fetch }) },
      { resolveAllowedOrigin: () => null, authenticate, controls: admissionControls() }
    );
    const response = await worker.fetch!(
      initializeRequest({ 'mcp-protocol-version': '2099-01-01' }),
      {},
      executionContext()
    );
    expect(response.status).toBe(400);
    expect(authenticate).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('binds POST, GET, and DELETE for an existing session to the verified Grant context', async () => {
    const authenticate = vi.fn(async () => ({ allowed: true as const, props }));
    const validateSession = vi.fn(async () => 'context_mismatch' as const);
    const fetch = vi.fn(async () => forwardedResponse());
    const worker = createCloudflareAgentAccessMcpWorker(
      { serve: () => ({ fetch }) },
      {
        resolveAllowedOrigin: () => null,
        authenticate,
        validateSession,
        controls: admissionControls(),
      }
    );

    for (const method of ['POST', 'GET', 'DELETE'] as const) {
      const response = await worker.fetch!(
        new Request('https://auth.example/mcp', {
          method,
          headers: {
            authorization: 'Bearer token',
            accept: method === 'POST' ? 'application/json, text/event-stream' : 'text/event-stream',
            ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
            'mcp-session-id': 'session-1',
          },
          ...(method === 'POST'
            ? { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }
            : {}),
        }),
        {},
        executionContext()
      );
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { message: expect.stringContaining('does not match') },
      });
    }
    expect(validateSession).toHaveBeenCalledTimes(3);
    expect(validateSession).toHaveBeenCalledWith('session-1', {}, props);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed for expired, unavailable, and malformed session identifiers', async () => {
    const authenticate = vi.fn(async () => ({ allowed: true as const, props }));
    const fetch = vi.fn(async () => forwardedResponse());
    const validateSession = vi
      .fn()
      .mockResolvedValueOnce('expired')
      .mockRejectedValueOnce(new Error('DO unavailable'));
    const worker = createCloudflareAgentAccessMcpWorker(
      { serve: () => ({ fetch }) },
      {
        resolveAllowedOrigin: () => null,
        authenticate,
        validateSession,
        controls: admissionControls(),
      }
    );

    const expired = await worker.fetch!(
      initializeRequest({ 'mcp-session-id': 'expired-session' }),
      {},
      executionContext()
    );
    expect(expired.status).toBe(404);
    expect(expired.headers.get('cache-control')).toBe('no-store');

    const unavailable = await worker.fetch!(
      initializeRequest({ 'mcp-session-id': 'unavailable-session' }),
      {},
      executionContext()
    );
    expect(unavailable.status).toBe(503);

    const malformed = await worker.fetch!(
      initializeRequest({ 'mcp-session-id': 'contains space' }),
      {},
      executionContext()
    );
    expect(malformed.status).toBe(400);
    expect(validateSession).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('authenticates an initialize request and passes only verified props to McpAgent', async () => {
    const authenticate = vi.fn(async () => ({ allowed: true as const, props }));
    const fetch = vi.fn(
      async (
        _request: Request,
        _env: unknown,
        context: ExecutionContext & { props?: CloudflareAgentAccessMcpProps }
      ) => {
        expect(context.props).toEqual({ context: props.context });
        expect(
          decodeCloudflareAgentAccessRequestContext(
            _request.headers.get(AGENT_ACCESS_INTERNAL_CONTEXT_HEADER)
          )
        ).toEqual(props.context);
        return forwardedResponse();
      }
    );
    const serve = vi.fn(() => ({ fetch }));
    const worker = createCloudflareAgentAccessMcpWorker(
      { serve },
      {
        resolveAllowedOrigin: (_request) => 'https://client.example',
        authenticate,
        controls: admissionControls(),
        binding: 'AGENT_ACCESS_MCP',
      }
    );
    const response = await worker.fetch!(
      initializeRequest({
        origin: 'https://client.example',
        [AGENT_ACCESS_INTERNAL_CONTEXT_HEADER]: 'attacker-controlled',
      }),
      {},
      executionContext()
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://client.example');
    expect(authenticate).toHaveBeenCalledOnce();
    expect(serve).toHaveBeenCalledWith(
      '/mcp',
      expect.objectContaining({ binding: 'AGENT_ACCESS_MCP', transport: 'streamable-http' })
    );
  });

  it('handles validated CORS preflight without treating it as an MCP authorization request', async () => {
    const authenticate = vi.fn(async () => ({ allowed: true as const, props }));
    const fetch = vi.fn(async () => forwardedResponse());
    const worker = createCloudflareAgentAccessMcpWorker(
      { serve: () => ({ fetch }) },
      {
        resolveAllowedOrigin: () => 'https://client.example',
        authenticate,
        controls: admissionControls(),
      }
    );
    const response = await worker.fetch!(
      new Request('https://auth.example/mcp', {
        method: 'OPTIONS',
        headers: { origin: 'https://client.example' },
      }),
      {},
      executionContext()
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('vary')).toBe('Origin');
    expect(response.headers.get('access-control-allow-headers')).toContain('DPoP');
    expect(authenticate).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects POST without the Streamable HTTP dual Accept contract after authentication', async () => {
    const authenticate = vi.fn(async () => ({ allowed: true as const, props }));
    const fetch = vi.fn(async () => forwardedResponse());
    const worker = createCloudflareAgentAccessMcpWorker(
      { serve: () => ({ fetch }) },
      { resolveAllowedOrigin: () => null, authenticate, controls: admissionControls() }
    );

    const response = await worker.fetch!(
      initializeRequest({ accept: 'application/json' }),
      {},
      executionContext()
    );
    expect(response.status).toBe(400);
    expect(authenticate).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects JSON-RPC batches and request bodies above the bounded transport limit', async () => {
    const authenticate = vi.fn(async () => ({ allowed: true as const, props }));
    const fetch = vi.fn(async () => forwardedResponse());
    const worker = createCloudflareAgentAccessMcpWorker(
      { serve: () => ({ fetch }) },
      { resolveAllowedOrigin: () => null, authenticate, controls: admissionControls() }
    );

    const batch = await worker.fetch!(
      new Request('https://auth.example/mcp', {
        method: 'POST',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify([
          { jsonrpc: '2.0', id: 1, method: 'initialize' },
          { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        ]),
      }),
      {},
      executionContext()
    );
    expect(batch.status).toBe(400);
    await expect(batch.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining('one JSON-RPC') },
    });

    const oversized = await worker.fetch!(
      initializeRequest({ 'content-length': String(AGENT_ACCESS_MCP_MAX_REQUEST_BYTES + 1) }),
      {},
      executionContext()
    );
    expect(oversized.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('enforces request, initialization, and concurrent-session admission independently', async () => {
    const authenticate = vi.fn(async () => ({ allowed: true as const, props }));
    const response = new Response('{}', {
      status: 200,
      headers: { 'mcp-session-id': 'new-session' },
    });
    const fetch = vi.fn(async () => response.clone());

    const requestLimited = createCloudflareAgentAccessMcpWorker(
      { serve: () => ({ fetch }) },
      {
        resolveAllowedOrigin: () => null,
        authenticate,
        controls: admissionControls({ requestAllowed: false }),
      }
    );
    expect((await requestLimited.fetch!(initializeRequest(), {}, executionContext())).status).toBe(
      429
    );

    const initializeLimited = createCloudflareAgentAccessMcpWorker(
      { serve: () => ({ fetch }) },
      {
        resolveAllowedOrigin: () => null,
        authenticate,
        controls: admissionControls({ initializeAllowed: false }),
      }
    );
    expect(
      (await initializeLimited.fetch!(initializeRequest(), {}, executionContext())).status
    ).toBe(429);

    const controls = admissionControls({ sessionRegistered: false });
    const concurrentLimited = createCloudflareAgentAccessMcpWorker(
      { serve: () => ({ fetch }) },
      { resolveAllowedOrigin: () => null, authenticate, controls }
    );
    expect(
      (await concurrentLimited.fetch!(initializeRequest(), {}, executionContext())).status
    ).toBe(429);
    expect(controls.destroySession).toHaveBeenCalledWith('new-session', {});
  });

  it('rejects an unregistered session before probing or allocating a named Durable Object', async () => {
    const authenticate = vi.fn(async () => ({ allowed: true as const, props }));
    const validateSession = vi.fn(async () => 'active' as const);
    const controls = admissionControls({ sessionActive: false });
    const fetch = vi.fn(async () => forwardedResponse());
    const worker = createCloudflareAgentAccessMcpWorker(
      { serve: () => ({ fetch }) },
      {
        resolveAllowedOrigin: () => null,
        authenticate,
        validateSession,
        controls,
      }
    );
    const response = await worker.fetch!(
      initializeRequest({ 'mcp-session-id': 'attacker-selected-session' }),
      {},
      executionContext()
    );
    expect(response.status).toBe(404);
    expect(validateSession).not.toHaveBeenCalled();
    expect(controls.destroySession).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects GET without SSE Accept and unsupported methods with an Allow header', async () => {
    const authenticate = vi.fn(async () => ({ allowed: true as const, props }));
    const fetch = vi.fn(async () => forwardedResponse());
    const worker = createCloudflareAgentAccessMcpWorker(
      { serve: () => ({ fetch }) },
      { resolveAllowedOrigin: () => null, authenticate, controls: admissionControls() }
    );

    const getResponse = await worker.fetch!(
      new Request('https://auth.example/mcp', {
        method: 'GET',
        headers: {
          authorization: 'Bearer token',
          accept: 'application/json',
          'mcp-protocol-version': '2025-11-25',
        },
      }),
      {},
      executionContext()
    );
    expect(getResponse.status).toBe(400);

    const putResponse = await worker.fetch!(
      new Request('https://auth.example/mcp', { method: 'PUT' }),
      {},
      executionContext()
    );
    expect(putResponse.status).toBe(405);
    expect(putResponse.headers.get('allow')).toBe('GET, POST, DELETE, OPTIONS');
    expect(authenticate).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { client: 'Codex', userAgent: 'codex-mcp-client/fixture', protocolVersion: undefined },
    { client: 'Claude Code', userAgent: 'claude-code/fixture', protocolVersion: '2025-06-18' },
    { client: 'Gemini CLI', userAgent: 'gemini-cli/fixture', protocolVersion: '2025-11-25' },
  ])(
    'accepts the $client Mode A Bearer Streamable HTTP initialization profile',
    async ({ userAgent, protocolVersion }) => {
      const authenticate = vi.fn(async () => ({ allowed: true as const, props }));
      const fetch = vi.fn(async () => forwardedResponse());
      const worker = createCloudflareAgentAccessMcpWorker(
        { serve: () => ({ fetch }) },
        { resolveAllowedOrigin: () => null, authenticate, controls: admissionControls() }
      );
      const response = await worker.fetch!(
        initializeRequest({
          'user-agent': userAgent,
          ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}),
        }),
        {},
        executionContext()
      );

      expect(response.status).toBe(200);
      expect(authenticate).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledOnce();
    }
  );
});
