import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkDirectoryConnectorHealthHandler,
  getDirectoryConnectorsHandler,
  issueDirectoryConnectorSecretHandler,
  listDirectoryConnectorRelayEventsHandler,
  rotateDirectoryConnectorSecretHandler,
  updateDirectoryConnectorsHandler,
} from '../routes/directory-connectors';

const mocks = vi.hoisted(() => ({
  safeFetch: vi.fn(),
  readResponseTextWithLimit: vi.fn(),
  createAuditLogFromContext: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    safeFetch: mocks.safeFetch,
    readResponseTextWithLimit: mocks.readResponseTextWithLimit,
    createAuditLogFromContext: mocks.createAuditLogFromContext,
  };
});

function createKV(initial: Record<string, unknown> = {}) {
  const values = new Map<string, string>();
  for (const [key, value] of Object.entries(initial)) {
    values.set(key, JSON.stringify(value));
  }
  return {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  };
}

function createContext(
  tenantId: string,
  body?: unknown,
  initialSettings: Record<string, unknown> = {},
  connectorId?: string,
  envOverrides: Record<string, unknown> = {}
) {
  const settings = createKV(initialSettings);
  return {
    req: {
      param: vi.fn((name: string) => {
        if (name === 'tenantId') return tenantId;
        if (name === 'connectorId') return connectorId;
        return undefined;
      }),
      json: vi.fn(async () => body),
    },
    env: {
      SETTINGS: settings,
      ...envOverrides,
    },
    get: vi.fn((name: string) => {
      if (name !== 'adminAuth') return undefined;
      return {
        roles: ['system_admin'],
        permissions: ['admin:settings:read', 'admin:settings:write'],
        tenantScope: ['*'],
      };
    }),
    json: (payload: unknown, status = 200) => Response.json(payload, { status }),
    _settings: settings,
  };
}

const validConfig = {
  enabled: true,
  default_connector_id: 'campus',
  auto_provision: true,
  connectors: [
    {
      id: 'campus',
      transport: 'direct',
      endpoint_url: 'https://wordwarden.example.com',
      auth_mode: 'hmac',
      connector_id: 'ww_tenant_a',
      key_id: 'kid-active',
      secret_ref: 'env:WORDWARDEN_SECRET',
      timeouts: {
        request_ms: 2500,
      },
      attribute_names: ['mail', 'displayName', 'mail'],
    },
  ],
};

describe('directory connectors admin API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAuditLogFromContext.mockResolvedValue(undefined);
  });

  it('returns an empty connector list by default', async () => {
    const context = createContext('tenant-a') as never;

    const response = await getDirectoryConnectorsHandler(context);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      tenantId: 'tenant-a',
      enabled: false,
      default_connector_id: 'campus',
      auto_provision: false,
      connectors: [],
    });
  });

  it('stores normalized connector config under the tenant directory-connectors key', async () => {
    const context = createContext('tenant-a', validConfig) as never;

    const response = await updateDirectoryConnectorsHandler(context);
    const body = (await response.json()) as {
      enabled: boolean;
      default_connector_id: string;
      auto_provision: boolean;
      connectors: Array<{
        attribute_names: string[];
        relay: {
          verify_timeout_ms: number;
          max_pending_requests: number;
          challenge_ttl_ms: number;
          auth_failure_rate_limit_per_minute: number;
          auth_failure_block_ms: number;
          secret_rotation_grace_ms: number;
        };
      }>;
    };

    expect(response.status).toBe(200);
    expect(body.enabled).toBe(true);
    expect(body.default_connector_id).toBe('campus');
    expect(body.auto_provision).toBe(true);
    expect(body.connectors[0]?.attribute_names).toEqual(['mail', 'displayName']);
    expect(body.connectors[0]?.relay).toMatchObject({
      verify_timeout_ms: 5000,
      max_pending_requests: 16,
      challenge_ttl_ms: 30000,
      auth_failure_rate_limit_per_minute: 10,
      auth_failure_block_ms: 300000,
      secret_rotation_grace_ms: 300000,
    });
    expect(
      (context as { _settings: ReturnType<typeof createKV> })._settings.put
    ).toHaveBeenCalledWith(
      'settings:tenant:tenant-a:directory-connectors',
      expect.stringContaining('"connectors"')
    );
    expect(mocks.createAuditLogFromContext).toHaveBeenCalledWith(
      expect.anything(),
      'directory_connector.updated',
      'directory_connector',
      'tenant-a',
      expect.objectContaining({
        tenant_id: 'tenant-a',
      })
    );
    expect(JSON.stringify(mocks.createAuditLogFromContext.mock.calls[0]?.[4])).not.toContain(
      'WORDWARDEN_SECRET'
    );
  });

  it('stores relay connector config without a public endpoint URL', async () => {
    const context = createContext('tenant-a', {
      ...validConfig,
      connectors: [
        {
          ...validConfig.connectors[0],
          transport: 'relay',
          endpoint_url: '',
        },
      ],
    }) as never;

    const response = await updateDirectoryConnectorsHandler(context);
    const body = (await response.json()) as {
      connectors: Array<{ transport: string; endpoint_url: string }>;
    };

    expect(response.status).toBe(200);
    expect(body.connectors[0]).toMatchObject({
      transport: 'relay',
      endpoint_url: '',
    });
  });

  it('rejects non-HTTPS non-loopback connector endpoints', async () => {
    const context = createContext('tenant-a', {
      ...validConfig,
      connectors: [
        {
          ...validConfig.connectors[0],
          endpoint_url: 'http://wordwarden.example.com',
        },
      ],
    }) as never;

    const response = await updateDirectoryConnectorsHandler(context);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_directory_connector_config');
  });

  it('requires explicit runtime settings on update', async () => {
    const context = createContext('tenant-a', {
      connectors: validConfig.connectors,
    }) as never;

    const response = await updateDirectoryConnectorsHandler(context);

    expect(response.status).toBe(400);
  });

  it('rejects enabled config when the default connector is missing', async () => {
    const context = createContext('tenant-a', {
      ...validConfig,
      default_connector_id: 'missing',
    }) as never;

    const response = await updateDirectoryConnectorsHandler(context);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_directory_connector_config');
  });

  it('rejects secret refs outside the Wordwarden env namespace', async () => {
    const context = createContext('tenant-a', {
      ...validConfig,
      connectors: [
        {
          ...validConfig.connectors[0],
          secret_ref: 'env:UNRELATED_SECRET',
        },
      ],
    }) as never;

    const response = await updateDirectoryConnectorsHandler(context);

    expect(response.status).toBe(400);
  });

  it('accepts managed secret refs for relay connectors', async () => {
    const context = createContext('tenant-a', {
      ...validConfig,
      connectors: [
        {
          ...validConfig.connectors[0],
          transport: 'relay',
          endpoint_url: '',
          secret_ref: 'managed:campus',
        },
      ],
    }) as never;

    const response = await updateDirectoryConnectorsHandler(context);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(JSON.stringify(body)).toContain('managed:campus');
  });

  it('issues an Authrim-managed one-time relay secret without auditing the secret', async () => {
    const context = createContext(
      'tenant-a',
      undefined,
      {
        'settings:tenant:tenant-a:directory-connectors': {
          enabled: true,
          default_connector_id: 'campus',
          auto_provision: false,
          connectors: [
            {
              ...validConfig.connectors[0],
              transport: 'relay',
              endpoint_url: '',
            },
          ],
        },
      },
      'campus'
    ) as never;

    const response = await issueDirectoryConnectorSecretHandler(context);
    const body = (await response.json()) as {
      connector_id: string;
      key_id: string;
      secret_ref: string;
      secret: string;
      one_time_display: boolean;
    };

    expect(response.status).toBe(200);
    expect(body.connector_id).toBe('campus');
    expect(body.key_id).toMatch(/^kid_/);
    expect(body.secret_ref).toBe('managed:campus');
    expect(body.secret).toMatch(/^wwsec_/);
    expect(body.one_time_display).toBe(true);

    const settings = (context as { _settings: ReturnType<typeof createKV> })._settings;
    expect(settings.put).toHaveBeenCalledWith(
      'settings:tenant:tenant-a:directory-connector-secret:campus',
      expect.stringContaining(body.secret)
    );
    expect(settings.put).toHaveBeenCalledWith(
      'settings:tenant:tenant-a:directory-connectors',
      expect.stringContaining('"secret_ref":"managed:campus"')
    );
    expect(settings.put).toHaveBeenCalledWith(
      'settings:tenant:tenant-a:directory-connectors',
      expect.stringContaining(`"key_id":"${body.key_id}"`)
    );
    expect(JSON.stringify(mocks.createAuditLogFromContext.mock.calls)).not.toContain(body.secret);
  });

  it('rotates an Authrim-managed relay secret with a previous-key grace window', async () => {
    const initialCreatedAt = '2026-06-23T12:00:00.000Z';
    const context = createContext(
      'tenant-a',
      undefined,
      {
        'settings:tenant:tenant-a:directory-connectors': {
          enabled: true,
          default_connector_id: 'campus',
          auto_provision: false,
          connectors: [
            {
              ...validConfig.connectors[0],
              transport: 'relay',
              endpoint_url: '',
              key_id: 'kid-old',
              secret_ref: 'managed:campus',
              relay: {
                verify_timeout_ms: 5000,
                max_pending_requests: 16,
                challenge_ttl_ms: 30000,
                auth_failure_rate_limit_per_minute: 10,
                auth_failure_block_ms: 300000,
                secret_rotation_grace_ms: 300000,
              },
            },
          ],
        },
        'settings:tenant:tenant-a:directory-connector-secret:campus': {
          active: {
            keyId: 'kid-old',
            secret: 'wwsec_old',
            createdAt: initialCreatedAt,
          },
        },
      },
      'campus'
    ) as never;

    const response = await rotateDirectoryConnectorSecretHandler(context);
    const body = (await response.json()) as {
      key_id: string;
      secret: string;
      previous_retire_after: string | null;
    };

    expect(response.status).toBe(200);
    expect(body.key_id).toMatch(/^kid_/);
    expect(body.key_id).not.toBe('kid-old');
    expect(body.secret).toMatch(/^wwsec_/);
    expect(body.previous_retire_after).toEqual(expect.any(String));

    const settings = (context as { _settings: ReturnType<typeof createKV> })._settings;
    expect(settings.put).toHaveBeenCalledWith(
      'settings:tenant:tenant-a:directory-connector-secret:campus',
      expect.stringContaining('"keyId":"kid-old"')
    );
    expect(settings.put).toHaveBeenCalledWith(
      'settings:tenant:tenant-a:directory-connector-secret:campus',
      expect.stringContaining('"retireAfter"')
    );
    expect(settings.put).toHaveBeenCalledWith(
      'settings:tenant:tenant-a:directory-connectors',
      expect.stringContaining(`"key_id":"${body.key_id}"`)
    );
    expect(JSON.stringify(mocks.createAuditLogFromContext.mock.calls)).not.toContain(body.secret);
  });

  it('checks connector health without exposing connector secrets', async () => {
    mocks.safeFetch.mockResolvedValue(Response.json({ ok: true, version: '0.1.0' }));
    mocks.readResponseTextWithLimit.mockResolvedValue(
      JSON.stringify({ ok: true, version: '0.1.0' })
    );
    const context = createContext(
      'tenant-a',
      undefined,
      {
        'settings:tenant:tenant-a:directory-connectors': {
          connectors: [{ ...validConfig.connectors[0], attribute_names: ['mail'] }],
        },
      },
      'campus'
    ) as never;

    const response = await checkDirectoryConnectorHealthHandler(context);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mocks.safeFetch).toHaveBeenCalledWith(
      'https://wordwarden.example.com/healthz',
      expect.objectContaining({
        method: 'GET',
        timeoutMs: 2500,
      })
    );
    expect(JSON.stringify(body)).not.toContain('WORDWARDEN_SECRET');
  });

  it('reports relay connector health from the relay Durable Object', async () => {
    const relayFetch = vi.fn(async () =>
      Response.json({ ok: true, connections: 1, authenticated_connections: 1 })
    );
    mocks.readResponseTextWithLimit.mockResolvedValueOnce(
      JSON.stringify({ ok: true, connections: 1, authenticated_connections: 1 })
    );
    const relay = {
      idFromName: vi.fn((name: string) => ({ name }) as unknown as DurableObjectId),
      get: vi.fn(() => ({ fetch: relayFetch }) as unknown as DurableObjectStub),
    } as unknown as DurableObjectNamespace;
    const context = createContext(
      'tenant-a',
      undefined,
      {
        'settings:tenant:tenant-a:directory-connectors': {
          connectors: [
            {
              ...validConfig.connectors[0],
              transport: 'relay',
              endpoint_url: '',
            },
          ],
        },
      },
      'campus',
      {
        DIRECTORY_CONNECTOR_RELAY: relay,
      }
    ) as never;

    const response = await checkDirectoryConnectorHealthHandler(context);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.body).toMatchObject({ connections: 1, authenticated_connections: 1 });
    expect(mocks.safeFetch).not.toHaveBeenCalled();
    expect(relay.idFromName).toHaveBeenCalledWith('tenant-a:ww_tenant_a');
    expect(relayFetch).toHaveBeenCalledWith(
      'https://directory-relay.internal/status?tenant_id=tenant-a&connector_id=ww_tenant_a'
    );
  });

  it('lists relay connector events from the relay Durable Object', async () => {
    const relayFetch = vi.fn(async () =>
      Response.json({
        tenant_id: 'tenant-a',
        connector_id: 'ww_tenant_a',
        events: [
          {
            type: 'directory_relay.verify.failed',
            requestId: 'req_123',
            code: 'relay_verify_timeout',
          },
        ],
      })
    );
    mocks.readResponseTextWithLimit.mockResolvedValueOnce(
      JSON.stringify({
        tenant_id: 'tenant-a',
        connector_id: 'ww_tenant_a',
        events: [
          {
            type: 'directory_relay.verify.failed',
            requestId: 'req_123',
            code: 'relay_verify_timeout',
          },
        ],
      })
    );
    const relay = {
      idFromName: vi.fn((name: string) => ({ name }) as unknown as DurableObjectId),
      get: vi.fn(() => ({ fetch: relayFetch }) as unknown as DurableObjectStub),
    } as unknown as DurableObjectNamespace;
    const context = createContext(
      'tenant-a',
      undefined,
      {
        'settings:tenant:tenant-a:directory-connectors': {
          connectors: [
            {
              ...validConfig.connectors[0],
              transport: 'relay',
              endpoint_url: '',
            },
          ],
        },
      },
      'campus',
      {
        DIRECTORY_CONNECTOR_RELAY: relay,
      }
    ) as never;

    const response = await listDirectoryConnectorRelayEventsHandler(context);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(JSON.stringify(body.body)).toContain('directory_relay.verify.failed');
    expect(relayFetch).toHaveBeenCalledWith(
      'https://directory-relay.internal/events?tenant_id=tenant-a&connector_id=ww_tenant_a'
    );
  });

  it('reports relay connector health unavailable when the relay binding is missing', async () => {
    const context = createContext(
      'tenant-a',
      undefined,
      {
        'settings:tenant:tenant-a:directory-connectors': {
          connectors: [
            {
              ...validConfig.connectors[0],
              transport: 'relay',
              endpoint_url: '',
            },
          ],
        },
      },
      'campus'
    ) as never;

    const response = await checkDirectoryConnectorHealthHandler(context);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(503);
    expect(body.error).toBe('relay_status_unavailable');
  });

  it('returns non-JSON health responses without failing the health check request', async () => {
    mocks.safeFetch.mockResolvedValue(new Response('ok', { status: 200 }));
    mocks.readResponseTextWithLimit.mockResolvedValue('ok');
    const context = createContext(
      'tenant-a',
      undefined,
      {
        'settings:tenant:tenant-a:directory-connectors': {
          connectors: [
            {
              ...validConfig.connectors[0],
              endpoint_url: 'http://localhost:8080',
              attribute_names: ['mail'],
            },
          ],
        },
      },
      'campus'
    ) as never;

    const response = await checkDirectoryConnectorHealthHandler(context);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.body).toEqual({ raw: 'ok' });
    expect(mocks.safeFetch).toHaveBeenCalledWith(
      'http://localhost:8080/healthz',
      expect.objectContaining({
        allowLocalhost: true,
        requireHttps: false,
      })
    );
  });
});
