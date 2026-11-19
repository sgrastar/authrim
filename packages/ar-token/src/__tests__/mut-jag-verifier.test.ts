import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import {
  clearExternalIdJagVerifierCacheForTests,
  verifyExternalIdJagSubjectToken,
} from '../external-id-jag-verifier';

const ISSUER = 'https://idp.example.com';
const AUDIENCE = 'authrim-token-exchange-client';
const JWKS_URI = `${ISSUER}/jwks`;
const DISCOVERY_URI = `${ISSUER}/.well-known/openid-configuration`;
const KID = 'kid-1';

interface Signer {
  privateKey: CryptoKey;
  publicJwk: JWK;
  alg: string;
}

async function createSigner(alg = 'RS256', jwk: Partial<JWK> = {}): Promise<Signer> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  return {
    alg,
    privateKey,
    publicJwk: { ...(await exportJWK(publicKey)), kid: KID, ...jwk },
  };
}

async function sign(
  signer: Signer,
  options: { issuer?: string; withSubject?: boolean } = {}
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  let builder = new SignJWT({ scope: 'openid' })
    .setProtectedHeader({ alg: signer.alg, kid: KID, typ: 'JWT' })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 300);
  if (options.withSubject !== false) builder = builder.setSubject('external-user');
  return builder.sign(signer.privateKey);
}

function urlOf(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function stubIdp(
  keys: unknown[],
  options: { issuer?: string; discoveryUrl?: string; discovery?: unknown; jwksBody?: string } = {}
) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = urlOf(input);
    if (url === (options.discoveryUrl ?? DISCOVERY_URI)) {
      return Response.json(
        options.discovery ?? { issuer: options.issuer ?? ISSUER, jwks_uri: JWKS_URI }
      );
    }
    if (url === JWKS_URI) {
      return options.jwksBody !== undefined
        ? new Response(options.jwksBody, { headers: { 'content-type': 'application/json' } })
        : Response.json({ keys });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const verify = (token: string, issuer = ISSUER) =>
  verifyExternalIdJagSubjectToken({ token, issuer, audiences: [AUDIENCE] });

describe('external ID-JAG verifier: algorithms and required claims', () => {
  beforeEach(() => clearExternalIdJagVerifierCacheForTests());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each(['RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'])(
    'accepts a token signed with the allowed algorithm %s',
    async (alg) => {
      const signer = await createSigner(alg);
      stubIdp([signer.publicJwk]);
      await expect(verify(await sign(signer))).resolves.toMatchObject({ sub: 'external-user' });
    }
  );

  it('requires the sub claim', async () => {
    const signer = await createSigner();
    stubIdp([signer.publicJwk]);
    await expect(verify(await sign(signer, { withSubject: false }))).rejects.toThrow(/sub/);
  });
});

describe('external ID-JAG verifier: issuer discovery URL', () => {
  beforeEach(() => clearExternalIdJagVerifierCacheForTests());
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['credentials (username)', 'https://user@idp.example.com'],
    ['credentials (password only)', 'https://:secret@idp.example.com'],
    ['a query', 'https://idp.example.com?tenant=a'],
    ['a fragment', 'https://idp.example.com#frag'],
  ])('rejects an issuer with %s before any fetch', async (_name, issuer) => {
    const signer = await createSigner();
    const fetchMock = stubIdp([signer.publicJwk]);
    await expect(verify(await sign(signer, { issuer }), issuer)).rejects.toThrow(
      'External ID-JAG issuer must be an HTTPS URL without credentials, query, or fragment'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('strips one trailing slash from the issuer before appending the discovery path', async () => {
    const issuer = `${ISSUER}/`;
    const signer = await createSigner();
    const fetchMock = stubIdp([signer.publicJwk], { issuer });
    await expect(verify(await sign(signer, { issuer }), issuer)).resolves.toMatchObject({
      iss: issuer,
    });
    expect(urlOf(fetchMock.mock.calls[0][0])).toBe(DISCOVERY_URI);
  });

  it('rejects an empty jwks_uri as missing', async () => {
    const signer = await createSigner();
    stubIdp([signer.publicJwk], { discovery: { issuer: ISSUER, jwks_uri: '' } });
    await expect(verify(await sign(signer))).rejects.toThrow(
      'External ID-JAG discovery metadata is missing jwks_uri'
    );
  });

  it('bounds the discovery document size', async () => {
    const signer = await createSigner();
    stubIdp([signer.publicJwk], {
      discovery: { issuer: ISSUER, jwks_uri: JWKS_URI, padding: 'x'.repeat(70 * 1024) },
    });
    await expect(verify(await sign(signer))).rejects.toThrow(/size|large|limit/i);
  });

  it('bounds the JWKS document size', async () => {
    const signer = await createSigner();
    stubIdp([], {
      jwksBody: JSON.stringify({ keys: [signer.publicJwk], padding: 'x'.repeat(300 * 1024) }),
    });
    await expect(verify(await sign(signer))).rejects.toThrow(/size|large|limit/i);
  });
});

describe('external ID-JAG verifier: JWKS entries and key selection', () => {
  beforeEach(() => clearExternalIdJagVerifierCacheForTests());
  afterEach(() => vi.unstubAllGlobals());

  it('skips null and kty-less JWKS entries and still verifies with the usable key', async () => {
    const signer = await createSigner();
    stubIdp([null, { kid: KID, use: 'sig' }, 'junk', signer.publicJwk]);
    await expect(verify(await sign(signer))).resolves.toMatchObject({ sub: 'external-user' });
  });

  it('rejects a JWKS whose entries are all unusable', async () => {
    const signer = await createSigner();
    stubIdp([{ kid: KID, use: 'sig' }, null]);
    await expect(verify(await sign(signer))).rejects.toThrow(
      'External ID-JAG JWKS contains no usable keys'
    );
  });

  it('ignores keys with another kid when selecting the verification key', async () => {
    const signer = await createSigner();
    const other = await createSigner('RS256', { kid: 'kid-other' });
    stubIdp([other.publicJwk, signer.publicJwk]);
    await expect(verify(await sign(signer))).resolves.toMatchObject({ sub: 'external-user' });
  });

  it('accepts keys without use, key_ops, or alg restrictions', async () => {
    const signer = await createSigner();
    const { use: _use, alg: _alg, key_ops: _ops, ...bare } = signer.publicJwk;
    stubIdp([bare]);
    await expect(verify(await sign(signer))).resolves.toMatchObject({ sub: 'external-user' });
  });

  it('accepts a key whose use is sig, key_ops include verify, and alg matches', async () => {
    const signer = await createSigner('RS256', { use: 'sig', key_ops: ['verify'], alg: 'RS256' });
    stubIdp([signer.publicJwk]);
    await expect(verify(await sign(signer))).resolves.toMatchObject({ sub: 'external-user' });
  });

  it.each([
    ['an encryption-only use', { use: 'enc' }],
    ['key_ops without verify', { key_ops: ['sign'] }],
    ['a different alg', { alg: 'RS512' }],
  ])('rejects a same-kid key with %s after one refresh', async (_name, restriction) => {
    const signer = await createSigner('RS256', restriction);
    const fetchMock = stubIdp([signer.publicJwk]);
    await expect(verify(await sign(signer))).rejects.toThrow(
      'External ID-JAG signing key was not found'
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('rejects an ambiguous kid even when the first duplicate is the correct key', async () => {
    const signer = await createSigner();
    const other = await createSigner();
    stubIdp([signer.publicJwk, other.publicJwk]);
    await expect(verify(await sign(signer))).rejects.toThrow(
      'External ID-JAG signing key was not found'
    );
  });
});

describe('external ID-JAG verifier: JWKS cache lifetime', () => {
  beforeEach(() => clearExternalIdJagVerifierCacheForTests());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reuses keys for five minutes and refetches once the TTL has elapsed', async () => {
    const signer = await createSigner();
    const fetchMock = stubIdp([signer.publicJwk]);
    const token = await sign(signer);
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);

    await verify(token);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    clock.mockReturnValue(start + 4 * 60 * 1000);
    await verify(token);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    clock.mockReturnValue(start + 5 * 60 * 1000);
    await verify(token);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
