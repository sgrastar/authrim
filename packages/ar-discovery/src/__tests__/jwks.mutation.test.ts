import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { jwksHandler } from '../jwks';

function app(): Hono<{ Bindings: Env }> {
  const instance = new Hono<{ Bindings: Env }>();
  instance.use('*', async (c, next) => {
    (c as unknown as { set: (key: string, value: string) => void }).set('tenantId', 'default');
    await next();
  });
  instance.get('/jwks', jwksHandler);
  return instance;
}

function envWith(extra: Record<string, unknown>): Env {
  return { ISSUER_URL: 'https://auth.example.com', ...extra } as unknown as Env;
}

/** The fallback (PUBLIC_JWK_JSON) path, with the error log captured. */
async function fromEnv(publicJwkJson: string) {
  const logged: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
  const response = await app().fetch(
    new Request('https://auth.example.com/jwks'),
    envWith({ PUBLIC_JWK_JSON: publicJwkJson })
  );
  return { response, logged: logged.join('\n') };
}

// Real public keys (generated once, importable by a client), not placeholder coordinates.
const RSA_N =
  'mvCKanRx_13sp1PejKq9YHz6YGy-09K4t-NeTbGlgrX4_hhYbTmxskGeqoiYvTgbzo_0-4ev7N5RnMCy1f7_2drYI0Ce020GhQTY0PmggqMPo0VPNOAOVwRzLc3eNpdOHEm-bLo6g66w1pEU4SS7J-QfNTA13UTRFbjr5Azi13kyZT1UvICvczKGX2BA8QA7ySvSAcHD9T9LYNbRVwF1FtCGDuEwCkO3Mdem7uXv3AunmlmsylsfQE-KtOBzyddfd8bC4-HdxRO8mX1M9k3ICGsCwB3QXC1fCJSKVc7GZrlhn-XfF7t5Kxm-zrWNWZE0HvCSmfXmIR3P4agXEk-8bw';
const RSA = { kty: 'RSA', n: RSA_N, e: 'AQAB' };
const EC = {
  kty: 'EC',
  crv: 'P-256',
  x: 'rWI7BYb5B88aAptVXkuXnyYBt9baHMjZAg1rsEFJxVs',
  y: 'QmtKKQqB_TzNCUZnI2F3OqbK8QL2fWwml9F1B0S8-_o',
};
const OKP = { kty: 'OKP', crv: 'Ed25519', x: 'So3KVYTh2Qmd7OF-sFzFQ3djJ3WOfM74GezhFxY8db4' };

describe('JWKS handler: key validation', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['a string', '"text"', 'JWK must be an object'],
    ['null', 'null', 'JWK must be an object'],
    ['an array', JSON.stringify([RSA]), 'JWK must be an object'],
    ['a number', '5', 'JWK must be an object'],
    ['a symmetric key', JSON.stringify({ kty: 'oct', k: 'secret' }), 'asymmetric public key'],
    ['a key without kty', JSON.stringify({ n: 'a', e: 'b' }), 'asymmetric public key'],
    ['a key whose kty is not a string', JSON.stringify({ kty: 3 }), 'asymmetric public key'],
    ['an RSA key without n', JSON.stringify({ kty: 'RSA', e: 'AQAB' }), 'missing required public'],
    ['an RSA key without e', JSON.stringify({ kty: 'RSA', n: 'x' }), 'missing required public'],
    ['an RSA key with a numeric n', JSON.stringify({ kty: 'RSA', n: 1, e: 'AQAB' }), 'missing'],
    ['an EC key without crv', JSON.stringify({ kty: 'EC', x: 'x', y: 'y' }), 'missing required'],
    [
      'an EC key without x',
      JSON.stringify({ kty: 'EC', crv: 'P-256', y: 'y' }),
      'missing required',
    ],
    [
      'an EC key without y',
      JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'x' }),
      'missing required',
    ],
    [
      'an EC key with a numeric y',
      JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'x', y: 1 }),
      'missing',
    ],
    [
      'an unsupported key type',
      JSON.stringify({ kty: 'XYZ', n: 'a', e: 'b' }),
      'unsupported key type',
    ],
    ['an OKP key without crv', JSON.stringify({ kty: 'OKP', x: 'x' }), 'missing required public'],
    ['an OKP key without x', JSON.stringify({ kty: 'OKP', crv: 'Ed25519' }), 'missing required'],
  ])('refuses %s with a server error and logs why', async (_label, json, reason) => {
    const { response, logged } = await fromEnv(json);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'server_error',
      message: 'Failed to generate JWKS',
      error_description: 'Failed to generate JWKS',
    });
    expect(logged).toContain(reason);
  });

  it.each([
    ['an RSA key', RSA],
    ['an EC key', EC],
    ['an OKP key', OKP],
  ])('publishes %s', async (_label, jwk) => {
    const { response } = await fromEnv(JSON.stringify(jwk));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ keys: [jwk] });
  });

  it.each([
    ['an RSA key', RSA, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }],
    ['an EC key', EC, { name: 'ECDSA', namedCurve: 'P-256' }],
    ['an OKP key', OKP, { name: 'Ed25519' }],
  ])('publishes %s as a key a client can import', async (_label, jwk, algorithm) => {
    const { response } = await fromEnv(JSON.stringify(jwk));
    const body = await response.json<{ keys: JsonWebKey[] }>();
    const [published] = body.keys;
    await expect(
      crypto.subtle.importKey('jwk', published, algorithm, true, ['verify'])
    ).resolves.toBeDefined();
  });

  it('publishes every public member and drops every private one', async () => {
    const jwk = {
      kty: 'RSA',
      use: 'sig',
      key_ops: ['verify'],
      alg: 'RS256',
      kid: 'k1',
      x5u: 'https://example.com/cert',
      x5c: ['Y2VydA=='],
      x5t: 'thumb1',
      'x5t#S256': 'thumb256',
      n: RSA_N,
      e: 'AQAB',
      d: 'private',
      p: 'p',
      q: 'q',
      dp: 'dp',
      dq: 'dq',
      qi: 'qi',
      k: 'secret',
    };
    const { response } = await fromEnv(JSON.stringify(jwk));
    expect(await response.json()).toEqual({
      keys: [
        {
          kty: 'RSA',
          use: 'sig',
          key_ops: ['verify'],
          alg: 'RS256',
          kid: 'k1',
          x5u: 'https://example.com/cert',
          x5c: ['Y2VydA=='],
          x5t: 'thumb1',
          'x5t#S256': 'thumb256',
          n: RSA_N,
          e: 'AQAB',
        },
      ],
    });
  });

  it('publishes the environment key with the long cache time and the Vary header', async () => {
    const { response } = await fromEnv(JSON.stringify(RSA));
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');
    expect(response.headers.get('Vary')).toBe('Accept-Encoding');
  });

  it('falls back to the environment key when a KeyManager key is not publishable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const response = await app().fetch(
      new Request('https://auth.example.com/jwks'),
      envWith({
        PUBLIC_JWK_JSON: JSON.stringify(RSA),
        KEY_MANAGER_PUBLIC: { getAllPublicKeys: async () => [{ kty: 'oct', k: 'secret' }] },
      })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');
    expect(await response.json()).toEqual({ keys: [RSA] });
  });

  it('publishes KeyManager keys with the five-minute cache time and the Vary header', async () => {
    const response = await app().fetch(
      new Request('https://auth.example.com/jwks'),
      envWith({ KEY_MANAGER_PUBLIC: { getAllPublicKeys: async () => [RSA] } })
    );
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(response.headers.get('Vary')).toBe('Accept-Encoding');
    expect(await response.json()).toEqual({ keys: [RSA] });
  });
});
