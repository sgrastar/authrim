import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';

const mocked = vi.hoisted(() => ({
  getClientCached: vi.fn(),
  timingSafeEqual: vi.fn(),
  arrayBufferToBase64Url: vi.fn(),
  createAuthContextFromHono: vi.fn(),
  getRequestCache: vi.fn(),
  createErrorResponse: vi.fn(),
  getLogger: vi.fn(),
  createAuditLog: vi.fn(),
  publishEvent: vi.fn(),
  buildKVKey: vi.fn(),
  getTenantIdFromContext: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    getClientCached: mocked.getClientCached,
    timingSafeEqual: mocked.timingSafeEqual,
    arrayBufferToBase64Url: mocked.arrayBufferToBase64Url,
    createAuthContextFromHono: mocked.createAuthContextFromHono,
    getRequestCache: mocked.getRequestCache,
    createErrorResponse: mocked.createErrorResponse,
    getLogger: mocked.getLogger,
    createAuditLog: mocked.createAuditLog,
    publishEvent: mocked.publishEvent,
    buildKVKey: mocked.buildKVKey,
    getTenantIdFromContext: mocked.getTenantIdFromContext,
  };
});

vi.mock('../request-issuer', () => ({
  getRequestAwareIssuerUrl: vi.fn().mockReturnValue('https://issuer.example.com'),
}));

import { clientConfigUpdateHandler } from '../client-config';

function createMockAdapter(): DatabaseAdapter {
  return {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue({ success: true, rowsAffected: 1, insertId: undefined }),
    transaction: vi.fn().mockImplementation(async (fn) => fn({} as DatabaseAdapter)),
    batch: vi.fn().mockResolvedValue([]),
    isHealthy: vi.fn().mockResolvedValue(true),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockContext(options: {
  clientId?: string;
  body?: Record<string, unknown>;
  env?: Partial<Env>;
}) {
  const store = new Map<string, unknown>();

  return {
    req: {
      param: vi.fn((name: string) =>
        name === 'client_id' ? (options.clientId ?? 'client-123') : undefined
      ),
      header: vi.fn((name: string) => {
        if (name.toLowerCase() === 'authorization') {
          return 'Bearer reg-token';
        }
        if (name.toLowerCase() === 'user-agent') {
          return 'vitest';
        }
        return undefined;
      }),
      json: vi.fn().mockResolvedValue(options.body ?? {}),
    },
    env: {
      DB: {},
      CLIENTS_CACHE: {
        delete: vi.fn().mockResolvedValue(undefined),
      },
      ...options.env,
    } as Env,
    get: vi.fn((key: string) => store.get(key)),
    set: vi.fn((key: string, value: unknown) => store.set(key, value)),
    json: vi.fn(
      (body, status = 200, headers) => new Response(JSON.stringify(body), { status, headers })
    ),
    body: vi.fn((body, status = 200) => new Response(body, { status })),
  } as any;
}

describe('client-config update handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.arrayBufferToBase64Url.mockReturnValue('token-hash');
    mocked.timingSafeEqual.mockReturnValue(true);
    mocked.getTenantIdFromContext.mockReturnValue('default');
    mocked.buildKVKey.mockReturnValue('client:client-123');
    mocked.getRequestCache.mockReturnValue({
      clients: new Map([['client-123', { client_id: 'client-123' }]]),
    });
    mocked.createErrorResponse.mockImplementation(
      (_c: unknown, code: { error: string; error_description: string }) =>
        new Response(JSON.stringify(code), { status: 500 })
    );
    mocked.getLogger.mockReturnValue({
      module: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    });
    mocked.createAuditLog.mockResolvedValue(undefined);
    mocked.publishEvent.mockResolvedValue(undefined);
  });

  it('normalizes undefined optional fields to null and clears request cache before re-read', async () => {
    const adapter = createMockAdapter();
    mocked.createAuthContextFromHono.mockReturnValue({ coreAdapter: adapter });

    mocked.getClientCached
      .mockResolvedValueOnce({
        client_id: 'client-123',
        client_name: 'Smoke Client',
        redirect_uris: ['https://example.com/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        registration_access_token_hash: 'token-hash',
      })
      .mockResolvedValueOnce({
        client_id: 'client-123',
        client_name: 'Smoke Client',
        redirect_uris: ['https://example.com/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        registration_access_token_hash: 'token-hash',
      })
      .mockResolvedValueOnce({
        client_id: 'client-123',
        client_name: 'Smoke Client Updated',
        redirect_uris: ['https://example.com/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        registration_access_token_hash: 'token-hash',
      });

    const c = createMockContext({
      body: {
        client_id: 'client-123',
        client_name: 'Smoke Client Updated',
        redirect_uris: ['https://example.com/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'openid',
      },
    });

    const res = await clientConfigUpdateHandler(c);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { client_name: string };
    expect(body.client_name).toBe('Smoke Client Updated');

    expect(adapter.execute).toHaveBeenCalledTimes(1);
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('WHERE tenant_id = ? AND client_id = ?'),
      expect.any(Array)
    );
    const executeParams = (adapter.execute as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as unknown[];
    expect(executeParams).toBeDefined();
    expect(executeParams.some((value) => value === undefined)).toBe(false);
    expect(executeParams.slice(-2)).toEqual(['default', 'client-123']);

    const requestCache = mocked.getRequestCache.mock.results[0]?.value as {
      clients: Map<string, unknown>;
    };
    expect(requestCache.clients.has('client-123')).toBe(false);
    expect(mocked.getClientCached).toHaveBeenCalledTimes(3);
  });

  it('rejects backchannel logout URIs that target internal addresses', async () => {
    mocked.getClientCached.mockResolvedValueOnce({
      client_id: 'client-123',
      client_name: 'Smoke Client',
      redirect_uris: ['https://example.com/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      registration_access_token_hash: 'token-hash',
    });

    const c = createMockContext({
      body: {
        client_id: 'client-123',
        redirect_uris: ['https://example.com/callback'],
        backchannel_logout_uri: 'https://169.254.169.254/latest/meta-data',
      },
    });

    const res = await clientConfigUpdateHandler(c);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe('invalid_client_metadata');
    expect(body.error_description).toContain('internal addresses');
  });

  it('rejects unsupported grant types before persistence', async () => {
    mocked.getClientCached.mockResolvedValueOnce({
      client_id: 'client-123',
      client_name: 'Smoke Client',
      redirect_uris: ['https://example.com/callback'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      registration_access_token_hash: 'token-hash',
    });

    const c = createMockContext({
      body: {
        client_id: 'client-123',
        redirect_uris: ['https://example.com/callback'],
        grant_types: ['authorization_code', 'password'],
      },
    });

    const res = await clientConfigUpdateHandler(c);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe('invalid_client_metadata');
    expect(body.error_description).toBe('Unsupported grant_type: password');
  });

  it('rejects non-HTTPS non-loopback redirect URIs before persistence', async () => {
    mocked.getClientCached.mockResolvedValueOnce({
      client_id: 'client-123',
      client_name: 'Smoke Client',
      redirect_uris: ['https://example.com/callback'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      registration_access_token_hash: 'token-hash',
    });

    const c = createMockContext({
      body: {
        client_id: 'client-123',
        redirect_uris: ['http://example.com/callback'],
      },
    });

    const res = await clientConfigUpdateHandler(c);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe('invalid_client_metadata');
    expect(body.error_description).toBe(
      'redirect_uri must use HTTPS except for loopback development callbacks'
    );
  });

  it('rejects jwks_uri values that target internal addresses', async () => {
    mocked.getClientCached.mockResolvedValueOnce({
      client_id: 'client-123',
      client_name: 'Smoke Client',
      redirect_uris: ['https://example.com/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      registration_access_token_hash: 'token-hash',
    });

    const c = createMockContext({
      body: {
        client_id: 'client-123',
        redirect_uris: ['https://example.com/callback'],
        jwks_uri: 'https://169.254.169.254/latest/meta-data',
      },
    });

    const res = await clientConfigUpdateHandler(c);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe('invalid_client_metadata');
    expect(body.error_description).toContain('internal addresses');
  });

  it('rejects unsupported JARM signing metadata before persistence', async () => {
    mocked.getClientCached.mockResolvedValueOnce({
      client_id: 'client-123',
      token_endpoint_auth_method: 'private_key_jwt',
      registration_access_token_hash: 'token-hash',
    });
    const c = createMockContext({
      body: {
        client_id: 'client-123',
        redirect_uris: ['https://example.com/callback'],
        authorization_signed_response_alg: 'HS256',
      },
    });

    const res = await clientConfigUpdateHandler(c);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: 'invalid_client_metadata',
      error_description: expect.stringContaining('authorization_signed_response_alg'),
    });
    expect(mocked.createAuthContextFromHono).not.toHaveBeenCalled();
  });

  it('rejects JARM signing metadata excluded by the active Message Signing profile', async () => {
    mocked.getClientCached.mockResolvedValueOnce({
      client_id: 'client-123',
      registration_access_token_hash: 'token-hash',
    });
    const c = createMockContext({
      body: {
        client_id: 'client-123',
        redirect_uris: ['https://example.com/callback'],
        authorization_signed_response_alg: 'RS256',
      },
      env: {
        SETTINGS: {
          get: vi.fn().mockImplementation(async (key: string) =>
            key.includes('certification-profile')
              ? JSON.stringify({
                  fapi: {
                    enabled: true,
                    messageSigning: {
                      enabled: true,
                      authorizationSigningAlgorithms: ['ES256'],
                    },
                  },
                })
              : null
          ),
        } as unknown as KVNamespace,
      },
    });

    const res = await clientConfigUpdateHandler(c);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: 'invalid_client_metadata',
      error_description: expect.stringContaining('authorization_signed_response_alg'),
    });
    expect(mocked.createAuthContextFromHono).not.toHaveBeenCalled();
  });

  it('rejects unsupported client assertion signing metadata before persistence', async () => {
    mocked.getClientCached.mockResolvedValueOnce({
      client_id: 'client-123',
      registration_access_token_hash: 'token-hash',
    });
    const c = createMockContext({
      body: {
        client_id: 'client-123',
        redirect_uris: ['https://example.com/callback'],
        token_endpoint_auth_signing_alg: 'HS256',
      },
    });

    const res = await clientConfigUpdateHandler(c);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: 'invalid_client_metadata',
      error_description: expect.stringContaining('token_endpoint_auth_signing_alg'),
    });
    expect(mocked.createAuthContextFromHono).not.toHaveBeenCalled();
  });

  it('rejects changing a FAPI client to secret-based token authentication', async () => {
    mocked.getClientCached.mockResolvedValue({
      client_id: 'client-123',
      token_endpoint_auth_method: 'private_key_jwt',
      registration_access_token_hash: 'token-hash',
    });
    const c = createMockContext({
      body: {
        client_id: 'client-123',
        redirect_uris: ['https://example.com/callback'],
        token_endpoint_auth_method: 'client_secret_basic',
      },
      env: {
        SETTINGS: {
          get: vi
            .fn()
            .mockImplementation(async (key: string) =>
              key.includes('certification-profile')
                ? JSON.stringify({ fapi: { enabled: true } })
                : null
            ),
        } as unknown as KVNamespace,
      },
    });

    const res = await clientConfigUpdateHandler(c);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: 'invalid_client_metadata',
      error_description: expect.stringContaining('private_key_jwt'),
    });
    expect(mocked.createAuthContextFromHono).not.toHaveBeenCalled();
  });

  it.each(['RS256', 'ES256', 'PS256', 'EdDSA'])(
    'accepts %s as client assertion signing metadata on update',
    async (algorithm) => {
      const adapter = createMockAdapter();
      mocked.createAuthContextFromHono.mockReturnValue({ coreAdapter: adapter });
      const storedClient = {
        client_id: 'client-123',
        redirect_uris: ['https://example.com/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        registration_access_token_hash: 'token-hash',
      };
      mocked.getClientCached
        .mockResolvedValueOnce(storedClient)
        .mockResolvedValueOnce(storedClient)
        .mockResolvedValueOnce({
          ...storedClient,
          token_endpoint_auth_signing_alg: algorithm,
        });

      const c = createMockContext({
        body: {
          client_id: 'client-123',
          redirect_uris: ['https://example.com/callback'],
          grant_types: ['authorization_code'],
          response_types: ['code'],
          token_endpoint_auth_method: 'private_key_jwt',
          token_endpoint_auth_signing_alg: algorithm,
        },
      });

      const res = await clientConfigUpdateHandler(c);

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        token_endpoint_auth_signing_alg: algorithm,
      });
      expect(adapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('token_endpoint_auth_signing_alg = ?'),
        expect.arrayContaining([algorithm])
      );
    }
  );

  it('rejects ambiguous client key sources before persistence', async () => {
    mocked.getClientCached.mockResolvedValueOnce({
      client_id: 'client-123',
      registration_access_token_hash: 'token-hash',
    });
    const c = createMockContext({
      body: {
        client_id: 'client-123',
        redirect_uris: ['https://example.com/callback'],
        jwks: { keys: [] },
        jwks_uri: 'https://client.example.com/jwks.json',
      },
    });

    const res = await clientConfigUpdateHandler(c);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: 'invalid_client_metadata',
      error_description: 'jwks and jwks_uri must not both be provided',
    });
    expect(mocked.createAuthContextFromHono).not.toHaveBeenCalled();
  });
});
