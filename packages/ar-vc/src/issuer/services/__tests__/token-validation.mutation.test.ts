/**
 * VCI token validation: every rejection reason, boundary and algorithm.
 */

import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../types';

const h = vi.hoisted(() => {
  const logger = { module: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  logger.module.mockReturnValue(logger);
  return { logger };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return { ...actual, createLogger: vi.fn(() => h.logger) };
});

import {
  consumeCNonce,
  decodeVCIProofNonce,
  getOrCreateCNonce,
  validateProofOfPossession,
  validateVCIAccessToken,
} from '../token-validation';

const loggerModuleNames = h.logger.module.mock.calls.map((call): unknown => call[0]);
const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;
const ISSUER = 'https://acme.example.com';
const AUDIENCE = 'did:web:acme.example.com';

const b64 = (value: unknown) =>
  btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

type Alg = 'ES256' | 'ES384' | 'ES512';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  vi.clearAllMocks();
  h.logger.module.mockReturnValue(h.logger);
});
afterEach(() => {
  vi.useRealTimers();
});

async function keyFor(alg: Alg) {
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
  return { privateKey, publicJwk: await exportJWK(publicKey) };
}

interface TokenOptions {
  alg?: Alg;
  header?: Record<string, unknown>;
  claims?: Record<string, unknown>;
}

/** An access token plus an env whose KeyManager serves its public key. */
async function accessToken(options: TokenOptions = {}) {
  const alg = options.alg ?? 'ES256';
  const { privateKey, publicJwk } = await keyFor(alg);
  const claims = {
    iss: `${ISSUER}/vci`,
    aud: ISSUER,
    sub: 'user-1',
    exp: NOW + 300,
    iat: NOW,
    jti: 'jti-1',
    scope: 'credential',
    tenant_id: 'acme',
    credential_configuration_id: 'cfg-1',
    offer_id: 'offer-1',
    ...options.claims,
  };
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg, kid: 'key-1', ...options.header })
    .sign(privateKey);
  const getVcIssuerJwksRpc = vi.fn(async () => ({ keys: [{ ...publicJwk, kid: 'key-1' }] }));
  const idFromName = vi.fn((name: string) => name);
  const env = {
    KEY_MANAGER: { idFromName, get: vi.fn(() => ({ getVcIssuerJwksRpc })) },
  } as unknown as Env;
  return { token, env, idFromName, getVcIssuerJwksRpc, publicJwk };
}

const validate = (env: Env, token: string, tenant = 'acme') =>
  validateVCIAccessToken(env, token, ISSUER, tenant);

describe('validateVCIAccessToken', () => {
  it('names its logger module', () => {
    expect(loggerModuleNames).toContain('VCI-TOKEN');
  });

  it('accepts a token and reports exactly its claims, for each ES algorithm', async () => {
    for (const alg of ['ES256', 'ES384', 'ES512'] as const) {
      const { token, env, idFromName } = await accessToken({ alg });
      expect(await validate(env, token)).toEqual({
        valid: true,
        userId: 'user-1',
        tenantId: 'acme',
        credentialConfigurationId: 'cfg-1',
        vct: 'cfg-1',
        jti: 'jti-1',
        offerId: 'offer-1',
      });
      expect(idFromName).toHaveBeenCalledWith('acme-v3');
    }
  });

  it('refuses a blank expected tenant and trims a padded one', async () => {
    const { token, env } = await accessToken();
    expect(await validate(env, token, '   ')).toEqual({
      valid: false,
      error: 'Token validation failed',
    });
    expect(h.logger.error).toHaveBeenCalledWith(
      'VCI access token validation failed',
      {},
      expect.objectContaining({ message: 'VCI access token requires tenantId' })
    );
    expect((await validate(env, token, ' acme ')).valid).toBe(true);
  });

  it('bounds the token size', async () => {
    const { env } = await accessToken();
    expect(await validate(env, 'x'.repeat(8 * 1024 + 1))).toEqual({
      valid: false,
      error: 'Token too large',
    });
    expect(await validate(env, 'x'.repeat(8 * 1024))).toEqual({
      valid: false,
      error: 'Invalid token format',
    });
  });

  it.each(['a.b', 'a.b.c.d', ''])('refuses the malformed token %j', async (token) => {
    const { env } = await accessToken();
    expect(await validate(env, token)).toEqual({ valid: false, error: 'Invalid token format' });
  });

  it('hides parse failures behind a generic error', async () => {
    const { env } = await accessToken();
    expect(await validate(env, '!!.!!.!!')).toEqual({
      valid: false,
      error: 'Token validation failed',
    });
    expect(h.logger.error).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no exp', { exp: undefined }],
    ['a string exp', { exp: String(NOW + 300) }],
    ['a past exp', { exp: NOW - 1 }],
    ['an exp equal to now (RFC 7519)', { exp: NOW }],
  ])('refuses a token with %s as expired', async (_name, claims) => {
    const { token, env } = await accessToken({ claims });
    expect(await validate(env, token)).toEqual({ valid: false, error: 'Token expired' });
  });

  it('accepts a token that expires in a second', async () => {
    const { token, env } = await accessToken({ claims: { exp: NOW + 1 } });
    expect((await validate(env, token)).valid).toBe(true);
  });

  it('allows 60 seconds of clock skew on iat and ignores a missing iat', async () => {
    const skewed = await accessToken({ claims: { iat: NOW + 60 } });
    expect((await validate(skewed.env, skewed.token)).valid).toBe(true);
    const future = await accessToken({ claims: { iat: NOW + 61 } });
    expect(await validate(future.env, future.token)).toEqual({
      valid: false,
      error: 'Token not yet valid',
    });
    const none = await accessToken({ claims: { iat: undefined } });
    expect((await validate(none.env, none.token)).valid).toBe(true);
  });

  it('accepts the pre-authorized AS only as issuer and the issuer as sole audience', async () => {
    for (const claims of [{ iss: ISSUER }, { iss: `${ISSUER}/vci/` }, { iss: 'x' }]) {
      const { token, env } = await accessToken({ claims });
      expect(await validate(env, token)).toEqual({ valid: false, error: 'Invalid issuer' });
    }
    for (const aud of ['https://other.example', [ISSUER, 'https://other.example'], [], ['x']]) {
      const { token, env } = await accessToken({ claims: { aud } });
      expect(await validate(env, token)).toEqual({ valid: false, error: 'Invalid audience' });
    }
    const single = await accessToken({ claims: { aud: [ISSUER] } });
    expect((await validate(single.env, single.token)).valid).toBe(true);
  });

  it('requires the credential scope as a whole word', async () => {
    for (const scope of [undefined, '', 'credentials', 'openid']) {
      const { token, env } = await accessToken({ claims: { scope } });
      expect(await validate(env, token)).toEqual({ valid: false, error: 'Missing required scope' });
    }
    const many = await accessToken({ claims: { scope: 'openid credential profile' } });
    expect((await validate(many.env, many.token)).valid).toBe(true);
  });

  it('refuses a missing or foreign tenant before touching the keys', async () => {
    for (const tenant_id of [undefined, '', 'other']) {
      const { token, env, getVcIssuerJwksRpc } = await accessToken({ claims: { tenant_id } });
      expect(await validate(env, token)).toEqual({ valid: false, error: 'Invalid tenant' });
      expect(getVcIssuerJwksRpc).not.toHaveBeenCalled();
    }
  });

  it('refuses a token whose key cannot be established', async () => {
    const expected = { valid: false, error: 'Invalid signature' };
    for (const header of [{ kid: undefined }, { kid: '' }, { kid: 5 }, { kid: 'unknown' }]) {
      const { token, env } = await accessToken({ header });
      expect(await validate(env, token)).toEqual(expected);
    }
    const unsupported = await accessToken();
    const [, payload, signature] = unsupported.token.split('.');
    const swapped = `${b64({ alg: 'ES999', kid: 'key-1' })}.${payload}.${signature}`;
    expect(await validate(unsupported.env, swapped)).toEqual(expected);
  });

  it('refuses a tampered token and a failing key service', async () => {
    const { token, env } = await accessToken();
    const [header, payload, signature] = token.split('.');
    const forged = `${header}.${b64({ ...JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))), sub: 'admin' })}.${signature}`;
    expect(await validate(env, forged)).toEqual({ valid: false, error: 'Invalid signature' });
    const failing = {
      KEY_MANAGER: {
        idFromName: (name: string) => name,
        get: () => ({
          getVcIssuerJwksRpc: async () => {
            throw new Error('down');
          },
        }),
      },
    } as unknown as Env;
    expect(await validate(failing, token)).toEqual({ valid: false, error: 'Invalid signature' });
  });

  it('checks the holder key of cnf against the token algorithm', async () => {
    const { publicJwk: ok } = await keyFor('ES256');
    const good = await accessToken({ claims: { cnf: { jwk: ok } } });
    expect(await validate(good.env, good.token)).toMatchObject({ valid: true, holderBinding: ok });
    const p384 = (await keyFor('ES384')).publicJwk;
    const p521 = (await keyFor('ES512')).publicJwk;
    for (const [alg, jwk] of [
      ['ES384', p384],
      ['ES512', p521],
    ] as const) {
      const t = await accessToken({ alg, claims: { cnf: { jwk } } });
      expect((await validate(t.env, t.token)).valid).toBe(true);
    }
    for (const jwk of [
      p384,
      { ...ok, kty: 'RSA' },
      { ...ok, x: 5 },
      { ...ok, x: '' },
      { ...ok, y: '' },
      { ...ok, y: undefined },
      { ...ok, d: 'private' },
    ]) {
      const t = await accessToken({ claims: { cnf: { jwk: jwk as JWK } } });
      expect(await validate(t.env, t.token)).toEqual({
        valid: false,
        error: 'Invalid holder binding',
      });
    }
    // No cnf at all is allowed here: the credential endpoint decides whether a binding is needed.
    const none = await accessToken({ claims: { cnf: {} } });
    expect((await validate(none.env, none.token)).valid).toBe(true);
  });
});

describe('validateProofOfPossession', () => {
  const CONFIG = { POP_VALIDITY_SECONDS: '120', POP_CLOCK_SKEW_SECONDS: '10' } as unknown as Env;

  async function proof(
    claims: Record<string, unknown> = {},
    header: Record<string, unknown> = {},
    signWith?: CryptoKey
  ) {
    const { privateKey, publicJwk } = await keyFor('ES256');
    return new SignJWT({ aud: AUDIENCE, nonce: 'n-1', iat: NOW, ...claims })
      .setProtectedHeader({ alg: 'ES256', typ: 'openid4vci-proof+jwt', jwk: publicJwk, ...header })
      .sign(signWith ?? privateKey);
  }
  const run = (jwt: string | undefined, proofType = 'jwt') =>
    validateProofOfPossession(CONFIG, { proof_type: proofType, jwt }, 'n-1', AUDIENCE);

  it('returns the holder key of a valid proof', async () => {
    const jwt = await proof();
    const result = await run(jwt);
    expect(result.valid).toBe(true);
    expect(result.holderPublicKey).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(result.error).toBeUndefined();
  });

  it('rejects other proof types and missing proofs', async () => {
    expect(await run('x', 'ldp_vp')).toEqual({ valid: false, error: 'Unsupported proof type' });
    expect(await run(undefined)).toEqual({ valid: false, error: 'Missing JWT proof' });
    expect(await run('')).toEqual({ valid: false, error: 'Missing JWT proof' });
  });

  it('bounds the proof size and shape', async () => {
    expect(await run('x'.repeat(16 * 1024 + 1))).toEqual({
      valid: false,
      error: 'Proof too large',
    });
    expect(await run('x'.repeat(16 * 1024))).toEqual({
      valid: false,
      error: 'Invalid JWT format',
    });
    expect(await run('a.b')).toEqual({ valid: false, error: 'Invalid JWT format' });
    expect(await run('!!.!!.!!')).toEqual({ valid: false, error: 'Proof validation failed' });
    expect(h.logger.error).toHaveBeenCalledTimes(1);
  });

  it('requires the holder key in the header', async () => {
    expect(await run(await proof({}, { jwk: undefined }))).toEqual({
      valid: false,
      error: 'Missing holder public key in JWT header',
    });
    expect(
      await run(await proof({}, { jwk: { kty: 'EC', crv: 'P-384', x: 'x', y: 'y' } }))
    ).toEqual({
      valid: false,
      error: 'Invalid holder public key',
    });
  });

  it('needs a numeric iat and honours the window edges', async () => {
    for (const iat of [undefined, null, '5']) {
      expect(await run(await proof({ iat }))).toEqual({ valid: false, error: 'Missing iat' });
    }
    expect((await run(await proof({ iat: NOW + 10 }))).valid).toBe(true);
    expect(await run(await proof({ iat: NOW + 11 }))).toEqual({
      valid: false,
      error: 'Proof issued in the future',
    });
    expect((await run(await proof({ iat: NOW - 120 }))).valid).toBe(true);
    expect(await run(await proof({ iat: NOW - 121 }))).toEqual({
      valid: false,
      error: 'Proof expired',
    });
  });

  it('rejects a proof not signed by the key in its header', async () => {
    const other = await keyFor('ES256');
    expect(await run(await proof({}, {}, other.privateKey))).toEqual({
      valid: false,
      error: 'Invalid proof signature',
    });
  });
});

describe('decodeVCIProofNonce', () => {
  const jwtWith = (payload: unknown, pad = 0) => `h.${b64(payload)}.${'s'.repeat(pad)}`;

  it('reads the nonce of a three-part token', () => {
    expect(decodeVCIProofNonce(jwtWith({ nonce: 'abc' }))).toBe('abc');
  });

  it('refuses empty, oversized, malformed and non-string nonces', () => {
    expect(decodeVCIProofNonce('')).toBeNull();
    expect(decodeVCIProofNonce('a.b')).toBeNull();
    expect(decodeVCIProofNonce('a.b.c.d')).toBeNull();
    expect(decodeVCIProofNonce('h.!!.s')).toBeNull();
    expect(decodeVCIProofNonce(jwtWith({ nonce: 5 }))).toBeNull();
    expect(decodeVCIProofNonce(jwtWith({}))).toBeNull();
  });

  it('bounds the token to 16 KiB and the nonce to 512 characters', () => {
    const base = jwtWith({ nonce: 'abc' });
    expect(decodeVCIProofNonce(jwtWith({ nonce: 'abc' }, 16 * 1024 - base.length))).toBe('abc');
    expect(decodeVCIProofNonce(jwtWith({ nonce: 'abc' }, 16 * 1024 - base.length + 1))).toBeNull();
    expect(decodeVCIProofNonce(jwtWith({ nonce: 'n'.repeat(512) }))).toBe('n'.repeat(512));
    expect(decodeVCIProofNonce(jwtWith({ nonce: 'n'.repeat(513) }))).toBeNull();
  });
});

describe('c_nonce expiry configuration', () => {
  function kvEnv(expiry: string | undefined) {
    const put = vi.fn(async () => undefined);
    const env = {
      C_NONCE_EXPIRY_SECONDS: expiry,
      AUTHRIM_CONFIG: { get: vi.fn(async () => null), put, delete: vi.fn() },
    } as unknown as Env;
    return { env, put };
  }

  it.each([
    ['60', 60],
    ['3600', 3600],
    ['3601', 300],
    ['0', 300],
    ['-5', 300],
    ['1.5', 300],
    ['abc', 300],
    [undefined, 300],
  ])('uses %s as %s seconds', async (configured, expected) => {
    const { env, put } = kvEnv(configured);
    const result = await getOrCreateCNonce(env, 'user-1');
    expect(result.expiresIn).toBe(expected);
    expect(put).toHaveBeenCalledWith('cnonce:user-1', result.nonce, { expirationTtl: expected });
  });

  it('does not consume a nonce that is absent or different', async () => {
    const del = vi.fn();
    const env = {
      AUTHRIM_CONFIG: { get: vi.fn(async () => 'stored'), delete: del },
    } as unknown as Env;
    expect(await consumeCNonce(env, 'u', 'other')).toBe(false);
    expect(del).not.toHaveBeenCalled();
    expect(await consumeCNonce(env, 'u', 'stored')).toBe(true);
    expect(del).toHaveBeenCalledWith('cnonce:u');
  });
});
