/**
 * Token Exchange: how the subject token is verified (the verification key from PUBLIC_JWK_JSON or
 * the KeyManager), its expiry, and whether its declared type matches its purpose.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDurableObjectNamespace } from './helpers/mocks';
import {
  ISSUER,
  SERVICE_CLIENT,
  exchangeContext,
  expectError,
  keyEnv,
  keySet,
  m,
  modulusOf,
  resetExchange,
  settingsOverrides,
  userSubject,
} from './helpers/mut-exchange-harness';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const h = await import('./helpers/mut-exchange-harness');
  return h.mockCore(await importOriginal());
});
vi.mock('../external-id-jag-verifier', async () =>
  (await import('./helpers/mut-exchange-harness')).mockJagVerifier()
);

import { tokenHandler } from '../token';

async function exchange(
  bodyOverrides: Record<string, unknown> = {},
  env?: Record<string, unknown>
): Promise<Response> {
  return tokenHandler(exchangeContext(bodyOverrides, { env: env ?? (await keyEnv()) }));
}

/** An env whose KeyManager publishes `jwks`, with PUBLIC_JWK_JSON as given (none by default). */
async function keyManagerEnv(jwks: object[], publicJwkJson?: string) {
  const signing = await keySet('kid-main');
  const keyManager = createMockDurableObjectNamespace({
    rpcMethods: {
      getActiveKeyWithPrivateRpc: vi
        .fn()
        .mockResolvedValue({ kid: 'kid-main', privatePEM: signing.privatePEM }),
      getAllPublicKeysRpc: vi.fn().mockResolvedValue(jwks),
    },
  });
  return { KEY_MANAGER: keyManager, PUBLIC_JWK_JSON: publicJwkJson };
}

async function verifiedWithModulus(): Promise<string | undefined> {
  expect(m.verifyToken).toHaveBeenCalledTimes(1);
  return modulusOf(m.verifyToken.mock.calls[0][1]);
}

const VERIFICATION_FAILED = 'Subject token verification failed';

describe('subject token verification key', () => {
  beforeEach(() => resetExchange());

  it('verifies with the PUBLIC_JWK_JSON key, signature and issuer only', async () => {
    const response = await exchange();
    expect(response.status).toBe(200);
    expect(m.verifyToken).toHaveBeenCalledWith('subject-token', expect.anything(), ISSUER, {
      skipAudienceCheck: true,
      algorithms: ['RS256'],
    });
    expect(await verifiedWithModulus()).toBe((await keySet('kid-main')).publicJWK.n);
  });

  it('reads the tenant KeyManager when PUBLIC_JWK_JSON is not configured', async () => {
    const [a, b] = await Promise.all([keySet('kid-a'), keySet('kid-b')]);
    m.parseTokenHeader.mockReturnValue({ alg: 'RS256', kid: 'kid-b' });
    const env = await keyManagerEnv([a.publicJWK, b.publicJWK]);
    expect((await exchange({}, env)).status).toBe(200);
    expect(await verifiedWithModulus()).toBe(b.publicJWK.n);
    expect(env.KEY_MANAGER.idFromName).toHaveBeenCalledWith('default-v3');
  });

  it('falls back to the KeyManager when PUBLIC_JWK_JSON holds another kid', async () => {
    const [a, b] = await Promise.all([keySet('kid-a'), keySet('kid-b')]);
    m.parseTokenHeader.mockReturnValue({ alg: 'RS256', kid: 'kid-b' });
    const env = await keyManagerEnv([b.publicJWK], JSON.stringify(a.publicJWK));
    expect((await exchange({}, env)).status).toBe(200);
    expect(await verifiedWithModulus()).toBe(b.publicJWK.n);
  });

  it('falls back to the KeyManager when PUBLIC_JWK_JSON cannot be read', async () => {
    const b = await keySet('kid-b');
    m.parseTokenHeader.mockReturnValue({ alg: 'RS256', kid: 'kid-b' });
    const env = await keyManagerEnv([b.publicJWK], '{not json');
    expect((await exchange({}, env)).status).toBe(200);
    expect(await verifiedWithModulus()).toBe(b.publicJWK.n);
  });

  it('names a key without a kid "default"', async () => {
    const b = await keySet('kid-b');
    const { kid: _kid, ...withoutKid } = b.publicJWK as { kid?: string };
    m.parseTokenHeader.mockReturnValue({ alg: 'RS256', kid: 'default' });
    expect((await exchange({}, await keyManagerEnv([withoutKid]))).status).toBe(200);
    expect(await verifiedWithModulus()).toBe(b.publicJWK.n);

    m.verifyToken.mockClear();
    expect(
      (
        await exchange(
          {},
          { ...(await keyManagerEnv([])), PUBLIC_JWK_JSON: JSON.stringify(withoutKid) }
        )
      ).status
    ).toBe(200);
    expect(await verifiedWithModulus()).toBe(b.publicJWK.n);
  });

  it('skips KeyManager keys that cannot be imported', async () => {
    const b = await keySet('kid-b');
    m.parseTokenHeader.mockReturnValue({ alg: 'RS256', kid: 'kid-b' });
    const broken = { kty: 'RSA', kid: 'kid-b', alg: 'RS256' };
    expect((await exchange({}, await keyManagerEnv([broken, b.publicJWK]))).status).toBe(200);
    expect(await verifiedWithModulus()).toBe(b.publicJWK.n);
  });

  it.each([
    ['the kid is not published', async () => [(await keySet('kid-a')).publicJWK]],
    ['no published key can be imported', async () => [{ kty: 'RSA', kid: 'kid-b' }]],
  ])('refuses the subject token when %s', async (_name, jwks) => {
    m.parseTokenHeader.mockReturnValue({ alg: 'RS256', kid: 'kid-b' });
    await expectError(
      await exchange({}, await keyManagerEnv(await jwks())),
      400,
      'invalid_grant',
      VERIFICATION_FAILED
    );
    expect(m.verifyToken).not.toHaveBeenCalled();
  });

  it('refuses the subject token when no key source is configured', async () => {
    await expectError(
      await exchange({}, { KEY_MANAGER: undefined, PUBLIC_JWK_JSON: undefined }),
      400,
      'invalid_grant',
      VERIFICATION_FAILED
    );
  });

  it('refuses an access token signed with an algorithm other than RS256', async () => {
    m.parseTokenHeader.mockReturnValue({ alg: 'ES256', kid: 'kid-main' });
    await expectError(await exchange(), 400, 'invalid_grant', VERIFICATION_FAILED);
    expect(m.verifyToken).not.toHaveBeenCalled();
  });

  it('refuses a subject token whose signature does not verify', async () => {
    m.verifyToken.mockRejectedValue(new Error('signature'));
    await expectError(await exchange(), 400, 'invalid_grant', VERIFICATION_FAILED);
  });
});

describe('subject token expiry', () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => resetExchange());

  it('accepts a token that has not yet expired and refuses one that has', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-19T00:00:00Z'));
    const now = Math.floor(Date.now() / 1000);
    // The signature check (jose) already refuses exp <= now, so only a still-valid token is
    // accepted here; the handler's own check is what refuses an expired one with this message.
    m.parseToken.mockReturnValue(userSubject({ exp: now + 1 }));
    expect((await exchange()).status).toBe(200);

    m.createAccessToken.mockClear();
    m.parseToken.mockReturnValue(userSubject({ exp: now - 1 }));
    await expectError(await exchange(), 400, 'invalid_grant', 'Subject token has expired');
  });
});

describe('subject token purpose', () => {
  beforeEach(() => resetExchange());

  const MISMATCH = 'Subject token type does not match token purpose';
  /** A legacy access token: no token_use, a user id sub, and an access scope. */
  const legacy = (overrides: Record<string, unknown> = {}) =>
    userSubject({ token_use: undefined, authrim_subject_account: true, ...overrides });

  it('accepts a legacy access token that carries an access scope', async () => {
    m.parseToken.mockReturnValue(legacy());
    expect((await exchange()).status).toBe(200);
    m.parseToken.mockReturnValue(legacy({ jti: 'at_rt_suffix' }));
    expect((await exchange()).status).toBe(200);
  });

  it.each([
    ['an empty scope', { scope: '' }],
    ['no scope', { scope: undefined }],
    ['a nonce', { nonce: 'n-1' }],
    ['an at_hash', { at_hash: 'h' }],
    ['a refresh token jti', { jti: 'rt_family' }],
    ['an ID token principal marker', { authrim_subject_principal: 'id_token' }],
  ])('refuses a legacy token with %s', async (_name, overrides) => {
    m.parseToken.mockReturnValue(legacy(overrides));
    await expectError(await exchange(), 400, 'invalid_grant', MISMATCH);
  });

  it.each([
    [
      'an ID token as an access token',
      'urn:ietf:params:oauth:token-type:access_token',
      { token_use: 'id' },
    ],
    ['an ID token as a JWT', 'urn:ietf:params:oauth:token-type:jwt', { token_use: 'id' }],
    ['a refresh token as a JWT', 'urn:ietf:params:oauth:token-type:jwt', { token_use: 'refresh' }],
    ['a token with a refresh version', 'urn:ietf:params:oauth:token-type:jwt', { rtv: 1 }],
  ])('refuses %s', async (_name, type, overrides) => {
    settingsOverrides.tokens = {
      'tokens.exchange_allowed_subject_token_types': 'access_token,jwt',
    };
    m.parseToken.mockReturnValue(userSubject(overrides));
    await expectError(await exchange({ subject_token_type: type }), 400, 'invalid_grant', MISMATCH);
  });

  it('accepts an access token declared as a JWT', async () => {
    settingsOverrides.tokens = { 'tokens.exchange_allowed_subject_token_types': 'jwt' };
    expect(
      (await exchange({ subject_token_type: 'urn:ietf:params:oauth:token-type:jwt' })).status
    ).toBe(200);
  });

  it('refuses a subject token issued to no client', async () => {
    m.parseToken.mockReturnValue(userSubject({ client_id: undefined }));
    await expectError(
      await exchange(),
      400,
      'invalid_grant',
      'Subject token is invalid or revoked'
    );
  });

  it('takes the issuing client from azp when the token has no client_id', async () => {
    m.parseToken.mockReturnValue(userSubject({ client_id: undefined, azp: SERVICE_CLIENT }));
    expect((await exchange()).status).toBe(200);
  });
});
