/**
 * Token Exchange: actor tokens (delegation), and the token issued: its act and cnf claims, its
 * signing key (the KeyManager key cache), the response and the issuance event.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, importJWK, jwtVerify } from 'jose';
import {
  ISSUER,
  SERVICE_CLIENT,
  baseClient,
  body,
  configKv,
  exchangeContext,
  expectError,
  issuedClaims,
  keyEnv,
  keyEnvParts,
  keySet,
  m,
  resetExchange,
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

const AT_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const withActor = { actor_token: 'actor-token', actor_token_type: AT_TYPE };
const ACTOR_REVOKED = 'Actor token is invalid or revoked';

async function exchange(bodyOverrides: Record<string, unknown> = {}): Promise<Response> {
  return tokenHandler(exchangeContext(bodyOverrides, { env: await keyEnv() }));
}

/** The subject token parses as `subject`, the actor token as `actor`. */
function tokens(subject: Record<string, unknown>, actor: Record<string, unknown>): void {
  m.parseToken.mockImplementation((token: string) => {
    if (token === 'subject-token') return subject;
    if (token === 'actor-token') return actor;
    throw new Error('not a JWT');
  });
}

const clientActor = (overrides: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  sub: 'client:actor-app',
  client_id: 'actor-app',
  aud: [SERVICE_CLIENT],
  token_use: 'access',
  jti: 'actor-jti',
  exp: Math.floor(Date.now() / 1000) + 300,
  ...overrides,
});

function useClients(extra: Record<string, Record<string, unknown>> = {}): void {
  const clients: Record<string, Record<string, unknown>> = {
    [SERVICE_CLIENT]: baseClient(),
    'actor-app': { client_id: 'actor-app' },
    ...extra,
  };
  m.getClientCached.mockImplementation(
    async (_c: unknown, _e: unknown, id: string) => clients[id] ?? null
  );
}

describe('actor tokens', () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    resetExchange();
    useClients();
  });

  it('makes the client the actor when only an actor token type is sent', async () => {
    tokens(userSubject(), clientActor());
    const response = await exchange({ actor_token_type: AT_TYPE });
    expect(response.status).toBe(200);
    expect(issuedClaims().act).toEqual({
      sub: `client:${SERVICE_CLIENT}`,
      client_id: SERVICE_CLIENT,
    });
  });

  it('verifies the actor token for its signature and issuer, then names it the actor', async () => {
    tokens(userSubject({ act: { sub: 'first-actor' } }), clientActor());
    expect((await exchange(withActor)).status).toBe(200);
    expect(m.verifyToken).toHaveBeenLastCalledWith('actor-token', expect.anything(), ISSUER, {
      skipAudienceCheck: true,
    });
    expect(issuedClaims().act).toEqual({
      sub: 'client:actor-app',
      client_id: 'actor-app',
      act: { sub: 'first-actor' },
    });
  });

  it('nests no more than one earlier actor', async () => {
    tokens(userSubject({ act: { sub: 'a', act: { sub: 'b' } } }), clientActor());
    expect((await exchange(withActor)).status).toBe(200);
    expect(issuedClaims().act).toEqual({ sub: 'client:actor-app', client_id: 'actor-app' });
  });

  it('refuses an actor token bound to a key the request does not prove', async () => {
    tokens(userSubject(), clientActor({ cnf: { jkt: 'someone-elses-key' } }));
    await expectError(
      await exchange(withActor),
      400,
      'invalid_grant',
      'Actor token sender binding does not match'
    );
  });

  it('carries the certificate binding of the actor token on', async () => {
    m.getPresentedClientCertificateThumbprint.mockResolvedValue('actor-tp');
    tokens(userSubject(), clientActor({ cnf: { 'x5t#S256': 'actor-tp' } }));
    expect((await exchange(withActor)).status).toBe(200);
    expect(issuedClaims().cnf).toEqual({ 'x5t#S256': 'actor-tp' });
  });

  it('refuses an Authrim actor token issued to no client', async () => {
    tokens(userSubject(), clientActor({ client_id: undefined }));
    await expectError(await exchange(withActor), 400, 'invalid_grant', ACTOR_REVOKED);
  });

  it('refuses an actor token that is not an access token', async () => {
    tokens(userSubject(), clientActor({ token_use: 'refresh' }));
    await expectError(
      await exchange(withActor),
      400,
      'invalid_grant',
      'Actor token is not an access token'
    );
  });

  it('accepts an actor token that has not yet expired and refuses one that has', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-19T00:00:00Z'));
    const now = Math.floor(Date.now() / 1000);
    tokens(userSubject({ exp: now + 60 }), clientActor({ exp: now + 1 }));
    expect((await exchange(withActor)).status).toBe(200);
    m.createAccessToken.mockClear();
    tokens(userSubject({ exp: now + 60 }), clientActor({ exp: now - 1 }));
    await expectError(await exchange(withActor), 400, 'invalid_grant', 'Actor token has expired');
  });

  it('does not hold a client principal actor to user token rules', async () => {
    m.derivedSubject.value = 'mapped-sub';
    tokens(userSubject(), clientActor());
    expect((await exchange(withActor)).status).toBe(200);
  });

  it("refuses another app's user token as the actor when its sub would differ", async () => {
    m.derivedSubject.value = 'mapped-sub';
    tokens(userSubject(), clientActor({ sub: 'user-2' }));
    await expectError(await exchange(withActor), 400, 'invalid_grant', ACTOR_REVOKED);
  });

  it("accepts another app's user token as the actor when the sub is the user id", async () => {
    m.derivedSubject.value = 'user-2';
    tokens(userSubject(), clientActor({ sub: 'user-2' }));
    expect((await exchange(withActor)).status).toBe(200);
    expect(issuedClaims().act).toMatchObject({ sub: 'user-2', client_id: 'actor-app' });
  });
});

describe('the issued token', () => {
  beforeEach(() => resetExchange());

  it('carries only the claims that apply, and is announced', async () => {
    const context = exchangeContext({}, { env: await keyEnv() });
    const before = Math.floor(Date.now() / 1000);
    const response = await tokenHandler(context);
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      access_token: 'exchanged-access-token',
      issued_token_type: AT_TYPE,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'openid profile',
    });
    const claims = issuedClaims();
    for (const absent of ['cnf', 'resource', 'authorization_details']) {
      expect(claims).not.toHaveProperty(absent);
    }
    expect(m.createAccessToken).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'kid-main',
      3600,
      'region-jti-1'
    );
    expect(context.res.headers.get('Cache-Control')).toBe('no-store');
    expect(context.res.headers.get('Pragma')).toBe('no-cache');

    expect(m.publishEvent).toHaveBeenCalledTimes(1);
    const event = m.publishEvent.mock.calls[0][1] as { data: { expiresAt: number } };
    expect(event).toMatchObject({
      type: 'token.access.issued',
      tenantId: 'default',
      data: {
        jti: 'at-jti-1',
        clientId: SERVICE_CLIENT,
        userId: 'user-1',
        scopes: ['openid', 'profile'],
        grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
      },
    });
    expect(event.data.expiresAt).toBeGreaterThanOrEqual(before + 3600);
    expect(event.data.expiresAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 3600);
  });

  it('names no external issuer for a client principal subject', async () => {
    m.parseToken.mockReturnValue(userSubject({ sub: `client:${SERVICE_CLIENT}` }));
    expect((await exchange()).status).toBe(200);
    expect(issuedClaims()).not.toHaveProperty('authrim_subject_issuer');
  });

  it('is never longer lived than the tenant profile allows', async () => {
    m.loadTenantProfileCached.mockResolvedValue({
      allows_token_exchange: true,
      max_token_ttl_seconds: 600,
    });
    expect((await body(await exchange())).expires_in).toBe(600);
  });

  it('is bound to both the DPoP key and an inherited certificate', async () => {
    m.extractDPoPProof.mockReturnValue('dpop-proof');
    m.getPresentedClientCertificateThumbprint.mockResolvedValue('tp');
    m.parseToken.mockReturnValue(userSubject({ cnf: { 'x5t#S256': 'tp' } }));
    expect((await exchange()).status).toBe(200);
    expect(issuedClaims().cnf).toEqual({ jkt: 'dpop-jkt', 'x5t#S256': 'tp' });
  });

  it('is signed with a fresh key after an emergency key rotation', async () => {
    const { env, getActiveKey } = await keyEnvParts();
    expect((await tokenHandler(exchangeContext({}, { env }))).status).toBe(200);
    const afterFirst = getActiveKey.mock.calls.length;

    // Same key version: the cached key is used.
    expect((await tokenHandler(exchangeContext({}, { env }))).status).toBe(200);
    expect(getActiveKey).toHaveBeenCalledTimes(afterFirst);

    // A new key version (emergency rotation): the key is fetched again, and the rotated key
    // (kid and private key) is what signs the token.
    const rotatedKeys = await keySet('kid-rotated');
    getActiveKey.mockResolvedValue({ kid: 'kid-rotated', privatePEM: rotatedKeys.privatePEM });
    m.createAccessToken.mockClear();
    const rotated = exchangeContext({}, { env });
    await configKv(rotated).put('v1:key-version:default', 'v2');
    expect((await tokenHandler(rotated)).status).toBe(200);
    expect(getActiveKey).toHaveBeenCalledTimes(afterFirst + 1);
    const [, signingKey, kid] = m.createAccessToken.mock.calls[0] as [unknown, CryptoKey, string];
    expect(kid).toBe('kid-rotated');
    // The private key is not extractable: prove which key it is by verifying a signature.
    const probe = await new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).sign(signingKey);
    await expect(
      jwtVerify(probe, await importJWK(rotatedKeys.publicJWK, 'RS256'))
    ).resolves.toBeDefined();
    await expect(
      jwtVerify(probe, await importJWK((await keySet('kid-main')).publicJWK, 'RS256'))
    ).rejects.toThrow();
  });

  it('is not issued when the signing key cannot be loaded', async () => {
    const { env, getActiveKey } = await keyEnvParts();
    getActiveKey.mockRejectedValue(new Error('DO down'));
    const context = exchangeContext({}, { env });
    await configKv(context).put('v1:key-version:default', 'v-unloadable');
    await expectError(
      await tokenHandler(context),
      500,
      'server_error',
      'Failed to load signing key'
    );
  });
});
