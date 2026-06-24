import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, ExecuteResult, HealthStatus, TransactionContext } from '@authrim/ar-lib-core';
import { DirectoryConnectorRelay } from '../directory-connector-relay';

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
    isHealthy: vi.fn(async (): Promise<HealthStatus> => ({
      healthy: true,
      latencyMs: 1,
      type: 'mock',
    })),
    getType: vi.fn(() => 'mock'),
    close: vi.fn(async () => undefined),
  };
}

describe('DirectoryConnectorRelay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
            tenantId: string;
            connectorId: string;
            requestId: string;
            timeout: ReturnType<typeof setTimeout>;
          }
        >;
      }
    ).pending;
    pending.set('pending-1', {
      tenantId: 'tenant-a',
      connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
      requestId: 'req_existing',
      timeout: setTimeout(() => undefined, 1000),
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
});
