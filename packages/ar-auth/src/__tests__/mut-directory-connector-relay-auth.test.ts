import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  attachment,
  authResponse,
  authenticate,
  createRelay,
  events,
  relayWebSocket,
} from './helpers/mut-directory-relay-fixtures';

const NONCE_KEY = `used-nonce:${TENANT}:${CONNECTOR}:nonce-1`;

async function send(
  relay: ReturnType<typeof createRelay>['relay'],
  message: unknown,
  att = attachment()
) {
  const socket = relayWebSocket(att);
  await relay.webSocketMessage(socket.ws, JSON.stringify(message));
  return socket;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.recordDirectoryConnectorHeartbeat.mockResolvedValue({ accepted: true });
});

describe('relay authentication success', () => {
  it('marks the nonce, clears failures, stores the connection and status, and sends auth.ok', async () => {
    const { relay, storage } = createRelay({ connector: { relay: { challenge_ttl_ms: 10_000 } } });
    await storage.put(AUTH_FAILURE_KEY, { windowStartedAt: Date.now(), count: 3 });
    const before = Date.now();
    const socket = await send(relay, await authResponse());

    expect(socket.sent).toEqual([
      {
        type: 'auth.ok',
        protocol: PROTOCOL,
        protocol_version: 1,
        min_supported_version: 1,
        tenant_id: TENANT,
        connector_id: CONNECTOR,
      },
    ]);
    const nonce = storage._values.get(NONCE_KEY) as { expiresAt: number };
    expect(nonce.expiresAt).toBeGreaterThanOrEqual(before + 20_000);
    expect(nonce.expiresAt).toBeLessThanOrEqual(Date.now() + 20_000);
    expect(storage._values.has(AUTH_FAILURE_KEY)).toBe(false);
    expect(storage._values.get('connection:connection-1')).toEqual({
      authenticated: true,
      tenantId: TENANT,
      connectorId: CONNECTOR,
      keyId: 'kid-active',
      authenticatedAt: expect.any(Number) as unknown,
    });
    expect(storage._values.get(STATUS_KEY)).toMatchObject({
      authenticatedKeyId: 'kid-active',
      lastAuthenticatedAt: expect.any(String) as unknown,
    });
    expect(events(storage)[0]).toMatchObject({
      type: 'directory_relay.connection.authenticated',
      keyId: 'kid-active',
    });
  });

  it('closes older authenticated sockets for the same connector only', async () => {
    const { relay, storage, ctx } = createRelay();
    await authenticate(storage, 'old-conn');
    await authenticate(storage, 'unauth-conn');
    storage._values.set('connection:unauth-conn', { authenticated: false });
    const old = relayWebSocket(attachment({ connectionId: 'old-conn' }));
    const unauth = relayWebSocket(attachment({ connectionId: 'unauth-conn' }));
    const other = relayWebSocket(attachment({ connectionId: 'x', connectorId: 'wwcon_OTHER' }));
    const current = relayWebSocket(attachment());
    ctx.getWebSockets.mockReturnValue([old.ws, unauth.ws, other.ws, current.ws]);

    await relay.webSocketMessage(current.ws, JSON.stringify(await authResponse()));

    expect(old.raw.close).toHaveBeenCalledWith(1000, 'replaced by newer relay connection');
    expect(storage._values.has('connection:old-conn')).toBe(false);
    expect(unauth.raw.close).not.toHaveBeenCalled();
    expect(other.raw.close).not.toHaveBeenCalled();
    expect(current.raw.close).not.toHaveBeenCalled();
    expect(current.sent.at(-1)).toMatchObject({ type: 'auth.ok' });
  });

  it('registers the relay instance with sanitized metadata', async () => {
    const { relay } = createRelay();
    await send(
      relay,
      await authResponse({
        instance_id: '  wwi_1234567890123456789012  ',
        display_name: ` ${'n'.repeat(200)} `,
        version: '  ',
        release_channel: 'bad channel!',
        started_at: 'not-a-date',
        config_fingerprint: 'sha256:xyz',
        config_categories: [' ldap ', 5, 'bad category', 'c'.repeat(65), 'ok:1'],
        drift_severity: 'catastrophic',
      })
    );
    const [, input] = mocks.recordDirectoryConnectorHeartbeat.mock.calls[0] as unknown as [
      unknown,
      Record<string, unknown>,
    ];
    expect(input).toMatchObject({
      tenantId: TENANT,
      connectorId: CONNECTOR,
      instanceId: 'wwi_1234567890123456789012',
      displayName: 'n'.repeat(128),
      transport: 'relay',
      version: 'unknown',
      releaseChannel: 'stable',
      healthStatus: 'healthy',
      healthSummary: { relay: 'authenticated' },
      configFingerprint: `sha256:${'0'.repeat(64)}`,
      configCategories: ['ldap', 'ok:1'],
      driftSeverity: 'none',
    });
    expect(Number.isFinite(Date.parse(input.startedAt as string))).toBe(true);
    expect(mocks.resolveTenantDatabaseSourceFromRegistry).toHaveBeenCalledWith(expect.anything(), {
      tenantId: TENANT,
      role: 'tenant_core',
      dataRole: 'tenant_core/default',
      shardGroup: 'default',
      shardIndex: 0,
    });
  });

  it('passes through valid relay metadata', async () => {
    const { relay } = createRelay();
    const fingerprint = `sha256:${'b'.repeat(64)}`;
    const categories = Array.from({ length: 40 }, (_, i) => `cat${i}`);
    await send(
      relay,
      await authResponse({
        display_name: 'Campus',
        version: '1.2.3',
        release_channel: 'beta.1',
        started_at: '2026-06-24T00:00:00.000Z',
        config_fingerprint: fingerprint,
        config_categories: categories,
        drift_severity: 'critical',
      })
    );
    const input = (
      mocks.recordDirectoryConnectorHeartbeat.mock.calls[0] as unknown as [
        unknown,
        Record<string, unknown>,
      ]
    )[1];
    expect(input).toMatchObject({
      displayName: 'Campus',
      version: '1.2.3',
      releaseChannel: 'beta.1',
      startedAt: '2026-06-24T00:00:00.000Z',
      configFingerprint: fingerprint,
      configCategories: categories.slice(0, 32),
      driftSeverity: 'critical',
    });
    mocks.recordDirectoryConnectorHeartbeat.mockClear();
    await send(
      relay,
      await authResponse({ nonce: 'nonce-2', drift_severity: 'warning', config_categories: 'x' }),
      attachment({ nonce: 'nonce-2' })
    );
    const second = (
      mocks.recordDirectoryConnectorHeartbeat.mock.calls[0] as unknown as [
        unknown,
        Record<string, unknown>,
      ]
    )[1];
    expect(second).toMatchObject({
      driftSeverity: 'warning',
      configCategories: ['relay'],
      displayName: undefined,
    });
  });

  it('rejects an instance refused by fleet registration without counting an auth failure', async () => {
    mocks.recordDirectoryConnectorHeartbeat.mockResolvedValue({ accepted: false });
    const { relay, storage } = createRelay();
    const socket = await send(relay, await authResponse());
    expect(socket.sent).toEqual([
      expect.objectContaining({ type: 'error', code: 'relay_auth_failed' }),
    ]);
    expect(socket.raw.close).toHaveBeenCalledWith(1008, 'relay authentication failed');
    expect(events(storage)[0]).toMatchObject({
      code: 'relay_instance_rejected',
      keyId: 'kid-active',
    });
    expect(storage._values.has(AUTH_FAILURE_KEY)).toBe(false);
    expect(storage._values.has(NONCE_KEY)).toBe(false);
    expect(storage._values.has('connection:connection-1')).toBe(false);
  });

  it('rejects an invalid instance id before touching the database', async () => {
    const { relay } = createRelay();
    const socket = await send(relay, await authResponse({ instance_id: 'wwi_short' }));
    expect(socket.sent[0]).toMatchObject({ code: 'relay_auth_failed' });
    expect(mocks.resolveTenantDatabaseSourceFromRegistry).not.toHaveBeenCalled();
  });
});

describe('relay authentication failures', () => {
  it('records the rejection event and failure for a context mismatch', async () => {
    const { relay, storage } = createRelay();
    const socket = await send(relay, await authResponse({ nonce: 'other' }));
    expect(socket.sent[0]).toEqual({
      type: 'error',
      protocol: PROTOCOL,
      protocol_version: 1,
      min_supported_version: 1,
      code: 'auth_context_mismatch',
      message: 'Authentication context mismatch',
    });
    expect(events(storage)[0]).toMatchObject({
      type: 'directory_relay.connection.rejected',
      code: 'auth_context_mismatch',
    });
  });

  it.each([
    ['stale_auth_challenge', attachment({ challengeExpiresAt: Date.now() - 1 }), {}],
    ['replayed_auth_challenge', attachment(), {}],
  ])('records %s as a rejection event and auth failure', async (code, att, over) => {
    const { relay, storage } = createRelay();
    if (code === 'replayed_auth_challenge') {
      await storage.put(NONCE_KEY, { expiresAt: Date.now() + 10_000 });
    }
    const socket = await send(relay, await authResponse(over), att);
    expect(socket.sent[0]).toMatchObject({ code });
    expect(events(storage)[0]).toMatchObject({ type: 'directory_relay.connection.rejected', code });
    expect(storage._values.get(AUTH_FAILURE_KEY)).toMatchObject({ count: 1 });
  });

  it.each([
    ['unknown key', {}, { key_id: 'kid-unknown' }],
    ['direct transport', { transport: 'direct' }, {}],
    ['disallowed env name', { secret_ref: 'env:OTHER_SECRET' }, {}],
    ['lowercase env name', { secret_ref: 'env:wordwarden_secret' }, {}],
  ])('fails closed with relay_auth_failed for %s', async (_l, connector, over) => {
    const { relay, storage } = createRelay({
      connector,
      env: { OTHER_SECRET: 'active-secret', wordwarden_secret: 'active-secret' },
    });
    const socket = await send(relay, await authResponse(over));
    expect(socket.sent[0]).toMatchObject({ code: 'relay_auth_failed' });
    expect(socket.raw.close).toHaveBeenCalledWith(1008, 'relay authentication failed');
    expect(events(storage)[0]).toMatchObject({
      code: 'relay_auth_failed',
      keyId: (over as { key_id?: string }).key_id ?? 'kid-active',
    });
    expect(storage._values.get(AUTH_FAILURE_KEY)).toMatchObject({ count: 1 });
  });

  it('accepts a bare env-name secret_ref with an allowed prefix', async () => {
    const { relay } = createRelay({
      connector: { secret_ref: 'AUTHRIM_WORDWARDEN_KEY' },
      env: { AUTHRIM_WORDWARDEN_KEY: 'active-secret' },
    });
    const socket = await send(relay, await authResponse());
    expect(socket.sent.at(-1)).toMatchObject({ type: 'auth.ok' });
  });

  it('fails when the configured env secret is empty', async () => {
    const { relay } = createRelay({ env: { WORDWARDEN_SECRET: '' } });
    const socket = await send(relay, await authResponse());
    expect(socket.sent[0]).toMatchObject({ code: 'relay_auth_failed' });
  });

  it('records a signature mismatch as an auth failure with the key id', async () => {
    const { relay, storage } = createRelay();
    const socket = await send(relay, await authResponse({}, 'wrong-secret'));
    expect(socket.sent[0]).toMatchObject({ code: 'relay_auth_failed' });
    expect(events(storage)[0]).toMatchObject({ code: 'relay_auth_failed', keyId: 'kid-active' });
    expect(storage._values.get(AUTH_FAILURE_KEY)).toMatchObject({ count: 1 });
    expect(mocks.recordDirectoryConnectorHeartbeat).not.toHaveBeenCalled();
  });
});

describe('relay authentication failure rate limiting', () => {
  it('counts failures within the window and blocks at the configured threshold', async () => {
    const { relay, storage } = createRelay({
      connector: {
        relay: { auth_failure_rate_limit_per_minute: 3, auth_failure_block_ms: 120_000 },
      },
    });
    for (let i = 0; i < 2; i += 1) await send(relay, await authResponse({}, 'bad'));
    const second = storage._values.get(AUTH_FAILURE_KEY) as Record<string, number | undefined>;
    expect(second.count).toBe(2);
    expect(second.blockedUntil).toBeUndefined();
    const before = Date.now();
    await send(relay, await authResponse({}, 'bad'));
    const third = storage._values.get(AUTH_FAILURE_KEY) as Record<string, number>;
    expect(third.count).toBe(3);
    expect(third.windowStartedAt).toBe(second.windowStartedAt);
    expect(third.blockedUntil).toBeGreaterThanOrEqual(before + 120_000);
    expect(third.blockedUntil).toBeLessThanOrEqual(Date.now() + 120_000);
  });

  it('starts a new window after 60 seconds', async () => {
    const { relay, storage } = createRelay();
    const old = Date.now() - 60_001;
    await storage.put(AUTH_FAILURE_KEY, { windowStartedAt: old, count: 9 });
    await send(relay, await authResponse({}, 'bad'));
    const record = storage._values.get(AUTH_FAILURE_KEY) as Record<string, number | undefined>;
    expect(record.count).toBe(1);
    expect(record.windowStartedAt).toBeGreaterThan(old);
    expect(record.blockedUntil).toBeUndefined();
  });

  it('uses the default threshold of 10 failures and a five minute block', async () => {
    const { relay, storage } = createRelay();
    const start = Date.now();
    await storage.put(AUTH_FAILURE_KEY, { windowStartedAt: start, count: 8 });
    await send(relay, await authResponse({}, 'bad'));
    expect(
      (storage._values.get(AUTH_FAILURE_KEY) as Record<string, unknown>).blockedUntil
    ).toBeUndefined();
    await send(relay, await authResponse({}, 'bad'));
    const record = storage._values.get(AUTH_FAILURE_KEY) as Record<string, number>;
    expect(record.count).toBe(10);
    expect(record.blockedUntil - Date.now()).toBeGreaterThan(5 * 60_000 - 1_000);
    expect(record.blockedUntil - Date.now()).toBeLessThanOrEqual(5 * 60_000);
  });

  it('clamps an out-of-range threshold to 100', async () => {
    const { relay, storage } = createRelay({
      connector: { relay: { auth_failure_rate_limit_per_minute: 500 } },
    });
    await storage.put(AUTH_FAILURE_KEY, { windowStartedAt: Date.now(), count: 98 });
    await send(relay, await authResponse({}, 'bad'));
    expect(
      (storage._values.get(AUTH_FAILURE_KEY) as Record<string, unknown>).blockedUntil
    ).toBeUndefined();
    await send(relay, await authResponse({}, 'bad'));
    expect(
      (storage._values.get(AUTH_FAILURE_KEY) as Record<string, number>).blockedUntil
    ).toBeGreaterThan(Date.now());
  });
});
