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

import { getIssuerPublicKey } from '../issuer-trust';

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

  it('prefers EC verification methods from a DID document', async () => {
    issuerTrustKeyMocks.resolveDID.mockResolvedValue({
      verificationMethod: [
        { id: '#ed', publicKeyJwk: { kty: 'OKP', crv: 'Ed25519' } },
        { id: '#p256', publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } },
      ],
    });

    const key = await getIssuerPublicKey(env, 'did:web:issuer.example.com');

    expect(key).toBe('ec-key');
    expect(issuerTrustKeyMocks.resolveDID).toHaveBeenCalledWith('did:web:issuer.example.com');
    expect(issuerTrustKeyMocks.importECPublicKey).toHaveBeenCalledWith({
      kty: 'EC',
      crv: 'P-256',
      x: 'x',
      y: 'y',
    });
    expect(issuerTrustKeyMocks.importJWK).not.toHaveBeenCalled();
  });

  it('falls back to Ed25519 OKP keys when a DID document has no EC method', async () => {
    issuerTrustKeyMocks.resolveDID.mockResolvedValue({
      verificationMethod: [
        { id: '#ed', publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: 'x', alg: 'EdDSA' } },
      ],
    });

    const key = await getIssuerPublicKey(env, 'did:web:issuer.example.com');

    expect(key).toBe('okp-key');
    expect(issuerTrustKeyMocks.importJWK).toHaveBeenCalledWith(
      { kty: 'OKP', crv: 'Ed25519', x: 'x', alg: 'EdDSA' },
      'EdDSA'
    );
  });

  it('rejects unresolved or keyless DID documents without leaking DID details', async () => {
    issuerTrustKeyMocks.resolveDID.mockResolvedValueOnce(null);
    await expect(getIssuerPublicKey(env, 'did:web:issuer.example.com')).rejects.toThrow(
      'Failed to resolve DID document'
    );

    issuerTrustKeyMocks.resolveDID.mockResolvedValueOnce({ verificationMethod: [] });
    await expect(getIssuerPublicKey(env, 'did:web:issuer.example.com')).rejects.toThrow(
      'No verification methods found in DID document'
    );
  });
});
