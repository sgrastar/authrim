/**
 * Check API authentication: access token (JWT) verification
 * (mutation-hardening tests using real RS256 signatures).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import { SUBJECT_REFERENCE_CLAIM } from '@authrim/ar-lib-core';
import { authenticateCheckApiRequest, type CheckAuthResult } from '../check-auth';
import {
  ACCESS_CLAIMS,
  ISSUER,
  jwtContext,
  newEcSigningKey,
  newSigningKey,
  signJwt,
  type SigningKey,
} from './check-auth-mutation-helpers';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createLogger: () => ({
      module: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    }),
  };
});

function failure(error: string, errorDescription: string, statusCode: number): CheckAuthResult {
  return { authenticated: false, error, errorDescription, statusCode };
}

const INVALID_ACCESS_TOKEN = failure('invalid_token', 'Invalid access token', 401);

async function verify(token: string, ctx: ReturnType<typeof jwtContext>) {
  return authenticateCheckApiRequest(`Bearer ${token}`, ctx);
}

describe('check-auth: verified access token', () => {
  it('authenticates a signed token and reports its identity and default grant', async () => {
    const key = await newSigningKey({ kid: 'k1', alg: 'RS256' });
    const token = await signJwt(key.privateKey, ACCESS_CLAIMS, { kid: 'k1' });

    expect(await verify(token, jwtContext([key.jwk]))).toEqual({
      authenticated: true,
      method: 'access_token',
      clientId: 'client_1',
      subjectId: 'user_1',
      tenantId: 'tenant_1',
      rateLimitTier: 'moderate',
      allowedOperations: ['check', 'batch'],
    });
  });

  it('takes the client from client_id, else azp', async () => {
    const key = await newSigningKey({ kid: 'k1' });
    const ctx = jwtContext([key.jwk]);
    const { client_id: _unused, ...withoutClient } = ACCESS_CLAIMS;

    const both = await signJwt(key.privateKey, { ...ACCESS_CLAIMS, azp: 'azp_1' }, { kid: 'k1' });
    expect((await verify(both, ctx)).clientId).toBe('client_1');

    const clientOnly = await signJwt(key.privateKey, ACCESS_CLAIMS, { kid: 'k1' });
    expect((await verify(clientOnly, ctx)).clientId).toBe('client_1');

    const azpOnly = await signJwt(
      key.privateKey,
      { ...withoutClient, azp: 'azp_1' },
      { kid: 'k1' }
    );
    expect((await verify(azpOnly, ctx)).clientId).toBe('azp_1');
  });

  it('trims the tenant claim and refuses a token without a usable one', async () => {
    const key = await newSigningKey({ kid: 'k1' });
    const ctx = jwtContext([key.jwk]);

    const padded = await signJwt(
      key.privateKey,
      { ...ACCESS_CLAIMS, tenant_id: '  tenant_1  ' },
      { kid: 'k1' }
    );
    expect((await verify(padded, ctx)).tenantId).toBe('tenant_1');

    const missingTenant = failure('invalid_token', 'Access token is missing tenant_id', 401);
    const { tenant_id: _unused, ...withoutTenant } = ACCESS_CLAIMS;
    for (const claims of [withoutTenant, { ...ACCESS_CLAIMS, tenant_id: '   ' }]) {
      const token = await signJwt(key.privateKey, claims, { kid: 'k1' });
      expect(await verify(token, ctx)).toEqual(missingTenant);
    }
    const numeric = await signJwt(
      key.privateKey,
      { ...ACCESS_CLAIMS, tenant_id: 7 },
      { kid: 'k1' }
    );
    expect(await verify(numeric, ctx)).toEqual(missingTenant);
  });

  it('is not configured without both the JWKS and the issuer', async () => {
    const key = await newSigningKey({ kid: 'k1' });
    const token = await signJwt(key.privateKey, ACCESS_CLAIMS, { kid: 'k1' });
    const notConfigured = failure(
      'invalid_token',
      'Access token verification is not configured',
      401
    );

    expect(await verify(token, { ...jwtContext([key.jwk]), issuerUrl: undefined })).toEqual(
      notConfigured
    );
    expect(await verify(token, { ...jwtContext([key.jwk]), jwks: undefined })).toEqual(
      notConfigured
    );
  });
});

describe('check-auth: whose account the subject names', () => {
  async function authenticateWith(claims: Record<string, unknown>) {
    const key = await newSigningKey({ kid: 'k1' });
    const token = await signJwt(key.privateKey, claims, { kid: 'k1' });
    return verify(token, jwtContext([key.jwk]));
  }

  it('rejects a token whose sub is mapped and carries a sealed account reference', async () => {
    expect(
      await authenticateWith({ ...ACCESS_CLAIMS, [SUBJECT_REFERENCE_CLAIM]: 'sr1.iv.ciphertext' })
    ).toEqual(INVALID_ACCESS_TOKEN);
  });

  it('rejects an ID token that does not show its sub is the user id', async () => {
    expect(
      await authenticateWith({ sub: 'user_1', client_id: 'client_1', tenant_id: 'tenant_1' })
    ).toEqual(INVALID_ACCESS_TOKEN);
  });

  it('rejects a token with a JWT ID but no token_use (a logout token)', async () => {
    expect(
      await authenticateWith({
        sub: 'user_1',
        jti: 'jti-1',
        client_id: 'client_1',
        tenant_id: 'tenant_1',
      })
    ).toEqual(INVALID_ACCESS_TOKEN);
  });

  it('accepts an ID token that marks its sub as the user id', async () => {
    const result = await authenticateWith({
      sub: 'user_1',
      authrim_subject_account: true,
      client_id: 'client_1',
      tenant_id: 'tenant_1',
    });
    expect(result).toMatchObject({ authenticated: true, subjectId: 'user_1' });
  });

  it('accepts a signed token that names no subject', async () => {
    const result = await authenticateWith({ client_id: 'client_1', tenant_id: 'tenant_1' });
    expect(result).toMatchObject({ authenticated: true, subjectId: undefined });
  });
});

describe('check-auth: signing key selection', () => {
  it('selects the key named by the kid, not the first one', async () => {
    const first = await newSigningKey({ kid: 'k1', alg: 'RS256' });
    const second = await newSigningKey({ kid: 'k2', alg: 'RS256' });
    const token = await signJwt(second.privateKey, ACCESS_CLAIMS, { kid: 'k2' });

    expect((await verify(token, jwtContext([first.jwk, second.jwk]))).authenticated).toBe(true);
  });

  it('does not accept a token signed by the key of another kid', async () => {
    const first = await newSigningKey({ kid: 'k1', alg: 'RS256' });
    const second = await newSigningKey({ kid: 'k2', alg: 'RS256' });
    const token = await signJwt(first.privateKey, ACCESS_CLAIMS, { kid: 'k2' });

    expect(await verify(token, jwtContext([first.jwk, second.jwk]))).toEqual(
      failure('invalid_token', 'Invalid token signature', 401)
    );
  });

  it('falls back to the first RSA key when no key has the kid', async () => {
    const decoy = await newEcSigningKey({ kid: 'ec' });
    const rsa = await newSigningKey({ kid: 'k1' }); // RSA key without an alg
    const token = await signJwt(rsa.privateKey, ACCESS_CLAIMS, { kid: 'unknown' });

    expect((await verify(token, jwtContext([decoy.jwk, rsa.jwk]))).authenticated).toBe(true);
  });

  it('falls back to the first RSA key for a token without a kid, not to a key without one', async () => {
    const wrong = await newSigningKey({ kid: 'k1', alg: 'RS256' });
    const unnamed = await newSigningKey({});
    const token = await signJwt(unnamed.privateKey, ACCESS_CLAIMS);

    expect(await verify(token, jwtContext([wrong.jwk, unnamed.jwk]))).toEqual(
      failure('invalid_token', 'Invalid token signature', 401)
    );
    const right = await signJwt(wrong.privateKey, ACCESS_CLAIMS);
    expect((await verify(right, jwtContext([wrong.jwk, unnamed.jwk]))).authenticated).toBe(true);
  });

  it('fails with a server error when the JWKS has no usable key', async () => {
    const key = await newSigningKey({ kid: 'k1' });
    const ec = await newEcSigningKey({ kid: 'ec' });
    const token = await signJwt(key.privateKey, ACCESS_CLAIMS, { kid: 'k1' });

    expect(await verify(token, jwtContext([ec.jwk]))).toEqual(
      failure('server_error', 'No suitable key found for signature verification', 500)
    );
    expect(await verify(token, jwtContext([]))).toEqual(
      failure('server_error', 'No suitable key found for signature verification', 500)
    );
  });

  it('refuses a token whose header cannot be parsed', async () => {
    const key = await newSigningKey({ kid: 'k1' });
    // Valid base64url characters that do not decode to a JSON header.
    expect(await verify('abc.e30.sig', jwtContext([key.jwk]))).toEqual(INVALID_ACCESS_TOKEN);
  });
});

const NOW_SECONDS = 1_800_000_000;

describe('check-auth: claim failures', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW_SECONDS * 1000));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function setup() {
    const key: SigningKey = await newSigningKey({ kid: 'k1', alg: 'RS256' });
    return { key, ctx: jwtContext([key.jwk]) };
  }

  it('reports an expired token', async () => {
    const { key, ctx } = await setup();
    const token = await signJwt(key.privateKey, ACCESS_CLAIMS, {
      kid: 'k1',
      expiresAt: NOW_SECONDS - 3600,
    });
    expect(await verify(token, ctx)).toEqual(
      failure('invalid_token', 'Access token has expired', 401)
    );
  });

  it('reports a bad signature', async () => {
    const { ctx } = await setup();
    const forger = await newSigningKey({});
    const token = await signJwt(forger.privateKey, ACCESS_CLAIMS, { kid: 'k1' });
    expect(await verify(token, ctx)).toEqual(
      failure('invalid_token', 'Invalid token signature', 401)
    );
  });

  it('reports a wrong issuer', async () => {
    const { key, ctx } = await setup();
    const token = await signJwt(key.privateKey, ACCESS_CLAIMS, {
      kid: 'k1',
      issuer: 'https://evil.example.com',
    });
    expect(await verify(token, ctx)).toEqual(failure('invalid_token', 'Invalid token issuer', 401));
  });

  it('checks the audience only when one is expected', async () => {
    const { key } = await setup();
    const ctx = jwtContext([key.jwk], { expectedAudience: 'policy-api' });
    const invalidAudience = failure('invalid_token', 'Invalid token audience', 401);

    const wrong = await signJwt(key.privateKey, ACCESS_CLAIMS, { kid: 'k1', audience: 'other' });
    expect(await verify(wrong, ctx)).toEqual(invalidAudience);

    const missing = await signJwt(key.privateKey, ACCESS_CLAIMS, { kid: 'k1' });
    expect(await verify(missing, ctx)).toEqual(invalidAudience);

    const right = await signJwt(key.privateKey, ACCESS_CLAIMS, {
      kid: 'k1',
      audience: 'policy-api',
    });
    expect((await verify(right, ctx)).authenticated).toBe(true);

    // No expected audience: any audience is accepted.
    const anyAudience = jwtContext([key.jwk]);
    expect((await verify(wrong, anyAudience)).authenticated).toBe(true);
  });

  it('reports other verification failures as an invalid token', async () => {
    const { key, ctx } = await setup();
    const notYetValid = await new SignJWT(ACCESS_CLAIMS)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setNotBefore(NOW_SECONDS + 3600)
      .setExpirationTime('2h')
      .sign(key.privateKey);
    expect(await verify(notYetValid, ctx)).toEqual(INVALID_ACCESS_TOKEN);
  });
});
