import { createHash } from 'node:crypto';
import * as jose from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Fapi2Client } from '../clients/fapi2-client';

const NOW = 1_800_000_000;
const ISSUER = 'https://server.example.com';
const REQUEST_URI = 'urn:ietf:params:oauth:request_uri:abc';

interface Keys {
  clientPrivate: jose.JWK;
  clientPublic: jose.CryptoKey;
  dpopPrivate: jose.JWK;
  dpopPublic: jose.CryptoKey;
}

let keys: Keys;

async function ecKeys(kid?: string) {
  const pair = await jose.generateKeyPair('ES256', { extractable: true });
  const privateJwk = await jose.exportJWK(pair.privateKey);
  return {
    privateJwk: kid ? { ...privateJwk, kid } : privateJwk,
    publicKey: pair.publicKey,
  };
}

function client(overrides: Partial<ConstructorParameters<typeof Fapi2Client>[0]> = {}) {
  return new Fapi2Client({
    issuer: ISSUER,
    clientId: 'fapi-client',
    redirectUri: 'https://client.example.com/callback',
    clientAssertionPrivateJwk: keys.clientPrivate,
    dpopPrivateJwk: keys.dpopPrivate,
    ...overrides,
  });
}

beforeEach(async () => {
  const client = await ecKeys('client-key');
  const dpop = await ecKeys('dpop-key');
  keys = {
    clientPrivate: client.privateJwk,
    clientPublic: client.publicKey,
    dpopPrivate: dpop.privateJwk,
    dpopPublic: dpop.publicKey,
  };
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('createClientAssertion', () => {
  it('signs a one-minute private_key_jwt with the client key', async () => {
    const jwt = await client().createClientAssertion('https://server.example.com/token');
    const { payload, protectedHeader } = await jose.jwtVerify(jwt, keys.clientPublic, {
      currentDate: new Date(NOW * 1000),
    });
    expect(protectedHeader).toEqual({ alg: 'ES256', typ: 'JWT', kid: 'client-key' });
    const { jti, ...claims } = payload;
    expect(claims).toEqual({
      iss: 'fapi-client',
      sub: 'fapi-client',
      aud: 'https://server.example.com/token',
      iat: NOW,
      exp: NOW + 60,
    });
    expect(jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('uses the given time, a fresh jti each time, and omits a missing kid', async () => {
    const noKid = await ecKeys();
    const c = client({ clientAssertionPrivateJwk: noKid.privateJwk });
    const first = await c.createClientAssertion('aud', 1000);
    const second = await c.createClientAssertion('aud', 1000);
    expect(jose.decodeProtectedHeader(first)).toEqual({ alg: 'ES256', typ: 'JWT' });
    expect(jose.decodeJwt(first)).toMatchObject({ iat: 1000, exp: 1060 });
    expect(jose.decodeJwt(first).jti).not.toBe(jose.decodeJwt(second).jti);
  });

  it('signs with PS256 when configured', async () => {
    const pair = await jose.generateKeyPair('PS256', { extractable: true });
    const jwk = { ...(await jose.exportJWK(pair.privateKey)), kid: 'rsa-key' };
    const jwt = await client({
      clientAssertionPrivateJwk: jwk,
      clientAssertionAlg: 'PS256',
    }).createClientAssertion('aud');
    expect(jose.decodeProtectedHeader(jwt)).toEqual({ alg: 'PS256', typ: 'JWT', kid: 'rsa-key' });
    await jose.jwtVerify(jwt, pair.publicKey, { currentDate: new Date(NOW * 1000) });
  });
});

describe('createDpopProof', () => {
  it('binds the method and URL without query or fragment, with no token hash by default', async () => {
    const proof = await client().createDpopProof({
      url: 'https://server.example.com/token?x=1#frag',
      method: 'post',
    });
    const header = jose.decodeProtectedHeader(proof);
    expect(header.typ).toBe('dpop+jwt');
    expect(header.alg).toBe('ES256');
    expect(header.jwk).toEqual({
      kty: 'EC',
      crv: 'P-256',
      x: keys.dpopPrivate.x,
      y: keys.dpopPrivate.y,
      kid: 'dpop-key',
    });
    const payload = jose.decodeJwt(proof);
    const { jti, ...claims } = payload;
    expect(claims).toEqual({ htm: 'POST', htu: 'https://server.example.com/token', iat: NOW });
    expect(jti).toMatch(/^[0-9a-f-]{36}$/);
    await jose.jwtVerify(proof, keys.dpopPublic, { currentDate: new Date(NOW * 1000) });
  });

  it('adds the access token hash and the server nonce when given', async () => {
    const proof = await client().createDpopProof({
      url: 'https://server.example.com/resource',
      method: 'GET',
      accessToken: 'tok',
      nonce: 'n-1',
      now: 42,
    });
    expect(jose.decodeJwt(proof)).toMatchObject({
      ath: createHash('sha256').update('tok', 'ascii').digest('base64url'),
      nonce: 'n-1',
      iat: 42,
    });
  });

  it('does not add empty token or nonce claims', async () => {
    const proof = await client().createDpopProof({
      url: 'https://server.example.com/resource',
      method: 'GET',
      accessToken: '',
      nonce: '',
    });
    const payload = jose.decodeJwt(proof);
    expect(payload).not.toHaveProperty('ath');
    expect(payload).not.toHaveProperty('nonce');
  });
});

describe('createAuthorizationRequestObject', () => {
  it('signs the parameters with the issuer as audience, and the client as issuer', async () => {
    const jwt = await client().createAuthorizationRequestObject({
      response_type: 'code',
      iss: 'attacker',
      aud: 'attacker',
      max_age: 0,
    });
    const { payload, protectedHeader } = await jose.jwtVerify(jwt, keys.clientPublic, {
      currentDate: new Date(NOW * 1000),
    });
    expect(protectedHeader).toEqual({
      alg: 'ES256',
      typ: 'oauth-authz-req+jwt',
      kid: 'client-key',
    });
    const { jti, ...claims } = payload;
    expect(claims).toEqual({
      response_type: 'code',
      max_age: 0,
      iss: 'fapi-client',
      aud: ISSUER,
      iat: NOW,
      nbf: NOW,
      exp: NOW + 60,
    });
    expect(typeof jti).toBe('string');
  });

  it('uses a given time and omits a missing kid', async () => {
    const noKid = await ecKeys();
    const jwt = await client({
      clientAssertionPrivateJwk: noKid.privateJwk,
    }).createAuthorizationRequestObject({ a: 'b' }, 500);
    expect(jose.decodeProtectedHeader(jwt)).toEqual({ alg: 'ES256', typ: 'oauth-authz-req+jwt' });
    expect(jose.decodeJwt(jwt)).toMatchObject({ iat: 500, nbf: 500, exp: 560 });
  });
});

describe('validateJarmResponse', () => {
  let signing: Awaited<ReturnType<typeof jose.generateKeyPair>>;
  let jwks: jose.JSONWebKeySet;

  beforeEach(async () => {
    signing = await jose.generateKeyPair('ES256', { extractable: true });
    jwks = {
      keys: [{ ...(await jose.exportJWK(signing.publicKey)), kid: 'server-key', alg: 'ES256' }],
    };
  });

  const sign = (
    claims: jose.JWTPayload,
    options: { iss?: string; aud?: string | string[]; exp?: number | null } = {}
  ) => {
    const builder = new jose.SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid: 'server-key' })
      .setIssuer(options.iss ?? ISSUER)
      .setAudience(options.aud ?? 'fapi-client')
      .setIssuedAt(NOW);
    if (options.exp !== null) builder.setExpirationTime(options.exp ?? NOW + 60);
    return builder.sign(signing.privateKey);
  };
  const validate = async (jwt: string, state = 'st') =>
    client().validateJarmResponse({
      responseJwt: jwt,
      jwks,
      expectedState: state,
      signingAlgorithm: 'ES256',
    });

  it('returns code, state, issuer and error fields', async () => {
    expect(await validate(await sign({ state: 'st', code: 'c1' }))).toEqual({
      code: 'c1',
      state: 'st',
      iss: ISSUER,
      error: undefined,
      error_description: undefined,
    });
    expect(
      await validate(await sign({ state: 'st', error: 'access_denied', error_description: 'no' }))
    ).toEqual({
      code: undefined,
      state: 'st',
      iss: ISSUER,
      error: 'access_denied',
      error_description: 'no',
    });
  });

  it('accepts an audience that is exactly the client, alone or in a one-element array', async () => {
    expect(
      await validate(await sign({ state: 'st', code: 'c' }, { aud: ['fapi-client'] }))
    ).toMatchObject({
      code: 'c',
    });
  });

  it('rejects another audience, an extra audience, another issuer and a bad state', async () => {
    await expect(
      validate(await sign({ state: 'st', code: 'c' }, { aud: 'other' }))
    ).rejects.toThrow();
    await expect(
      validate(await sign({ state: 'st', code: 'c' }, { aud: ['fapi-client', 'other'] }))
    ).rejects.toThrow('JARM response audience must contain only the client_id');
    await expect(
      validate(await sign({ state: 'st', code: 'c' }, { iss: 'https://evil.example' }))
    ).rejects.toThrow();
    await expect(validate(await sign({ state: 'st', code: 'c' }), 'other')).rejects.toThrow(
      'JARM response state mismatch'
    );
    await expect(validate(await sign({ code: 'c' }))).rejects.toThrow(
      'JARM response state mismatch'
    );
  });

  it('requires exp, allowing a minute of clock skew and no more', async () => {
    await expect(validate(await sign({ state: 'st', code: 'c' }, { exp: null }))).rejects.toThrow();
    expect(await validate(await sign({ state: 'st', code: 'c' }, { exp: NOW - 59 }))).toBeTruthy();
    await expect(
      validate(await sign({ state: 'st', code: 'c' }, { exp: NOW - 61 }))
    ).rejects.toThrow();
  });

  it('rejects a wrong algorithm and a signature from another key', async () => {
    const other = await jose.generateKeyPair('ES256', { extractable: true });
    const forged = await new jose.SignJWT({ state: 'st', code: 'c' })
      .setProtectedHeader({ alg: 'ES256', kid: 'server-key' })
      .setIssuer(ISSUER)
      .setAudience('fapi-client')
      .setExpirationTime(NOW + 60)
      .sign(other.privateKey);
    await expect(validate(forged)).rejects.toThrow();
    const wrongAlg = await jose.generateKeyPair('ES384', { extractable: true });
    const jwk = { ...(await jose.exportJWK(wrongAlg.publicKey)), kid: 'server-key' };
    const token = await new jose.SignJWT({ state: 'st', code: 'c' })
      .setProtectedHeader({ alg: 'ES384', kid: 'server-key' })
      .setIssuer(ISSUER)
      .setAudience('fapi-client')
      .setExpirationTime(NOW + 60)
      .sign(wrongAlg.privateKey);
    await expect(
      client().validateJarmResponse({
        responseJwt: token,
        jwks: { keys: [jwk] },
        expectedState: 'st',
        signingAlgorithm: 'ES256',
      })
    ).rejects.toThrow();
  });

  it('rejects malformed code and error values and a response with neither', async () => {
    await expect(validate(await sign({ state: 'st', code: 5 }))).rejects.toThrow(
      'JARM response has invalid code'
    );
    await expect(validate(await sign({ state: 'st', error: 5 }))).rejects.toThrow(
      'JARM response has invalid error'
    );
    await expect(validate(await sign({ state: 'st' }))).rejects.toThrow(
      'JARM response contains neither code nor error'
    );
    await expect(validate(await sign({ state: 'st', code: 5, error: 'x' }))).rejects.toThrow(
      'JARM response has invalid code'
    );
  });
});

describe('the DPoP-protected endpoints', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  const json = (body: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
  // RFC 9449 section 8: the authorization server asks for a nonce with error=use_dpop_nonce.
  const nonceChallenge = (nonce: string) =>
    new Response('{"error":"use_dpop_nonce"}', { status: 400, headers: { 'DPoP-Nonce': nonce } });
  // RFC 9449 section 9: the resource server asks with WWW-Authenticate: DPoP error="use_dpop_nonce".
  const resourceChallenge = (nonce: string) =>
    new Response('', {
      status: 401,
      headers: {
        'DPoP-Nonce': nonce,
        'WWW-Authenticate': 'DPoP error="use_dpop_nonce", error_description="nonce required"',
      },
    });
  const requestOf = (call: number) => {
    const [url, init] = fetchMock.mock.calls[call] ?? [];
    const requestInit: RequestInit = init ?? {};
    const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url?.url;
    return {
      url: target ?? '',
      method: requestInit.method,
      headers: (requestInit.headers ?? {}) as Record<string, string>,
      form: new URLSearchParams(typeof requestInit.body === 'string' ? requestInit.body : ''),
    };
  };

  describe('pushAuthorizationRequest', () => {
    const par = (params: Record<string, string> = { response_type: 'code' }) =>
      client().pushAuthorizationRequest('https://server.example.com/par', params);

    it('posts the parameters with client authentication and a DPoP proof', async () => {
      fetchMock.mockResolvedValueOnce(
        json({ request_uri: REQUEST_URI, expires_in: 90 }, { status: 201 })
      );
      expect(await par({ response_type: 'code', state: 's' })).toEqual({
        request_uri: REQUEST_URI,
        expires_in: 90,
      });
      const request = requestOf(0);
      expect(request.url).toBe('https://server.example.com/par');
      expect(request.method).toBe('POST');
      expect(Object.keys(request.headers).sort()).toEqual(['Content-Type', 'DPoP']);
      expect(request.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      const { client_assertion: assertionValue, ...fields } = Object.fromEntries(request.form);
      expect(fields).toEqual({
        response_type: 'code',
        state: 's',
        client_id: 'fapi-client',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      });
      expect(typeof assertionValue).toBe('string');
      const assertion = jose.decodeJwt(String(request.form.get('client_assertion')));
      expect(assertion.aud).toBe(ISSUER);
      const proof = jose.decodeJwt(request.headers.DPoP ?? '');
      expect(proof).toMatchObject({ htm: 'POST', htu: 'https://server.example.com/par' });
      expect(proof).not.toHaveProperty('nonce');
      expect(proof).not.toHaveProperty('ath');
    });

    it('rejects an unsafe endpoint without any request', async () => {
      await expect(client().pushAuthorizationRequest('http://127.0.0.1/par', {})).rejects.toThrow(
        'FAPI endpoint is not safe to fetch'
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a request_uri without the standard prefix and a bad expiry', async () => {
      fetchMock.mockResolvedValueOnce(json({ request_uri: 'urn:other:abc', expires_in: 90 }));
      await expect(par()).rejects.toThrow('PAR response missing valid request_uri');
      fetchMock.mockResolvedValueOnce(json({ request_uri: 5, expires_in: 90 }));
      await expect(par()).rejects.toThrow('PAR response missing valid request_uri');
      fetchMock.mockResolvedValueOnce(json({ request_uri: REQUEST_URI, expires_in: 0 }));
      await expect(par()).rejects.toThrow('PAR response missing valid expires_in');
      fetchMock.mockResolvedValueOnce(json({ request_uri: REQUEST_URI, expires_in: -5 }));
      await expect(par()).rejects.toThrow('PAR response missing valid expires_in');
      fetchMock.mockResolvedValueOnce(json({ request_uri: REQUEST_URI, expires_in: '90' }));
      await expect(par()).rejects.toThrow('PAR response missing valid expires_in');
      fetchMock.mockResolvedValueOnce(json({ request_uri: REQUEST_URI, expires_in: 1 }));
      expect(await par()).toMatchObject({ expires_in: 1 });
    });

    it('fails on an HTTP error without a nonce challenge', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 500 }));
      await expect(par()).rejects.toThrow('FAPI endpoint request failed: HTTP 500');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('retries once with the nonce, then gives up on a second failure', async () => {
      fetchMock
        .mockResolvedValueOnce(nonceChallenge('n-1'))
        .mockResolvedValueOnce(nonceChallenge('n-2'));
      await expect(par()).rejects.toThrow('FAPI endpoint request failed: HTTP 400');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(jose.decodeJwt(requestOf(1).headers.DPoP ?? '').nonce).toBe('n-1');
    });

    it.each([
      ['another error code', '{"error":"invalid_client"}'],
      ['a body that is not JSON', 'busy'],
      ['an empty body', ''],
      ['a JSON value that is not an error object', '"use_dpop_nonce"'],
    ])('does not retry %s even when the server sends a nonce', async (_name, body) => {
      fetchMock.mockResolvedValueOnce(
        new Response(body, { status: 400, headers: { 'DPoP-Nonce': 'n-1' } })
      );
      await expect(par()).rejects.toThrow('FAPI endpoint request failed: HTTP 400');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not retry a server error that carries a nonce', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response('{"error":"server_error"}', { status: 500, headers: { 'DPoP-Nonce': 'n-1' } })
      );
      await expect(par()).rejects.toThrow('FAPI endpoint request failed: HTTP 500');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not retry a successful response that carries a nonce', async () => {
      fetchMock.mockResolvedValueOnce(
        json({ request_uri: REQUEST_URI, expires_in: 90 }, { headers: { 'DPoP-Nonce': 'n-1' } })
      );
      await par();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('exchangeCode and refreshToken', () => {
    it('posts an authorization_code grant with the PKCE verifier and redirect URI', async () => {
      fetchMock.mockResolvedValueOnce(
        json({ access_token: 'a', token_type: 'DPoP', expires_in: 300 })
      );
      expect(
        await client().exchangeCode({
          tokenEndpoint: 'https://server.example.com/token',
          code: 'the-code',
          codeVerifier: 'the-verifier',
        })
      ).toEqual({ access_token: 'a', token_type: 'DPoP', expires_in: 300 });
      const form = requestOf(0).form;
      expect(form.get('grant_type')).toBe('authorization_code');
      expect(form.get('code')).toBe('the-code');
      expect(form.get('redirect_uri')).toBe('https://client.example.com/callback');
      expect(form.get('code_verifier')).toBe('the-verifier');
      expect(form.get('client_id')).toBe('fapi-client');
      expect(form.has('refresh_token')).toBe(false);
    });

    it('posts a refresh_token grant', async () => {
      fetchMock.mockResolvedValueOnce(
        json({ access_token: 'a2', token_type: 'dpop', refresh_token: 'r2' })
      );
      expect(
        await client().refreshToken({
          tokenEndpoint: 'https://server.example.com/token',
          refreshToken: 'r1',
        })
      ).toEqual({ access_token: 'a2', token_type: 'dpop', refresh_token: 'r2' });
      const form = requestOf(0).form;
      expect(form.get('grant_type')).toBe('refresh_token');
      expect(form.get('refresh_token')).toBe('r1');
      expect(form.has('code')).toBe(false);
      expect(form.has('redirect_uri')).toBe(false);
    });

    it.each([
      [{ token_type: 'DPoP' }, 'Token response missing access_token'],
      [{ access_token: '', token_type: 'DPoP' }, 'Token response missing access_token'],
      [{ access_token: 5, token_type: 'DPoP' }, 'Token response missing access_token'],
      [{ access_token: 'a' }, 'Token response token_type must be DPoP'],
      [{ access_token: 'a', token_type: 'Bearer' }, 'Token response token_type must be DPoP'],
      [{ access_token: 'a', token_type: 5 }, 'Token response token_type must be DPoP'],
      [
        { access_token: 'a', token_type: 'DPoP', expires_in: 0 },
        'Token response has invalid expires_in',
      ],
      [
        { access_token: 'a', token_type: 'DPoP', expires_in: -1 },
        'Token response has invalid expires_in',
      ],
      [
        { access_token: 'a', token_type: 'DPoP', expires_in: '300' },
        'Token response has invalid expires_in',
      ],
    ])('rejects the token response %j', async (body, message) => {
      fetchMock.mockResolvedValueOnce(json(body));
      await expect(
        client().exchangeCode({
          tokenEndpoint: 'https://server.example.com/token',
          code: 'c',
          codeVerifier: 'v',
        })
      ).rejects.toThrow(message);
    });

    it('accepts a token_type in any case and a positive integer expiry of 1', async () => {
      fetchMock.mockResolvedValueOnce(
        json({ access_token: 'a', token_type: 'DPOP', expires_in: 1 })
      );
      expect(
        await client().refreshToken({
          tokenEndpoint: 'https://server.example.com/token',
          refreshToken: 'r',
        })
      ).toMatchObject({ expires_in: 1 });
    });
  });

  describe('fetchResource', () => {
    const resource = () =>
      client().fetchResource({
        resourceUrl: 'https://server.example.com/me?x=1',
        accessToken: 'tok',
      });

    it('sends the DPoP-bound token and returns the JSON body', async () => {
      fetchMock.mockResolvedValueOnce(json({ sub: 'u1' }));
      expect(await resource()).toEqual({ sub: 'u1' });
      const request = requestOf(0);
      expect(request.url).toBe('https://server.example.com/me?x=1');
      expect(request.method).toBeUndefined();
      expect(Object.keys(request.headers).sort()).toEqual(['Authorization', 'DPoP']);
      expect(request.headers.Authorization).toBe('DPoP tok');
      const proof = jose.decodeJwt(request.headers.DPoP ?? '');
      expect(proof).toMatchObject({
        htm: 'GET',
        htu: 'https://server.example.com/me',
        ath: createHash('sha256').update('tok', 'ascii').digest('base64url'),
      });
      expect(proof).not.toHaveProperty('nonce');
    });

    it('rejects an unsafe resource URL without any request', async () => {
      await expect(
        client().fetchResource({ resourceUrl: 'http://127.0.0.1/me', accessToken: 't' })
      ).rejects.toThrow('resource_endpoint is not safe to fetch');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('retries once with the server nonce', async () => {
      fetchMock
        .mockResolvedValueOnce(resourceChallenge('n-9'))
        .mockResolvedValueOnce(json({ sub: 'u1' }));
      expect(await resource()).toEqual({ sub: 'u1' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(jose.decodeJwt(requestOf(1).headers.DPoP ?? '').nonce).toBe('n-9');
    });

    it.each([
      ['a bearer-style challenge for another error', 401, 'DPoP error="invalid_token"'],
      ['a challenge without an error', 401, 'DPoP realm="api"'],
      ['a use_dpop_nonce challenge on another status', 403, 'DPoP error="use_dpop_nonce"'],
      ['a use_dpop_nonce error of another scheme', 401, 'Bearer error="use_dpop_nonce"'],
      ['no challenge at all', 401, ''],
    ])('does not retry %s even when the server sends a nonce', async (_name, status, challenge) => {
      fetchMock.mockResolvedValueOnce(
        new Response('', {
          status,
          headers: { 'DPoP-Nonce': 'n-9', ...(challenge ? { 'WWW-Authenticate': challenge } : {}) },
        })
      );
      await expect(resource()).rejects.toThrow(`FAPI resource request failed: HTTP ${status}`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('fails on a second challenge or an error without a nonce', async () => {
      fetchMock
        .mockResolvedValueOnce(resourceChallenge('n-9'))
        .mockResolvedValueOnce(resourceChallenge('n-10'));
      await expect(resource()).rejects.toThrow('FAPI resource request failed: HTTP 401');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 403 }));
      await expect(resource()).rejects.toThrow('FAPI resource request failed: HTTP 403');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
