import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { JWK } from 'jose';
import {
  clearAllStatusListCaches,
  clearIssuerJwksCache,
  getCredentialStatusValue,
} from '../status-list';
import { encodeStatusListBytes } from '../status-list-codec';

const mocks = vi.hoisted(() => ({
  safeFetch: vi.fn(),
  safeFetchJson: vi.fn(),
}));
vi.mock('../../utils/url-security', () => ({
  safeFetch: mocks.safeFetch,
  safeFetchJson: mocks.safeFetchJson,
  readResponseTextWithLimit: (response: Response) => response.text(),
}));

const ISSUER = 'https://issuer.example.test/tenant-a';
const URI = `${ISSUER}/status/list-1`;
const NOW_S = 1_800_000_000;

describe('Token Status List default issuer-key resolution', () => {
  let privateKey: CryptoKey;
  let publicJwk: JWK;

  async function token(
    input: {
      issuer?: string;
      uri?: string;
      kid?: string | null;
    } = {}
  ): Promise<string> {
    const issuer = input.issuer ?? ISSUER;
    const uri = input.uri ?? URI;
    const list = await encodeStatusListBytes(new Uint8Array(8), 'ietf_tsl_v1');
    return new SignJWT({
      iss: issuer,
      sub: uri,
      iat: NOW_S,
      exp: NOW_S + 7200,
      status_list: { bits: 2, lst: list },
    })
      .setProtectedHeader({
        alg: 'ES256',
        typ: 'statuslist+jwt',
        ...(input.kid === null ? {} : { kid: input.kid ?? 'key-1' }),
      })
      .sign(privateKey);
  }

  function serve(jwt: string) {
    mocks.safeFetch.mockImplementation(
      async () =>
        new Response(jwt, {
          headers: { 'content-type': 'application/statuslist+jwt' },
        })
    );
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    clearAllStatusListCaches();
    vi.spyOn(Date, 'now').mockReturnValue(NOW_S * 1000);
    const pair = await generateKeyPair('ES256', { extractable: true });
    privateKey = pair.privateKey;
    publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'key-1', use: 'sig' };
    mocks.safeFetchJson.mockResolvedValue({ keys: [publicJwk] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearAllStatusListCaches();
  });

  it('fetches the HTTPS issuer origin JWKS with bounded, HTTPS-only options and verifies the token', async () => {
    serve(await token());

    await expect(
      getCredentialStatusValue(URI, 0, {
        format: 'ietf_tsl_v1',
        expectedIssuer: ISSUER,
      })
    ).resolves.toBe(0);

    expect(mocks.safeFetchJson).toHaveBeenCalledExactlyOnceWith(
      'https://issuer.example.test/.well-known/jwks.json',
      {
        headers: { Accept: 'application/json' },
        requireHttps: true,
        timeoutMs: 10000,
        maxResponseSize: 256 * 1024,
      }
    );
    expect(mocks.safeFetch).toHaveBeenCalledExactlyOnceWith(
      URI,
      expect.objectContaining({
        requireHttps: true,
        maxResponseSize: 2 * 1024 * 1024,
      })
    );
  });

  it('uses a cached JWKS across status-list URIs on the same issuer origin', async () => {
    const secondUri = `${ISSUER}/status/list-2`;
    serve(await token());
    await getCredentialStatusValue(URI, 0, { format: 'ietf_tsl_v1', expectedIssuer: ISSUER });
    serve(await token({ uri: secondUri }));

    await expect(
      getCredentialStatusValue(secondUri, 0, {
        format: 'ietf_tsl_v1',
        expectedIssuer: ISSUER,
      })
    ).resolves.toBe(0);
    expect(mocks.safeFetch).toHaveBeenCalledTimes(2);
    expect(mocks.safeFetchJson).toHaveBeenCalledOnce();

    clearIssuerJwksCache();
    await getCredentialStatusValue(secondUri, 0, {
      format: 'ietf_tsl_v1',
      expectedIssuer: ISSUER,
      forceRefresh: true,
    });
    expect(mocks.safeFetchJson).toHaveBeenCalledTimes(2);
  });

  it('resolves did:web through its domain but refuses unsupported DID methods without a JWKS request', async () => {
    const didIssuer = 'did:web:issuer.example.test:tenant-a';
    serve(await token({ issuer: didIssuer }));
    await expect(
      getCredentialStatusValue(URI, 0, {
        format: 'ietf_tsl_v1',
        expectedIssuer: didIssuer,
      })
    ).resolves.toBe(0);
    expect(mocks.safeFetchJson).toHaveBeenCalledWith(
      'https://issuer.example.test/.well-known/jwks.json',
      expect.objectContaining({ requireHttps: true })
    );

    clearAllStatusListCaches();
    mocks.safeFetchJson.mockClear();
    const unsupportedIssuer = 'did:key:z6MkUnsupported';
    serve(await token({ issuer: unsupportedIssuer }));
    await expect(
      getCredentialStatusValue(URI, 0, {
        format: 'ietf_tsl_v1',
        expectedIssuer: unsupportedIssuer,
      })
    ).rejects.toThrow('DID method not supported');
    expect(mocks.safeFetchJson).not.toHaveBeenCalled();
  });

  it('requires an exact kid and does not disclose a missing kid in the error', async () => {
    serve(await token({ kid: 'secret-kid' }));

    const error = await getCredentialStatusValue(URI, 0, {
      format: 'ietf_tsl_v1',
      expectedIssuer: ISSUER,
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Key verification failed');
    expect((error as Error).message).not.toContain('secret-kid');
    expect(mocks.safeFetchJson).toHaveBeenCalledOnce();
  });

  it('selects an algorithm-compatible signing key when the token has no kid', async () => {
    serve(await token({ kid: null }));
    mocks.safeFetchJson.mockResolvedValue({
      keys: [
        { kty: 'RSA', use: 'sig', kid: 'rsa-decoy' },
        { ...publicJwk, kid: 'ec-signing' },
        { ...publicJwk, kid: 'encryption-only', use: 'enc' },
      ],
    });

    await expect(
      getCredentialStatusValue(URI, 0, {
        format: 'ietf_tsl_v1',
        expectedIssuer: ISSUER,
      })
    ).resolves.toBe(0);
  });

  it('does not accept a token signed by a key outside the fetched JWKS', async () => {
    serve(await token());
    const another = await generateKeyPair('ES256', { extractable: true });
    mocks.safeFetchJson.mockResolvedValue({
      keys: [{ ...(await exportJWK(another.publicKey)), kid: 'key-1', use: 'sig' }],
    });

    await expect(
      getCredentialStatusValue(URI, 0, {
        format: 'ietf_tsl_v1',
        expectedIssuer: ISSUER,
      })
    ).rejects.toThrow('signature verification failed');
  });
});
