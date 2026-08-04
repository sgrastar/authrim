import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DatabaseAdapter,
  ExecuteResult,
  HealthStatus,
  TransactionContext,
} from '@authrim/ar-lib-core';

const resolveTenantDatabaseSourceFromRegistry = vi.hoisted(() => vi.fn());

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveTenantDatabaseSourceFromRegistry,
  };
});

import { DirectoryConnectorRelay } from '../directory-connector-relay';
import {
  buildDirectoryRelayAuthCanonical,
  signDirectoryRelayCanonical,
} from '../directory-relay-protocol';

function createStorage() {
  const values = new Map<string, unknown>();
  return {
    get: vi.fn(async <T>(key: string): Promise<T | undefined> => values.get(key) as T | undefined),
    put: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key: string) => values.delete(key)),
    _values: values,
  };
}

function createRelay(options: { connector?: Record<string, unknown> } = {}) {
  const storage = createStorage();
  const db = createAdapter();
  const connector = {
    id: 'campus',
    transport: 'relay',
    auth_mode: 'hmac',
    connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
    key_id: 'kid-active',
    secret_ref: 'env:WORDWARDEN_SECRET',
    attribute_names: ['mail'],
    ...options.connector,
  };
  const env = {
    SETTINGS: {
      get: vi.fn(async (key: string) => {
        if (key !== 'settings:tenant:tenant-a:directory-connectors') return null;
        return JSON.stringify({ connectors: [connector] });
      }),
    },
    DB: db,
    WORDWARDEN_SECRET: 'active-secret',
  };
  const ctx = {
    storage,
    getWebSockets: vi.fn((): WebSocket[] => []),
    acceptWebSocket: vi.fn(),
  };

  return {
    relay: new DirectoryConnectorRelay(ctx as unknown as DurableObjectState, env as never),
    ctx,
    db,
    storage,
    env,
  };
}

function executeResult(rowsAffected = 1): ExecuteResult {
  return { rowsAffected, success: true };
}

function createAdapter(): DatabaseAdapter {
  return {
    query: vi.fn(async () => []),
    queryOne: vi.fn(async () => null),
    execute: vi.fn(async () => executeResult()),
    async transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
      return fn({
        query: vi.fn(async () => []),
        queryOne: vi.fn(async () => null),
        execute: vi.fn(async () => executeResult()),
      });
    },
    batch: vi.fn(async () => []),
    isHealthy: vi.fn(
      async (): Promise<HealthStatus> => ({
        healthy: true,
        latencyMs: 1,
        type: 'mock',
      })
    ),
    getType: vi.fn(() => 'mock'),
    close: vi.fn(async () => undefined),
  };
}

function relayWebSocket(attachment: Record<string, unknown> | null) {
  const sent: Array<Record<string, unknown>> = [];
  const ws = {
    deserializeAttachment: vi.fn(() => attachment),
    send: vi.fn((value: string) => sent.push(JSON.parse(value) as Record<string, unknown>)),
    close: vi.fn(),
  };
  return { ws: ws as unknown as WebSocket, sent, raw: ws };
}

const relayAttachment = {
  connectionId: 'connection-1',
  tenantId: 'tenant-a',
  connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
  challengeId: 'challenge-1',
  nonce: 'nonce-1',
  challengeExpiresAt: Date.now() + 30_000,
  connectedAt: Date.now(),
};

async function authResponse(overrides: Record<string, unknown> = {}) {
  const timestamp = new Date().toISOString();
  const base = {
    type: 'auth.response',
    protocol: 'authrim.wordwarden.relay.v1',
    protocol_version: 1,
    min_supported_version: 1,
    tenant_id: 'tenant-a',
    connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
    key_id: 'kid-active',
    challenge_id: 'challenge-1',
    nonce: 'nonce-1',
    timestamp,
    instance_id: 'wwi_1234567890123456789012',
    display_name: 'Campus Relay',
    version: '1.0.0',
    started_at: '2026-06-24T00:00:00.000Z',
    ...overrides,
  };
  const canonical = buildDirectoryRelayAuthCanonical({
    tenantId: String(base.tenant_id),
    connectorId: String(base.connector_id),
    keyId: String(base.key_id),
    protocolVersion: Number(base.protocol_version),
    minSupportedVersion: Number(base.min_supported_version),
    challengeId: String(base.challenge_id),
    nonce: String(base.nonce),
    timestamp: String(base.timestamp),
  });
  return {
    ...base,
    signature: await signDirectoryRelayCanonical(canonical, 'active-secret'),
    ...overrides,
  };
}

describe('DirectoryConnectorRelay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveTenantDatabaseSourceFromRegistry.mockImplementation(async (env) => ({
      source: env.DB,
    }));
  });

  it('reports relay runtime defaults in status responses', async () => {
    const { relay } = createRelay();

    const response = await relay.fetch(
      new Request(
        'https://directory-relay.internal/status?tenant_id=tenant-a&connector_id=wwcon_8K4M2Q9F7D3H6P1X'
      )
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      connections: 0,
      authenticated_connections: 0,
      pending_requests: 0,
      max_pending_requests: 16,
      verify_timeout_ms: 5000,
      challenge_ttl_ms: 30000,
      relay_protocol: 'authrim.wordwarden.relay.v1',
      protocol_version: 1,
      min_supported_version: 1,
    });
  });

  it('returns 404 for methods and paths outside the relay contract', async () => {
    const { relay } = createRelay();
    const response = await relay.fetch(new Request('https://directory-relay.internal/unknown'));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });

  it('rejects malformed websocket messages without closing an otherwise usable socket', async () => {
    const { relay } = createRelay();
    const { ws, sent, raw } = relayWebSocket(relayAttachment);

    await relay.webSocketMessage(ws, '{');
    await relay.webSocketMessage(ws, new Uint8Array([123]).buffer as ArrayBuffer);

    expect(sent.map((message) => message.code)).toEqual(['invalid_json', 'invalid_json']);
    expect(raw.close).not.toHaveBeenCalled();
  });

  it('closes clients that advertise an incompatible relay protocol', async () => {
    const { relay } = createRelay();
    const { ws, sent, raw } = relayWebSocket(relayAttachment);

    await relay.webSocketMessage(
      ws,
      JSON.stringify({
        type: 'auth.response',
        protocol: 'authrim.wordwarden.relay.v1',
        protocol_version: 0,
        min_supported_version: 2,
      })
    );

    expect(sent[0]).toMatchObject({ code: 'incompatible_relay_protocol' });
    expect(raw.close).toHaveBeenCalledWith(1008, 'incompatible relay protocol');
  });

  it('rejects unknown message types without disclosing connection state', async () => {
    const { relay } = createRelay();
    const { ws, sent } = relayWebSocket(relayAttachment);
    await relay.webSocketMessage(
      ws,
      JSON.stringify({
        type: 'admin.command',
        protocol: 'authrim.wordwarden.relay.v1',
        protocol_version: 1,
        min_supported_version: 1,
      })
    );
    expect(sent[0]).toMatchObject({ code: 'unknown_message_type' });
  });

  it('fails authentication when serialized connection state is missing or malformed', async () => {
    const { relay } = createRelay();
    const missing = relayWebSocket(null);
    await relay.webSocketMessage(missing.ws, JSON.stringify(await authResponse()));
    expect(missing.sent[0]).toMatchObject({ code: 'missing_connection_state' });
    expect(missing.raw.close).toHaveBeenCalledWith(1011, 'missing connection state');

    const malformed = relayWebSocket(relayAttachment);
    malformed.raw.deserializeAttachment.mockImplementationOnce(() => {
      throw new Error('corrupt attachment');
    });
    await relay.webSocketMessage(malformed.ws, JSON.stringify(await authResponse()));
    expect(malformed.sent[0]).toMatchObject({ code: 'missing_connection_state' });
  });

  it.each([
    ['tenant_id', 'tenant-b'],
    ['connector_id', 'wwcon_OTHERCONNECTOR1234567890'],
    ['challenge_id', 'challenge-other'],
    ['nonce', 'nonce-other'],
  ])('rejects authentication context substitution through %s', async (field, value) => {
    const { relay, storage } = createRelay();
    const { ws, sent, raw } = relayWebSocket(relayAttachment);

    await relay.webSocketMessage(ws, JSON.stringify(await authResponse({ [field]: value })));

    expect(sent[0]).toMatchObject({ code: 'auth_context_mismatch' });
    expect(raw.close).toHaveBeenCalledWith(1008, 'auth context mismatch');
    expect(storage._values.get('auth-failure:tenant-a:wwcon_8K4M2Q9F7D3H6P1X')).toMatchObject({
      count: 1,
    });
  });

  it.each([
    ['expired challenge', { challengeExpiresAt: Date.now() - 1 }, {}],
    ['invalid timestamp', relayAttachment, { timestamp: 'not-a-date' }],
    [
      'timestamp outside the maximum window',
      relayAttachment,
      { timestamp: new Date(Date.now() - 10 * 60_000).toISOString() },
    ],
  ])('rejects stale authentication: %s', async (_label, attachment, overrides) => {
    const { relay } = createRelay();
    const { ws, sent, raw } = relayWebSocket({ ...relayAttachment, ...attachment });

    await relay.webSocketMessage(ws, JSON.stringify(await authResponse(overrides)));

    expect(sent[0]).toMatchObject({ code: 'stale_auth_challenge' });
    expect(raw.close).toHaveBeenCalledWith(1008, 'stale auth challenge');
  });

  it('rejects a replayed authentication nonce before verifying the signature', async () => {
    const { relay, storage } = createRelay();
    await storage.put('used-nonce:tenant-a:wwcon_8K4M2Q9F7D3H6P1X:nonce-1', {
      expiresAt: Date.now() + 30_000,
    });
    const { ws, sent } = relayWebSocket(relayAttachment);

    await relay.webSocketMessage(ws, JSON.stringify(await authResponse()));

    expect(sent[0]).toMatchObject({ code: 'replayed_auth_challenge' });
  });

  it('deletes an expired nonce record and permits a fresh authentication', async () => {
    const { relay, storage } = createRelay();
    await storage.put('used-nonce:tenant-a:wwcon_8K4M2Q9F7D3H6P1X:nonce-1', {
      expiresAt: Date.now() - 1,
    });
    const { ws, sent } = relayWebSocket(relayAttachment);

    await relay.webSocketMessage(ws, JSON.stringify(await authResponse()));

    expect(sent.at(-1)).toMatchObject({ type: 'auth.ok', tenant_id: 'tenant-a' });
    expect(storage.delete).toHaveBeenCalledWith(
      'used-nonce:tenant-a:wwcon_8K4M2Q9F7D3H6P1X:nonce-1'
    );
  });

  it.each([
    ['unknown key', { key_id: 'kid-unknown' }],
    ['invalid signature encoding', { signature: '<not-hex>' }],
    ['wrong signature', { signature: '0'.repeat(64) }],
  ])('fails closed for %s', async (_label, overrides) => {
    const { relay } = createRelay();
    const { ws, sent, raw } = relayWebSocket(relayAttachment);
    const message = await authResponse(overrides);
    if ('signature' in overrides) Object.assign(message, overrides);

    await relay.webSocketMessage(ws, JSON.stringify(message));

    expect(sent[0]).toMatchObject({ code: 'relay_auth_failed' });
    expect(raw.close).toHaveBeenCalledWith(1008, 'relay authentication failed');
  });

  it('authenticates a signed connector, persists key state, and never stores the secret', async () => {
    const { relay, storage } = createRelay();
    const { ws, sent, raw } = relayWebSocket(relayAttachment);

    await relay.webSocketMessage(ws, JSON.stringify(await authResponse()));

    expect(sent.at(-1)).toMatchObject({
      type: 'auth.ok',
      tenant_id: 'tenant-a',
      connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
    });
    expect(raw.close).not.toHaveBeenCalled();
    expect(storage._values.get('connection:connection-1')).toMatchObject({
      authenticated: true,
      tenantId: 'tenant-a',
      keyId: 'kid-active',
    });
    expect(JSON.stringify([...storage._values.entries()])).not.toContain('active-secret');
  });

  it('blocks reconnects after the configured authentication failure threshold', async () => {
    const { relay, storage } = createRelay({
      connector: {
        relay: {
          auth_failure_rate_limit_per_minute: 1,
          auth_failure_block_ms: 60_000,
        },
      },
    });
    const { ws } = relayWebSocket(relayAttachment);
    const message = await authResponse({ signature: '0'.repeat(64) });
    Object.assign(message, { signature: '0'.repeat(64) });
    await relay.webSocketMessage(ws, JSON.stringify(message));

    const blocked = storage._values.get('auth-failure:tenant-a:wwcon_8K4M2Q9F7D3H6P1X') as {
      blockedUntil?: number;
    };
    expect(blocked.blockedUntil).toBeGreaterThan(Date.now());
  });

  it('records connector fleet registration when relay auth includes instance metadata', async () => {
    const { relay, db } = createRelay();
    const relayInternals = relay as unknown as {
      recordFleetRegistration: (
        attachment: Record<string, unknown>,
        message: Record<string, unknown>
      ) => Promise<boolean>;
    };

    await expect(
      relayInternals.recordFleetRegistration(
        {
          tenantId: 'tenant-a',
          connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
        },
        {
          instance_id: 'wwi_1234567890123456789012',
          display_name: 'campus relay',
          version: '0.1.0',
          started_at: '2026-06-24T00:00:00.000Z',
        }
      )
    ).resolves.toBe(true);

    expect(db.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO directory_connector_instances'),
      expect.arrayContaining([
        'tenant-a',
        'wwcon_8K4M2Q9F7D3H6P1X',
        'wwi_1234567890123456789012',
        'campus relay',
        'relay',
        '0.1.0',
      ])
    );
  });

  it('rejects relay fleet registration without an immutable instance id', async () => {
    const { relay, db } = createRelay();
    const relayInternals = relay as unknown as {
      recordFleetRegistration: (
        attachment: Record<string, unknown>,
        message: Record<string, unknown>
      ) => Promise<boolean>;
    };

    await expect(
      relayInternals.recordFleetRegistration(
        {
          tenantId: 'tenant-a',
          connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
        },
        {
          version: '0.1.0',
          started_at: '2026-06-24T00:00:00.000Z',
        }
      )
    ).resolves.toBe(false);

    expect(db.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO directory_connector_instances'),
      expect.anything()
    );
  });

  it('rejects verify requests when connector pending requests exceed the configured limit', async () => {
    const { relay } = createRelay({
      connector: {
        relay: {
          max_pending_requests: 1,
        },
      },
    });
    const pending = (
      relay as unknown as {
        pending: Map<
          string,
          {
            resolve: (response: unknown) => void;
            reject: (error: Error) => void;
            tenantId: string;
            connectorId: string;
            requestId: string;
            timeout: ReturnType<typeof setTimeout>;
            expiresAt: number;
          }
        >;
      }
    ).pending;
    pending.set('pending-1', {
      resolve: vi.fn(),
      reject: vi.fn(),
      tenantId: 'tenant-a',
      connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
      requestId: 'req_existing',
      timeout: setTimeout(() => undefined, 1000),
      expiresAt: Date.now() + 1000,
    });

    const response = await relay.fetch(
      new Request('https://directory-relay.internal/verify-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request_id: 'req_new',
          tenant_id: 'tenant-a',
          connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
          username: 'alice',
          password: 'correct',
          attribute_names: ['mail'],
        }),
      })
    );
    const body = (await response.json()) as { error?: { code?: string; retryable?: boolean } };

    clearTimeout(pending.get('pending-1')?.timeout);
    expect(response.status).toBe(429);
    expect(body.error).toMatchObject({
      code: 'relay_overloaded',
      retryable: true,
    });

    const eventsResponse = await relay.fetch(
      new Request(
        'https://directory-relay.internal/events?tenant_id=tenant-a&connector_id=wwcon_8K4M2Q9F7D3H6P1X'
      )
    );
    const eventsBody = (await eventsResponse.json()) as {
      events: Array<{ type: string; code?: string; requestId?: string }>;
    };
    expect(eventsResponse.status).toBe(200);
    expect(eventsBody.events[0]).toMatchObject({
      type: 'directory_relay.overloaded',
      code: 'relay_overloaded',
      requestId: 'req_new',
    });
  });

  it('cleans expired pending relay requests before enforcing the pending limit', async () => {
    const { relay } = createRelay({
      connector: {
        relay: {
          max_pending_requests: 1,
        },
      },
    });
    const timeout = setTimeout(() => undefined, 1000);
    const reject = vi.fn();
    const pending = (
      relay as unknown as {
        pending: Map<
          string,
          {
            resolve: (response: unknown) => void;
            reject: (error: Error) => void;
            tenantId: string;
            connectorId: string;
            requestId: string;
            timeout: ReturnType<typeof setTimeout>;
            expiresAt: number;
          }
        >;
      }
    ).pending;
    pending.set('pending-expired', {
      resolve: vi.fn(),
      reject,
      tenantId: 'tenant-a',
      connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
      requestId: 'req_expired',
      timeout,
      expiresAt: Date.now() - 1,
    });

    const response = await relay.fetch(
      new Request('https://directory-relay.internal/verify-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request_id: 'req_new',
          tenant_id: 'tenant-a',
          connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
          username: 'alice',
          password: 'correct',
          attribute_names: ['mail'],
        }),
      })
    );
    const body = (await response.json()) as { error?: { code?: string; retryable?: boolean } };

    expect(response.status).toBe(503);
    expect(body.error).toMatchObject({
      code: 'relay_connector_offline',
      retryable: true,
    });
    expect(pending.size).toBe(0);
    expect(reject).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'relay_verify_timeout' })
    );
  });

  it('rejects oversized verify request bodies even when content-length is absent', async () => {
    const { relay } = createRelay();

    const response = await relay.fetch(
      new Request('https://directory-relay.internal/verify-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'x'.repeat(64 * 1024 + 1),
      })
    );
    const body = (await response.json()) as { error?: { code?: string; retryable?: boolean } };

    expect(response.status).toBe(413);
    expect(body.error).toMatchObject({
      code: 'relay_request_too_large',
      retryable: false,
    });
  });

  it('returns non-retryable relay verify errors without upgrading them to retryable transport errors', async () => {
    const { relay, ctx, storage } = createRelay();
    await storage.put('connection:conn-1', {
      authenticated: true,
      tenantId: 'tenant-a',
      connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
      keyId: 'kid-active',
      authenticatedAt: Date.now(),
    });

    const relayInternals = relay as unknown as {
      handleVerifyError: (ws: WebSocket, message: unknown) => Promise<void>;
    };
    const ws = {
      deserializeAttachment: vi.fn(() => ({
        connectionId: 'conn-1',
        tenantId: 'tenant-a',
        connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
      })),
      send: vi.fn((payload: string) => {
        const message = JSON.parse(payload) as { type?: string; id?: string; request_id?: string };
        if (message.type !== 'verify.request') return;
        setTimeout(() => {
          void relayInternals.handleVerifyError(ws as unknown as WebSocket, {
            type: 'verify.error',
            protocol: 'authrim.wordwarden.relay.v1',
            protocol_version: 1,
            min_supported_version: 1,
            id: message.id,
            request_id: message.request_id,
            tenant_id: 'tenant-a',
            connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
            error: {
              code: 'invalid_relay_request',
              retryable: false,
            },
          });
        }, 0);
      }),
      close: vi.fn(),
    };
    ctx.getWebSockets.mockReturnValue([ws as unknown as WebSocket]);

    const response = await relay.fetch(
      new Request('https://directory-relay.internal/verify-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request_id: 'req_123',
          tenant_id: 'tenant-a',
          connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
          username: 'alice',
          password: 'correct',
          attribute_names: ['mail'],
        }),
      })
    );
    const body = (await response.json()) as { error?: { code?: string; retryable?: boolean } };

    expect(response.status).toBe(400);
    expect(body.error).toMatchObject({
      code: 'invalid_relay_request',
      retryable: false,
    });
    const eventRecord = storage._values.get('events:tenant-a:wwcon_8K4M2Q9F7D3H6P1X') as {
      events: Array<{ code?: string; retryable?: boolean }>;
    };
    expect(eventRecord.events[0]).toMatchObject({
      code: 'invalid_relay_request',
      retryable: false,
    });
  });

  it('normalizes relay verify error codes before recording or returning them', async () => {
    const { relay, storage } = createRelay();
    await storage.put('connection:conn-1', {
      authenticated: true,
      tenantId: 'tenant-a',
      connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
      keyId: 'kid-active',
      authenticatedAt: Date.now(),
    });

    const timeout = setTimeout(() => undefined, 1000);
    const reject = vi.fn();
    const relayInternals = relay as unknown as {
      pending: Map<
        string,
        {
          resolve: (response: unknown) => void;
          reject: (error: Error) => void;
          timeout: ReturnType<typeof setTimeout>;
          expiresAt: number;
          requestId: string;
          tenantId: string;
          connectorId: string;
        }
      >;
      handleVerifyError: (ws: WebSocket, message: unknown) => Promise<void>;
    };
    relayInternals.pending.set('message-1', {
      resolve: vi.fn(),
      reject,
      timeout,
      expiresAt: Date.now() + 1000,
      requestId: 'req_123',
      tenantId: 'tenant-a',
      connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
    });
    const ws = {
      deserializeAttachment: vi.fn(() => ({
        connectionId: 'conn-1',
        tenantId: 'tenant-a',
        connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
      })),
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;

    await relayInternals.handleVerifyError(ws, {
      type: 'verify.error',
      protocol: 'authrim.wordwarden.relay.v1',
      protocol_version: 1,
      min_supported_version: 1,
      id: 'message-1',
      error: {
        code: '<script>alert(1)</script>'.repeat(20),
        retryable: false,
      },
    });

    clearTimeout(timeout);
    expect(reject).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'relay_verify_error', retryable: false })
    );
    const eventRecord = storage._values.get('events:tenant-a:wwcon_8K4M2Q9F7D3H6P1X') as {
      events: Array<{ code?: string; retryable?: boolean }>;
    };
    expect(eventRecord.events[0]).toMatchObject({
      code: 'relay_verify_error',
      retryable: false,
    });
  });

  it.each(['verify.response', 'verify.error'])(
    'rejects an unauthenticated %s message',
    async (type) => {
      const { relay } = createRelay();
      const { ws, sent, raw } = relayWebSocket(relayAttachment);
      const message =
        type === 'verify.response'
          ? {
              type,
              protocol: 'authrim.wordwarden.relay.v1',
              protocol_version: 1,
              min_supported_version: 1,
              id: 'message-1',
              request_id: 'request-1',
              tenant_id: 'tenant-a',
              connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
              result: 'failure',
              directory_status: 'ok',
            }
          : {
              type,
              protocol: 'authrim.wordwarden.relay.v1',
              protocol_version: 1,
              min_supported_version: 1,
              id: 'message-1',
              error: { code: 'directory_rejected', retryable: false },
            };

      await relay.webSocketMessage(ws, JSON.stringify(message));

      expect(sent[0]).toMatchObject({ code: 'unauthenticated' });
      expect(raw.close).toHaveBeenCalledWith(1008, 'unauthenticated');
    }
  );

  it.each(['verify.response', 'verify.error'])(
    'does not accept an unknown request ID from an authenticated %s',
    async (type) => {
      const { relay, storage } = createRelay();
      await storage.put('connection:connection-1', {
        authenticated: true,
        tenantId: 'tenant-a',
        connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
        keyId: 'kid-active',
        authenticatedAt: Date.now(),
      });
      const { ws, sent, raw } = relayWebSocket(relayAttachment);
      const common = {
        type,
        protocol: 'authrim.wordwarden.relay.v1',
        protocol_version: 1,
        min_supported_version: 1,
        id: 'unknown-message',
      };
      const message =
        type === 'verify.response'
          ? {
              ...common,
              request_id: 'request-1',
              tenant_id: 'tenant-a',
              connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
              result: 'failure',
              directory_status: 'ok',
            }
          : { ...common, error: { code: 'directory_rejected', retryable: false } };

      await relay.webSocketMessage(ws, JSON.stringify(message));

      expect(sent[0]).toMatchObject({ code: 'unknown_request_id' });
      expect(raw.close).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['request_id', 'request-other'],
    ['tenant_id', 'tenant-b'],
    ['connector_id', 'wwcon_OTHERCONNECTOR1234567890'],
  ])('rejects a verify response with mismatched %s', async (field, value) => {
    const { relay, storage } = createRelay();
    await storage.put('connection:connection-1', {
      authenticated: true,
      tenantId: 'tenant-a',
      connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
      keyId: 'kid-active',
      authenticatedAt: Date.now(),
    });
    const timeout = setTimeout(() => undefined, 1000);
    const reject = vi.fn();
    const internals = relay as unknown as {
      pending: Map<string, Record<string, unknown>>;
    };
    internals.pending.set('message-1', {
      resolve: vi.fn(),
      reject,
      timeout,
      expiresAt: Date.now() + 1000,
      requestId: 'request-1',
      tenantId: 'tenant-a',
      connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
    });
    const { ws, raw } = relayWebSocket(relayAttachment);

    await relay.webSocketMessage(
      ws,
      JSON.stringify({
        type: 'verify.response',
        protocol: 'authrim.wordwarden.relay.v1',
        protocol_version: 1,
        min_supported_version: 1,
        id: 'message-1',
        request_id: 'request-1',
        tenant_id: 'tenant-a',
        connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
        result: 'failure',
        directory_status: 'ok',
        [field]: value,
      })
    );

    clearTimeout(timeout);
    expect(reject).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'relay_response_mismatch', retryable: false })
    );
    expect(raw.close).toHaveBeenCalledWith(1008, 'relay response mismatch');
    expect(internals.pending.has('message-1')).toBe(false);
  });

  it('resolves a pending request only for an authenticated matching response', async () => {
    const { relay, storage } = createRelay();
    await storage.put('connection:connection-1', {
      authenticated: true,
      tenantId: 'tenant-a',
      connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
      keyId: 'kid-active',
      authenticatedAt: Date.now(),
    });
    const timeout = setTimeout(() => undefined, 1000);
    const resolve = vi.fn();
    const internals = relay as unknown as { pending: Map<string, Record<string, unknown>> };
    internals.pending.set('message-1', {
      resolve,
      reject: vi.fn(),
      timeout,
      expiresAt: Date.now() + 1000,
      requestId: 'request-1',
      tenantId: 'tenant-a',
      connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
    });
    const { ws } = relayWebSocket(relayAttachment);
    const message = {
      type: 'verify.response',
      protocol: 'authrim.wordwarden.relay.v1',
      protocol_version: 1,
      min_supported_version: 1,
      id: 'message-1',
      request_id: 'request-1',
      tenant_id: 'tenant-a',
      connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
      result: 'success',
      directory_status: 'ok',
    };

    await relay.webSocketMessage(ws, JSON.stringify(message));

    clearTimeout(timeout);
    expect(resolve).toHaveBeenCalledWith(message);
    expect(internals.pending.has('message-1')).toBe(false);
  });

  it.each([
    ['request_id', 'request-other'],
    ['tenant_id', 'tenant-b'],
    ['connector_id', 'wwcon_OTHERCONNECTOR1234567890'],
  ])('rejects a verify error with mismatched optional %s', async (field, value) => {
    const { relay, storage } = createRelay();
    await storage.put('connection:connection-1', {
      authenticated: true,
      tenantId: 'tenant-a',
      connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
      keyId: 'kid-active',
      authenticatedAt: Date.now(),
    });
    const timeout = setTimeout(() => undefined, 1000);
    const reject = vi.fn();
    const internals = relay as unknown as { pending: Map<string, Record<string, unknown>> };
    internals.pending.set('message-1', {
      resolve: vi.fn(),
      reject,
      timeout,
      expiresAt: Date.now() + 1000,
      requestId: 'request-1',
      tenantId: 'tenant-a',
      connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
    });
    const { ws, raw } = relayWebSocket(relayAttachment);

    await relay.webSocketMessage(
      ws,
      JSON.stringify({
        type: 'verify.error',
        protocol: 'authrim.wordwarden.relay.v1',
        protocol_version: 1,
        min_supported_version: 1,
        id: 'message-1',
        error: { code: 'directory_rejected', retryable: false },
        [field]: value,
      })
    );

    clearTimeout(timeout);
    expect(reject).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'relay_response_mismatch', retryable: false })
    );
    expect(raw.close).toHaveBeenCalledWith(1008, 'relay response mismatch');
  });

  it('returns a stable error when forwarding to an authenticated socket throws', async () => {
    const { relay, ctx, storage } = createRelay();
    await storage.put('connection:connection-1', {
      authenticated: true,
      tenantId: 'tenant-a',
      connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
      keyId: 'kid-active',
      authenticatedAt: Date.now(),
    });
    const socket = relayWebSocket(relayAttachment);
    socket.raw.send.mockImplementationOnce(() => {
      throw new Error('socket closed');
    });
    ctx.getWebSockets.mockReturnValue([socket.ws]);

    const response = await relay.fetch(
      new Request('https://directory-relay.internal/verify-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request_id: 'request-1',
          tenant_id: 'tenant-a',
          connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
          username: 'alice',
          password: 'secret',
          attribute_names: ['mail'],
        }),
      })
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'relay_send_failed', retryable: true },
    });
  });

  it('rejects all pending requests for the connector when its authenticated socket closes', async () => {
    const { relay, storage } = createRelay();
    await storage.put('connection:connection-1', {
      authenticated: true,
      tenantId: 'tenant-a',
      connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
      keyId: 'kid-active',
      authenticatedAt: Date.now(),
    });
    const timeout = setTimeout(() => undefined, 1000);
    const reject = vi.fn();
    const internals = relay as unknown as { pending: Map<string, Record<string, unknown>> };
    internals.pending.set('message-1', {
      resolve: vi.fn(),
      reject,
      timeout,
      expiresAt: Date.now() + 1000,
      requestId: 'request-1',
      tenantId: 'tenant-a',
      connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
    });
    const { ws } = relayWebSocket(relayAttachment);

    await relay.webSocketClose(ws);

    clearTimeout(timeout);
    expect(reject).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'relay_connection_closed', retryable: true })
    );
    expect(storage._values.has('connection:connection-1')).toBe(false);
  });

  it('validates required event query parameters and returns an empty event list', async () => {
    const { relay } = createRelay();
    const invalid = await relay.fetch(new Request('https://directory-relay.internal/events'));
    expect(invalid.status).toBe(400);

    const valid = await relay.fetch(
      new Request(
        'https://directory-relay.internal/events?tenant_id=tenant-a&connector_id=wwcon_8K4M2Q9F7D3H6P1X'
      )
    );
    expect(await valid.json()).toMatchObject({
      tenant_id: 'tenant-a',
      connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
      events: [],
    });
  });
});
