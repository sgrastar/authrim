import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkDirectoryConnectorHealthHandler,
  getDirectoryConnectorsHandler,
  issueDirectoryConnectorSecretHandler,
  listDirectoryConnectorFleetHandler,
  listDirectoryConnectorRelayEventsHandler,
  listDirectoryPendingUsersHandler,
  rotateDirectoryConnectorSecretHandler,
  updateDirectoryConnectorsHandler,
  updateDirectoryConnectorFleetInstanceHandler,
  updateDirectoryPendingUserHandler,
} from '../routes/directory-connectors';

const mocks = vi.hoisted(() => ({
  safeFetch: vi.fn(),
  readResponseTextWithLimit: vi.fn(),
  createAuditLogFromContext: vi.fn(),
  coreAdapter: {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    safeFetch: mocks.safeFetch,
    readResponseTextWithLimit: mocks.readResponseTextWithLimit,
    createAuditLogFromContext: mocks.createAuditLogFromContext,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.coreAdapter })),
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
  envOverrides: Record<string, unknown> = {},
  query: Record<string, string | undefined> = {},
  pendingId?: string,
  instanceId?: string
) {
  const settings = createKV(initialSettings);
  return {
    req: {
      param: vi.fn((name: string) => {
        if (name === 'tenantId') return tenantId;
        if (name === 'connectorId') return connectorId;
        if (name === 'pendingId') return pendingId;
        if (name === 'instanceId') return instanceId;
        return undefined;
      }),
      query: vi.fn((name: string) => query[name]),
      json: vi.fn(async () => body),
    },
    env: {
      SETTINGS: settings,
      ...envOverrides,
    },
    get: vi.fn((name: string) => {
      if (name !== 'adminAuth') return undefined;
      return {
        userId: 'admin-1',
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
      connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
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
    mocks.coreAdapter.query.mockReset();
    mocks.coreAdapter.queryOne.mockReset();
    mocks.coreAdapter.execute.mockReset();
    mocks.coreAdapter.transaction.mockReset();
    mocks.createAuditLogFromContext.mockResolvedValue(undefined);
    mocks.coreAdapter.query.mockResolvedValue([]);
    mocks.coreAdapter.queryOne.mockResolvedValue(null);
    mocks.coreAdapter.execute.mockResolvedValue({ rowsAffected: 1, success: true });
    mocks.coreAdapter.transaction.mockImplementation(async (fn) =>
      fn({
        execute: mocks.coreAdapter.execute,
        query: mocks.coreAdapter.query,
        queryOne: mocks.coreAdapter.queryOne,
      })
    );
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
        heartbeat: {
          key_id: string;
          secret_ref: string;
          previous_key_id: string;
          previous_secret_ref: string;
          interval_ms: number;
          stale_after_ms: number;
          retention_days: number;
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
    expect(body.connectors[0]?.heartbeat).toMatchObject({
      key_id: '',
      secret_ref: '',
      previous_key_id: '',
      previous_secret_ref: '',
      interval_ms: 300000,
      stale_after_ms: 900000,
      retention_days: 14,
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

  it('rejects duplicate immutable Wordwarden connector identifiers', async () => {
    const context = createContext('tenant-a', {
      ...validConfig,
      connectors: [
        validConfig.connectors[0],
        {
          ...validConfig.connectors[0],
          id: 'branch',
          endpoint_url: 'https://branch-wordwarden.example.com',
        },
      ],
    }) as never;

    const response = await updateDirectoryConnectorsHandler(context);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_directory_connector_config');
    expect(String(body.error_description)).toContain('wwcon_8K4M2Q9F7D3H6P1X');
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
    expect(relay.idFromName).toHaveBeenCalledWith('tenant-a:wwcon_8K4M2Q9F7D3H6P1X');
    expect(relayFetch).toHaveBeenCalledWith(
      'https://directory-relay.internal/status?tenant_id=tenant-a&connector_id=wwcon_8K4M2Q9F7D3H6P1X'
    );
  });

  it('lists relay connector events from the relay Durable Object', async () => {
    const relayFetch = vi.fn(async () =>
      Response.json({
        tenant_id: 'tenant-a',
        connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
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
        connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
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
      'https://directory-relay.internal/events?tenant_id=tenant-a&connector_id=wwcon_8K4M2Q9F7D3H6P1X'
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

  it('lists directory pending users with parsed directory facts', async () => {
    mocks.coreAdapter.query.mockResolvedValue([
      {
        id: 'pending-1',
        tenant_id: 'tenant-a',
        connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
        directory_subject: 'subject-1',
        login_identifier: 'alice@example.com',
        status: 'pending',
        directory_facts_json: JSON.stringify({
          identity: { subject: 'subject-1', canonical_username: 'alice@example.com' },
          attributes: { mail: { value: 'alice@example.com', source: 'directory' } },
          groups: [],
          evidence: { request_id: 'req-1' },
        }),
        created_at: 1000,
        updated_at: 2000,
        decided_at: null,
        decided_by: null,
        decision_reason: null,
        linked_user_id: null,
      },
    ]);
    const context = createContext(
      'tenant-a',
      undefined,
      {},
      undefined,
      {},
      { status: 'pending', limit: '10' }
    ) as never;

    const response = await listDirectoryPendingUsersHandler(context);
    const body = (await response.json()) as { items: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.directory_facts).toEqual(
      expect.objectContaining({
        identity: expect.objectContaining({ subject: 'subject-1' }),
      })
    );
    expect(mocks.coreAdapter.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM directory_jit_pending_users'),
      ['tenant-a', 'pending', 10]
    );
  });

  it('rejects invalid immutable connector ids when filtering pending users', async () => {
    const context = createContext(
      'tenant-a',
      undefined,
      {},
      undefined,
      {},
      { connector_id: 'campus' }
    ) as never;

    const response = await listDirectoryPendingUsersHandler(context);

    expect(response.status).toBe(400);
    expect(mocks.coreAdapter.query).not.toHaveBeenCalled();
  });

  it('rejects a pending directory user without exposing directory secrets', async () => {
    mocks.coreAdapter.queryOne.mockResolvedValueOnce({
      id: 'pending-1',
      tenant_id: 'tenant-a',
      connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
      directory_subject: 'subject-1',
      login_identifier: 'alice@example.com',
      status: 'pending',
      directory_facts_json: '{}',
      created_at: 1000,
      updated_at: 2000,
      decided_at: null,
      decided_by: null,
      decision_reason: null,
      linked_user_id: null,
    });
    mocks.coreAdapter.queryOne.mockResolvedValueOnce({ legacy_user_id: 'user-1' });
    mocks.coreAdapter.queryOne.mockResolvedValueOnce({ legacy_user_id: 'user-1' });
    mocks.coreAdapter.queryOne.mockResolvedValueOnce(null);
    const context = createContext(
      'tenant-a',
      { action: 'reject', reason: 'No matching SCIM user' },
      {},
      undefined,
      {},
      {},
      'pending-1'
    ) as never;

    const response = await updateDirectoryPendingUserHandler(context);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.status).toBe('rejected');
    expect(mocks.coreAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'rejected'"),
      expect.arrayContaining(['admin-1', 'No matching SCIM user', 'tenant-a', 'pending-1'])
    );
    expect(JSON.stringify(mocks.createAuditLogFromContext.mock.calls)).not.toContain(
      'alice@example.com'
    );
  });

  it('links a pending directory user to an existing Authrim user', async () => {
    mocks.coreAdapter.queryOne.mockResolvedValueOnce({
      id: 'pending-1',
      tenant_id: 'tenant-a',
      connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
      directory_subject: 'subject-1',
      login_identifier: 'alice@example.com',
      status: 'pending',
      directory_facts_json: '{"identity":{"subject":"subject-1"}}',
      created_at: 1000,
      updated_at: 2000,
      decided_at: null,
      decided_by: null,
      decision_reason: null,
      linked_user_id: null,
    });
    mocks.coreAdapter.queryOne.mockResolvedValueOnce({ legacy_user_id: 'user-1' });
    mocks.coreAdapter.queryOne.mockResolvedValueOnce(null);
    const context = createContext(
      'tenant-a',
      { action: 'link', user_id: 'user-1', reason: 'SCIM profile verified' },
      {},
      undefined,
      {},
      {},
      'pending-1'
    ) as never;

    const response = await updateDirectoryPendingUserHandler(context);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      id: 'pending-1',
      status: 'linked',
      linked_user_id: 'user-1',
    });
    expect(mocks.coreAdapter.transaction).toHaveBeenCalledOnce();
    expect(mocks.coreAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO directory_identity_links'),
      expect.arrayContaining(['tenant-a', 'wwcon_8K4M2Q9F7D3H6P1X', 'subject-1', 'user-1'])
    );
    expect(mocks.coreAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'linked'"),
      expect.arrayContaining(['user-1', 'admin-1', 'SCIM profile verified'])
    );
  });

  it('does not overwrite an existing directory subject link', async () => {
    mocks.coreAdapter.queryOne.mockResolvedValueOnce({
      id: 'pending-1',
      tenant_id: 'tenant-a',
      connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
      directory_subject: 'subject-1',
      login_identifier: 'alice@example.com',
      status: 'pending',
      directory_facts_json: '{}',
      created_at: 1000,
      updated_at: 2000,
      decided_at: null,
      decided_by: null,
      decision_reason: null,
      linked_user_id: null,
    });
    mocks.coreAdapter.queryOne.mockResolvedValueOnce({ legacy_user_id: 'user-1' });
    mocks.coreAdapter.queryOne.mockResolvedValueOnce({ user_id: 'user-other' });
    const context = createContext(
      'tenant-a',
      { action: 'link', user_id: 'user-1' },
      {},
      undefined,
      {},
      {},
      'pending-1'
    ) as never;

    const response = await updateDirectoryPendingUserHandler(context);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(body.error).toBe('directory_identity_link_conflict');
    expect(mocks.coreAdapter.transaction).not.toHaveBeenCalled();
  });

  it('rolls back pending linking when pending state changes during the transaction', async () => {
    mocks.coreAdapter.queryOne.mockResolvedValueOnce({
      id: 'pending-1',
      tenant_id: 'tenant-a',
      connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
      directory_subject: 'subject-1',
      login_identifier: 'alice@example.com',
      status: 'pending',
      directory_facts_json: '{}',
      created_at: 1000,
      updated_at: 2000,
      decided_at: null,
      decided_by: null,
      decision_reason: null,
      linked_user_id: null,
    });
    mocks.coreAdapter.queryOne.mockResolvedValueOnce({ legacy_user_id: 'user-1' });
    mocks.coreAdapter.queryOne.mockResolvedValueOnce(null);
    mocks.coreAdapter.execute
      .mockResolvedValueOnce({ rowsAffected: 1, success: true })
      .mockResolvedValueOnce({ rowsAffected: 0, success: true });
    const context = createContext(
      'tenant-a',
      { action: 'link', user_id: 'user-1' },
      {},
      undefined,
      {},
      {},
      'pending-1'
    ) as never;

    const response = await updateDirectoryPendingUserHandler(context);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(body.error).toBe('directory_pending_user_not_pending');
    expect(mocks.coreAdapter.transaction).toHaveBeenCalledOnce();
    expect(mocks.createAuditLogFromContext).not.toHaveBeenCalledWith(
      expect.anything(),
      'directory_jit_pending_user.linked',
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });

  it('lists connector fleet instances and status episodes', async () => {
    mocks.coreAdapter.query.mockResolvedValueOnce([
      {
        id: 'dcinst_1',
        tenant_id: 'tenant-a',
        connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
        instance_id: 'wwi_1234567890123456789012',
        display_name: 'campus-a',
        transport: 'relay',
        version: '0.13.0',
        started_at: '2026-06-24T00:00:00.000Z',
        first_seen_at: 1000,
        last_seen_at: 2000,
        status: 'connected',
        health_status: 'healthy',
        health_summary_json: '{"ldap":"ok"}',
        config_fingerprint: 'sha256:abc',
        config_categories_json: '["ldap"]',
        drift_severity: 'none',
        deactivated_at: null,
        deactivated_by: null,
        deactivation_reason: null,
        updated_at: 2000,
      },
    ]);
    mocks.coreAdapter.query.mockResolvedValueOnce([
      {
        id: 'dcepi_1',
        tenant_id: 'tenant-a',
        connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
        instance_id: 'wwi_1234567890123456789012',
        status: 'connected',
        started_at: 1000,
        ended_at: null,
        last_seen_at: 2000,
        reason: null,
        acknowledged_at: null,
        acknowledged_by: null,
        created_at: 1000,
        updated_at: 2000,
      },
    ]);
    const context = createContext(
      'tenant-a',
      undefined,
      {},
      undefined,
      {},
      { connector_id: 'wwcon_8K4M2Q9F7D3H6P1X', limit: '10' }
    ) as never;

    const response = await listDirectoryConnectorFleetHandler(context);
    const body = (await response.json()) as {
      items: Array<Record<string, unknown>>;
      episodes: Array<Record<string, unknown>>;
    };

    expect(response.status).toBe(200);
    expect(body.items[0]).toMatchObject({
      instance_id: 'wwi_1234567890123456789012',
      health_summary: { ldap: 'ok' },
      config_categories: ['ldap'],
    });
    expect(body.episodes[0]).toMatchObject({
      id: 'dcepi_1',
      status: 'connected',
    });
  });

  it('applies fleet episode retention per connector when listing all connectors', async () => {
    mocks.coreAdapter.query.mockResolvedValueOnce([]);
    mocks.coreAdapter.query
      .mockResolvedValueOnce([
        {
          id: 'dcepi_older',
          tenant_id: 'tenant-a',
          connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
          instance_id: 'wwi_1234567890123456789012',
          status: 'connected',
          started_at: 1000,
          ended_at: null,
          last_seen_at: 1000,
          reason: null,
          acknowledged_at: null,
          acknowledged_by: null,
          created_at: 1000,
          updated_at: 1000,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'dcepi_newer',
          tenant_id: 'tenant-a',
          connector_id: 'wwcon_4R7T9K2M6Q1F3D8H',
          instance_id: 'wwi_abcdefghijklmno1234567',
          status: 'unhealthy',
          started_at: 3000,
          ended_at: null,
          last_seen_at: 3000,
          reason: 'unhealthy',
          acknowledged_at: null,
          acknowledged_by: null,
          created_at: 3000,
          updated_at: 3000,
        },
      ]);
    const config = {
      ...validConfig,
      connectors: [
        {
          ...validConfig.connectors[0],
          heartbeat: {
            retention_days: 7,
          },
        },
        {
          ...validConfig.connectors[0],
          id: 'campus-b',
          endpoint_url: 'https://wordwarden-b.example.com',
          connector_id: 'wwcon_4R7T9K2M6Q1F3D8H',
          heartbeat: {
            retention_days: 30,
          },
        },
      ],
    };
    const context = createContext(
      'tenant-a',
      undefined,
      { 'settings:tenant:tenant-a:directory-connectors': config },
      undefined,
      {},
      {
        limit: '10',
      }
    ) as never;

    const response = await listDirectoryConnectorFleetHandler(context);
    const body = (await response.json()) as {
      episodes: Array<Record<string, unknown>>;
    };

    expect(response.status).toBe(200);
    expect(body.episodes.map((episode) => episode.id)).toEqual(['dcepi_newer', 'dcepi_older']);
    expect(mocks.coreAdapter.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('FROM directory_connector_status_episodes'),
      ['tenant-a', 'wwcon_8K4M2Q9F7D3H6P1X', expect.any(Number), 10]
    );
    expect(mocks.coreAdapter.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('FROM directory_connector_status_episodes'),
      ['tenant-a', 'wwcon_4R7T9K2M6Q1F3D8H', expect.any(Number), 10]
    );
  });

  it('updates connector fleet instance state without exposing reason in audit metadata', async () => {
    const context = createContext(
      'tenant-a',
      {
        action: 'deactivate',
        connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
        reason: 'suspected host compromise',
      },
      {},
      undefined,
      {},
      {},
      undefined,
      'wwi_1234567890123456789012'
    ) as never;

    const response = await updateDirectoryConnectorFleetInstanceHandler(context);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      instance_id: 'wwi_1234567890123456789012',
      connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
      action: 'deactivate',
    });
    expect(mocks.coreAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE directory_connector_instances'),
      expect.arrayContaining(['deactivated', 'admin-1', 'suspected host compromise'])
    );
    expect(JSON.stringify(mocks.createAuditLogFromContext.mock.calls)).not.toContain(
      'suspected host compromise'
    );
  });

  it('rejects fleet actions with mutable connector ids', async () => {
    const context = createContext(
      'tenant-a',
      { action: 'acknowledge', connector_id: 'campus' },
      {},
      undefined,
      {},
      {},
      undefined,
      'wwi_1234567890123456789012'
    ) as never;

    const response = await updateDirectoryConnectorFleetInstanceHandler(context);

    expect(response.status).toBe(400);
    expect(mocks.coreAdapter.execute).not.toHaveBeenCalled();
  });
});
