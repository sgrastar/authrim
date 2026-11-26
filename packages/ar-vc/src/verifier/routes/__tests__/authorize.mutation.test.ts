/**
 * VP authorize route: validation order and codes, the stored request, and the answer.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../types';

const h = vi.hoisted(() => {
  const logger = { module: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  logger.module.mockReturnValue(logger);
  return {
    logger,
    findByClientId: vi.fn(),
    newStore: vi.fn(),
    nonce: vi.fn(),
    sha: vi.fn(),
    adapterArgs: vi.fn(),
    repoArgs: vi.fn(),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getLogger: () => h.logger,
    getTenantIdFromContext: () => 'tenant-1',
    createErrorResponse: (
      c: { json: (b: unknown, s: number) => Response },
      code: string,
      options?: unknown
    ) => c.json({ code, options: options ?? null }, 400),
    resolveAuthCorePersistenceAdapterFromEnv: async (...args: unknown[]) => {
      h.adapterArgs(...args);
      return { adapter: true };
    },
    ClientRepository: class {
      constructor(...args: unknown[]) {
        h.repoArgs(...args);
      }
      findByClientId = h.findByClientId;
    },
  };
});
vi.mock('../../../utils/vp-request-sharding', () => ({
  getVPRequestStoreForNewRequest: h.newStore,
}));
vi.mock('../../../utils/crypto', () => ({ generateSecureNonce: h.nonce, sha256Base64url: h.sha }));
vi.mock('../../../request-identifiers', () => ({
  getRequestIssuerUrl: () => 'https://verifier.example.com',
}));

import { AR_ERROR_CODES } from '@authrim/ar-lib-core';
import { vpAuthorizeRoute } from '../authorize';

const NOW_MS = 1_800_000_000_000;
let stub: { fetch: ReturnType<typeof vi.fn<(request: Request) => Promise<unknown>>> };
let env: Record<string, unknown>;

const definition = { id: 'pd' };
const valid = { client_id: 'client-1', presentation_definition: definition };
const failure = (code: string, options: unknown = null) => ({
  status: 400,
  body: { code, options },
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  vi.resetAllMocks();
  h.logger.module.mockReturnValue(h.logger);
  env = {};
  stub = { fetch: vi.fn<(request: Request) => Promise<unknown>>() };
  stub.fetch.mockResolvedValue(new Response('{}'));
  h.findByClientId.mockResolvedValue({ enabled: true });
  h.newStore.mockResolvedValue({ stub, requestId: 'g1:apac:1:vp_1' });
  h.nonce.mockImplementation(async (length?: number) =>
    length === 32 ? 'status-token' : 'nonce-1'
  );
  h.sha.mockResolvedValue('status-hash');
});
afterEach(() => {
  vi.useRealTimers();
});

async function post(body: unknown, raw?: string) {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/authorize', vpAuthorizeRoute);
  const response = await app.request(
    'https://verifier.example.com/authorize',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw ?? JSON.stringify(body),
    },
    env as unknown as Env
  );
  return { status: response.status, body: await response.json(), headers: response.headers };
}

describe('vpAuthorizeRoute: validation', () => {
  it('names its logger module', async () => {
    await post(valid);
    expect(h.logger.module).toHaveBeenCalledWith('VC-VERIFIER');
  });

  it('refuses another tenant, a missing client and an unsupported scheme', async () => {
    expect(await post({ ...valid, tenant_id: 'other' })).toMatchObject(
      failure(AR_ERROR_CODES.VALIDATION_INVALID_VALUE)
    );
    expect((await post({ ...valid, tenant_id: 'tenant-1' })).status).toBe(200);
    for (const client_id of [undefined, '']) {
      expect(await post({ ...valid, client_id })).toMatchObject(
        failure(AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, { variables: { field: 'client_id' } })
      );
    }
    for (const client_id_scheme of ['x509_san_dns', 'redirect_uri', 'did']) {
      expect(await post({ ...valid, client_id_scheme })).toMatchObject(
        failure(AR_ERROR_CODES.VALIDATION_INVALID_VALUE)
      );
    }
    expect(h.findByClientId).toHaveBeenCalledTimes(1);
  });

  it('checks the client registration of the tenant for the pre-registered scheme only', async () => {
    await post(valid);
    expect(h.adapterArgs).toHaveBeenCalledWith(env, 'vc-vp-authorize', { tenantId: 'tenant-1' });
    expect(h.repoArgs).toHaveBeenCalledWith({ adapter: true }, 'tenant-1');
    expect(h.findByClientId).toHaveBeenCalledWith('client-1');
    h.findByClientId.mockClear();
    await post({ ...valid, client_id_scheme: 'pre-registered' });
    expect(h.findByClientId).toHaveBeenCalledWith('client-1');
    for (const client of [null, { enabled: false }]) {
      h.findByClientId.mockResolvedValue(client);
      expect(await post(valid)).toMatchObject(failure(AR_ERROR_CODES.CLIENT_INVALID));
    }
    h.findByClientId.mockResolvedValue({});
    expect((await post(valid)).status).toBe(200);
  });

  it('requires a presentation definition or a DCQL query and refuses caller chosen response targets', async () => {
    expect(await post({ client_id: 'client-1' })).toMatchObject(
      failure(AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'presentation_definition' },
      })
    );
    stub.fetch.mockClear();
    for (const extra of [{ response_uri: 'https://evil.example' }, { state: 's' }]) {
      expect(await post({ ...valid, ...extra })).toMatchObject(
        failure(AR_ERROR_CODES.VALIDATION_INVALID_VALUE)
      );
    }
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it('answers an internal error for a body that is not JSON', async () => {
    expect(await post(undefined, 'not json')).toMatchObject(failure(AR_ERROR_CODES.INTERNAL_ERROR));
    expect(h.logger.error).toHaveBeenCalledWith('VP authorization failed', {}, expect.any(Error));
  });
});

describe('vpAuthorizeRoute: the request', () => {
  it('stores the request with a hashed status capability and the response endpoint', async () => {
    await post({ ...valid, dcql_query: { credentials: [] } });
    expect(h.sha).toHaveBeenCalledWith('status-token');
    expect(h.newStore).toHaveBeenCalledWith(env, 'tenant-1', 'client-1', expect.any(String));
    const request = stub.fetch.mock.calls[0][0] as Request;
    expect(new URL(request.url).pathname).toBe('/create');
    expect(request.method).toBe('POST');
    expect(request.headers.get('Content-Type')).toBe('application/json');
    expect(await request.json()).toEqual({
      id: 'g1:apac:1:vp_1',
      tenantId: 'tenant-1',
      clientId: 'client-1',
      nonce: 'nonce-1',
      state: 'g1:apac:1:vp_1',
      statusTokenHash: 'status-hash',
      presentationDefinition: definition,
      dcqlQuery: { credentials: [] },
      responseUri: 'https://verifier.example.com/vp/response',
      responseMode: 'direct_post',
      status: 'pending',
      createdAt: NOW_MS,
      expiresAt: NOW_MS + 300_000,
    });
  });

  it('reads the expiry setting, and falls back to five minutes', async () => {
    env.VP_REQUEST_EXPIRY_SECONDS = '120';
    expect((await post(valid)).body).toMatchObject({ expires_in: 120 });
    expect(
      ((await (stub.fetch.mock.calls[0][0] as Request).json()) as { expiresAt: number }).expiresAt
    ).toBe(NOW_MS + 120_000);
    env.VP_REQUEST_EXPIRY_SECONDS = '';
    expect((await post(valid)).body).toMatchObject({ expires_in: 300 });
  });

  it('answers with the wallet request and the capability, uncached', async () => {
    const result = await post(valid);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      request_id: 'g1:apac:1:vp_1',
      status_token: 'status-token',
      request_uri: 'https://verifier.example.com/vp/request/g1:apac:1:vp_1',
      nonce: 'nonce-1',
      expires_in: 300,
      authorization_request: {
        response_type: 'vp_token',
        client_id: 'client-1',
        client_id_scheme: 'pre-registered',
        response_mode: 'direct_post',
        response_uri: 'https://verifier.example.com/vp/response',
        nonce: 'nonce-1',
        state: 'g1:apac:1:vp_1',
        presentation_definition: definition,
      },
    });
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(result.headers.get('Pragma')).toBe('no-cache');
    expect((await post({ ...valid, client_id_scheme: 'pre-registered' })).body).toMatchObject({
      authorization_request: { client_id_scheme: 'pre-registered' },
    });
  });

  it('answers an internal error when the request cannot be stored', async () => {
    stub.fetch.mockResolvedValue(new Response('{}', { status: 500 }));
    expect(await post(valid)).toMatchObject(failure(AR_ERROR_CODES.INTERNAL_ERROR));
    expect(h.logger.error).toHaveBeenCalledWith(
      'VP authorization failed',
      {},
      expect.objectContaining({ message: 'vp_request_create_failed' })
    );
  });
});
