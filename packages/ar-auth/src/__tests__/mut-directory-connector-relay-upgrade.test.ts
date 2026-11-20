import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveTenantDatabaseSourceFromRegistry: vi.fn(async () => ({ source: {} })),
  recordDirectoryConnectorHeartbeat: vi.fn(async () => ({ accepted: true })),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveTenantDatabaseSourceFromRegistry: mocks.resolveTenantDatabaseSourceFromRegistry,
    ensureDatabaseAdapter: vi.fn(() => ({})),
    recordDirectoryConnectorHeartbeat: mocks.recordDirectoryConnectorHeartbeat,
  };
});

import {
  AUTH_FAILURE_KEY,
  CONNECTOR,
  PROTOCOL,
  STATUS_KEY,
  TENANT,
  WorkersLikeResponse,
  authenticate,
  createRelay,
  events,
  relayWebSocket,
} from './helpers/mut-directory-relay-fixtures';

const UPGRADE_URL = `https://relay.example/api/auth/directory-relay/connect/${TENANT}/${CONNECTOR}`;

function upgrade(url = UPGRADE_URL, headerValue = 'websocket') {
  return new Request(url, { headers: { Upgrade: headerValue } });
}

let serverSocket: ReturnType<typeof relayWebSocket>;

beforeEach(() => {
  vi.clearAllMocks();
  serverSocket = relayWebSocket(null);
  vi.stubGlobal(
    'WebSocketPair',
    class {
      0 = { client: true };
      1 = serverSocket.ws;
    }
  );
  vi.stubGlobal('Response', WorkersLikeResponse);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('DirectoryConnectorRelay websocket upgrade', () => {
  it('issues a challenge, records status and event, and returns 101', async () => {
    const { relay, ctx, storage } = createRelay({
      connector: { relay: { challenge_ttl_ms: 10_000 } },
    });
    const before = Date.now();
    const response = await relay.fetch(upgrade(UPGRADE_URL, 'WebSocket'));
    expect(response.status).toBe(101);
    expect(response.webSocket).toEqual({ client: true });
    expect(ctx.acceptWebSocket).toHaveBeenCalledWith(serverSocket.ws);

    const saved = serverSocket.raw.serializeAttachment.mock.calls[0][0] as Record<
      string,
      number | string
    >;
    expect(saved).toMatchObject({ tenantId: TENANT, connectorId: CONNECTOR });
    expect(saved.challengeExpiresAt).toBe((saved.connectedAt as number) + 10_000);
    expect(saved.connectedAt).toBeGreaterThanOrEqual(before);
    for (const field of ['connectionId', 'challengeId', 'nonce']) {
      expect(saved[field]).toMatch(/^[0-9a-f-]{36}$/);
    }

    expect(serverSocket.sent).toEqual([
      {
        type: 'auth.challenge',
        protocol: PROTOCOL,
        protocol_version: 1,
        min_supported_version: 1,
        challenge_id: saved.challengeId,
        nonce: saved.nonce,
        issued_at: new Date(saved.connectedAt).toISOString(),
        expires_at: new Date(saved.challengeExpiresAt).toISOString(),
      },
    ]);
    expect(storage._values.get(STATUS_KEY)).toMatchObject({
      tenantId: TENANT,
      connectorId: CONNECTOR,
      relayProtocol: PROTOCOL,
      lastConnectedAt: new Date(saved.connectedAt).toISOString(),
    });
    expect(events(storage)[0]).toMatchObject({
      type: 'directory_relay.connection.challenge_issued',
      tenantId: TENANT,
      connectorId: CONNECTOR,
    });
  });

  it.each([
    [1, 5_000],
    [10 * 60_000, 5 * 60_000],
    [12_345.5, 30_000],
  ])('clamps challenge_ttl_ms %s to %s', async (ttl, expected) => {
    const { relay } = createRelay({ connector: { relay: { challenge_ttl_ms: ttl } } });
    await relay.fetch(upgrade());
    const saved = serverSocket.raw.serializeAttachment.mock.calls[0][0] as Record<string, number>;
    expect(saved.challengeExpiresAt - saved.connectedAt).toBe(expected);
  });

  it.each([
    ['/api/auth/directory-relay/connect/tenant-a', 'missing connector segment'],
    [`/api/auth/directory-relay/connect/${'t'.repeat(129)}/${CONNECTOR}`, 'long tenant'],
    ['/api/auth/directory-relay/connect/tenant-a/bad.connector', 'bad connector'],
    [`/api/auth/directory-relay/connect/tenant-a/${CONNECTOR}/extra`, 'extra segment'],
  ])('returns 404 for an invalid route (%s: %s)', async (path) => {
    const { relay, ctx } = createRelay();
    const response = await relay.fetch(upgrade(`https://relay.example${path}`));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Invalid relay route');
    expect(ctx.acceptWebSocket).not.toHaveBeenCalled();
  });

  it('decodes route segments and accepts a 128-character tenant', async () => {
    const tenant = 't'.repeat(128);
    const { relay, env } = createRelay();
    const response = await relay.fetch(
      upgrade(`https://relay.example/api/auth/directory-relay/connect/${tenant}/${CONNECTOR}`)
    );
    // settings exist only for tenant-a, so the decoded tenant reaches the settings lookup
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Relay connector is not configured');
    expect(env.SETTINGS.get).toHaveBeenCalledWith(`settings:tenant:${tenant}:directory-connectors`);

    const encoded = createRelay();
    await encoded.relay.fetch(
      upgrade(`https://relay.example/api/auth/directory-relay/connect/tenant%3Ab/${CONNECTOR}`)
    );
    expect(encoded.env.SETTINGS.get).toHaveBeenCalledWith(
      'settings:tenant:tenant:b:directory-connectors'
    );
  });

  it.each([
    ['direct transport', { transport: 'direct' }],
    ['non-hmac auth mode', { auth_mode: 'mtls' }],
  ])('returns 404 when the connector is not a relay hmac connector (%s)', async (_l, connector) => {
    const { relay, ctx } = createRelay({ connector });
    const response = await relay.fetch(upgrade());
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Relay connector is not configured');
    expect(ctx.acceptWebSocket).not.toHaveBeenCalled();
  });

  it('returns 429 with retry_after_seconds while authentication is blocked', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_700_000_000_000);
    const { relay, storage, ctx } = createRelay();
    await storage.put(AUTH_FAILURE_KEY, {
      windowStartedAt: Date.now(),
      count: 10,
      blockedUntil: Date.now() + 90_500,
    });
    let response: Response;
    try {
      response = await relay.fetch(upgrade());
    } finally {
      vi.useRealTimers();
    }
    expect(response.status).toBe(429);
    const body = await response.json<Record<string, unknown>>();
    expect(body.error).toBe('relay_auth_rate_limited');
    expect(body.retry_after_seconds).toBe(91);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(ctx.acceptWebSocket).not.toHaveBeenCalled();
  });

  it('deletes an expired block and accepts the connection', async () => {
    const { relay, storage } = createRelay();
    await storage.put(AUTH_FAILURE_KEY, {
      windowStartedAt: 0,
      count: 10,
      blockedUntil: Date.now() - 1,
    });
    const response = await relay.fetch(upgrade());
    expect(response.status).toBe(101);
    expect(storage._values.has(AUTH_FAILURE_KEY)).toBe(false);
  });

  it('closes an unauthenticated socket after the challenge expires and records an auth_timeout', async () => {
    vi.useFakeTimers();
    const { relay, storage } = createRelay({ connector: { relay: { challenge_ttl_ms: 5_000 } } });
    await relay.fetch(upgrade());
    const saved = serverSocket.raw.serializeAttachment.mock.calls[0][0] as Record<string, unknown>;
    serverSocket.raw.deserializeAttachment.mockReturnValue(saved);

    await vi.advanceTimersByTimeAsync(5_500);
    expect(serverSocket.raw.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(serverSocket.raw.close).toHaveBeenCalledWith(1008, 'relay authentication timeout');
    expect(storage._values.get(AUTH_FAILURE_KEY)).toMatchObject({ count: 1 });
    expect(events(storage).map((e) => e.code)).toEqual(expect.arrayContaining(['auth_timeout']));
    expect(storage._values.get(STATUS_KEY)).toMatchObject({ lastDisconnectReason: 'auth_timeout' });
  });

  it('leaves an authenticated socket open when the challenge timer fires', async () => {
    vi.useFakeTimers();
    const { relay, storage } = createRelay({ connector: { relay: { challenge_ttl_ms: 5_000 } } });
    await relay.fetch(upgrade());
    const saved = serverSocket.raw.serializeAttachment.mock.calls[0][0] as { connectionId: string };
    serverSocket.raw.deserializeAttachment.mockReturnValue(saved);
    await authenticate(storage, saved.connectionId);

    await vi.advanceTimersByTimeAsync(7_000);
    expect(serverSocket.raw.close).not.toHaveBeenCalled();
    expect(storage._values.has(AUTH_FAILURE_KEY)).toBe(false);
  });

  it('closes with 1011 when the authentication check fails', async () => {
    vi.useFakeTimers();
    const { relay, storage } = createRelay({ connector: { relay: { challenge_ttl_ms: 5_000 } } });
    await relay.fetch(upgrade());
    const saved = serverSocket.raw.serializeAttachment.mock.calls[0][0] as Record<string, unknown>;
    serverSocket.raw.deserializeAttachment.mockReturnValue(saved);
    storage.get.mockImplementationOnce(async () => {
      throw new Error('storage down');
    });
    await vi.advanceTimersByTimeAsync(7_000);
    expect(serverSocket.raw.close).toHaveBeenCalledWith(1011, 'relay authentication check failed');
    expect(storage._values.get(STATUS_KEY)).toMatchObject({
      lastDisconnectReason: 'auth_check_failed',
    });
  });
});

describe('DirectoryConnectorRelay fetch routing', () => {
  it.each([
    ['GET', '/verify-password'],
    ['POST', '/status'],
    ['POST', '/events'],
  ])('returns not_found for %s %s', async (method, path) => {
    const { relay } = createRelay();
    const response = await relay.fetch(
      new Request(`https://directory-relay.internal${path}`, {
        method,
        body: method === 'POST' ? '{}' : undefined,
      })
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });

  it('records close and error disconnect reasons with the authenticated key id', async () => {
    const { relay, storage } = createRelay();
    await authenticate(storage);
    const socket = relayWebSocket({
      connectionId: 'connection-1',
      tenantId: TENANT,
      connectorId: CONNECTOR,
    });
    await relay.webSocketError(socket.ws);
    expect(storage._values.get(STATUS_KEY)).toMatchObject({ lastDisconnectReason: 'error' });
    expect(events(storage)[0]).toMatchObject({
      type: 'directory_relay.connection.closed',
      code: 'error',
      keyId: 'kid-active',
    });
    await relay.webSocketClose(socket.ws);
    expect(storage._values.get(STATUS_KEY)).toMatchObject({ lastDisconnectReason: 'closed' });
    expect(events(storage)[0].keyId).toBeUndefined();
  });

  it('ignores close events for sockets without connection state', async () => {
    const { relay, storage } = createRelay();
    await relay.webSocketClose(relayWebSocket(null).ws);
    expect(storage.put).not.toHaveBeenCalled();
  });
});
