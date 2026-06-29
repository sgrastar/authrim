import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildHeartbeatCanonicalRequest,
  directoryConnectorHeartbeatHandler,
  signHeartbeatCanonicalRequest,
} from '../directory-connector-heartbeat';

const mocks = vi.hoisted(() => ({
  coreAdapter: {},
  createAuditLog: vi.fn(),
  recordDirectoryConnectorHeartbeat: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.coreAdapter })),
    createAuditLog: mocks.createAuditLog,
    recordDirectoryConnectorHeartbeat: mocks.recordDirectoryConnectorHeartbeat,
  };
});

function createKV(values: Record<string, unknown>) {
  return {
    get: vi.fn(async (key: string) => {
      const value = values[key];
      return value === undefined ? null : JSON.stringify(value);
    }),
  };
}

function createContext(input: {
  tenantId?: string;
  connectorId?: string;
  bodyText: string;
  headers?: Record<string, string>;
  settings?: Record<string, unknown>;
}) {
  const headers = new Map(
    Object.entries(input.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    req: {
      param: vi.fn((name: string) => {
        if (name === 'tenantId') return input.tenantId ?? 'tenant-a';
        if (name === 'connectorId') return input.connectorId ?? 'wwcon_8K4M2Q9F7D3H6P1X';
        return undefined;
      }),
      header: vi.fn((name: string) => headers.get(name.toLowerCase())),
      text: vi.fn(async () => input.bodyText),
      raw: new Request('https://login.example.com/api/auth/directory-connectors/heartbeat', {
        method: 'POST',
        body: input.bodyText,
      }),
    },
    env: {
      SETTINGS: createKV(
        input.settings ?? {
          'settings:tenant:tenant-a:directory-connectors': {
            connectors: [
              {
                id: 'campus',
                connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
                heartbeat: {
                  key_id: 'hb-active',
                  secret_ref: 'env:WORDWARDEN_HEARTBEAT_SECRET',
                },
              },
            ],
          },
        }
      ),
      WORDWARDEN_HEARTBEAT_SECRET: 'heartbeat-secret',
    },
    executionCtx: { waitUntil: vi.fn() },
    json: (payload: unknown, status = 200) => Response.json(payload, { status }),
  };
}

function heartbeatPayload(overrides: Record<string, unknown> = {}) {
  return {
    instance_id: 'wwi_1234567890123456789012',
    transport: 'direct',
    version: '0.13.0',
    release_channel: 'stable',
    started_at: '2026-06-24T00:00:00.000Z',
    health_status: 'healthy',
    health_summary: { ldap: 'ok' },
    config_fingerprint: `sha256:${'a'.repeat(64)}`,
    config_categories: ['ldap'],
    ...overrides,
  };
}

async function signedHeaders(bodyText: string, secret = 'heartbeat-secret') {
  const timestamp = String(Date.now());
  const canonical = await buildHeartbeatCanonicalRequest({
    tenantId: 'tenant-a',
    connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
    instanceId: 'wwi_1234567890123456789012',
    keyId: 'hb-active',
    timestamp,
    bodyText,
  });
  return {
    'X-Authrim-Heartbeat-Key-Id': 'hb-active',
    'X-Authrim-Heartbeat-Timestamp': timestamp,
    'X-Authrim-Heartbeat-Signature': `sha256=${await signHeartbeatCanonicalRequest(
      canonical,
      secret
    )}`,
  };
}

describe('directory connector heartbeat handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAuditLog.mockResolvedValue(undefined);
    mocks.recordDirectoryConnectorHeartbeat.mockResolvedValue({
      accepted: true,
      status: 'connected',
    });
  });

  it('records a valid connector heartbeat without persisting secrets', async () => {
    const bodyText = JSON.stringify(heartbeatPayload());
    const context = createContext({
      bodyText,
      headers: await signedHeaders(bodyText),
    }) as never;

    const response = await directoryConnectorHeartbeatHandler(context);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      status: 'connected',
      instance_id: 'wwi_1234567890123456789012',
      connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
    });
    expect(mocks.recordDirectoryConnectorHeartbeat).toHaveBeenCalledWith(
      mocks.coreAdapter,
      expect.objectContaining({
        tenantId: 'tenant-a',
        connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
        instanceId: 'wwi_1234567890123456789012',
        releaseChannel: 'stable',
        configFingerprint: `sha256:${'a'.repeat(64)}`,
      })
    );
    expect(JSON.stringify(mocks.recordDirectoryConnectorHeartbeat.mock.calls)).not.toContain(
      'heartbeat-secret'
    );
  });

  it('rejects invalid HMAC signatures with a generic response and audit detail', async () => {
    const bodyText = JSON.stringify(heartbeatPayload());
    const context = createContext({
      bodyText,
      headers: {
        ...(await signedHeaders(bodyText, 'wrong-secret')),
        'X-Authrim-Heartbeat-Signature': `sha256=${'b'.repeat(64)}`,
      },
    }) as never;

    const response = await directoryConnectorHeartbeatHandler(context);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(401);
    expect(body).toEqual({ error: 'invalid_heartbeat' });
    expect(mocks.recordDirectoryConnectorHeartbeat).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'directory_connector_heartbeat.failed',
        metadata: expect.stringContaining('signature_mismatch'),
      })
    );
    const auditEntry = mocks.createAuditLog.mock.calls[0]?.[1] as { metadata?: string };
    expect(auditEntry.metadata).not.toContain('heartbeat-secret');
  });

  it('rejects oversized heartbeat payload before parsing JSON', async () => {
    const bodyText = 'x'.repeat(33 * 1024);
    const context = createContext({
      bodyText,
      headers: await signedHeaders(bodyText),
    }) as never;

    const response = await directoryConnectorHeartbeatHandler(context);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(413);
    expect(body).toEqual({ error: 'invalid_heartbeat' });
    expect(mocks.recordDirectoryConnectorHeartbeat).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'directory_connector_heartbeat.failed',
        metadata: expect.stringContaining('payload_too_large'),
      })
    );
  });

  it('rejects deactivated instances after signature validation', async () => {
    mocks.recordDirectoryConnectorHeartbeat.mockResolvedValueOnce({
      accepted: false,
      status: 'deactivated',
      reason: 'instance_deactivated',
    });
    const bodyText = JSON.stringify(heartbeatPayload());
    const context = createContext({
      bodyText,
      headers: await signedHeaders(bodyText),
    }) as never;

    const response = await directoryConnectorHeartbeatHandler(context);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: 'invalid_heartbeat' });
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.stringContaining('instance_deactivated'),
      })
    );
  });
});
