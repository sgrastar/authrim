import { describe, expect, it, vi } from 'vitest';
import {
  DirectoryPasswordRelayClient,
  directoryRelayInstanceName,
} from '../directory-relay-client';

type Responder = (init: RequestInit) => Promise<Response> | Response;

function createRelay(responder: Responder) {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => responder(init));
  const namespace = {
    idFromName: vi.fn((name: string) => ({ name }) as unknown as DurableObjectId),
    get: vi.fn(() => ({ fetch }) as unknown as DurableObjectStub),
  } as unknown as DurableObjectNamespace;
  return { namespace, fetch };
}

const okBody = {
  request_id: 'req_1',
  tenant_id: 'tenant-a',
  connector_id: 'wwcon_1',
  result: 'failure',
  reason: 'invalid_credentials',
  directory_status: 'ok',
};

function client(namespace: DurableObjectNamespace, timeoutMs = 1000) {
  return new DirectoryPasswordRelayClient({
    relay: namespace,
    tenantId: 'tenant-a',
    connectorId: 'wwcon_1',
    timeoutMs,
  });
}

const input = { username: 'alice', password: 'pw', requestId: 'req_1' };

describe('DirectoryPasswordRelayClient (mutation hardening)', () => {
  it('sends an empty attribute_names list and the configured identifiers by default', async () => {
    const relay = createRelay(() => Response.json(okBody));
    const result = await client(relay.namespace).verifyPassword(input);
    expect(result).toMatchObject({ result: 'failure', reason: 'invalid_credentials' });
    const init = relay.fetch.mock.calls[0][1];
    expect(JSON.parse(init.body as string)).toEqual({
      request_id: 'req_1',
      tenant_id: 'tenant-a',
      connector_id: 'wwcon_1',
      username: 'alice',
      password: 'pw',
      attribute_names: [],
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('generates a request id when none is provided', async () => {
    let sentId = '';
    const relay = createRelay((init) => {
      sentId = (JSON.parse(init.body as string) as { request_id: string }).request_id;
      return Response.json({ ...okBody, request_id: sentId });
    });
    const result = await client(relay.namespace).verifyPassword({ username: 'a', password: 'b' });
    expect(sentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.request_id).toBe(sentId);
  });

  it('maps an aborted relay call to relay_timeout after the configured timeout', async () => {
    const relay = createRelay(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          );
        })
    );
    await expect(client(relay.namespace, 5).verifyPassword(input)).rejects.toMatchObject({
      details: { code: 'relay_timeout', retryable: true, status: 0, tenantId: 'tenant-a' },
    });
    // retryable timeout is retried exactly once
    expect(relay.fetch).toHaveBeenCalledTimes(2);
  });

  it('maps other fetch failures to relay_fetch_error', async () => {
    const relay = createRelay(() => {
      throw new TypeError('network down');
    });
    await expect(client(relay.namespace).verifyPassword(input)).rejects.toMatchObject({
      details: {
        code: 'relay_fetch_error',
        retryable: true,
        status: 0,
        requestId: 'req_1',
        connectorId: 'wwcon_1',
      },
    });
    expect(relay.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not treat a non-DOMException named AbortError as a timeout', async () => {
    const relay = createRelay(() => {
      const error = new Error('fake');
      error.name = 'AbortError';
      throw error;
    });
    await expect(client(relay.namespace).verifyPassword(input)).rejects.toMatchObject({
      details: { code: 'relay_fetch_error' },
    });
  });

  it('does not treat a DOMException with another name as a timeout', async () => {
    const relay = createRelay(() => {
      throw new DOMException('nope', 'NetworkError');
    });
    await expect(client(relay.namespace).verifyPassword(input)).rejects.toMatchObject({
      details: { code: 'relay_fetch_error' },
    });
  });

  it('retries a retryable relay error at most once', async () => {
    const relay = createRelay(() =>
      Response.json(
        { error: { code: 'relay_connection_closed', retryable: true } },
        { status: 503 }
      )
    );
    await expect(client(relay.namespace).verifyPassword(input)).rejects.toMatchObject({
      details: { code: 'relay_connection_closed', retryable: true, status: 503 },
    });
    expect(relay.fetch).toHaveBeenCalledTimes(2);
  });

  it('falls back to relay_unavailable and status-derived retryability for unparsable errors', async () => {
    const r500 = createRelay(() => new Response('oops', { status: 500 }));
    await expect(client(r500.namespace).verifyPassword(input)).rejects.toMatchObject({
      details: { code: 'relay_unavailable', retryable: true, status: 500 },
    });
    expect(r500.fetch).toHaveBeenCalledTimes(2);

    const r499 = createRelay(() => new Response('oops', { status: 499 }));
    await expect(client(r499.namespace).verifyPassword(input)).rejects.toMatchObject({
      details: { code: 'relay_unavailable', retryable: false, status: 499 },
    });
    expect(r499.fetch).toHaveBeenCalledTimes(1);

    const r501 = createRelay(() => Response.json({ error: {} }, { status: 501 }));
    await expect(client(r501.namespace).verifyPassword(input)).rejects.toMatchObject({
      details: { code: 'relay_unavailable', retryable: true, status: 501 },
    });
  });

  it('honours an explicit retryable=false from the relay', async () => {
    const relay = createRelay(() =>
      Response.json({ error: { code: 'x_error', retryable: false } }, { status: 503 })
    );
    await expect(client(relay.namespace).verifyPassword(input)).rejects.toMatchObject({
      details: { code: 'x_error', retryable: false },
    });
    expect(relay.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry 429 responses even when marked retryable', async () => {
    const relay = createRelay(() =>
      Response.json({ error: { code: 'some_code', retryable: true } }, { status: 429 })
    );
    await expect(client(relay.namespace).verifyPassword(input)).rejects.toMatchObject({
      details: { code: 'some_code', status: 429 },
    });
    expect(relay.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    'relay_connector_offline',
    'relay_overloaded',
    'relay_connector_not_configured',
    'invalid_relay_request',
    'relay_request_too_large',
  ])('does not retry %s', async (code) => {
    const relay = createRelay(() =>
      Response.json({ error: { code, retryable: true } }, { status: 503 })
    );
    await expect(client(relay.namespace).verifyPassword(input)).rejects.toMatchObject({
      details: { code },
    });
    expect(relay.fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a 200 response that is not JSON', async () => {
    const relay = createRelay(() => new Response('not json', { status: 200 }));
    await expect(client(relay.namespace).verifyPassword(input)).rejects.toMatchObject({
      details: { code: 'invalid_connector_response', retryable: false, status: 502 },
    });
    expect(relay.fetch).toHaveBeenCalledTimes(1);
  });

  it('propagates non-DirectoryPasswordError failures without retry', async () => {
    const namespace = {
      idFromName: vi.fn(() => {
        throw new RangeError('bad id');
      }),
      get: vi.fn(),
    } as unknown as DurableObjectNamespace;
    await expect(client(namespace).verifyPassword(input)).rejects.toBeInstanceOf(RangeError);
    expect(namespace.idFromName).toHaveBeenCalledTimes(1);
  });

  it('url-encodes the instance name parts', () => {
    expect(directoryRelayInstanceName({ tenantId: 'a:b', connectorId: 'c/d' })).toBe('a%3Ab:c%2Fd');
  });
});
