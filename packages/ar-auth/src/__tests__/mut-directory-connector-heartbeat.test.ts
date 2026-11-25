import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkSystemEventDetails } from '@authrim/ar-lib-core';
import {
  buildHeartbeatCanonicalRequest,
  directoryConnectorHeartbeatHandler,
  signHeartbeatCanonicalRequest,
} from '../directory-connector-heartbeat';

const mocks = vi.hoisted(() => ({
  coreAdapter: {},
  logSystemEvent: vi.fn(),
  recordDirectoryConnectorHeartbeat: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.coreAdapter })),
    logSystemEvent: mocks.logSystemEvent,
    recordDirectoryConnectorHeartbeat: mocks.recordDirectoryConnectorHeartbeat,
  };
});

const CONNECTOR = 'wwcon_8K4M2Q9F7D3H6P1X';
const INSTANCE = 'wwi_1234567890123456789012';
const SETTINGS_KEY = 'settings:tenant:tenant-a:directory-connectors';
const activeConnector = {
  id: 'campus',
  connector_id: CONNECTOR,
  heartbeat: { key_id: 'hb-active', secret_ref: 'env:WORDWARDEN_HEARTBEAT_SECRET' },
};

function createContext(input: {
  bodyText?: string;
  raw?: Request;
  headers?: Record<string, string>;
  connectors?: unknown[];
  kvGet?: () => Promise<string | null>;
  env?: Record<string, unknown>;
}) {
  const headers = new Map(
    Object.entries(input.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])
  );
  const connectors = input.connectors ?? [activeConnector];
  return {
    req: {
      param: vi.fn((name: string) => (name === 'tenantId' ? 'tenant-a' : CONNECTOR)),
      header: vi.fn((name: string) => headers.get(name.toLowerCase())),
      raw:
        input.raw ??
        new Request('https://login.example.com/hb', { method: 'POST', body: input.bodyText }),
    },
    env: {
      SETTINGS: {
        get: vi.fn(
          input.kvGet ??
            (async (key: string) => (key === SETTINGS_KEY ? JSON.stringify({ connectors }) : null))
        ),
      },
      WORDWARDEN_HEARTBEAT_SECRET: 'heartbeat-secret',
      WORDWARDEN_OLD_SECRET: 'old-secret',
      ...input.env,
    },
    executionCtx: { waitUntil: vi.fn() },
    json: (payload: unknown, status = 200) => Response.json(payload, { status }),
  };
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    instance_id: INSTANCE,
    transport: 'direct',
    version: '0.13.0',
    started_at: '2026-06-24T00:00:00.000Z',
    health_status: 'healthy',
    config_fingerprint: `sha256:${'a'.repeat(64)}`,
    ...overrides,
  };
}

async function signed(
  bodyText: string,
  opts: { keyId?: string; secret?: string; ts?: string } = {}
) {
  const keyId = opts.keyId ?? 'hb-active';
  const timestamp = opts.ts ?? String(Date.now());
  const canonical = await buildHeartbeatCanonicalRequest({
    tenantId: 'tenant-a',
    connectorId: CONNECTOR,
    instanceId: INSTANCE,
    keyId,
    timestamp,
    bodyText,
  });
  return {
    'X-Authrim-Heartbeat-Key-Id': keyId,
    'X-Authrim-Heartbeat-Timestamp': timestamp,
    'X-Authrim-Heartbeat-Signature': await signHeartbeatCanonicalRequest(
      canonical,
      opts.secret ?? 'heartbeat-secret'
    ),
  };
}

async function run(ctx: ReturnType<typeof createContext>) {
  const response = await directoryConnectorHeartbeatHandler(ctx as never);
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

function lastAudit() {
  const call = mocks.logSystemEvent.mock.calls.at(-1);
  if (!call) return undefined;
  return call[1] as Record<string, unknown> & { details: Record<string, unknown> };
}

async function signedRun(
  body: Record<string, unknown>,
  extra: Parameters<typeof createContext>[0] = {}
) {
  const bodyText = JSON.stringify(body);
  return run(createContext({ bodyText, headers: await signed(bodyText), ...extra }));
}

describe('directory connector heartbeat (mutation hardening)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.logSystemEvent.mockResolvedValue(undefined);
    mocks.recordDirectoryConnectorHeartbeat.mockResolvedValue({
      accepted: true,
      status: 'connected',
    });
  });

  it('treats a body stream read error as an invalid payload', async () => {
    const stream = new ReadableStream({
      pull(controller) {
        controller.error(new Error('broken'));
      },
    });
    const raw = new Request('https://login.example.com/hb', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit);
    const result = await run(createContext({ raw }));
    expect(result).toEqual({ status: 400, body: { error: 'invalid_heartbeat' } });
    expect(lastAudit()?.details).toMatchObject({ reason: 'invalid_payload' });
  });

  it('rejects a literal null JSON body as invalid_payload', async () => {
    const result = await run(createContext({ bodyText: 'null' }));
    expect(result).toEqual({ status: 400, body: { error: 'invalid_heartbeat' } });
  });

  it('accepts a body of exactly the byte limit', async () => {
    const base = JSON.stringify(payload({ health_summary: { pad: '' } }));
    const pad = 'x'.repeat(32 * 1024 - base.length);
    const result = await signedRun(payload({ health_summary: { pad } }));
    expect(result.status).toBe(200);
  });

  it('audits an unknown connector with a 404 generic error', async () => {
    const result = await signedRun(payload(), { connectors: [] });
    expect(result).toEqual({ status: 404, body: { error: 'invalid_heartbeat' } });
    expect(lastAudit()).toMatchObject({
      tenantId: 'tenant-a',
      targetId: CONNECTOR,
      details: { connector_id: CONNECTOR, reason: 'connector_not_configured' },
    });
  });

  it('treats a settings read failure as an unconfigured connector', async () => {
    const result = await signedRun(payload(), {
      kvGet: async () => Promise.reject(new Error('kv')),
    });
    expect(result.status).toBe(404);
  });

  it('skips null connector entries before the matching one', async () => {
    const result = await signedRun(payload(), { connectors: [null, activeConnector] });
    expect(result.status).toBe(200);
  });

  it('audits missing or stale signature context with the instance and key id', async () => {
    const bodyText = JSON.stringify(payload());
    const headers = await signed(bodyText, { ts: 'not-a-date' });
    const result = await run(
      createContext({
        bodyText,
        headers: { ...headers, 'X-Forwarded-For': '198.51.100.7, 10.0.0.1' },
      })
    );
    expect(result).toEqual({ status: 401, body: { error: 'invalid_heartbeat' } });
    // The caller's address is not kept: the system log has no subject to erase by.
    expect(lastAudit()).toMatchObject({
      targetId: INSTANCE,
      details: { reason: 'invalid_signature_context', instance_id: INSTANCE, key_id: 'hb-active' },
    });
    expect(JSON.stringify(lastAudit())).not.toContain('198.51.100.7');
  });

  it('records an IP-shaped or free-text key id as invalid, so the event is still recordable', async () => {
    for (const keyId of ['192.0.2.1', '2001:db8::1', 'key id']) {
      const bodyText = JSON.stringify(payload());
      const headers = await signed(bodyText, { keyId });
      const result = await run(createContext({ bodyText, headers }));
      expect(result.status).toBe(401);
      const details = lastAudit()?.details as Record<string, unknown>;
      expect(details.key_id).toBe('invalid');
      expect(() => checkSystemEventDetails(details)).not.toThrow();
    }
  });

  it('audits an unknown key id', async () => {
    const bodyText = JSON.stringify(payload());
    const headers = await signed(bodyText, { keyId: 'hb-other' });
    const result = await run(createContext({ bodyText, headers }));
    expect(result).toEqual({ status: 401, body: { error: 'invalid_heartbeat' } });
    expect(lastAudit()?.details).toEqual({
      connector_id: CONNECTOR,
      reason: 'unknown_heartbeat_key',
      instance_id: INSTANCE,
      key_id: 'hb-other',
    });
  });

  it('does not use the previous secret for a key id that matches neither key', async () => {
    const connector = {
      ...activeConnector,
      heartbeat: {
        ...activeConnector.heartbeat,
        previous_key_id: 'hb-old',
        previous_secret_ref: 'env:WORDWARDEN_OLD_SECRET',
      },
    };
    const bodyText = JSON.stringify(payload());
    const headers = await signed(bodyText, { keyId: 'hb-other', secret: 'old-secret' });
    const result = await run(createContext({ bodyText, headers, connectors: [connector] }));
    expect(result.status).toBe(401);
    expect(lastAudit()?.details).toMatchObject({ reason: 'unknown_heartbeat_key' });
  });

  it('audits signature mismatch with instance and key id', async () => {
    const bodyText = JSON.stringify(payload());
    const headers = await signed(bodyText, { secret: 'wrong' });
    const result = await run(createContext({ bodyText, headers }));
    expect(result.status).toBe(401);
    expect(lastAudit()).toMatchObject({
      targetId: INSTANCE,
      details: { reason: 'signature_mismatch', instance_id: INSTANCE, key_id: 'hb-active' },
    });
  });

  it('audits a storage rejection with its reason and the instance', async () => {
    mocks.recordDirectoryConnectorHeartbeat.mockResolvedValue({
      accepted: false,
      reason: 'instance_revoked',
    });
    const result = await signedRun(payload());
    expect(result).toEqual({ status: 403, body: { error: 'invalid_heartbeat' } });
    expect(lastAudit()).toMatchObject({
      targetId: INSTANCE,
      details: { reason: 'instance_revoked', instance_id: INSTANCE, key_id: 'hb-active' },
    });
  });

  it.each([
    ['transport', 'relay'],
    ['transport', 'tunnel'],
    ['health_status', 'degraded'],
    ['health_status', 'unhealthy'],
    ['drift_severity', 'warning'],
    ['drift_severity', 'critical'],
    ['version', 'v'.repeat(64)],
  ])('accepts %s=%s', async (field, value) => {
    const result = await signedRun(payload({ [field]: value }));
    expect(result.status).toBe(200);
    const recorded = mocks.recordDirectoryConnectorHeartbeat.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    const keys: Record<string, string> = {
      health_status: 'healthStatus',
      drift_severity: 'driftSeverity',
    };
    const key = keys[field] ?? field;
    expect(recorded[key]).toBe(value);
  });

  it('rejects a version longer than 64 characters', async () => {
    const result = await signedRun(payload({ version: 'v'.repeat(65) }));
    expect(result.status).toBe(400);
  });

  it('keeps display names up to 128 characters and drops longer ones', async () => {
    await signedRun(payload({ display_name: 'd'.repeat(128) }));
    await signedRun(payload({ display_name: 'd'.repeat(129) }));
    const calls = mocks.recordDirectoryConnectorHeartbeat.mock.calls.map(
      (c) => c[1] as Record<string, unknown>
    );
    expect(calls[0].displayName).toBe('d'.repeat(128));
    expect(calls[1].displayName).toBeUndefined();
  });

  it('defaults optional collections and keeps 64-character categories', async () => {
    await signedRun(payload());
    await signedRun(payload({ config_categories: ['c'.repeat(64), 'c'.repeat(65)] }));
    const calls = mocks.recordDirectoryConnectorHeartbeat.mock.calls.map(
      (c) => c[1] as Record<string, unknown>
    );
    expect(calls[0]).toMatchObject({
      configCategories: [],
      healthSummary: {},
      releaseChannel: 'stable',
      driftSeverity: 'none',
    });
    expect(calls[1].configCategories).toEqual(['c'.repeat(64)]);
  });
});
