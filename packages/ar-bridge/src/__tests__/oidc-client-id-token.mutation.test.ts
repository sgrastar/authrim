/**
 * OIDCRPClient: ID token validation, claim by claim.
 */
import * as jose from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { argRec, callArg, rec } from './helpers/mock-args';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn<(url: string, options?: RequestInit) => Promise<Response>>(),
  jwtVerify: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  warn: vi.fn(),
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
  readResponseTextWithLimit: async (response: Response) => response.text(),
}));
vi.mock('jose', async (importOriginal) => ({
  ...(await importOriginal<typeof import('jose')>()),
  jwtVerify: (...args: unknown[]) => mocks.jwtVerify(...args),
  createLocalJWKSet: () => () => undefined,
}));

import { OIDCRPClient, type OIDCRPClientConfig } from '../clients/oidc-client';
import type {} from '../types';

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
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_S * 1000);
  mocks.fetch.mockImplementation(async () => json(DISCOVERY));
});
afterEach(() => vi.useRealTimers());

const fetchedUrls = () => mocks.fetch.mock.calls.map((call) => String(call[0]));

describe('validateIdToken', () => {
  const claims = (overrides: Record<string, unknown> = {}) => ({
    iss: ISSUER,
    aud: 'client-1',
    sub: 'user-1',
    nonce: 'no',
    exp: NOW_S + 300,
    iat: NOW_S - 10,
    ...overrides,
  });
  const verified = (payload: Record<string, unknown>, alg = 'RS256') =>
    mocks.jwtVerify.mockResolvedValue({ payload, protectedHeader: { alg } });
  const jwksResponse = () => json({ keys: [] });
  const validate = (
    c: OIDCRPClient,
    options: Record<string, unknown> = {},
    diagnostics?: unknown
  ) => c.validateIdToken('id.token', { nonce: 'no', ...options }, diagnostics as never);
  const c = () => client({ jwksUri: `${ISSUER}/jwks` });

  beforeEach(() => {
    mocks.fetch.mockImplementation(async () => jwksResponse());
    verified(claims());
  });

  it('returns the claims as user info and verifies issuer and audience', async () => {
    const info = await validate(c());
    expect(info).toMatchObject({ sub: 'user-1', iss: ISSUER });
    expect(mocks.jwtVerify).toHaveBeenCalledWith('id.token', expect.anything(), {
      issuer: ISSUER,
      audience: 'client-1',
    });
  });

  it('accepts the legacy nonce-only signature', async () => {
    expect(await c().validateIdToken('id.token', 'no')).toMatchObject({ sub: 'user-1' });
    await expect(c().validateIdToken('id.token', 'other')).rejects.toThrow(
      'ID token nonce mismatch'
    );
  });

  it('caches the key set for an hour and can drop the cache', async () => {
    verified(claims({ exp: NOW_S + 5000, iat: NOW_S - 10 }));
    const client1 = c();
    await validate(client1);
    await validate(client1);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(callArg(mocks.fetch, 0, 0)).toBe(`${ISSUER}/jwks`);
    expect(argRec(mocks.fetch, 0, 1)).toEqual({ timeoutMs: 5000, maxResponseSize: 256 * 1024 });
    vi.setSystemTime(NOW_S * 1000 + 3_599_999);
    await validate(client1);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW_S * 1000 + 3_600_000);
    await validate(client1);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    client1.clearJWKSCache();
    await validate(client1);
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
  });

  it('discovers the key set URL when none is configured, and refuses an unsafe one', async () => {
    mocks.fetch.mockImplementation(async (url: string) =>
      url.endsWith('/jwks') ? jwksResponse() : json(DISCOVERY)
    );
    await validate(client());
    expect(fetchedUrls()).toEqual([`${ISSUER}/.well-known/openid-configuration`, `${ISSUER}/jwks`]);
    await expect(validate(client({ jwksUri: 'http://op.example/jwks' }))).rejects.toThrow(
      'jwks_uri is not safe to fetch'
    );
  });

  it('requires the signing algorithm to be one the provider advertises', async () => {
    verified(claims(), 'RS256');
    await expect(validate(c(), { expectedSigningAlgorithms: ['ES256'] })).rejects.toThrow(
      'ID token signing algorithm is not allowed by provider metadata'
    );
    expect(await validate(c(), { expectedSigningAlgorithms: ['ES256', 'RS256'] })).toBeTruthy();
  });

  it.each([
    [{ iss: undefined }, 'ID token missing required iss claim'],
    [{ iss: 5 }, 'ID token missing required iss claim'],
    [{ aud: undefined }, 'ID token missing required aud claim'],
    [{ nonce: 'wrong' }, 'ID token nonce mismatch'],
    [{ nonce: undefined }, 'ID token nonce mismatch'],
    [{ exp: undefined }, 'ID token missing required exp claim'],
    [{ exp: null }, 'ID token missing required exp claim'],
    [{ exp: NOW_S - 1 }, 'ID token expired'],
    [{ iat: undefined }, 'ID token missing required iat claim'],
    [{ iat: null }, 'ID token missing required iat claim'],
    [{ iat: NOW_S + 61 }, 'ID token issued in the future'],
    [{ sub: undefined }, 'ID token missing required sub claim'],
    [{ sub: '' }, 'ID token missing required sub claim'],
    [{ sub: '   ' }, 'ID token missing required sub claim'],
    [{ sub: 5 }, 'ID token missing required sub claim'],
    [{ azp: 'someone-else' }, 'ID token azp does not match expected client_id'],
  ])('refuses claims %j', async (change, message) => {
    verified(claims(change));
    await expect(validate(c())).rejects.toThrow(message);
  });

  it('accepts an issue time exactly one minute ahead, and an expiry one second ahead', async () => {
    // (An expiry equal to now is refused by the real jose before these checks: see the real-jose tests.)
    verified(claims({ exp: NOW_S + 1, iat: NOW_S + 60 }));
    expect(await validate(c())).toBeTruthy();
  });

  it('accepts a matching azp, and several audiences only when the extra ones are trusted', async () => {
    verified(claims({ azp: 'client-1' }));
    expect(await validate(c())).toBeTruthy();
    verified(claims({ aud: ['client-1', 'other'] }));
    await expect(validate(c())).rejects.toThrow(
      'ID token audience contains an audience that is not trusted'
    );
    const trusting = (audiences: string[]) =>
      client({ jwksUri: `${ISSUER}/jwks`, trustedAudiences: audiences });
    expect(await validate(trusting(['other']))).toBeTruthy();
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    mocks.warn.mockClear();
    await expect(validate(trusting(['someone-else']))).rejects.toThrow('not trusted');
    verified(claims({ aud: ['client-1', 'other', 'third'] }));
    await expect(validate(trusting(['other']))).rejects.toThrow('not trusted');
    expect(await validate(trusting(['third', 'other']))).toBeTruthy();
    mocks.warn.mockClear();
    verified(claims({ aud: ['client-1', 'other'], azp: 'client-1' }));
    await validate(trusting(['other']));
    verified(claims({ aud: ['client-1'] }));
    await validate(c());
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('takes the trusted audiences from the provider quirks, string entries only', async () => {
    verified(claims({ aud: ['client-1', 'other'] }));
    const fromProvider = (trustedAudiences: unknown) =>
      OIDCRPClient.fromProvider(
        {
          id: 'p1',
          name: 'Corp',
          providerType: 'oidc',
          issuer: ISSUER,
          clientId: 'client-1',
          scopes: 'openid',
          jwksUri: `${ISSUER}/jwks`,
          providerQuirks: { trustedAudiences },
        } as never,
        'https://rp.example/cb',
        's'
      );
    expect(await validate(fromProvider(['other', 5, '']))).toBeTruthy();
    await expect(validate(fromProvider(['x', 5]))).rejects.toThrow('not trusted');
    await expect(validate(fromProvider('other'))).rejects.toThrow('not trusted');
  });

  it('can require the audience to be exactly the client', async () => {
    verified(claims({ aud: ['client-1', 'other'] }));
    await expect(validate(c(), { requireExactAudience: true })).rejects.toThrow(
      'ID token audience must contain only the expected client_id'
    );
    verified(claims({ aud: ['other'] }));
    await expect(validate(c(), { requireExactAudience: true })).rejects.toThrow(
      'ID token audience must contain only the expected client_id'
    );
    verified(claims({ aud: 'other' }));
    await expect(validate(c(), { requireExactAudience: true })).rejects.toThrow(
      'ID token audience must contain only the expected client_id'
    );
    verified(claims({ aud: ['client-1'] }));
    expect(await validate(c(), { requireExactAudience: true })).toBeTruthy();
    verified(claims({ aud: 'client-1' }));
    expect(await validate(c(), { requireExactAudience: true })).toBeTruthy();
  });

  describe('max_age', () => {
    it('requires auth_time within max_age plus a minute of skew', async () => {
      verified(claims({ auth_time: NOW_S - 360 }));
      expect(await validate(c(), { maxAge: 300 })).toBeTruthy();
      verified(claims({ auth_time: NOW_S - 361 }));
      await expect(validate(c(), { maxAge: 300 })).rejects.toThrow(
        'Authentication is too old: auth_time was 361 seconds ago, max_age is 300'
      );
      verified(claims());
      await expect(validate(c(), { maxAge: 300 })).rejects.toThrow(
        'ID token missing auth_time claim (required when max_age is requested)'
      );
    });

    it('checks max_age 0 and ignores auth_time when none was requested', async () => {
      verified(claims({ auth_time: NOW_S - 61 }));
      await expect(validate(c(), { maxAge: 0 })).rejects.toThrow('Authentication is too old');
      expect(await validate(c())).toBeTruthy();
    });
  });

  describe('acr_values', () => {
    it('requires the returned acr to be one of the requested values', async () => {
      verified(claims({ acr: 'urn:b' }));
      expect(await validate(c(), { acrValues: 'urn:a   urn:b' })).toBeTruthy();
      await expect(validate(c(), { acrValues: 'urn:a urn:c' })).rejects.toThrow(
        'ID token acr (urn:b) does not match any requested acr_values: urn:a, urn:c'
      );
      verified(claims());
      await expect(validate(c(), { acrValues: 'urn:a urn:b' })).rejects.toThrow(
        'ID token missing acr claim. Requested acr_values: urn:a, urn:b'
      );
    });

    it('has nothing to check for blank requested values', async () => {
      expect(await validate(c(), { acrValues: '   ' })).toBeTruthy();
    });
  });

  describe('token hashes', () => {
    const halfHash = async (value: string, algorithm: string) => {
      const digest = new Uint8Array(
        await crypto.subtle.digest(algorithm, new TextEncoder().encode(value))
      );
      return jose.base64url.encode(digest.slice(0, digest.length / 2));
    };

    it.each([
      ['RS256', 'SHA-256'],
      ['ES384', 'SHA-384'],
      ['PS512', 'SHA-512'],
      ['EdDSA', 'SHA-256'],
      ['XX999', 'SHA-256'],
    ])('checks at_hash and c_hash for %s with %s', async (alg, hash) => {
      verified(
        claims({
          at_hash: await halfHash('access-token', hash),
          c_hash: await halfHash('auth-code', hash),
        }),
        alg
      );
      expect(await validate(c(), { accessToken: 'access-token', code: 'auth-code' })).toBeTruthy();
      await expect(validate(c(), { accessToken: 'other-token' })).rejects.toThrow(
        'at_hash validation failed'
      );
      await expect(validate(c(), { code: 'other-code' })).rejects.toThrow(
        'c_hash validation failed'
      );
    });

    it('does not check a hash that is absent, or a token that was not given', async () => {
      verified(claims({ at_hash: 'bogus', c_hash: 'bogus' }));
      expect(await validate(c())).toBeTruthy();
      verified(claims());
      expect(await validate(c(), { accessToken: 'at', code: 'c' })).toBeTruthy();
    });

    it('requires c_hash when the flow demands it', async () => {
      await expect(validate(c(), { requireCodeHash: true })).rejects.toThrow(
        'ID token missing required c_hash claim'
      );
      verified(claims({ c_hash: await halfHash('auth-code', 'SHA-256') }));
      expect(await validate(c(), { requireCodeHash: true, code: 'auth-code' })).toBeTruthy();
    });
  });

  describe('Microsoft multi-tenant issuers', () => {
    const ms = (tenantType: string) =>
      client({
        issuer: 'https://login.microsoftonline.com/common/v2.0',
        jwksUri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
        providerQuirks: { tenantType },
      });
    it.each(['common', 'consumers', 'organizations'])(
      'accepts a tenant-specific issuer for %s without matching the generic one',
      async (tenantType) => {
        verified(
          claims({
            iss: 'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0',
          })
        );
        expect(await validate(ms(tenantType))).toBeTruthy();
        expect(rec(argRec(mocks.jwtVerify, 0, 2)).issuer).toBeUndefined();
      }
    );

    it('refuses an issuer outside the Microsoft pattern, and keeps strict checks otherwise', async () => {
      verified(claims({ iss: 'https://login.microsoftonline.com.evil.example/abc/v2.0' }));
      await expect(validate(ms('common'))).rejects.toThrow('Invalid Microsoft issuer');
      verified(claims({ iss: 'https://login.microsoftonline.com/abc/v2.0/extra' }));
      await expect(validate(ms('common'))).rejects.toThrow('Invalid Microsoft issuer');
      mocks.jwtVerify.mockClear();
      verified(claims({ iss: 'https://login.microsoftonline.com/abc/v2.0' }));
      await validate(ms('tenant-guid'));
      expect(rec(argRec(mocks.jwtVerify, 0, 2)).issuer).toBe(
        'https://login.microsoftonline.com/common/v2.0'
      );
    });
  });

  describe('diagnostics and key rotation', () => {
    const logger = () => ({ logTokenValidation: vi.fn().mockResolvedValue(undefined) });
    const diagnostics = (log: ReturnType<typeof logger>) =>
      ({
        logger: log,
        flowId: 'flow-1',
        requestId: 'req-1',
        diagnosticSessionId: 'diag-1',
      }) as never;

    it('records the validation steps that passed', async () => {
      const log = logger();
      await validate(c(), {}, diagnostics(log));
      const { details, ...entry } = argRec(log.logTokenValidation);
      expect(entry).toEqual({
        diagnosticSessionId: 'diag-1',
        flowId: 'flow-1',
        requestId: 'req-1',
        step: 'id-token-validation',
        tokenType: 'id_token',
        result: 'pass',
      });
      expect(rec(details)).toMatchObject({
        signature_ok: true,
        issuer_ok: true,
        audience_ok: true,
        nonce_ok: true,
        exp_ok: true,
        iat_ok: true,
        azp_ok: true,
        sub_ok: true,
      });
      expect(rec(details)).not.toHaveProperty('auth_time_ok');
      expect(rec(rec(details).claims)).toMatchObject({ iss: ISSUER, sub: 'user-1', nonce: 'no' });
    });

    it('records a failure with its message and rethrows', async () => {
      const log = logger();
      verified(claims({ nonce: 'wrong' }));
      await expect(validate(c(), {}, diagnostics(log))).rejects.toThrow('ID token nonce mismatch');
      expect(log.logTokenValidation).toHaveBeenCalledWith({
        diagnosticSessionId: 'diag-1',
        flowId: 'flow-1',
        requestId: 'req-1',
        step: 'id-token-validation',
        tokenType: 'id_token',
        result: 'fail',
        errorMessage: 'ID token nonce mismatch',
      });
    });

    it('retries once with fresh keys after a signature failure', async () => {
      const log = logger();
      mocks.jwtVerify
        .mockRejectedValueOnce(new Error('signature verification failed'))
        .mockResolvedValueOnce({ payload: claims(), protectedHeader: { alg: 'RS256' } });
      const client1 = c();
      const info = await validate(client1, {}, diagnostics(log));
      expect(info).toMatchObject({ sub: 'user-1' });
      expect(mocks.fetch).toHaveBeenCalledTimes(2);
      expect(mocks.warn).toHaveBeenCalledWith(
        'ID token signature verification failed, refreshing JWKS and retrying...'
      );
      const retried = argRec(log.logTokenValidation);
      expect(retried.result).toBe('pass');
      expect(rec(retried.details)).toMatchObject({ jwks_refreshed: true, signature_ok: true });
    });

    it.each(['JWS is bad', 'no key found', 'bad signature'])(
      'retries for the failure "%s" too',
      async (message) => {
        mocks.jwtVerify
          .mockRejectedValueOnce(new Error(message))
          .mockResolvedValueOnce({ payload: claims(), protectedHeader: { alg: 'RS256' } });
        expect(await validate(c())).toBeTruthy();
        expect(mocks.jwtVerify).toHaveBeenCalledTimes(2);
      }
    );

    it('records the failure of the retry and throws it', async () => {
      const log = logger();
      mocks.jwtVerify.mockRejectedValue(new Error('signature verification failed'));
      await expect(validate(c(), {}, diagnostics(log))).rejects.toThrow(
        'signature verification failed'
      );
      expect(mocks.jwtVerify).toHaveBeenCalledTimes(2);
      expect(log.logTokenValidation).toHaveBeenCalledTimes(1);
      expect(argRec(log.logTokenValidation)).toMatchObject({
        result: 'fail',
        errorMessage: 'signature verification failed',
      });
      mocks.jwtVerify.mockRejectedValue('plain failure');
      mocks.jwtVerify.mockRejectedValueOnce(new Error('JWS invalid'));
      log.logTokenValidation.mockClear();
      await expect(validate(c(), {}, diagnostics(log))).rejects.toBe('plain failure');
      expect(argRec(log.logTokenValidation).errorMessage).toBe('plain failure');
    });

    it('does not retry other failures, and stringifies a non-Error one', async () => {
      const log = logger();
      mocks.jwtVerify.mockRejectedValue('weird');
      await expect(validate(c(), {}, diagnostics(log))).rejects.toBe('weird');
      expect(mocks.jwtVerify).toHaveBeenCalledTimes(1);
      expect(argRec(log.logTokenValidation).errorMessage).toBe('weird');
    });
  });
});
