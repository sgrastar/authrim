import { describe, expect, it } from 'vitest';
import { AGENT_ACCESS_MCP_MAX_REQUEST_BYTES } from '../platform/cloudflare/mcp-admission';
import {
  harness,
  jsonRpcError,
  mcpCall,
  mcpPost,
  toolsCall,
} from './helpers/mut-worker-admission-harness';

const SESSION = { 'mcp-session-id': 'session-1' };

async function transportDenial(request: Request) {
  const h = harness();
  const response = await h.fetch(request);
  const body = await jsonRpcError(response);
  return { status: response.status, body, event: h.lastEvent(), response, h };
}

describe('Streamable HTTP media-type negotiation', () => {
  it.each([
    ['a missing Content-Type', mcpPost(undefined, {}), 'content-type'],
    ['a non-JSON Content-Type', mcpPost(undefined, { 'content-type': 'text/plain' }), ''],
    ['no Accept header', mcpPost(undefined, {}), 'accept'],
    ['Accept without text/event-stream', mcpPost(undefined, { accept: 'application/json' }), ''],
    ['Accept without application/json', mcpPost(undefined, { accept: 'text/event-stream' }), ''],
    [
      'application/json refused with q=0',
      mcpPost(undefined, { accept: 'application/json;q=0, text/event-stream' }),
      '',
    ],
    [
      'event-stream refused with spaced q = 0.000',
      mcpPost(undefined, { accept: 'application/json, text/event-stream; q = 0.000' }),
      '',
    ],
    [
      'event-stream refused with q= 0. and a trailing parameter',
      mcpPost(undefined, { accept: 'application/json, text/event-stream;q= 0. ;level=1' }),
      '',
    ],
    [
      'event-stream refused with q =0.00',
      mcpPost(undefined, { accept: 'application/json, text/event-stream;q =0.00' }),
      '',
    ],
  ])('rejects a POST with %s', async (_name, request, removeHeader) => {
    if (removeHeader) request.headers.delete(removeHeader);
    const { status, body, event } = await transportDenial(request);
    expect(status).toBe(400);
    expect(body).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32600,
        message:
          'POST requires application/json and Accept for application/json and text/event-stream',
      },
    });
    expect(event).toMatchObject({
      eventType: 'agent.mcp.admission.transport_denied',
      outcome: 'denied',
      httpStatus: 400,
      tenantId: 'tenant-1',
      details: { code: 'AGENT_MCP_MEDIA_TYPE_INVALID' },
    });
  });

  it.each([
    ['a non-zero quality', 'application/json;q=0.5, text/event-stream;q=0.01'],
    ['an unrelated parameter ending in q=0', 'application/json;xq=0, text/event-stream'],
    ['mixed case media types', 'Application/JSON, TEXT/Event-Stream'],
  ])('admits a POST with %s', async (_name, accept) => {
    const h = harness();
    const response = await h.fetch(
      mcpPost(undefined, { accept, 'content-type': ' Application/JSON ; charset=utf-8' })
    );
    expect(response.status).toBe(200);
    expect(h.forward).toHaveBeenCalledOnce();
  });

  it('rejects a GET whose Accept omits text/event-stream', async () => {
    const request = mcpCall('GET', { ...SESSION, accept: 'application/json' });
    const { status, body, event } = await transportDenial(request);
    expect(status).toBe(400);
    expect(body.error).toEqual({ code: -32600, message: 'GET requires Accept: text/event-stream' });
    expect(event).toMatchObject({ details: { code: 'AGENT_MCP_ACCEPT_INVALID' } });
    expect(event?.eventType).toBe('agent.mcp.admission.transport_denied');
  });

  it('rejects a GET without any Accept header', async () => {
    const request = mcpCall('GET', SESSION);
    request.headers.delete('accept');
    const { event } = await transportDenial(request);
    expect(event).toMatchObject({ details: { code: 'AGENT_MCP_ACCEPT_INVALID' } });
  });

  it('does not apply the SSE Accept rule to DELETE', async () => {
    const h = harness();
    const response = await h.fetch(mcpCall('DELETE', { ...SESSION, accept: 'application/json' }));
    expect(response.status).toBe(200);
  });
});

describe('MCP protocol version', () => {
  it.each(['2025-11-25', '2025-06-18', '2025-03-26'])('accepts revision %s', async (version) => {
    const h = harness();
    const response = await h.fetch(mcpPost(undefined, { 'mcp-protocol-version': version }));
    expect(response.status).toBe(200);
  });

  it('rejects an unsupported revision with the JSON-RPC invalid-request error', async () => {
    const { status, body, event, response } = await transportDenial(
      mcpPost(undefined, { 'mcp-protocol-version': '2024-11-05' })
    );
    expect(status).toBe(400);
    expect(body).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Unsupported MCP-Protocol-Version' },
    });
    expect(response.headers.get('allow')).toBeNull();
    expect(event).toMatchObject({
      eventType: 'agent.mcp.admission.transport_denied',
      details: { code: 'AGENT_MCP_PROTOCOL_VERSION_UNSUPPORTED' },
    });
  });
});

describe('bounded JSON-RPC body', () => {
  async function bodyError(request: Request) {
    const { status, body, event } = await transportDenial(request);
    expect(status).toBe(400);
    expect(event).toMatchObject({
      eventType: 'agent.mcp.admission.transport_denied',
      details: { code: 'AGENT_MCP_JSONRPC_INVALID' },
    });
    return body.error;
  }

  it.each(['-1', 'abc', '1.5', '9007199254740993'])(
    'rejects Content-Length %s as invalid',
    async (length) => {
      await expect(bodyError(mcpPost(undefined, { 'content-length': length }))).resolves.toEqual({
        code: -32600,
        message: 'Content-Length is invalid',
      });
    }
  );

  it('rejects a declared Content-Length above the limit', async () => {
    await expect(
      bodyError(
        mcpPost(undefined, { 'content-length': String(AGENT_ACCESS_MCP_MAX_REQUEST_BYTES + 1) })
      )
    ).resolves.toMatchObject({ message: 'MCP request body exceeds the maximum size' });
  });

  it('accepts a declared Content-Length of zero or exactly the limit and strips it', async () => {
    for (const length of ['0', String(AGENT_ACCESS_MCP_MAX_REQUEST_BYTES)]) {
      const h = harness();
      const response = await h.fetch(mcpPost(undefined, { 'content-length': length }));
      expect(response.status).toBe(200);
      const forwarded = h.forward.mock.calls[0]?.[0];
      expect(forwarded.headers.get('content-length')).toBeNull();
    }
  });

  it('rejects a POST without a body', async () => {
    await expect(bodyError(mcpPost(null))).resolves.toMatchObject({
      message: 'POST requires one JSON-RPC message',
    });
  });

  it('accepts a streamed body of exactly the limit and rejects one byte more', async () => {
    const padded = (size: number) => {
      const prefix = '{"jsonrpc":"2.0","id":1,"method":"initialize","p":"';
      return prefix + 'x'.repeat(size - prefix.length - 2) + '"}';
    };
    const ok = harness();
    expect((await ok.fetch(mcpPost(padded(AGENT_ACCESS_MCP_MAX_REQUEST_BYTES)))).status).toBe(200);
    await expect(
      bodyError(mcpPost(padded(AGENT_ACCESS_MCP_MAX_REQUEST_BYTES + 1)))
    ).resolves.toMatchObject({ message: 'MCP request body exceeds the maximum size' });
  });

  it('rejects a body stream that fails while reading', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('socket reset'));
      },
    });
    await expect(bodyError(mcpPost(stream))).resolves.toMatchObject({
      message: 'MCP request body could not be read',
    });
  });

  it('reassembles a multi-chunk body and forwards the same POST', async () => {
    const encoder = new TextEncoder();
    const parts = ['{"jsonrpc":"2.0",', '"id":1,"method":', '"initialize"}'];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part));
        controller.close();
      },
    });
    const h = harness();
    const response = await h.fetch(mcpPost(stream));
    expect(response.status).toBe(200);
    const forwarded = h.forward.mock.calls[0]?.[0];
    expect(forwarded.method).toBe('POST');
    expect(forwarded.redirect).toBe('follow');
    await expect(forwarded.text()).resolves.toBe(parts.join(''));
  });

  it('rejects bodies that are not valid UTF-8 JSON', async () => {
    const invalidUtf8 = new Uint8Array([...new TextEncoder().encode('{"a":"'), 0xff, 0x22, 0x7d]);
    await expect(bodyError(mcpPost(invalidUtf8))).resolves.toMatchObject({
      message: 'POST requires valid JSON',
    });
    await expect(bodyError(mcpPost('{not json'))).resolves.toMatchObject({
      message: 'POST requires valid JSON',
    });
  });

  it.each(['null', '[{"method":"initialize"}]', '1'])(
    'requires exactly one JSON-RPC object, not %s',
    async (body) => {
      await expect(bodyError(mcpPost(body))).resolves.toEqual({
        code: -32600,
        message: 'Exactly one JSON-RPC message is required per POST',
      });
    }
  );

  it('requires a sessionless POST to be initialize', async () => {
    const { body, event } = await transportDenial(mcpPost(toolsCall));
    expect(body.error.message).toBe('A sessionless POST must be an initialize request');
    expect(event).toMatchObject({
      eventType: 'agent.mcp.admission.session_denied',
      details: { code: 'AGENT_MCP_SESSION_INITIALIZE_REQUIRED' },
    });
  });
});
