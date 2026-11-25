/**
 * OIDCRPClient: discovery, dynamic registration, authorization URL and token request.
 */
import * as jose from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { argRec, callArg, rec } from './helpers/mock-args';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn<(url: string, options?: RequestInit) => Promise<Response>>(),
  jwtVerify: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  warn: vi.fn(),
  limits: [] as number[],
}));

vi.mock('@authrim/ar-lib-core', () => ({
  createLogger: () => ({
    module: () => ({ info: vi.fn(), warn: mocks.warn, error: vi.fn(), debug: vi.fn() }),
  }),
  validateWebhookUrl: (value: string) => {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:') return { valid: false, error: 'HTTPS required' };
      if (['127.0.0.1', '169.254.169.254', 'localhost'].includes(url.hostname)) {
        return { valid: false, error: 'blocked' };
      }
      return { valid: true, parsedUrl: url };
    } catch {
      return { valid: false, error: 'invalid' };
    }
  },
  safeFetch: (url: string, options?: RequestInit) => mocks.fetch(url, options),
  safeFetchJson: async (url: string, options?: RequestInit) => {
    const response = await mocks.fetch(url, options);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  },
  readResponseTextWithLimit: async (response: Response, limit: number) => {
    mocks.limits.push(limit);
    return response.text();
  },
}));
vi.mock('jose', async (importOriginal) => ({
  ...(await importOriginal<typeof import('jose')>()),
  jwtVerify: (...args: unknown[]) => mocks.jwtVerify(...args),
  createLocalJWKSet: () => () => undefined,
}));

import { OIDCRPClient, type OIDCRPClientConfig } from '../clients/oidc-client';
import type { UpstreamProvider } from '../types';

const NOW_S = 1_800_000_000;
const ISSUER = 'https://op.example';
const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
  response_types_supported: ['code'],
};

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

function config(overrides: Partial<OIDCRPClientConfig> = {}): OIDCRPClientConfig {
  return {
    issuer: ISSUER,
    clientId: 'client-1',
    clientSecret: 'secret-1',
    redirectUri: 'https://rp.example/callback',
    scopes: ['openid', 'email'],
    ...overrides,
  };
}
const client = (overrides: Partial<OIDCRPClientConfig> = {}) => new OIDCRPClient(config(overrides));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.limits.length = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_S * 1000);
  mocks.fetch.mockImplementation(async () => json(DISCOVERY));
});
afterEach(() => vi.useRealTimers());

const fetchedUrls = () => mocks.fetch.mock.calls.map((call) => String(call[0]));

describe('discover', () => {
  it('fetches the well-known document with a bounded request, once', async () => {
    mocks.fetch.mockImplementation(async () => json({ ...DISCOVERY, issuer: `${ISSUER}/` }));
    const c = client({ issuer: `${ISSUER}/` });
    const first = await c.discover();
    const second = await c.discover();
    expect(first).toBe(second);
    expect(fetchedUrls()).toEqual([`${ISSUER}/.well-known/openid-configuration`]);
    expect(argRec(mocks.fetch, 0, 1)).toEqual({ timeoutMs: 10000, maxResponseSize: 64 * 1024 });
  });

  it('uses an explicit discovery URL', async () => {
    await client({ discoveryUrl: 'https://other.example/.well-known/x' }).discover();
    expect(fetchedUrls()).toEqual(['https://other.example/.well-known/x']);
  });

  it('refuses an unsafe issuer without fetching', async () => {
    await expect(client({ issuer: 'http://op.example' }).discover()).rejects.toThrow(
      'issuer is not safe to fetch'
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('refuses an HTTP error', async () => {
    mocks.fetch.mockResolvedValue(new Response('', { status: 503 }));
    await expect(client().discover()).rejects.toThrow(
      'Failed to fetch OIDC discovery document: 503'
    );
  });

  it.each([
    [
      { issuer: 'https://evil.example' },
      'Discovery document issuer mismatch: expected https://op.example, got https://evil.example',
    ],
    [
      { authorization_endpoint: undefined },
      'Discovery document missing required authorization_endpoint',
    ],
    [{ token_endpoint: undefined }, 'Discovery document missing required token_endpoint'],
    [{ jwks_uri: undefined }, 'Discovery document missing required jwks_uri'],
    [
      { response_types_supported: undefined },
      'Discovery document missing required response_types_supported',
    ],
    [
      { response_types_supported: [] },
      'Discovery document missing required response_types_supported',
    ],
  ])('validates the document: %j', async (change, message) => {
    mocks.fetch.mockResolvedValue(json({ ...DISCOVERY, ...change }));
    await expect(client().discover()).rejects.toThrow(message);
  });

  it('does not require jwks_uri from an OAuth 2.0 provider', async () => {
    mocks.fetch.mockResolvedValue(json({ ...DISCOVERY, jwks_uri: undefined }));
    expect(await client({ discoveryDocumentType: 'oauth2' }).discover()).toMatchObject({
      issuer: ISSUER,
    });
  });
});

describe('fromProvider', () => {
  const provider = (overrides: Partial<UpstreamProvider> = {}): UpstreamProvider =>
    ({
      id: 'p1',
      name: 'Corp',
      providerType: 'oidc',
      issuer: ISSUER,
      clientId: 'client-1',
      scopes: 'openid, email  profile',
      providerQuirks: {},
      ...overrides,
    }) as UpstreamProvider;

  it('maps the provider and splits scopes on spaces and commas', async () => {
    const c = OIDCRPClient.fromProvider(
      provider({
        authorizationEndpoint: 'https://op.example/a',
        tokenEndpoint: 'https://op.example/t',
        userinfoEndpoint: 'https://op.example/u',
        jwksUri: 'https://op.example/j',
        tokenEndpointAuthMethod: 'client_secret_basic',
        useRequestObject: false,
      }),
      'https://rp.example/cb',
      'secret'
    );
    const url = new URL(
      await c.createAuthorizationUrl({ state: 's', nonce: 'n', codeVerifier: 'v'.repeat(43) })
    );
    expect(url.origin + url.pathname).toBe('https://op.example/a');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('redirect_uri')).toBe('https://rp.example/cb');
    expect(url.searchParams.get('client_id')).toBe('client-1');
  });

  it('reads the discovery URL from the FAPI quirks and the document type from the provider', async () => {
    const c = OIDCRPClient.fromProvider(
      provider({
        providerType: 'oauth2',
        providerQuirks: { fapi2: { discoveryUrl: 'https://op.example/fapi-config' } },
      }),
      'https://rp.example/cb',
      'secret'
    );
    mocks.fetch.mockImplementation(async () => json({ ...DISCOVERY, jwks_uri: undefined }));
    await c.discover();
    expect(fetchedUrls()).toEqual(['https://op.example/fapi-config']);
    const other = OIDCRPClient.fromProvider(
      provider({ providerQuirks: { fapi2: { discoveryUrl: 5 } } }),
      'https://rp.example/cb',
      'secret'
    );
    mocks.fetch.mockClear();
    mocks.fetch.mockImplementation(async () => json(DISCOVERY));
    await other.discover();
    expect(fetchedUrls()).toEqual([`${ISSUER}/.well-known/openid-configuration`]);
  });

  it('uses an empty issuer when the provider has none', async () => {
    const c = OIDCRPClient.fromProvider(
      provider({ issuer: undefined, authorizationEndpoint: 'https://op.example/a' }),
      'https://rp.example/cb',
      's'
    );
    await expect(c.discover()).rejects.toThrow('issuer is not safe to fetch');
  });

  it('keeps the userinfo signing algorithm from dynamic registration', async () => {
    const c = OIDCRPClient.fromProvider(
      provider({
        providerQuirks: { dynamicClientRegistration: { userinfoSignedResponseAlg: 'RS256' } },
        userinfoEndpoint: 'https://op.example/u',
      }),
      'https://rp.example/cb',
      's'
    );
    mocks.fetch.mockImplementation(async (url: string) =>
      url.endsWith('/u')
        ? new Response('a.b.c', { headers: { 'Content-Type': 'application/jwt' } })
        : json(DISCOVERY)
    );
    await expect(c.fetchUserInfo('tok')).rejects.toThrow();
  });
});

describe('registerClient', () => {
  const REG = { ...DISCOVERY, registration_endpoint: `${ISSUER}/register` };
  const request = {
    redirect_uris: ['https://rp.example/callback'],
    client_name: 'RP',
    token_endpoint_auth_method: 'client_secret_basic' as const,
  };
  const registered = {
    client_id: 'new',
    client_secret: 'sec',
    token_endpoint_auth_method: 'client_secret_basic',
  };

  beforeEach(() => {
    mocks.fetch.mockImplementation(async (url: string) =>
      url.endsWith('/register') ? json(registered, { status: 201 }) : json(REG)
    );
  });
  const registerCall = () =>
    mocks.fetch.mock.calls.find((call) => String(call[0]).endsWith('/register'));

  it('posts the metadata without the access token, which goes in a bearer header', async () => {
    const result = await client().registerClient({ ...request, initialAccessToken: 'iat' });
    expect(result).toEqual(registered);
    const call = registerCall();
    const options = rec(call?.[1]);
    expect(options).toMatchObject({
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer iat',
      },
      timeoutMs: 10_000,
      maxResponseSize: 64 * 1024,
    });
    expect(JSON.parse(String(options.body))).toEqual(request);
  });

  it('sends no authorization header without an access token', async () => {
    await client().registerClient(request);
    expect(rec(rec(registerCall()?.[1]).headers)).not.toHaveProperty('Authorization');
  });

  it('needs a registration endpoint, a safe one, and a redirect URI', async () => {
    mocks.fetch.mockResolvedValue(json(DISCOVERY));
    await expect(client().registerClient(request)).rejects.toThrow(
      'Discovery document missing registration_endpoint'
    );
    mocks.fetch.mockResolvedValue(
      json({ ...DISCOVERY, registration_endpoint: 'http://op.example/register' })
    );
    await expect(client().registerClient(request)).rejects.toThrow(
      'registration_endpoint is not safe to fetch'
    );
    mocks.fetch.mockResolvedValue(json(REG));
    await expect(client().registerClient({ ...request, redirect_uris: [] })).rejects.toThrow(
      'Dynamic registration requires at least one redirect_uri'
    );
  });

  it('fails on an HTTP error', async () => {
    mocks.fetch.mockImplementation(async (url: string) =>
      url.endsWith('/register') ? new Response('{}', { status: 400 }) : json(REG)
    );
    await expect(client().registerClient(request)).rejects.toThrow(
      'Dynamic client registration failed: HTTP 400'
    );
  });

  it.each([
    [{ client_secret: 'sec' }, 'Dynamic registration response missing client_id'],
    [{ client_id: '', client_secret: 'sec' }, 'Dynamic registration response missing client_id'],
    [{ client_id: 5, client_secret: 'sec' }, 'Dynamic registration response missing client_id'],
    [{ client_id: 'c' }, 'Dynamic registration response missing client_secret'],
    [{ client_id: 'c', client_secret: '' }, 'Dynamic registration response missing client_secret'],
    [
      { client_id: 'c', client_secret: 's', token_endpoint_auth_method: 'client_secret_post' },
      'Dynamic registration response changed token_endpoint_auth_method',
    ],
  ])('refuses the response %j', async (body, message) => {
    mocks.fetch.mockImplementation(async (url: string) =>
      url.endsWith('/register') ? json(body) : json(REG)
    );
    await expect(client().registerClient(request)).rejects.toThrow(message);
  });

  it('allows no secret for the none method, and defaults the requested method to basic', async () => {
    mocks.fetch.mockImplementation(async (url: string) =>
      url.endsWith('/register') ? json({ client_id: 'c' }) : json(REG)
    );
    expect(
      await client().registerClient({ ...request, token_endpoint_auth_method: 'none' })
    ).toEqual({ client_id: 'c' });
    await expect(client().registerClient({ redirect_uris: request.redirect_uris })).rejects.toThrow(
      'Dynamic registration response missing client_secret'
    );
    mocks.fetch.mockImplementation(async (url: string) =>
      url.endsWith('/register')
        ? json({
            client_id: 'c',
            client_secret: 's',
            token_endpoint_auth_method: 'client_secret_post',
          })
        : json(REG)
    );
    await expect(client().registerClient({ redirect_uris: request.redirect_uris })).rejects.toThrow(
      'changed token_endpoint_auth_method'
    );
  });
});

describe('createAuthorizationUrl', () => {
  const start = (c: OIDCRPClient, extra: Record<string, unknown> = {}) =>
    c.createAuthorizationUrl({
      state: 'st',
      nonce: 'no',
      codeVerifier: 'v'.repeat(43),
      ...extra,
    });

  it('builds a code flow request with an S256 challenge, discovering the endpoint', async () => {
    const url = new URL(await start(client()));
    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
    const { code_challenge: challenge, ...params } = Object.fromEntries(url.searchParams);
    expect(params).toEqual({
      response_type: 'code',
      client_id: 'client-1',
      redirect_uri: 'https://rp.example/callback',
      scope: 'openid email',
      state: 'st',
      nonce: 'no',
      code_challenge_method: 'S256',
    });
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('adds each optional parameter only when given', async () => {
    const url = new URL(
      await start(client({ authorizationEndpoint: 'https://op.example/a' }), {
        prompt: 'login',
        loginHint: 'a@example.com',
        maxAge: 0,
        acrValues: 'urn:acr:1',
        responseMode: 'form_post',
        responseType: 'code id_token',
      })
    );
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.get('login_hint')).toBe('a@example.com');
    expect(url.searchParams.get('max_age')).toBe('0');
    expect(url.searchParams.get('acr_values')).toBe('urn:acr:1');
    expect(url.searchParams.get('response_mode')).toBe('form_post');
    expect(url.searchParams.get('response_type')).toBe('code id_token');
    const plain = new URL(await start(client({ authorizationEndpoint: 'https://op.example/a' })));
    for (const key of ['prompt', 'login_hint', 'max_age', 'acr_values', 'response_mode']) {
      expect(plain.searchParams.has(key)).toBe(false);
    }
  });

  describe('with a request object', () => {
    let signing: Awaited<ReturnType<typeof jose.generateKeyPair>>;
    let privateJwk: jose.JWK;
    beforeEach(async () => {
      signing = await jose.generateKeyPair('ES256', { extractable: true });
      privateJwk = { ...(await jose.exportJWK(signing.privateKey)), kid: 'ro-key' };
    });
    const signed = (extra: Partial<OIDCRPClientConfig> = {}) =>
      client({
        authorizationEndpoint: 'https://op.example/a',
        useRequestObject: true,
        requestObjectSigningAlg: 'ES256',
        privateKeyJwk: privateJwk,
        ...extra,
      });

    it('passes the signed request by value with the client identity in the query', async () => {
      const url = new URL(await start(signed(), { prompt: 'login' }));
      expect([...url.searchParams.keys()].sort()).toEqual([
        'client_id',
        'request',
        'response_type',
        'scope',
      ]);
      expect(url.searchParams.get('client_id')).toBe('client-1');
      expect(url.searchParams.get('scope')).toBe('openid email');
      const request = String(url.searchParams.get('request'));
      const { payload: signedBytes, protectedHeader } = await jose.compactVerify(
        request,
        signing.publicKey
      );
      const payload = rec(JSON.parse(new TextDecoder().decode(signedBytes)));
      expect(protectedHeader).toMatchObject({ alg: 'ES256', typ: 'oauth-authz-req+jwt' });
      expect(payload).toMatchObject({
        iss: 'client-1',
        aud: ISSUER,
        prompt: 'login',
        state: 'st',
        nonce: 'no',
        response_type: 'code',
        iat: NOW_S,
        exp: NOW_S + 300,
      });
      expect(typeof payload.jti).toBe('string');
    });

    it('publishes the object and passes a request_uri instead when one is registered', async () => {
      const publish = vi.fn().mockResolvedValue(undefined);
      const url = new URL(
        await start(signed(), {
          requestUri: 'https://rp.example/ro?id=st',
          publishRequestObject: publish,
        })
      );
      expect(url.searchParams.get('request_uri')).toBe('https://rp.example/ro?id=st');
      expect(url.searchParams.has('request')).toBe(false);
      expect(publish).toHaveBeenCalledTimes(1);
      expect(String(callArg(publish, 0, 0)).split('.')).toHaveLength(3);
    });

    it('refuses a request_uri without a publisher', async () => {
      await expect(start(signed(), { requestUri: 'https://rp.example/ro' })).rejects.toThrow(
        'request_uri requires a request object publisher'
      );
    });

    it('refuses a request_uri without a publisher for an unsigned object too, and publishes with one', async () => {
      const unsigned = (extra: Partial<OIDCRPClientConfig> = {}) =>
        signed({ requestObjectSigningAlg: 'none', privateKeyJwk: undefined, ...extra });
      await expect(start(unsigned(), { requestUri: 'https://rp.example/ro' })).rejects.toThrow(
        'request_uri requires a request object publisher'
      );
      const publish = vi.fn().mockResolvedValue(undefined);
      const url = new URL(
        await start(unsigned(), {
          requestUri: 'https://rp.example/ro',
          publishRequestObject: publish,
        })
      );
      expect(url.searchParams.get('request_uri')).toBe('https://rp.example/ro');
      expect(url.searchParams.has('request')).toBe(false);
      expect(String(callArg(publish, 0, 0)).endsWith('.')).toBe(true);
      const byValue = new URL(await start(unsigned()));
      expect(String(byValue.searchParams.get('request')).endsWith('.')).toBe(true);
      expect([...byValue.searchParams.keys()].sort()).toEqual([
        'client_id',
        'request',
        'response_type',
        'scope',
      ]);
    });

    it('refuses request objects without a usable key', async () => {
      await expect(start(signed({ privateKeyJwk: undefined }))).rejects.toThrow(
        'Request Object is enabled but no compatible signing key is configured'
      );
    });

    it('signs with RS256 unless told otherwise, and supports unsigned (none) objects', async () => {
      const rsa = await jose.generateKeyPair('RS256', { extractable: true });
      const jwk = await jose.exportJWK(rsa.privateKey);
      const url = new URL(
        await start(signed({ requestObjectSigningAlg: undefined, privateKeyJwk: jwk }))
      );
      expect(jose.decodeProtectedHeader(String(url.searchParams.get('request')))).toMatchObject({
        alg: 'RS256',
      });
      const none = await signed({ requestObjectSigningAlg: 'none' }).createRequestObject({
        a: 'b',
      });
      expect(none.endsWith('.')).toBe(true);
      expect(jose.decodeProtectedHeader(none)).toMatchObject({ alg: 'none' });
    });
  });
});

describe('exchangeCode', () => {
  const tokenResponse = { access_token: 'at', token_type: 'Bearer' };
  const exchange = (c: OIDCRPClient) => c.exchangeCode('the-code', 'the-verifier');
  const tokenCall = () => mocks.fetch.mock.calls.find((call) => String(call[0]).endsWith('/token'));

  beforeEach(() => {
    mocks.fetch.mockImplementation(async (url: string) =>
      url.endsWith('/token') ? json(tokenResponse) : json(DISCOVERY)
    );
  });

  it('posts the code in the body with the secret, by default', async () => {
    const result = await exchange(client({ tokenEndpoint: `${ISSUER}/token` }));
    expect(result).toEqual({
      tokens: tokenResponse,
      requestContext: {
        tokenEndpoint: `${ISSUER}/token`,
        authMethod: 'client_secret_post',
        authHeaderPresent: false,
      },
    });
    const options = rec(tokenCall()?.[1]);
    expect(options).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeoutMs: 10000,
      maxResponseSize: 64 * 1024,
    });
    expect(rec(options.headers)).not.toHaveProperty('Authorization');
    expect(Object.fromEntries(new URLSearchParams(String(options.body)))).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: 'https://rp.example/callback',
      code_verifier: 'the-verifier',
      client_id: 'client-1',
      client_secret: 'secret-1',
    });
  });

  it('uses HTTP Basic with form-encoded credentials, and no credentials in the body', async () => {
    const result = await exchange(
      client({
        tokenEndpoint: `${ISSUER}/token`,
        tokenEndpointAuthMethod: 'client_secret_basic',
        clientId: 'id:with space',
        clientSecret: 's/ecret+',
      })
    );
    expect(result.requestContext).toMatchObject({
      authMethod: 'client_secret_basic',
      authHeaderPresent: true,
    });
    const options = rec(tokenCall()?.[1]);
    expect(rec(options.headers).Authorization).toBe(
      `Basic ${btoa(`${encodeURIComponent('id:with space')}:${encodeURIComponent('s/ecret+')}`)}`
    );
    const body = new URLSearchParams(String(options.body));
    expect(body.has('client_id')).toBe(false);
    expect(body.has('client_secret')).toBe(false);
  });

  it('prefers the configured method, then the quirk, then discovery, then post', async () => {
    const basic = await exchange(
      client({ tokenEndpoint: `${ISSUER}/token`, providerQuirks: { useBasicAuth: true } })
    );
    expect(basic.requestContext.authMethod).toBe('client_secret_basic');
    const post = await exchange(
      client({
        tokenEndpoint: `${ISSUER}/token`,
        providerQuirks: { useBasicAuth: false },
      })
    );
    expect(post.requestContext.authMethod).toBe('client_secret_post');
    const configured = await exchange(
      client({
        tokenEndpoint: `${ISSUER}/token`,
        tokenEndpointAuthMethod: 'client_secret_post',
        providerQuirks: { useBasicAuth: true },
      })
    );
    expect(configured.requestContext.authMethod).toBe('client_secret_post');
  });

  it.each([
    [['client_secret_post', 'client_secret_basic'], 'client_secret_basic'],
    [['client_secret_post'], 'client_secret_post'],
    [['private_key_jwt'], 'client_secret_post'],
    [undefined, 'client_secret_post'],
  ])('chooses from the discovered methods %j', async (methods, expected) => {
    mocks.fetch.mockImplementation(async (url: string) =>
      url.endsWith('/token')
        ? json(tokenResponse)
        : json({ ...DISCOVERY, token_endpoint_auth_methods_supported: methods })
    );
    const result = await exchange(client());
    expect(result.requestContext.authMethod).toBe(expected);
  });

  it('falls back to post when discovery is unavailable for the method choice', async () => {
    mocks.fetch.mockImplementation(async (url: string) =>
      url.endsWith('/token') ? json(tokenResponse) : new Response('', { status: 500 })
    );
    const result = await exchange(client({ tokenEndpoint: `${ISSUER}/token` }));
    expect(result.requestContext.authMethod).toBe('client_secret_post');
  });

  it('refuses an unsafe endpoint and an HTTP error, and exposes the tokens through handleCallback', async () => {
    await expect(exchange(client({ tokenEndpoint: 'http://op.example/token' }))).rejects.toThrow(
      'token_endpoint is not safe to fetch'
    );
    mocks.fetch.mockImplementation(async () => new Response('{}', { status: 401 }));
    await expect(exchange(client({ tokenEndpoint: `${ISSUER}/token` }))).rejects.toThrow(
      'Token exchange failed: HTTP 401'
    );
    mocks.fetch.mockImplementation(async (url: string) =>
      url.endsWith('/token') ? json(tokenResponse) : json(DISCOVERY)
    );
    expect(await client({ tokenEndpoint: `${ISSUER}/token` }).handleCallback('c', 'v')).toEqual(
      tokenResponse
    );
  });
});

describe('fromProvider', () => {
  const provider = (quirks: Record<string, unknown> | undefined): UpstreamProvider => ({
    id: 'p',
    tenantId: 't',
    name: 'P',
    providerType: 'oidc',
    enabled: true,
    priority: 0,
    issuer: ISSUER,
    clientId: 'client-1',
    clientSecretEncrypted: 'x',
    scopes: 'openid, email profile',
    attributeMapping: {},
    autoLinkEmail: false,
    jitProvisioning: false,
    requireEmailVerified: false,
    providerQuirks: quirks as UpstreamProvider['providerQuirks'],
    createdAt: 0,
    updatedAt: 0,
  });
  const built = (quirks: Record<string, unknown> | undefined) =>
    rec(
      (
        OIDCRPClient.fromProvider(provider(quirks), 'https://rp.example/cb', 's') as unknown as {
          config: unknown;
        }
      ).config
    );

  it('splits the scopes on whitespace and commas', () => {
    expect(built({}).scopes).toEqual(['openid', 'email', 'profile']);
  });

  it.each([
    [
      'a text value',
      { dynamicClientRegistration: { userinfoSignedResponseAlg: 'ES256' } },
      'ES256',
    ],
    ['an empty text value', { dynamicClientRegistration: { userinfoSignedResponseAlg: '' } }, ''],
    [
      'a value that is not text',
      { dynamicClientRegistration: { userinfoSignedResponseAlg: 5 } },
      undefined,
    ],
    [
      'a registration that is a list',
      { dynamicClientRegistration: [{ userinfoSignedResponseAlg: 'ES256' }] },
      undefined,
    ],
    ['a registration that is text', { dynamicClientRegistration: 'ES256' }, undefined],
    ['a registration that is null', { dynamicClientRegistration: null }, undefined],
    ['no registration', {}, undefined],
  ])('reads the userinfo signing algorithm from %s', (_n, quirks, expected) => {
    expect(built(quirks).userinfoSignedResponseAlg).toBe(expected);
  });

  it.each([
    ['a FAPI object', { fapi2: { discoveryUrl: 'https://op.example/d' } }, 'https://op.example/d'],
    ['a discovery URL that is not text', { fapi2: { discoveryUrl: 5 } }, undefined],
    ['a FAPI list', { fapi2: [{ discoveryUrl: 'https://op.example/d' }] }, undefined],
    ['FAPI text', { fapi2: 'https://op.example/d' }, undefined],
    ['FAPI null', { fapi2: null }, undefined],
    ['no FAPI', {}, undefined],
  ])('reads the discovery URL from %s', (_n, quirks, expected) => {
    expect(built(quirks).discoveryUrl).toBe(expected);
  });

  it('keeps only the trusted audiences that are non-empty text', () => {
    expect(built({ trustedAudiences: ['a', '', 5, 'b'] }).trustedAudiences).toEqual(['a', 'b']);
    expect(built({ trustedAudiences: 'a' }).trustedAudiences).toBeUndefined();
    expect(built({}).trustedAudiences).toBeUndefined();
  });
});

describe('response size limits', () => {
  const KB = 1024;
  const tokens = { access_token: 'at', token_type: 'Bearer' };

  it('reads at most 64 KiB of a discovery document and of a registration answer', async () => {
    await client().discover();
    expect(mocks.limits).toEqual([64 * KB]);
    mocks.limits.length = 0;
    mocks.fetch.mockImplementation(async (url: string) =>
      url.endsWith('/register')
        ? json(
            {
              client_id: 'new',
              client_secret: 's',
              token_endpoint_auth_method: 'client_secret_basic',
            },
            { status: 201 }
          )
        : json({ ...DISCOVERY, registration_endpoint: `${ISSUER}/register` })
    );
    await client().registerClient({
      redirect_uris: ['https://rp.example/callback'],
      token_endpoint_auth_method: 'client_secret_basic',
    });
    expect(mocks.limits).toEqual([64 * KB, 64 * KB]);
  });

  it('reads at most 64 KiB of a token answer, and drains 16 KiB of a failed refresh', async () => {
    mocks.fetch.mockImplementation(async (url: string) =>
      url.endsWith('/token') ? json(tokens) : json(DISCOVERY)
    );
    await client({ tokenEndpoint: `${ISSUER}/token` }).refreshTokens('r');
    expect(mocks.limits.at(-1)).toBe(64 * KB);
    mocks.limits.length = 0;
    mocks.fetch.mockImplementation(async () => new Response('nope', { status: 400 }));
    await expect(client({ tokenEndpoint: `${ISSUER}/token` }).refreshTokens('r')).rejects.toThrow(
      'Token refresh failed: HTTP 400'
    );
    expect(mocks.limits.at(-1)).toBe(16 * KB);
    mocks.limits.length = 0;
    mocks.fetch.mockImplementation(async (url: string) =>
      url.endsWith('/token') ? json(tokens) : json(DISCOVERY)
    );
    await client({ tokenEndpoint: `${ISSUER}/token` }).exchangeCode('c', 'v');
    expect(mocks.limits.at(-1)).toBe(64 * KB);
  });
});
