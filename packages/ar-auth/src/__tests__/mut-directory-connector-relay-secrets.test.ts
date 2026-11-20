import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  recordDirectoryConnectorHeartbeat: vi.fn(async () => ({ accepted: true })),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveTenantDatabaseSourceFromRegistry: vi.fn(async () => ({ source: {} })),
    ensureDatabaseAdapter: vi.fn(() => ({})),
    recordDirectoryConnectorHeartbeat: mocks.recordDirectoryConnectorHeartbeat,
  };
});

import {
  CONNECTOR,
  PROTOCOL,
  SETTINGS_KEY,
  STATUS_KEY,
  TENANT,
  addPending,
  attachment,
  authResponse,
  authenticate,
  baseConnector,
  createRelay,
  relayWebSocket,
} from './helpers/mut-directory-relay-fixtures';

const MANAGED_KEY = `settings:tenant:${TENANT}:directory-connector-secret:campus`;

function managedRelay(record: unknown, connector: Record<string, unknown> = {}) {
  return createRelay({
    connector: { secret_ref: 'managed:campus', ...connector },
    settings: {
      [MANAGED_KEY]:
        record === null ? null : typeof record === 'string' ? record : JSON.stringify(record),
    },
  });
}

async function authWith(
  relay: ReturnType<typeof createRelay>['relay'],
  keyId: string,
  secret: string
) {
  const socket = relayWebSocket(attachment());
  await relay.webSocketMessage(
    socket.ws,
    JSON.stringify(await authResponse({ key_id: keyId }, secret))
  );
  return socket.sent.at(-1)?.type === 'auth.ok' ? 'ok' : socket.sent.at(-1)?.code;
}

const active = { keyId: 'kid-new', secret: 'new-secret', createdAt: '2026-01-01T00:00:00Z' };

beforeEach(() => vi.clearAllMocks());

describe('managed relay secrets', () => {
  it('accepts the active managed key', async () => {
    const { relay } = managedRelay({ active });
    expect(await authWith(relay, 'kid-new', 'new-secret')).toBe('ok');
  });

  it('accepts a managed secret ref naming the connector id', async () => {
    const { relay } = managedRelay({ active }, { secret_ref: `managed:${CONNECTOR}` });
    expect(await authWith(relay, 'kid-new', 'new-secret')).toBe('ok');
  });

  it('rejects a managed secret ref naming another connector', async () => {
    const { relay } = managedRelay({ active }, { secret_ref: 'managed:other' });
    expect(await authWith(relay, 'kid-new', 'new-secret')).toBe('relay_auth_failed');
  });

  it('accepts the previous key only until it retires', async () => {
    const previous = (retireAfter: string) => ({
      active,
      previous: {
        keyId: 'kid-old',
        secret: 'old-secret',
        createdAt: '2025-01-01T00:00:00Z',
        retireAfter,
      },
    });
    const future = managedRelay(previous(new Date(Date.now() + 60_000).toISOString()));
    expect(await authWith(future.relay, 'kid-old', 'old-secret')).toBe('ok');

    const past = managedRelay(previous(new Date(Date.now() - 1_000).toISOString()));
    expect(await authWith(past.relay, 'kid-old', 'old-secret')).toBe('relay_auth_failed');

    const invalid = managedRelay(previous('not-a-date'));
    expect(await authWith(invalid.relay, 'kid-old', 'old-secret')).toBe('relay_auth_failed');
  });

  it('does not fall back to key_id or env secrets for managed refs', async () => {
    const { relay } = managedRelay({ active });
    expect(await authWith(relay, 'kid-active', 'active-secret')).toBe('relay_auth_failed');
  });

  it.each([
    ['missing record', null],
    ['invalid JSON', '{'],
    ['missing active key id', { active: { secret: 's' } }],
    ['missing active secret', { active: { keyId: 'kid-new' } }],
  ])('fails closed for a %s', async (_l, record) => {
    const { relay } = managedRelay(record);
    expect(await authWith(relay, 'kid-new', 'new-secret')).toBe('relay_auth_failed');
  });

  it('fails closed when reading the managed record throws', async () => {
    const { relay, env } = managedRelay({ active });
    env.SETTINGS.get.mockImplementation(async (key: string) => {
      if (key === MANAGED_KEY) throw new Error('kv');
      return JSON.stringify({ connectors: [baseConnector({ secret_ref: 'managed:campus' })] });
    });
    expect(await authWith(relay, 'kid-new', 'new-secret')).toBe('relay_auth_failed');
  });
});

describe('connector settings parsing', () => {
  it.each([
    ['invalid JSON', '{'],
    ['array root', '[]'],
    ['non-array connectors', JSON.stringify({ connectors: {} })],
    ['null root', 'null'],
  ])('treats %s as unconfigured', async (_l, raw) => {
    const { relay } = createRelay({ settings: { [SETTINGS_KEY]: raw } });
    expect(await authWith(relay, 'kid-active', 'active-secret')).toBe('relay_auth_failed');
  });

  it('treats a settings read failure as unconfigured', async () => {
    const { relay, env } = createRelay();
    env.SETTINGS.get.mockRejectedValue(new Error('kv'));
    expect(await authWith(relay, 'kid-active', 'active-secret')).toBe('relay_auth_failed');
  });

  it('skips malformed connectors and falls back to id as connector_id', async () => {
    const connectors = [
      null,
      [],
      { id: CONNECTOR, key_id: 'k', secret_ref: '' },
      {
        id: CONNECTOR,
        transport: 'relay',
        key_id: 'kid-active',
        secret_ref: 'env:WORDWARDEN_SECRET',
      },
    ];
    const { relay } = createRelay({ settings: { [SETTINGS_KEY]: JSON.stringify({ connectors }) } });
    expect(await authWith(relay, 'kid-active', 'active-secret')).toBe('ok');
  });

  it('treats an unknown transport as direct', async () => {
    const { relay } = createRelay({ connector: { transport: 'tunnel' } });
    expect(await authWith(relay, 'kid-active', 'active-secret')).toBe('relay_auth_failed');
  });
});

describe('relay status reporting', () => {
  async function status(
    relay: ReturnType<typeof createRelay>['relay'],
    query = `?tenant_id=${TENANT}&connector_id=${CONNECTOR}`
  ) {
    const response = await relay.fetch(
      new Request(`https://directory-relay.internal/status${query}`)
    );
    return await response.json<Record<string, unknown>>();
  }

  it('reports clamped runtime settings and stored status fields', async () => {
    const { relay, storage } = createRelay({
      connector: {
        relay: { max_pending_requests: 1000, verify_timeout_ms: 1, challenge_ttl_ms: 60_000 },
      },
    });
    await storage.put(STATUS_KEY, {
      lastConnectedAt: 'c',
      lastAuthenticatedAt: 'a',
      authenticatedKeyId: 'kid-active',
      lastVerifyStartedAt: 'vs',
      lastVerifySucceededAt: 'vok',
      lastVerifyFailedAt: 'vf',
      lastDisconnectAt: 'd',
      lastDisconnectReason: 'closed',
    });
    expect(await status(relay)).toEqual({
      ok: true,
      connections: 0,
      authenticated_connections: 0,
      pending_requests: 0,
      max_pending_requests: 256,
      verify_timeout_ms: 100,
      challenge_ttl_ms: 60_000,
      relay_protocol: PROTOCOL,
      protocol_version: 1,
      min_supported_version: 1,
      last_connected_at: 'c',
      last_authenticated_at: 'a',
      authenticated_key_id: 'kid-active',
      last_verify_started_at: 'vs',
      last_verify_succeeded_at: 'vok',
      last_verify_failed_at: 'vf',
      last_disconnect_at: 'd',
      last_disconnect_reason: 'closed',
    });
  });

  it('counts authenticated sockets and connector-scoped pending requests', async () => {
    const { relay, storage, ctx } = createRelay();
    await authenticate(storage, 'conn-a');
    const authed = relayWebSocket(attachment({ connectionId: 'conn-a' }));
    const unauthed = relayWebSocket(attachment({ connectionId: 'conn-b' }));
    ctx.getWebSockets.mockReturnValue([authed.ws, unauthed.ws]);
    const p1 = addPending(relay, 'p1');
    const p2 = addPending(relay, 'p2', { connectorId: 'other' });
    const scoped = await status(relay);
    expect(scoped).toMatchObject({
      connections: 2,
      authenticated_connections: 1,
      pending_requests: 1,
    });
    const unscoped = await status(relay, '');
    expect(unscoped).toMatchObject({
      pending_requests: 2,
      max_pending_requests: 16,
      verify_timeout_ms: 5000,
    });
    clearTimeout(p1.timeout);
    clearTimeout(p2.timeout);
  });

  it('expires an authenticated connection whose key no longer resolves', async () => {
    const { relay, storage, ctx } = createRelay({ connector: { key_id: 'kid-rotated' } });
    await authenticate(storage, 'conn-a', 'kid-active');
    const socket = relayWebSocket(attachment({ connectionId: 'conn-a' }));
    ctx.getWebSockets.mockReturnValue([socket.ws]);
    expect(await status(relay)).toMatchObject({ authenticated_connections: 0 });
    expect(socket.raw.close).toHaveBeenCalledWith(1008, 'authenticated key expired');
    expect(storage._values.has('connection:conn-a')).toBe(false);
    expect(storage._values.get(STATUS_KEY)).toMatchObject({
      lastDisconnectReason: 'authenticated_key_expired',
    });
  });

  it('does not count a connection record for a different tenant or connector', async () => {
    const { relay, storage, ctx } = createRelay();
    storage._values.set('connection:conn-a', {
      authenticated: true,
      tenantId: TENANT,
      connectorId: 'wwcon_OTHER',
      keyId: 'kid-active',
    });
    storage._values.set('connection:conn-b', {
      authenticated: true,
      tenantId: 'tenant-b',
      connectorId: CONNECTOR,
      keyId: 'kid-active',
    });
    ctx.getWebSockets.mockReturnValue([
      relayWebSocket(attachment({ connectionId: 'conn-a' })).ws,
      relayWebSocket(attachment({ connectionId: 'conn-b' })).ws,
    ]);
    expect(await status(relay)).toMatchObject({ authenticated_connections: 0 });
  });

  it('returns stored events for the connector', async () => {
    const { relay, storage } = createRelay();
    await authWith(relay, 'kid-active', 'bad');
    const response = await relay.fetch(
      new Request(
        `https://directory-relay.internal/events?tenant_id=${TENANT}&connector_id=${CONNECTOR}`
      )
    );
    const body = await response.json<{ events: Array<Record<string, unknown>> }>();
    expect(body.events[0]).toMatchObject({ code: 'relay_auth_failed', tenantId: TENANT });
    expect(storage.get).toHaveBeenCalled();
    const missing = await relay.fetch(
      new Request(`https://directory-relay.internal/events?tenant_id=${TENANT}&connector_id=%20`)
    );
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      error: { code: 'invalid_relay_request', retryable: false },
    });
  });
});
