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
  env?: Record<string, unknown>;
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
      ...input.env,
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

  it.each([
    ['malformed JSON', '{'],
    ['JSON null', 'null'],
    ['JSON array', '[]'],
    ['missing instance ID', JSON.stringify(heartbeatPayload({ instance_id: undefined }))],
    ['invalid instance ID', JSON.stringify(heartbeatPayload({ instance_id: 'invalid' }))],
    ['missing version', JSON.stringify(heartbeatPayload({ version: undefined }))],
    ['oversized version', JSON.stringify(heartbeatPayload({ version: 'v'.repeat(65) }))],
    ['invalid start time', JSON.stringify(heartbeatPayload({ started_at: 'yesterday' }))],
    ['invalid fingerprint', JSON.stringify(heartbeatPayload({ config_fingerprint: 'sha256:no' }))],
    ['unsupported transport', JSON.stringify(heartbeatPayload({ transport: 'smtp' }))],
    ['unsupported health status', JSON.stringify(heartbeatPayload({ health_status: 'unknown' }))],
    ['invalid release channel', JSON.stringify(heartbeatPayload({ release_channel: 'bad value' }))],
    ['invalid drift severity', JSON.stringify(heartbeatPayload({ drift_severity: 'emergency' }))],
  ])('rejects structurally invalid payloads: %s', async (_name, bodyText) => {
    const context = createContext({ bodyText }) as never;

    const response = await directoryConnectorHeartbeatHandler(context);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_heartbeat' });
    expect(mocks.recordDirectoryConnectorHeartbeat).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ metadata: expect.stringContaining('invalid_payload') })
    );
  });

  it.each([
    ['', 'wwcon_8K4M2Q9F7D3H6P1X'],
    ['tenant-a', 'not-a-wordwarden-connector-id'],
  ])(
    'rejects invalid route identity before reading or auditing payload',
    async (tenantId, connectorId) => {
      const context = createContext({ tenantId, connectorId, bodyText: '{}' }) as never;

      const response = await directoryConnectorHeartbeatHandler(context);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'invalid_request' });
      expect(mocks.createAuditLog).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['missing headers', {}],
    [
      'malformed signature',
      {
        'X-Authrim-Heartbeat-Key-Id': 'hb-active',
        'X-Authrim-Heartbeat-Timestamp': String(Date.now()),
        'X-Authrim-Heartbeat-Signature': 'not-hex',
      },
    ],
    [
      'stale numeric timestamp',
      {
        'X-Authrim-Heartbeat-Key-Id': 'hb-active',
        'X-Authrim-Heartbeat-Timestamp': '1',
        'X-Authrim-Heartbeat-Signature': `sha256=${'a'.repeat(64)}`,
      },
    ],
    [
      'invalid date timestamp',
      {
        'X-Authrim-Heartbeat-Key-Id': 'hb-active',
        'X-Authrim-Heartbeat-Timestamp': 'not-a-date',
        'X-Authrim-Heartbeat-Signature': `sha256=${'a'.repeat(64)}`,
      },
    ],
  ])('rejects signature context failure: %s', async (_name, headers) => {
    const bodyText = JSON.stringify(heartbeatPayload());
    const context = createContext({ bodyText, headers }) as never;

    const response = await directoryConnectorHeartbeatHandler(context);

    expect(response.status).toBe(401);
    expect(mocks.recordDirectoryConnectorHeartbeat).not.toHaveBeenCalled();
  });

  it('rejects an unknown connector without revealing whether its signing key exists', async () => {
    const bodyText = JSON.stringify(heartbeatPayload());
    const context = createContext({
      bodyText,
      headers: await signedHeaders(bodyText),
      settings: { 'settings:tenant:tenant-a:directory-connectors': { connectors: [] } },
    }) as never;

    const response = await directoryConnectorHeartbeatHandler(context);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_heartbeat' });
  });

  it.each([
    ['missing active secret reference', { key_id: 'hb-active' }],
    ['non-environment secret reference', { key_id: 'hb-active', secret_ref: 'literal:secret' }],
    ['disallowed environment variable', { key_id: 'hb-active', secret_ref: 'env:SECRET' }],
    ['missing environment value', { key_id: 'hb-active', secret_ref: 'env:WORDWARDEN_MISSING' }],
  ])('rejects unusable key configuration: %s', async (_name, heartbeat) => {
    const bodyText = JSON.stringify(heartbeatPayload());
    const context = createContext({
      bodyText,
      headers: await signedHeaders(bodyText),
      settings: {
        'settings:tenant:tenant-a:directory-connectors': {
          connectors: [{ id: 'campus', connector_id: 'wwcon_8K4M2Q9F7D3H6P1X', heartbeat }],
        },
      },
    }) as never;

    const response = await directoryConnectorHeartbeatHandler(context);

    expect(response.status).toBe(401);
    expect(mocks.recordDirectoryConnectorHeartbeat).not.toHaveBeenCalled();
  });

  it('accepts the configured previous key during credential rotation', async () => {
    const bodyText = JSON.stringify(
      heartbeatPayload({
        display_name: ' Campus Connector ',
        transport: 'relay',
        health_status: 'degraded',
        release_channel: undefined,
        drift_severity: undefined,
        health_summary: null,
        config_categories: [' ldap ', '', 'ldap', 42, 'x'.repeat(65), 'groups'],
      })
    );
    const timestamp = String(Date.now());
    const canonical = await buildHeartbeatCanonicalRequest({
      tenantId: 'tenant-a',
      connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
      instanceId: 'wwi_1234567890123456789012',
      keyId: 'hb-previous',
      timestamp,
      bodyText,
    });
    const context = createContext({
      bodyText,
      headers: {
        'X-Authrim-Heartbeat-Key-Id': 'hb-previous',
        'X-Authrim-Heartbeat-Timestamp': timestamp,
        'X-Authrim-Heartbeat-Signature': await signHeartbeatCanonicalRequest(
          canonical,
          'previous-secret'
        ),
      },
      settings: {
        'settings:tenant:tenant-a:directory-connectors': {
          connectors: [
            {
              id: 'campus',
              connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
              heartbeat: {
                key_id: 'hb-active',
                secret_ref: 'env:WORDWARDEN_HEARTBEAT_SECRET',
                previous_key_id: 'hb-previous',
                previous_secret_ref: 'env:WORDWARDEN_PREVIOUS_SECRET',
              },
            },
          ],
        },
      },
      env: { WORDWARDEN_PREVIOUS_SECRET: 'previous-secret' },
    }) as never;

    const response = await directoryConnectorHeartbeatHandler(context);

    expect(response.status).toBe(200);
    expect(mocks.recordDirectoryConnectorHeartbeat).toHaveBeenCalledWith(
      mocks.coreAdapter,
      expect.objectContaining({
        displayName: 'Campus Connector',
        transport: 'relay',
        healthStatus: 'degraded',
        releaseChannel: 'stable',
        healthSummary: {},
        configCategories: ['ldap', 'groups'],
        driftSeverity: 'none',
      })
    );
  });

  it.each([
    ['settings read failure', { get: vi.fn().mockRejectedValue(new Error('KV unavailable')) }],
    ['missing settings', { get: vi.fn().mockResolvedValue(null) }],
    ['malformed settings JSON', { get: vi.fn().mockResolvedValue('{') }],
    [
      'non-array connector settings',
      { get: vi.fn().mockResolvedValue(JSON.stringify({ connectors: {} })) },
    ],
  ])('treats %s as an unconfigured connector', async (_name, settings) => {
    const bodyText = JSON.stringify(heartbeatPayload());
    const context = createContext({
      bodyText,
      headers: await signedHeaders(bodyText),
      env: { SETTINGS: settings },
    }) as never;

    const response = await directoryConnectorHeartbeatHandler(context);

    expect(response.status).toBe(404);
    expect(mocks.recordDirectoryConnectorHeartbeat).not.toHaveBeenCalled();
  });

  it('skips malformed and nonmatching connector records before selecting the requested connector', async () => {
    const bodyText = JSON.stringify(heartbeatPayload());
    const settings = {
      get: vi.fn().mockResolvedValue(
        JSON.stringify({
          connectors: [
            null,
            [],
            { id: '', connector_id: 'invalid' },
            {
              id: 'other',
              connector_id: 'wwcon_1K4M2Q9F7D3H6P8X',
              heartbeat: [],
            },
            {
              id: 'campus',
              connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
              heartbeat: {
                key_id: 'hb-active',
                secret_ref: 'env:WORDWARDEN_HEARTBEAT_SECRET',
              },
            },
          ],
        })
      ),
    };
    const context = createContext({
      bodyText,
      headers: await signedHeaders(bodyText),
      env: { SETTINGS: settings },
    }) as never;

    const response = await directoryConnectorHeartbeatHandler(context);

    expect(response.status).toBe(200);
    expect(mocks.recordDirectoryConnectorHeartbeat).toHaveBeenCalledOnce();
  });

  it('rejects a previous key whose configured environment secret is empty', async () => {
    const bodyText = JSON.stringify(heartbeatPayload());
    const timestamp = String(Date.now());
    const context = createContext({
      bodyText,
      headers: {
        'X-Authrim-Heartbeat-Key-Id': 'hb-previous',
        'X-Authrim-Heartbeat-Timestamp': timestamp,
        'X-Authrim-Heartbeat-Signature': `sha256=${'a'.repeat(64)}`,
      },
      settings: {
        'settings:tenant:tenant-a:directory-connectors': {
          connectors: [
            {
              id: 'campus',
              connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
              heartbeat: {
                previous_key_id: 'hb-previous',
                previous_secret_ref: 'env:WORDWARDEN_PREVIOUS_SECRET',
              },
            },
          ],
        },
      },
      env: { WORDWARDEN_PREVIOUS_SECRET: '' },
    }) as never;

    const response = await directoryConnectorHeartbeatHandler(context);

    expect(response.status).toBe(401);
    expect(mocks.recordDirectoryConnectorHeartbeat).not.toHaveBeenCalled();
  });

  it('uses a generic rejection reason when storage declines a heartbeat without one', async () => {
    mocks.recordDirectoryConnectorHeartbeat.mockResolvedValueOnce({
      accepted: false,
      status: 'deactivated',
    });
    const bodyText = JSON.stringify(heartbeatPayload());
    const context = createContext({ bodyText, headers: await signedHeaders(bodyText) }) as never;

    const response = await directoryConnectorHeartbeatHandler(context);

    expect(response.status).toBe(403);
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ metadata: expect.stringContaining('heartbeat_rejected') })
    );
  });

  it('bounds and normalizes optional telemetry collections before persistence', async () => {
    const bodyText = JSON.stringify(
      heartbeatPayload({
        health_summary: [],
        config_categories: Array.from({ length: 100 }, (_, index) => `category-${index}`),
      })
    );
    const context = createContext({ bodyText, headers: await signedHeaders(bodyText) }) as never;

    const response = await directoryConnectorHeartbeatHandler(context);

    expect(response.status).toBe(200);
    expect(mocks.recordDirectoryConnectorHeartbeat).toHaveBeenCalledWith(
      mocks.coreAdapter,
      expect.objectContaining({
        healthSummary: {},
        configCategories: expect.arrayContaining(['category-0']),
      })
    );
    const input = mocks.recordDirectoryConnectorHeartbeat.mock.calls[0]?.[1] as {
      configCategories: string[];
    };
    expect(input.configCategories.length).toBeLessThan(100);
  });

  it('handles an absent request body as an invalid heartbeat payload', async () => {
    const context = createContext({ bodyText: '' }) as unknown as {
      req: { raw: Request };
    };
    context.req.raw = new Request(
      'https://login.example.com/api/auth/directory-connectors/heartbeat',
      { method: 'POST' }
    );

    const response = await directoryConnectorHeartbeatHandler(context as never);

    expect(response.status).toBe(400);
  });

  it('does not let audit-log failures alter the authentication response', async () => {
    mocks.createAuditLog.mockRejectedValueOnce('storage failure');
    const bodyText = JSON.stringify(heartbeatPayload());
    const context = createContext({ bodyText, headers: {} }) as never;

    const response = await directoryConnectorHeartbeatHandler(context);

    expect(response.status).toBe(401);
  });
});
