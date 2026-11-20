import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveTenantDatabaseSourceFromRegistry: vi.fn(async () => ({ source: {} })),
    ensureDatabaseAdapter: vi.fn(() => ({})),
    recordDirectoryConnectorHeartbeat: vi.fn(async () => ({ accepted: true })),
  };
});

import {
  CONNECTOR,
  PROTOCOL,
  STATUS_KEY,
  TENANT,
  attachment,
  authenticate,
  createRelay,
  events,
  pendingMap,
  relayWebSocket,
  verifyBody,
  verifyRequest,
} from './helpers/mut-directory-relay-fixtures';

type Reply = (request: Record<string, unknown>) => Record<string, unknown> | null;

async function setupConnected(reply: Reply, connector: Record<string, unknown> = {}) {
  const fixture = createRelay({ connector });
  await authenticate(fixture.storage);
  const socket = relayWebSocket(attachment());
  const requests: Array<Record<string, unknown>> = [];
  socket.raw.send.mockImplementation((value: string) => {
    const message = JSON.parse(value) as Record<string, unknown>;
    socket.sent.push(message);
    if (message.type !== 'verify.request') return;
    requests.push(message);
    const response = reply(message);
    if (response) {
      setTimeout(() => {
        void fixture.relay.webSocketMessage(socket.ws, JSON.stringify(response));
      }, 0);
    }
  });
  fixture.ctx.getWebSockets.mockReturnValue([socket.ws]);
  return { ...fixture, socket, requests };
}

const envelope = { protocol: PROTOCOL, protocol_version: 1, min_supported_version: 1 };

async function errorOf(response: Response) {
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

beforeEach(() => vi.clearAllMocks());

describe('relay verify-password request validation', () => {
  it('rejects a request without a body', async () => {
    const { relay } = createRelay();
    const response = await relay.fetch(
      new Request('https://directory-relay.internal/verify-password', { method: 'POST' })
    );
    expect(await errorOf(response)).toEqual({
      status: 400,
      body: { error: { code: 'invalid_relay_request', retryable: false } },
    });
  });

  it('rejects a declared content-length above the limit before reading', async () => {
    const { relay } = createRelay();
    const response = await relay.fetch(
      verifyRequest('{}', { 'content-length': String(64 * 1024 + 1) })
    );
    expect(await errorOf(response)).toEqual({
      status: 413,
      body: { error: { code: 'relay_request_too_large', retryable: false } },
    });
  });

  it('accepts a body of exactly 64 KiB as far as JSON parsing', async () => {
    const { relay } = createRelay();
    const response = await relay.fetch(verifyRequest(' '.repeat(64 * 1024)));
    expect(await errorOf(response)).toEqual({
      status: 400,
      body: { error: { code: 'invalid_relay_request', retryable: false } },
    });
  });

  it('rejects a body stream read error', async () => {
    const { relay } = createRelay();
    const stream = new ReadableStream({
      pull(controller) {
        controller.error(new Error('broken'));
      },
    });
    const response = await relay.fetch(
      new Request('https://directory-relay.internal/verify-password', {
        method: 'POST',
        body: stream,
        duplex: 'half',
      } as RequestInit)
    );
    expect((await errorOf(response)).body).toEqual({
      error: { code: 'invalid_relay_request', retryable: false },
    });
  });

  it.each([
    ['invalid JSON', '{'],
    ['missing request_id', verifyBody({ request_id: undefined })],
    ['blank tenant_id', verifyBody({ tenant_id: '  ' })],
    ['missing connector_id', verifyBody({ connector_id: undefined })],
    ['missing username', verifyBody({ username: '' })],
    ['empty password', verifyBody({ password: '' })],
    ['non-string password', verifyBody({ password: 1234 })],
  ])('rejects %s as invalid_relay_request', async (_l, body) => {
    const { relay } = createRelay();
    expect(await errorOf(await relay.fetch(verifyRequest(body)))).toEqual({
      status: 400,
      body: { error: { code: 'invalid_relay_request', retryable: false } },
    });
  });

  it.each([
    ['unknown connector', { connector_id: 'wwcon_UNKNOWN' }, {}],
    ['direct connector', {}, { transport: 'direct' }],
  ])('returns relay_connector_not_configured for %s', async (_l, body, connector) => {
    const { relay } = createRelay({ connector });
    expect(await errorOf(await relay.fetch(verifyRequest(verifyBody(body))))).toEqual({
      status: 404,
      body: { error: { code: 'relay_connector_not_configured', retryable: false } },
    });
  });

  it('returns relay_connector_offline when no authenticated socket exists for the connector', async () => {
    const { relay, ctx, storage } = createRelay();
    await authenticate(storage);
    ctx.getWebSockets.mockReturnValue([
      relayWebSocket(null).ws,
      relayWebSocket(attachment({ connectorId: 'wwcon_OTHER' })).ws,
      relayWebSocket(attachment({ tenantId: 'tenant-b' })).ws,
    ]);
    expect(await errorOf(await relay.fetch(verifyRequest(verifyBody())))).toEqual({
      status: 503,
      body: { error: { code: 'relay_connector_offline', retryable: true } },
    });
  });
});

describe('relay verify-password forwarding', () => {
  it('forwards the request, returns the verify response, and records success', async () => {
    const { relay, storage, requests } = await setupConnected((request) => ({
      ...envelope,
      type: 'verify.response',
      id: request.id,
      request_id: request.request_id,
      tenant_id: TENANT,
      connector_id: CONNECTOR,
      result: 'success',
      directory_status: 'ok',
    }));
    const response = await relay.fetch(
      verifyRequest(
        verifyBody({
          username: '  alice  ',
          password: ' pw ',
          attribute_names: ['mail', '', 3, 'cn'],
        })
      )
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ result: 'success', request_id: 'req_1' });
    expect(requests[0]).toEqual({
      type: 'verify.request',
      ...envelope,
      id: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
      request_id: 'req_1',
      tenant_id: TENANT,
      connector_id: CONNECTOR,
      username: 'alice',
      password: ' pw ',
      attribute_names: ['mail', 'cn'],
    });
    expect(events(storage).map((e) => e.type)).toEqual([
      'directory_relay.verify.succeeded',
      'directory_relay.verify.forwarded',
    ]);
    expect(events(storage)[0]).toMatchObject({ requestId: 'req_1', result: 'success' });
    const status = storage._values.get(STATUS_KEY) as Record<string, unknown>;
    expect(status.lastVerifyStartedAt).toEqual(expect.any(String));
    expect(status.lastVerifySucceededAt).toEqual(expect.any(String));
    expect(status.lastVerifyFailedAt).toBeUndefined();
    expect(pendingMap(relay).size).toBe(0);
  });

  it('sends an empty attribute list when attribute_names is not an array', async () => {
    const { relay, requests } = await setupConnected((request) => ({
      ...envelope,
      type: 'verify.response',
      id: request.id,
      request_id: request.request_id,
      tenant_id: TENANT,
      connector_id: CONNECTOR,
      result: 'failure',
    }));
    await relay.fetch(verifyRequest(verifyBody({ attribute_names: 'mail' })));
    expect(requests[0].attribute_names).toEqual([]);
  });

  it('times out with 504 relay_verify_timeout and records a timeout event', async () => {
    const { relay, storage } = await setupConnected(() => null, {
      relay: { verify_timeout_ms: 100 },
    });
    const started = Date.now();
    const response = await relay.fetch(verifyRequest(verifyBody()));
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(await errorOf(response)).toEqual({
      status: 504,
      body: { error: { code: 'relay_verify_timeout', retryable: true } },
    });
    expect(events(storage)[0]).toMatchObject({
      type: 'directory_relay.verify.timeout',
      code: 'relay_verify_timeout',
      retryable: true,
      requestId: 'req_1',
    });
    expect((storage._values.get(STATUS_KEY) as Record<string, unknown>).lastVerifyFailedAt).toEqual(
      expect.any(String)
    );
    expect(pendingMap(relay).size).toBe(0);
  });

  it('records a send failure and clears the pending request', async () => {
    const fixture = await setupConnected(() => null);
    fixture.socket.raw.send.mockImplementation(() => {
      throw new Error('closed');
    });
    const response = await fixture.relay.fetch(verifyRequest(verifyBody()));
    expect(await errorOf(response)).toEqual({
      status: 503,
      body: { error: { code: 'relay_send_failed', retryable: true } },
    });
    expect(pendingMap(fixture.relay).size).toBe(0);
    expect(events(fixture.storage)[0]).toMatchObject({
      type: 'directory_relay.verify.failed',
      code: 'relay_send_failed',
      retryable: true,
    });
  });

  it('rejects a mismatched verify response with 400 and closes the socket', async () => {
    const { relay, socket, storage } = await setupConnected((request) => ({
      ...envelope,
      type: 'verify.response',
      id: request.id,
      request_id: 'other-request',
      tenant_id: TENANT,
      connector_id: CONNECTOR,
      result: 'success',
    }));
    expect(await errorOf(await relay.fetch(verifyRequest(verifyBody())))).toEqual({
      status: 400,
      body: { error: { code: 'relay_response_mismatch', retryable: false } },
    });
    expect(socket.raw.close).toHaveBeenCalledWith(1008, 'relay response mismatch');
    expect(events(storage).map((e) => e.code)).toContain('relay_response_mismatch');
  });

  it.each([
    ['tenant_id', 'tenant-b'],
    ['connector_id', 'wwcon_OTHER'],
  ])('rejects a verify response with mismatched %s', async (field, value) => {
    const { relay } = await setupConnected((request) => ({
      ...envelope,
      type: 'verify.response',
      id: request.id,
      request_id: request.request_id,
      tenant_id: TENANT,
      connector_id: CONNECTOR,
      result: 'success',
      [field]: value,
    }));
    expect((await errorOf(await relay.fetch(verifyRequest(verifyBody())))).body).toEqual({
      error: { code: 'relay_response_mismatch', retryable: false },
    });
  });

  it.each([
    [{ code: 'directory_down', retryable: true }, 503, 'directory_down', true],
    [{ code: 'bad code!' }, 503, 'relay_verify_error', true],
    [{ code: 'x'.repeat(129) }, 503, 'relay_verify_error', true],
    [{ code: 'policy.denied', retryable: false }, 400, 'policy.denied', false],
    [{ code: 'policy:x', retryable: 'no' }, 503, 'policy:x', true],
    ['string-error', 503, 'relay_verify_error', true],
    [['array'], 503, 'relay_verify_error', true],
  ])('maps verify.error %j to %s %s', async (error, status, code, retryable) => {
    const { relay, storage } = await setupConnected((request) => ({
      ...envelope,
      type: 'verify.error',
      id: request.id,
      request_id: request.request_id,
      error,
    }));
    expect(await errorOf(await relay.fetch(verifyRequest(verifyBody())))).toEqual({
      status,
      body: { error: { code, retryable } },
    });
    expect(events(storage)[0]).toMatchObject({
      type: 'directory_relay.verify.failed',
      code,
      retryable,
    });
  });
});

describe('relay verify message guards', () => {
  it.each(['verify.response', 'verify.error'])(
    'rejects %s from an unauthenticated socket',
    async (type) => {
      const { relay } = createRelay();
      const socket = relayWebSocket(attachment());
      await relay.webSocketMessage(socket.ws, JSON.stringify({ ...envelope, type, id: 'x' }));
      expect(socket.sent[0]).toMatchObject({ type: 'error', code: 'unauthenticated' });
      expect(socket.raw.close).toHaveBeenCalledWith(1008, 'unauthenticated');
    }
  );

  it.each(['verify.response', 'verify.error'])(
    'reports an unknown request id for %s',
    async (type) => {
      const { relay, storage } = createRelay();
      await authenticate(storage);
      const socket = relayWebSocket(attachment());
      await relay.webSocketMessage(socket.ws, JSON.stringify({ ...envelope, type, id: 'missing' }));
      expect(socket.sent[0]).toMatchObject({ code: 'unknown_request_id' });
      expect(socket.raw.close).not.toHaveBeenCalled();
    }
  );
});

describe('relay event log', () => {
  it('keeps the newest 100 events and truncates long fields', async () => {
    const { relay, storage } = createRelay({ connector: { relay: { max_pending_requests: 1 } } });
    const old = Array.from({ length: 100 }, (_, i) => ({ id: `e${i}`, type: 'old' }));
    storage._values.set(`events:${TENANT}:${CONNECTOR}`, { events: old });
    pendingMap(relay).set('p', {
      resolve: vi.fn(),
      reject: vi.fn(),
      timeout: setTimeout(() => undefined, 0),
      expiresAt: Date.now() + 10_000,
      requestId: 'r',
      tenantId: TENANT,
      connectorId: CONNECTOR,
    });
    await relay.fetch(verifyRequest(verifyBody({ request_id: ` ${'r'.repeat(300)} ` })));
    const list = events(storage);
    expect(list).toHaveLength(100);
    expect(list[0]).toMatchObject({
      type: 'directory_relay.overloaded',
      requestId: 'r'.repeat(256),
    });
    expect(list[99].id).toBe('e98');
  });
});
