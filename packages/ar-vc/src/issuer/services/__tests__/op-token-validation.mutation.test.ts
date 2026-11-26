/**
 * OP access token validation (HAIP issuance): header rules, key selection, claim checks and the
 * revocation lookup, each with its exact result.
 */

import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../types';

const core = vi.hoisted(() => {
  const logger = { module: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  logger.module.mockReturnValue(logger);
  return {
    logger,
    resolveIssuedTokenAccount: vi.fn(),
    resolveTenantMetadataContext: vi.fn(),
    findOAuthClientConsentRevocation: vi.fn(),
    isAccessTokenConsentWithdrawn: vi.fn(),
    getRevocationStoreByJti: vi.fn(),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createLogger: vi.fn(() => core.logger),
    resolveIssuedTokenAccount: core.resolveIssuedTokenAccount,
    resolveTenantMetadataContext: core.resolveTenantMetadataContext,
    findOAuthClientConsentRevocation: core.findOAuthClientConsentRevocation,
    isAccessTokenConsentWithdrawn: core.isAccessTokenConsentWithdrawn,
    getRevocationStoreByJti: core.getRevocationStoreByJti,
  };
});

import { checkOpTokenRevocation, validateOpAccessToken } from '../op-token-validation';

const loggerModuleNames = core.logger.module.mock.calls.map((call): unknown => call[0]);
const ISSUER = 'https://acme.example.com';
const TENANT = 'acme';
const NOW = 1_800_000_000;
const JKT = 'A'.repeat(43);

const b64 = (value: unknown) =>
  btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let privateKey: CryptoKey;
let publicJwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'op-key' };
});

const claims = (overrides: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  aud: ISSUER,
  sub: 'user-1',
  client_id: 'wallet-1',
  jti: 'jti-1',
  exp: NOW + 300,
  iat: NOW,
  scope: 'credential openid',
  token_use: 'access',
  attestation_authenticated: true,
  cnf: { jkt: JKT },
  ...overrides,
});

async function sign(overrides: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  return new SignJWT(claims(overrides))
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: 'op-key', ...header })
    .sign(privateKey);
}

/** A token with an arbitrary header and a bogus signature: only for checks before the signature. */
const forged = (header: Record<string, unknown>) => `${b64(header)}.${b64(claims())}.AAAA`;

let keys: JWK[];
const idFromName = vi.fn((name: string) => name);
const env = {
  KEY_MANAGER: {
    idFromName,
    get: () => ({ getAllOIDCPublicKeysRpc: async () => keys }),
  },
} as unknown as Env;

const validate = (token: string, tenantId = TENANT) =>
  validateOpAccessToken(env, token, { issuer: ISSUER, tenantId, now: NOW * 1000 });
const failure = (error: string) => ({ valid: false, error });

beforeEach(() => {
  vi.clearAllMocks();
  core.logger.module.mockReturnValue(core.logger);
  keys = [publicJwk];
  core.resolveIssuedTokenAccount.mockResolvedValue({ ok: true, userId: 'account-1' });
  core.resolveTenantMetadataContext.mockResolvedValue({ coreDb: 'core-db' });
  core.findOAuthClientConsentRevocation.mockResolvedValue('consent-state');
  core.isAccessTokenConsentWithdrawn.mockReturnValue(false);
});

describe('validateOpAccessToken: request and header', () => {
  it('names its logger module', () => {
    expect(loggerModuleNames).toContain('VCI-OP-TOKEN');
  });

  it('accepts a wallet grant and reports exactly its facts', async () => {
    const token = await sign();
    expect(await validate(token)).toEqual({
      valid: true,
      userId: 'account-1',
      tenantId: TENANT,
      clientId: 'wallet-1',
      jti: 'jti-1',
      scopes: ['credential', 'openid'],
      jkt: JKT,
      expiresAt: NOW + 300,
    });
    expect(idFromName).toHaveBeenCalledWith('acme-v3');
    expect(core.resolveIssuedTokenAccount).toHaveBeenCalledWith(
      env,
      TENANT,
      'wallet-1',
      expect.objectContaining({ sub: 'user-1' }),
      false
    );
    expect(core.resolveTenantMetadataContext).toHaveBeenCalledWith(env, TENANT);
    expect(core.findOAuthClientConsentRevocation).toHaveBeenCalledWith('core-db', {
      tenantId: TENANT,
      userId: 'account-1',
      clientId: 'wallet-1',
    });
    expect(core.isAccessTokenConsentWithdrawn).toHaveBeenCalledWith(
      'consent-state',
      expect.objectContaining({ jti: 'jti-1' })
    );
  });

  it('refuses a blank tenant', async () => {
    expect(await validate(await sign(), '  ')).toEqual(failure('Missing tenant'));
  });

  it('bounds the token size', async () => {
    expect(await validate('')).toEqual(failure('Token too large'));
    expect(await validate('x'.repeat(8 * 1024 + 1))).toEqual(failure('Token too large'));
    expect(await validate('x'.repeat(8 * 1024))).toEqual(failure('Invalid token format'));
  });

  it('refuses a token that is not a JWT', async () => {
    expect(await validate('not-a-jwt')).toEqual(failure('Invalid token format'));
  });

  it.each([
    ['no kid', { kid: undefined }],
    ['an empty kid', { kid: '' }],
    ['a numeric kid', { kid: 7 }],
    ['another typ', { typ: 'at+jwt' }],
    ['no typ', { typ: undefined }],
    ['a different alg', { alg: 'PS256' }],
    ['no alg', { alg: undefined }],
    ['an embedded jwk', { jwk: { kty: 'RSA' } }],
    ['an x5c chain', { x5c: ['AAAA'] }],
    ['a jku', { jku: 'https://evil.example/keys' }],
    ['a crit list', { crit: ['exp'] }],
  ])('refuses a header with %s', async (_name, header) => {
    const base = { alg: 'RS256', typ: 'JWT', kid: 'op-key' };
    expect(await validate(forged({ ...base, ...header }))).toEqual(failure('Invalid token header'));
  });

  it('accepts only an RSA signing key of the tenant OP that fits RS256', async () => {
    const token = await sign();
    for (const key of [
      { ...publicJwk, kid: 'other' },
      { ...publicJwk, kty: 'EC' },
      { ...publicJwk, d: 'private' },
      { ...publicJwk, use: 'enc' },
      { ...publicJwk, alg: 'RS512' },
    ]) {
      keys = [key];
      expect(await validate(token)).toEqual(failure('Unknown signing key'));
    }
    for (const key of [
      { ...publicJwk, use: 'sig', alg: 'RS256' },
      { ...publicJwk, use: 'sig' },
      { ...publicJwk, alg: 'RS256' },
    ]) {
      keys = [key];
      expect((await validate(token)).valid).toBe(true);
    }
  });

  it('hides verification and key service failures behind a generic error', async () => {
    expect(await validate(await sign({ iss: 'https://evil.example' }))).toEqual(
      failure('Token validation failed')
    );
    expect(await validate(await sign({ aud: 'https://evil.example' }))).toEqual(
      failure('Token validation failed')
    );
    expect(await validate(await sign({ exp: NOW - 6 }))).toEqual(
      failure('Token validation failed')
    );
    expect((await validate(await sign({ exp: NOW - 4 }))).valid).toBe(true);
    const failing = {
      KEY_MANAGER: {
        idFromName,
        get: () => ({
          getAllOIDCPublicKeysRpc: async () => {
            throw new TypeError('down');
          },
        }),
      },
    } as unknown as Env;
    expect(
      await validateOpAccessToken(failing, await sign(), { issuer: ISSUER, tenantId: TENANT })
    ).toEqual(failure('Token validation failed'));
    expect(core.logger.warn).toHaveBeenCalledWith('OP access token validation failed', {
      reason: 'TypeError',
    });
  });
});

describe('validateOpAccessToken: claims', () => {
  it('requires the issuer as the only audience', async () => {
    expect(await validate(await sign({ aud: [ISSUER, 'https://other.example'] }))).toEqual(
      failure('Invalid audience')
    );
    expect((await validate(await sign({ aud: [ISSUER] }))).valid).toBe(true);
  });

  it.each([
    ['token_use', { token_use: 'refresh' }, 'Not an access token'],
    ['a missing token_use', { token_use: undefined }, 'Not an access token'],
    ['attestation false', { attestation_authenticated: false }, 'Not a wallet grant'],
    ['attestation as a string', { attestation_authenticated: 'true' }, 'Not a wallet grant'],
    ['no sub', { sub: undefined }, 'Missing subject'],
    ['an empty sub', { sub: '' }, 'Missing subject'],
    ['a numeric sub', { sub: 5 }, 'Missing subject'],
    ['no client', { client_id: undefined }, 'Missing client'],
    ['an empty client', { client_id: '' }, 'Missing client'],
    ['a numeric client', { client_id: 5 }, 'Missing client'],
    ['no jti', { jti: undefined }, 'Missing jti'],
    ['an empty jti', { jti: '' }, 'Missing jti'],
    ['a numeric jti', { jti: 5 }, 'Missing jti'],
    ['no exp', { exp: undefined }, 'Missing expiry'],
    ['no cnf', { cnf: undefined }, 'Token is not DPoP-bound'],
    ['no jkt', { cnf: {} }, 'Token is not DPoP-bound'],
    ['a numeric jkt', { cnf: { jkt: 5 } }, 'Token is not DPoP-bound'],
    ['a short jkt', { cnf: { jkt: 'A'.repeat(42) } }, 'Token is not DPoP-bound'],
    ['a prefixed jkt', { cnf: { jkt: `x${JKT}` } }, 'Token is not DPoP-bound'],
    ['a suffixed jkt', { cnf: { jkt: `${JKT}x` } }, 'Token is not DPoP-bound'],
    [
      'a jkt with a bad character',
      { cnf: { jkt: `${'A'.repeat(42)}+` } },
      'Token is not DPoP-bound',
    ],
  ])('refuses %s', async (_name, overrides, error) => {
    expect(await validate(await sign(overrides))).toEqual(failure(error));
  });

  it('accepts url-safe jkt characters and reads a missing scope as none', async () => {
    const jkt = `${'a-_9'.repeat(10)}AB-`;
    const result = await validate(await sign({ cnf: { jkt }, scope: undefined }));
    expect(result).toMatchObject({ valid: true, jkt, scopes: [] });
  });

  it('refuses a subject the OP cannot resolve to an account', async () => {
    core.resolveIssuedTokenAccount.mockResolvedValue({ ok: false });
    expect(await validate(await sign())).toEqual(failure('Subject unavailable'));
    expect(core.findOAuthClientConsentRevocation).not.toHaveBeenCalled();
  });

  it('refuses a token whose consent was withdrawn', async () => {
    core.isAccessTokenConsentWithdrawn.mockReturnValue(true);
    expect(await validate(await sign())).toEqual(failure('Consent withdrawn'));
  });
});

describe('checkOpTokenRevocation', () => {
  const JTI = 'jti/with space';
  const URL = 'http://internal/check?jti=jti%2Fwith%20space';
  const answer = (body: unknown, ok = true) => ({ ok, json: async () => body });
  const legacyName = 'tenant:acme:token-revocation';
  const legacyFetch = vi.fn();
  const legacyIdFromName = vi.fn((name: string) => `id:${name}`);

  function coreEnv(options: { store?: boolean; instanceName?: string; first: unknown }) {
    const fetch = vi.fn(async () => options.first);
    core.getRevocationStoreByJti.mockResolvedValue({
      stub: { fetch },
      instanceName: options.instanceName ?? 'sharded-instance',
    });
    const store =
      options.store === false
        ? undefined
        : { idFromName: legacyIdFromName, get: () => ({ fetch: legacyFetch }) };
    return { env: { TOKEN_REVOCATION_STORE: store } as unknown as Env, fetch };
  }
  const check = (env: Env) => checkOpTokenRevocation(env, JTI, TENANT);

  beforeEach(() => {
    legacyFetch.mockReset();
  });

  it('is unknown without a revocation store', async () => {
    const { env: e } = coreEnv({ store: false, first: answer({ revoked: false }) });
    expect(await check(e)).toBe('unknown');
    expect(core.getRevocationStoreByJti).not.toHaveBeenCalled();
  });

  it('asks the shard of the token with an encoded jti', async () => {
    const { env: e, fetch } = coreEnv({ first: answer({ revoked: true }) });
    expect(await check(e)).toBe('revoked');
    expect(core.getRevocationStoreByJti).toHaveBeenCalledWith(e, JTI, TENANT);
    expect(fetch).toHaveBeenCalledWith(URL);
    expect(legacyFetch).not.toHaveBeenCalled();
  });

  it('is unknown for a failed call or an answer that is not a boolean', async () => {
    expect(await check(coreEnv({ first: answer({}, false) }).env)).toBe('unknown');
    expect(await check(coreEnv({ first: answer({ revoked: false }, false) }).env)).toBe('unknown');
    expect(await check(coreEnv({ first: answer({}) }).env)).toBe('unknown');
    expect(await check(coreEnv({ first: answer({ revoked: 'false' }) }).env)).toBe('unknown');
    expect(await check(coreEnv({ first: answer({ revoked: 0 }) }).env)).toBe('unknown');
  });

  it('is unknown when the lookup throws', async () => {
    const { env: e } = coreEnv({ first: answer({ revoked: false }) });
    core.getRevocationStoreByJti.mockRejectedValue(new Error('down'));
    expect(await check(e)).toBe('unknown');
  });

  it('is active when the shard is the tenant-wide instance and answers false', async () => {
    const { env: e } = coreEnv({ instanceName: legacyName, first: answer({ revoked: false }) });
    expect(await check(e)).toBe('active');
    expect(legacyFetch).not.toHaveBeenCalled();
  });

  it('also asks the legacy tenant-wide instance and reads its answer', async () => {
    const run = async (legacy: unknown) => {
      legacyFetch.mockResolvedValue(legacy);
      return check(coreEnv({ first: answer({ revoked: false }) }).env);
    };
    expect(await run(answer({ revoked: false }))).toBe('active');
    expect(legacyIdFromName).toHaveBeenCalledWith(legacyName);
    expect(legacyFetch).toHaveBeenCalledWith(URL);
    expect(await run(answer({ revoked: true }))).toBe('revoked');
    expect(await run(answer({ revoked: false }, false))).toBe('unknown');
    expect(await run(answer({}))).toBe('unknown');
    expect(await run(answer({ revoked: 'no' }))).toBe('unknown');
  });
});
