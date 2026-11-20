import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import type { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core/types/env';
import {
  DEFAULT_CLIENT,
  createAuthorizeApp,
  createMockEnv,
  redirectedError,
} from './helpers/mut-authorize-env';

const mockGetClient = vi.hoisted(() =>
  vi.fn<(env: unknown, clientId: string) => Promise<Record<string, unknown> | null>>()
);
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getClient: mockGetClient,
    getClientCached: vi.fn((_c: unknown, env: unknown, clientId: string) =>
      mockGetClient(env, clientId)
    ),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(
      async (env: { DB: unknown }, partition?: string) =>
        (
          actual as unknown as {
            ensureDatabaseAdapter: (db: unknown, partition?: string) => unknown;
          }
        ).ensureDatabaseAdapter(env.DB, partition)
    ),
  };
});

let app: Hono<{ Bindings: Env }>;
let env: Env;

function useClient(overrides: Record<string, unknown> = {}) {
  mockGetClient.mockResolvedValue({ ...DEFAULT_CLIENT, ...overrides });
}

beforeEach(() => {
  vi.clearAllMocks();
  useClient();
  app = createAuthorizeApp();
  env = createMockEnv();
});

async function call(query: string) {
  return app.request(`/authorize?${query}`, { method: 'GET' }, env);
}

describe('authorize: request object (JAR)', () => {
  let keys: { publicKey: CryptoKey; privateKey: CryptoKey };
  let publicJwk: JWK;
  const fetchMock = vi.fn();

  beforeAll(async () => {
    keys = await generateKeyPair('RS256', { extractable: true });
    publicJwk = { ...(await exportJWK(keys.publicKey)), kid: 'rp-1', alg: 'RS256', use: 'sig' };
  });
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    useClient({ jwks: { keys: [publicJwk] } });
  });
  afterEach(() => vi.unstubAllGlobals());

  async function signed(claims: Record<string, unknown>, alg = 'RS256') {
    return new SignJWT({
      client_id: 'test-client',
      redirect_uri: 'https://example.com/callback',
      response_type: 'code',
      scope: 'openid',
      ...claims,
    })
      .setProtectedHeader({ alg, kid: 'rp-1' })
      .setIssuer('test-client')
      .setAudience('https://test.example.com')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(keys.privateKey);
  }

  async function withRequest(request: string, outer = 'client_id=test-client') {
    return call(`${outer}&request=${encodeURIComponent(request)}`);
  }

  async function expectRefusal(
    response: Response,
    status: number,
    error: string,
    description: string
  ) {
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error, error_description: description });
  }

  it('refuses a request that is neither a JWT nor a JWE', async () => {
    await expectRefusal(
      await withRequest('not-a-token'),
      400,
      'invalid_request_object',
      'Request object must be a valid JWT or JWE'
    );
  });

  it('refuses a JWE it cannot decrypt', async () => {
    const response = await withRequest('a.b.c.d.e');
    await expectRefusal(
      response,
      400,
      'invalid_request_object',
      'Failed to decrypt request object'
    );
  });

  it('refuses an unsigned request object unless the tenant allows it, and always in production', async () => {
    const unsigned = `${btoa(JSON.stringify({ alg: 'none' })).replace(/=+$/, '')}.${btoa(
      JSON.stringify({ client_id: 'test-client', redirect_uri: 'https://example.com/callback' })
    ).replace(/=+$/, '')}.`;
    await expectRefusal(
      await withRequest(unsigned),
      400,
      'invalid_request_object',
      'Unsigned request objects (alg=none) are not allowed in this environment'
    );
    env.NODE_ENV = 'production';
    await expectRefusal(
      await withRequest(unsigned),
      400,
      'invalid_request_object',
      'Unsigned request objects (alg=none) are not permitted in production'
    );
  });

  it('refuses a signed request object without client_id', async () => {
    await expectRefusal(
      await withRequest(await signed({}), 'scope=openid'),
      400,
      'invalid_request',
      'client_id is required when using signed request objects'
    );
  });

  it('refuses a signed request object of an unknown client', async () => {
    mockGetClient.mockResolvedValue(null);
    await expectRefusal(
      await withRequest(await signed({})),
      401,
      'invalid_client',
      'Client authentication failed'
    );
  });

  it('verifies with a key fetched from jwks_uri', async () => {
    useClient({ jwks_uri: 'https://rp.example.org/jwks' });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const response = await withRequest(await signed({ scope: 'openid nope', state: 'ro-state' }));
    expect(fetchMock.mock.calls[0][0]).toBe('https://rp.example.org/jwks');
    const { params } = redirectedError(response);
    expect(params.get('error')).toBe('invalid_scope');
    expect(params.get('state')).toBe('ro-state');
  });

  it('refuses a jwks_uri without a signing key, and one that cannot be fetched', async () => {
    useClient({ jwks_uri: 'https://rp.example.org/jwks' });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ keys: [{ ...publicJwk, use: 'enc' }] }), { status: 200 })
    );
    await expectRefusal(
      await withRequest(await signed({})),
      400,
      'invalid_request_object',
      'No suitable signing key found in client jwks_uri'
    );
    fetchMock.mockRejectedValueOnce(new Error('down'));
    await expectRefusal(
      await withRequest(await signed({})),
      400,
      'invalid_request_object',
      'Failed to fetch client jwks_uri'
    );
  });

  it('requires the request object client_id to be the outer client_id', async () => {
    await expectRefusal(
      await withRequest(await signed({ client_id: 'other-client' })),
      400,
      'invalid_request_object',
      'client_id in the request object must match the authorization request'
    );
  });

  it('requires redirect_uri in the request object', async () => {
    await expectRefusal(
      await withRequest(await signed({ redirect_uri: undefined })),
      400,
      'invalid_request_object',
      'redirect_uri is required in request object'
    );
  });

  it('refuses a query redirect_uri that differs from the request object', async () => {
    await expectRefusal(
      await withRequest(
        await signed({}),
        `client_id=test-client&redirect_uri=${encodeURIComponent('http://localhost:3000/callback')}`
      ),
      400,
      'invalid_request',
      'redirect_uri mismatch between query parameter and request object'
    );
  });

  it('lets the request object parameters win over the query', async () => {
    const response = await withRequest(
      await signed({ state: 'ro-state', scope: 'openid ro-only', max_age: 0 }),
      'client_id=test-client&state=query-state&scope=openid&redirect_uri=' +
        encodeURIComponent('https://example.com/callback')
    );
    const { params } = redirectedError(response);
    expect(params.get('error')).toBe('invalid_scope');
    expect(params.get('error_description')).toContain('ro-only');
    expect(params.get('state')).toBe('ro-state');
  });

  it('serialises object authorization_details from the request object', async () => {
    const response = await withRequest(
      await signed({ scope: 'openid', authorization_details: [{ type: 'unknown_type' }] })
    );
    const { params } = redirectedError(response);
    // RAR is off: the parameter is present (taken from the request object) and refused.
    expect(params.get('error')).toBe('invalid_request');
    expect(params.get('error_description')).toContain(
      'authorization_details parameter is not supported'
    );
  });

  it('refuses a request object whose signature does not verify', async () => {
    const other = await generateKeyPair('RS256');
    const forged = await new SignJWT({
      client_id: 'test-client',
      redirect_uri: 'https://example.com/callback',
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('test-client')
      .setAudience('https://test.example.com')
      .sign(other.privateKey);
    await expectRefusal(
      await withRequest(forged),
      400,
      'invalid_request_object',
      'Failed to parse or verify request object'
    );
  });
});
