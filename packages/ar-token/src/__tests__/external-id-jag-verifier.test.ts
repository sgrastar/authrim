import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import {
  clearExternalIdJagVerifierCacheForTests,
  verifyExternalIdJagSubjectToken,
} from '../external-id-jag-verifier';

const ISSUER = 'https://idp.example.com';
const AUDIENCE = 'authrim-token-exchange-client';
const JWKS_URI = `${ISSUER}/jwks`;
const KID = 'idp-signing-key-1';

interface SigningFixture {
  privateKey: CryptoKey;
  publicJwk: JWK;
}

async function createSigningFixture(kid = KID): Promise<SigningFixture> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  return {
    privateKey,
    publicJwk: {
      ...(await exportJWK(publicKey)),
      alg: 'RS256',
      kid,
      use: 'sig',
    },
  };
}

async function signSubjectToken(
  privateKey: CryptoKey,
  overrides: {
    issuer?: string;
    audience?: string;
    expiresAt?: number;
    kid?: string;
  } = {}
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ scope: 'openid profile', client_id: AUDIENCE })
    .setProtectedHeader({ alg: 'RS256', kid: overrides.kid ?? KID, typ: 'JWT' })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setSubject('external-user-123')
    .setAudience(overrides.audience ?? AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(overrides.expiresAt ?? now + 300)
    .sign(privateKey);
}

function mockDiscoveryAndJwks(publicJwk: JWK): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({ issuer: ISSUER, jwks_uri: JWKS_URI });
    }
    if (url === JWKS_URI) {
      return Response.json({ keys: [publicJwk] });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('external ID-JAG subject token verification', () => {
  beforeEach(() => {
    clearExternalIdJagVerifierCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('verifies signature, issuer, audience, expiry, and required claims', async () => {
    const signing = await createSigningFixture();
    const fetchMock = mockDiscoveryAndJwks(signing.publicJwk);
    const token = await signSubjectToken(signing.privateKey);

    const payload = await verifyExternalIdJagSubjectToken({
      token,
      issuer: ISSUER,
      audiences: [AUDIENCE],
    });

    expect(payload.sub).toBe('external-user-123');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects a token forged with a key that is not in the issuer JWKS', async () => {
    const trusted = await createSigningFixture();
    const attacker = await createSigningFixture();
    mockDiscoveryAndJwks(trusted.publicJwk);
    const token = await signSubjectToken(attacker.privateKey);

    await expect(
      verifyExternalIdJagSubjectToken({ token, issuer: ISSUER, audiences: [AUDIENCE] })
    ).rejects.toThrow();
  });

  it('rejects a token whose issuer claim differs from the configured issuer', async () => {
    const signing = await createSigningFixture();
    mockDiscoveryAndJwks(signing.publicJwk);
    const token = await signSubjectToken(signing.privateKey, {
      issuer: 'https://other-idp.example.com',
    });

    await expect(
      verifyExternalIdJagSubjectToken({ token, issuer: ISSUER, audiences: [AUDIENCE] })
    ).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const signing = await createSigningFixture();
    mockDiscoveryAndJwks(signing.publicJwk);
    const token = await signSubjectToken(signing.privateKey, {
      expiresAt: Math.floor(Date.now() / 1000) - 120,
    });

    await expect(
      verifyExternalIdJagSubjectToken({ token, issuer: ISSUER, audiences: [AUDIENCE] })
    ).rejects.toThrow();
  });

  it('rejects an audience mismatch', async () => {
    const signing = await createSigningFixture();
    mockDiscoveryAndJwks(signing.publicJwk);
    const token = await signSubjectToken(signing.privateKey, { audience: 'different-client' });

    await expect(
      verifyExternalIdJagSubjectToken({ token, issuer: ISSUER, audiences: [AUDIENCE] })
    ).rejects.toThrow();
  });

  it('rejects issuer discovery from a non-HTTPS URL before fetching', async () => {
    const signing = await createSigningFixture();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const token = await signSubjectToken(signing.privateKey, {
      issuer: 'http://idp.example.com',
    });

    await expect(
      verifyExternalIdJagSubjectToken({
        token,
        issuer: 'http://idp.example.com',
        audiences: [AUDIENCE],
      })
    ).rejects.toThrow(/HTTPS/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the cached JWKS for subsequent tokens from the same issuer', async () => {
    const signing = await createSigningFixture();
    const fetchMock = mockDiscoveryAndJwks(signing.publicJwk);
    const first = await signSubjectToken(signing.privateKey);
    const second = await signSubjectToken(signing.privateKey);

    await verifyExternalIdJagSubjectToken({
      token: first,
      issuer: ISSUER,
      audiences: [AUDIENCE],
    });
    await verifyExternalIdJagSubjectToken({
      token: second,
      issuer: ISSUER,
      audiences: [AUDIENCE],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
