import { describe, expect, it, vi } from 'vitest';
import type { AgentGrantContract } from '../../../core';
import type { CloudflareAgentAccessMcpProps } from '../mcp-props';
import { createCloudflareAgentAccessMcpWorker } from '../mcp-admission';
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
  it('rejects an untrusted Origin before token processing or Durable Object routing', async () => {
    const authenticate = vi.fn(async () => ({ allowed: true as const, props }));
    const fetch = vi.fn(async () => new Response('forwarded'));
    const worker = createCloudflareAgentAccessMcpWorker(
      { serve: () => ({ fetch }) },
      {
        resolveAllowedOrigin: () => null,
        authenticate,
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
    const fetch = vi.fn(async () => new Response('forwarded'));
    const worker = createCloudflareAgentAccessMcpWorker(
      { serve: () => ({ fetch }) },
      { resolveAllowedOrigin: () => null, authenticate }
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
    const fetch = vi.fn(async () => new Response('forwarded'));
    const worker = createCloudflareAgentAccessMcpWorker(
      { serve: () => ({ fetch }) },
      { resolveAllowedOrigin: () => null, authenticate }
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
    const fetch = vi.fn(async () => new Response('forwarded'));
    const worker = createCloudflareAgentAccessMcpWorker(
      { serve: () => ({ fetch }) },
      { resolveAllowedOrigin: () => null, authenticate }
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
    const fetch = vi.fn(async () => new Response('forwarded'));
    const worker = createCloudflareAgentAccessMcpWorker(
      { serve: () => ({ fetch }) },
      { resolveAllowedOrigin: () => null, authenticate, validateSession }
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
    const fetch = vi.fn(async () => new Response('forwarded'));
    const validateSession = vi
      .fn()
      .mockResolvedValueOnce('expired')
      .mockRejectedValueOnce(new Error('DO unavailable'));
    const worker = createCloudflareAgentAccessMcpWorker(
      { serve: () => ({ fetch }) },
      { resolveAllowedOrigin: () => null, authenticate, validateSession }
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
        return new Response('forwarded');
      }
    );
    const serve = vi.fn(() => ({ fetch }));
    const worker = createCloudflareAgentAccessMcpWorker(
      { serve },
      {
        resolveAllowedOrigin: (_request) => 'https://client.example',
        authenticate,
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
    const fetch = vi.fn(async () => new Response('forwarded'));
    const worker = createCloudflareAgentAccessMcpWorker(
      { serve: () => ({ fetch }) },
      {
        resolveAllowedOrigin: () => 'https://client.example',
        authenticate,
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
    const fetch = vi.fn(async () => new Response('forwarded'));
    const worker = createCloudflareAgentAccessMcpWorker(
      { serve: () => ({ fetch }) },
      { resolveAllowedOrigin: () => null, authenticate }
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

  it('rejects GET without SSE Accept and unsupported methods with an Allow header', async () => {
    const authenticate = vi.fn(async () => ({ allowed: true as const, props }));
    const fetch = vi.fn(async () => new Response('forwarded'));
    const worker = createCloudflareAgentAccessMcpWorker(
      { serve: () => ({ fetch }) },
      { resolveAllowedOrigin: () => null, authenticate }
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
      const fetch = vi.fn(async () => new Response('forwarded'));
      const worker = createCloudflareAgentAccessMcpWorker(
        { serve: () => ({ fetch }) },
        { resolveAllowedOrigin: () => null, authenticate }
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
