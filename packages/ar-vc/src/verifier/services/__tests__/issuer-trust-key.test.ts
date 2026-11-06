import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../types';

const issuerTrustKeyMocks = vi.hoisted(() => ({
  importECPublicKey: vi.fn(),
  safeFetchJson: vi.fn(),
  resolveDID: vi.fn(),
  importJWK: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const logger = {
    module: vi.fn().mockReturnThis(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    ...actual,
    createLogger: vi.fn(() => logger),
    importECPublicKey: issuerTrustKeyMocks.importECPublicKey,
    safeFetchJson: issuerTrustKeyMocks.safeFetchJson,
    resolveDID: issuerTrustKeyMocks.resolveDID,
  };
});

vi.mock('jose', () => ({
  importJWK: issuerTrustKeyMocks.importJWK,
}));

import { getIssuerPublicKey, jwtVcIssuerMetadataUrl } from '../issuer-trust';

describe('getIssuerPublicKey', () => {
  const env = {} as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    issuerTrustKeyMocks.importECPublicKey.mockResolvedValue('ec-key');
    issuerTrustKeyMocks.importJWK.mockResolvedValue('okp-key');
  });

  it('imports the first suitable EC signing key from a trusted JWKS URI', async () => {
    issuerTrustKeyMocks.safeFetchJson.mockResolvedValue({
      keys: [
        { kty: 'RSA', use: 'sig', alg: 'RS256', kid: 'rsa-key' },
        { kty: 'EC', use: 'enc', alg: 'ES256', kid: 'wrong-use' },
        { kty: 'EC', use: 'sig', alg: 'ES384', kid: 'signing-key', crv: 'P-384' },
      ],
    });

    const key = await getIssuerPublicKey(
      env,
      'did:web:issuer.example.com',
      'https://issuer.example.com/jwks'
    );

    expect(key).toBe('ec-key');
    expect(issuerTrustKeyMocks.safeFetchJson).toHaveBeenCalledWith(
      'https://issuer.example.com/jwks',
      expect.objectContaining({
        requireHttps: true,
        maxResponseSize: 256 * 1024,
      })
    );
    expect(issuerTrustKeyMocks.importECPublicKey).toHaveBeenCalledWith(
      expect.objectContaining({ kid: 'signing-key' })
    );
    expect(issuerTrustKeyMocks.resolveDID).not.toHaveBeenCalled();
  });

  it('applies the signing-key rules without a kid and refuses a choice between keys', async () => {
    issuerTrustKeyMocks.safeFetchJson.mockResolvedValueOnce({
      keys: [
        // Stated for signing only: never a verification key, even with use "sig".
        { kty: 'EC', crv: 'P-256', use: 'sig', alg: 'ES256', key_ops: ['sign'], kid: 'signer' },
        { kty: 'EC', crv: 'P-384', use: 'sig', alg: 'ES256', kid: 'curve-mismatch' },
      ],
    });
    await expect(
      getIssuerPublicKey(env, 'did:web:issuer.example.com', 'https://issuer.example.com/jwks')
    ).rejects.toThrow('No suitable EC signing key found in JWKS');

    issuerTrustKeyMocks.safeFetchJson.mockResolvedValueOnce({
      keys: [
        { kty: 'EC', crv: 'P-256', use: 'sig', alg: 'ES256', kid: 'a' },
        { kty: 'EC', crv: 'P-256', use: 'sig', alg: 'ES256', kid: 'b' },
      ],
    });
    await expect(
      getIssuerPublicKey(env, 'did:web:issuer.example.com', 'https://issuer.example.com/jwks')
    ).rejects.toThrow(
      'JWKS has several matching signing keys: the signature must name one with kid'
    );
    expect(issuerTrustKeyMocks.importECPublicKey).not.toHaveBeenCalled();
  });

  it('rejects JWKS documents without a HAIP-compatible EC signing key', async () => {
    issuerTrustKeyMocks.safeFetchJson.mockResolvedValue({
      keys: [
        { kty: 'RSA', use: 'sig', alg: 'RS256' },
        { kty: 'EC', use: 'enc', alg: 'ES256' },
      ],
    });

    await expect(
      getIssuerPublicKey(env, 'did:web:issuer.example.com', 'https://issuer.example.com/jwks')
    ).rejects.toThrow('No suitable EC signing key found in JWKS');
    expect(issuerTrustKeyMocks.importECPublicKey).not.toHaveBeenCalled();
  });

  const issuer = 'did:web:issuer.example.com';

  it("uses the issuer's single assertion key and ignores keys for other purposes", async () => {
    issuerTrustKeyMocks.resolveDID.mockResolvedValue({
      verificationMethod: [
        {
          id: '#ed-auth',
          controller: issuer,
          publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: 'auth' },
        },
        {
          id: '#p256',
          controller: issuer,
          publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
        },
      ],
      authentication: ['#ed-auth'],
      assertionMethod: ['#p256'],
    });

    const key = await getIssuerPublicKey(env, issuer);

    expect(key).toBe('ec-key');
    expect(issuerTrustKeyMocks.resolveDID).toHaveBeenCalledWith(issuer);
    // The JWK omits alg: it comes from the curve, as the EC key import requires one.
    expect(issuerTrustKeyMocks.importECPublicKey).toHaveBeenCalledWith({
      kty: 'EC',
      crv: 'P-256',
      x: 'x',
      y: 'y',
      alg: 'ES256',
    });
    expect(issuerTrustKeyMocks.importJWK).not.toHaveBeenCalled();
  });

  it('accepts an Ed25519 assertion key', async () => {
    issuerTrustKeyMocks.resolveDID.mockResolvedValue({
      verificationMethod: [
        {
          id: '#ed',
          controller: issuer,
          publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: 'x', alg: 'EdDSA' },
        },
      ],
      assertionMethod: ['#ed'],
    });

    const key = await getIssuerPublicKey(env, issuer);

    expect(key).toBe('okp-key');
    expect(issuerTrustKeyMocks.importJWK).toHaveBeenCalledWith(
      { kty: 'OKP', crv: 'Ed25519', x: 'x', alg: 'EdDSA' },
      'EdDSA'
    );
  });

  it('accepts a document whose only key is embedded in assertionMethod', async () => {
    issuerTrustKeyMocks.resolveDID.mockResolvedValue({
      assertionMethod: [
        {
          id: '#embedded',
          controller: issuer,
          publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'e', y: 'e' },
        },
      ],
    });

    await expect(getIssuerPublicKey(env, issuer)).resolves.toBe('ec-key');
  });

  it('refuses, without a kid, no assertion key or a choice between several', async () => {
    issuerTrustKeyMocks.resolveDID.mockResolvedValueOnce({
      verificationMethod: [
        { id: '#p256', controller: issuer, publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x' } },
      ],
    });
    await expect(getIssuerPublicKey(env, issuer)).rejects.toThrow(
      'No assertion key found in DID document'
    );

    issuerTrustKeyMocks.resolveDID.mockResolvedValueOnce({
      verificationMethod: [
        { id: '#a', controller: issuer, publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'a' } },
        { id: '#b', controller: issuer, publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'b' } },
      ],
      assertionMethod: ['#a', '#b'],
    });
    await expect(getIssuerPublicKey(env, issuer)).rejects.toThrow(
      'DID document has several assertion keys: the signature must name one with kid'
    );

    // A method without controller, or with another, is not the issuer's.
    issuerTrustKeyMocks.resolveDID.mockResolvedValueOnce({
      verificationMethod: [
        { id: '#none', publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'n' } },
        { id: '#empty', controller: '', publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'e' } },
      ],
      assertionMethod: ['#none', '#empty'],
    });
    await expect(getIssuerPublicKey(env, issuer)).rejects.toThrow(
      'No assertion key found in DID document'
    );
    expect(issuerTrustKeyMocks.importECPublicKey).not.toHaveBeenCalled();
  });

  it('rejects unresolved DID documents without leaking DID details', async () => {
    issuerTrustKeyMocks.resolveDID.mockResolvedValueOnce(null);
    await expect(getIssuerPublicKey(env, issuer)).rejects.toThrow('Failed to resolve DID document');
  });

  describe('with the kid of the signed JWT (an issuer after a key rotation)', () => {
    const did = 'did:web:issuer.example.com';
    /** A document whose methods are all assertion keys. */
    const assertingWith = (methods: Array<{ id: string; [key: string]: unknown }>) => {
      const verificationMethod = methods.map((vm) => ({ controller: did, ...vm }));
      return { verificationMethod, assertionMethod: verificationMethod.map((vm) => vm.id) };
    };
    const rotated = assertingWith([
      { id: `${did}#old`, publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'old', y: 'old' } },
      { id: `${did}#new`, publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'new', y: 'new' } },
    ]);

    it.each([
      { form: 'a bare key id', kid: 'new' },
      { form: 'a fragment', kid: '#new' },
      { form: 'a DID URL', kid: `${did}#new` },
    ])('picks the DID method $form names, not the first key', async ({ kid }) => {
      issuerTrustKeyMocks.resolveDID.mockResolvedValue(rotated);

      await getIssuerPublicKey(env, did, undefined, kid);

      expect(issuerTrustKeyMocks.importECPublicKey).toHaveBeenCalledWith(
        expect.objectContaining({ x: 'new' })
      );
    });

    it('rejects a kid no DID method has instead of trying another key', async () => {
      issuerTrustKeyMocks.resolveDID.mockResolvedValue(rotated);

      await expect(getIssuerPublicKey(env, did, undefined, 'revoked')).rejects.toThrow(
        'No verification method matches the key id'
      );
      expect(issuerTrustKeyMocks.importECPublicKey).not.toHaveBeenCalled();
    });

    it.each([
      { form: 'a bare key id', kid: 'p256' },
      { form: 'a fragment', kid: '#p256' },
      { form: 'a DID URL', kid: `${did}#p256` },
    ])('resolves relative method IDs against the DID for $form', async ({ kid }) => {
      issuerTrustKeyMocks.resolveDID.mockResolvedValue(
        assertingWith([
          { id: '#other', publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'other', y: 'other' } },
          { id: '#p256', publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'p256', y: 'p256' } },
        ])
      );

      await getIssuerPublicKey(env, did, undefined, kid);

      expect(issuerTrustKeyMocks.importECPublicKey).toHaveBeenCalledWith(
        expect.objectContaining({ x: 'p256' })
      );
    });

    it("prefers a method ID over another key's JWK kid", async () => {
      issuerTrustKeyMocks.resolveDID.mockResolvedValue(
        assertingWith([
          {
            id: `${did}#old`,
            publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'old', y: 'old', kid: `${did}#new` },
          },
          { id: `${did}#new`, publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'new', y: 'new' } },
        ])
      );

      await getIssuerPublicKey(env, did, undefined, `${did}#new`);

      expect(issuerTrustKeyMocks.importECPublicKey).toHaveBeenCalledWith(
        expect.objectContaining({ x: 'new' })
      );
    });

    it('refuses a kid that names more than one method', async () => {
      issuerTrustKeyMocks.resolveDID.mockResolvedValue(
        assertingWith([
          { id: '#dup', publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'a' } },
          { id: `${did}#dup`, publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'b', y: 'b' } },
        ])
      );

      await expect(getIssuerPublicKey(env, did, undefined, 'dup')).rejects.toThrow(
        'Key id names more than one verification method'
      );
      expect(issuerTrustKeyMocks.importECPublicKey).not.toHaveBeenCalled();
    });

    it('picks the JWKS key the kid names, and rejects an unknown one', async () => {
      issuerTrustKeyMocks.safeFetchJson.mockResolvedValue({
        keys: [
          { kty: 'EC', crv: 'P-256', use: 'sig', alg: 'ES256', kid: 'old', x: 'old' },
          { kty: 'EC', crv: 'P-256', alg: 'ES256', kid: 'new', x: 'new' },
          { kty: 'EC', crv: 'P-256', use: 'enc', alg: 'ES256', kid: 'enc-only' },
          { kty: 'EC', crv: 'P-256', key_ops: ['deriveBits'], kid: 'agreement' },
          { kty: 'EC', crv: 'P-384', alg: 'ES256', kid: 'curve-mismatch' },
        ],
      });

      await getIssuerPublicKey(env, did, 'https://issuer.example.com/jwks', 'new');
      expect(issuerTrustKeyMocks.importECPublicKey).toHaveBeenCalledWith(
        expect.objectContaining({ x: 'new', alg: 'ES256' })
      );

      for (const unusable of ['enc-only', 'agreement', 'curve-mismatch']) {
        await expect(
          getIssuerPublicKey(env, did, 'https://issuer.example.com/jwks', unusable)
        ).rejects.toThrow('No suitable EC signing key found in JWKS');
      }
    });

    it('only accepts an assertion key of the issuer', async () => {
      const authenticationOnly = {
        id: `${did}#auth`,
        controller: did,
        publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'auth', y: 'auth' },
      };
      issuerTrustKeyMocks.resolveDID.mockResolvedValue({
        ...rotated,
        verificationMethod: [...rotated.verificationMethod, authenticationOnly],
        authentication: [authenticationOnly.id],
      });
      await expect(getIssuerPublicKey(env, did, undefined, 'auth')).rejects.toThrow(
        'No verification method matches the key id'
      );

      issuerTrustKeyMocks.resolveDID.mockResolvedValue(
        assertingWith([
          {
            id: `${did}#foreign`,
            controller: 'did:web:other.example.com',
            publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'f', y: 'f' },
          },
          { id: `${did}#agreement`, publicKeyJwk: { kty: 'OKP', crv: 'X25519', x: 'k' } },
        ])
      );
      await expect(getIssuerPublicKey(env, did, undefined, 'foreign')).rejects.toThrow(
        'Verification method is controlled by another DID'
      );
      issuerTrustKeyMocks.resolveDID.mockResolvedValueOnce({
        verificationMethod: [{ id: '#bare', publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'b' } }],
        assertionMethod: ['#bare'],
      });
      await expect(getIssuerPublicKey(env, did, undefined, 'bare')).rejects.toThrow(
        'Verification method is controlled by another DID'
      );
      await expect(getIssuerPublicKey(env, did, undefined, 'agreement')).rejects.toThrow(
        'Verification method is not a supported signing key'
      );
      expect(issuerTrustKeyMocks.importECPublicKey).not.toHaveBeenCalled();
    });

    it('resolves an assertion key embedded in assertionMethod', async () => {
      issuerTrustKeyMocks.resolveDID.mockResolvedValue({
        verificationMethod: [
          {
            id: '#listed',
            controller: did,
            publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'l', y: 'l' },
          },
        ],
        assertionMethod: [
          {
            id: '#embedded',
            controller: did,
            publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'e', y: 'e' },
          },
        ],
      });

      await getIssuerPublicKey(env, did, undefined, 'embedded');

      expect(issuerTrustKeyMocks.importECPublicKey).toHaveBeenCalledWith(
        expect.objectContaining({ x: 'e' })
      );
    });
  });
});

describe('https issuers (SD-JWT VC Issuer Metadata)', () => {
  const env = {} as Env;
  const KEY = { kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig', kid: 'k1' };

  beforeEach(() => {
    vi.clearAllMocks();
    issuerTrustKeyMocks.importECPublicKey.mockResolvedValue('ec-key');
  });

  it('builds the metadata URL by inserting the well-known segment before the path', () => {
    expect(jwtVcIssuerMetadataUrl('https://idp.example.com')).toBe(
      'https://idp.example.com/.well-known/jwt-vc-issuer'
    );
    expect(jwtVcIssuerMetadataUrl('https://idp.example.com/t/acme/')).toBe(
      'https://idp.example.com/.well-known/jwt-vc-issuer/t/acme'
    );
    expect(() => jwtVcIssuerMetadataUrl('http://idp.example.com')).toThrow();
    expect(() => jwtVcIssuerMetadataUrl('https://idp.example.com/?a=1')).toThrow();
  });

  it('uses the inline jwks of metadata that names the issuer, by kid', async () => {
    issuerTrustKeyMocks.safeFetchJson.mockResolvedValue({
      issuer: 'https://idp.example.com',
      jwks: { keys: [KEY, { ...KEY, kid: 'k2' }] },
    });

    await expect(getIssuerPublicKey(env, 'https://idp.example.com', undefined, 'k2')).resolves.toBe(
      'ec-key'
    );
    expect(issuerTrustKeyMocks.safeFetchJson).toHaveBeenCalledWith(
      'https://idp.example.com/.well-known/jwt-vc-issuer',
      expect.objectContaining({ requireHttps: true })
    );
    expect(issuerTrustKeyMocks.importECPublicKey).toHaveBeenCalledWith(
      expect.objectContaining({ kid: 'k2' })
    );
    expect(issuerTrustKeyMocks.resolveDID).not.toHaveBeenCalled();
  });

  it('follows the jwks_uri of the metadata', async () => {
    issuerTrustKeyMocks.safeFetchJson
      .mockResolvedValueOnce({
        issuer: 'https://idp.example.com',
        jwks_uri: 'https://idp.example.com/vc/jwks',
      })
      .mockResolvedValueOnce({ keys: [KEY] });

    await getIssuerPublicKey(env, 'https://idp.example.com', undefined, 'k1');
    expect(issuerTrustKeyMocks.safeFetchJson).toHaveBeenLastCalledWith(
      'https://idp.example.com/vc/jwks',
      expect.objectContaining({ requireHttps: true })
    );
  });

  it('refuses metadata that names another issuer', async () => {
    issuerTrustKeyMocks.safeFetchJson.mockResolvedValue({
      issuer: 'https://evil.example.com',
      jwks: { keys: [KEY] },
    });
    await expect(
      getIssuerPublicKey(env, 'https://idp.example.com', undefined, 'k1')
    ).rejects.toThrow('different issuer');
    expect(issuerTrustKeyMocks.importECPublicKey).not.toHaveBeenCalled();
  });

  it('refuses metadata without keys', async () => {
    issuerTrustKeyMocks.safeFetchJson.mockResolvedValue({ issuer: 'https://idp.example.com' });
    await expect(getIssuerPublicKey(env, 'https://idp.example.com')).rejects.toThrow(
      'neither jwks nor jwks_uri'
    );
  });
});
