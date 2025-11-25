import { describe, it, expect } from 'vitest';
import { generateRSAKeyPair, exportPublicJWK, exportPrivateKey, generateKeySet } from '../keys';

describe('Key Generation Utilities', () => {
  describe('generateRSAKeyPair', () => {
    it('should generate RSA key pair with default size', async () => {
      const keyPair = await generateRSAKeyPair();

      expect(keyPair).toBeDefined();
      expect(keyPair.publicKey).toBeDefined();
      expect(keyPair.privateKey).toBeDefined();
    });

    it('should generate RSA key pair with custom size', async () => {
      const keyPair = await generateRSAKeyPair(4096);

      expect(keyPair).toBeDefined();
      expect(keyPair.publicKey).toBeDefined();
      expect(keyPair.privateKey).toBeDefined();
    });
  });

  describe('exportPublicJWK', () => {
    it('should export public key as JWK format', async () => {
      const { publicKey } = await generateRSAKeyPair();
      const jwk = await exportPublicJWK(publicKey);

      expect(jwk).toBeDefined();
      expect(jwk.kty).toBe('RSA');
      expect(jwk.use).toBe('sig');
      expect(jwk.alg).toBe('RS256');
      expect(jwk.n).toBeDefined(); // Modulus
      expect(jwk.e).toBeDefined(); // Exponent
    });

    it('should include kid when provided', async () => {
      const { publicKey } = await generateRSAKeyPair();
      const kid = 'test-key-1';
      const jwk = await exportPublicJWK(publicKey, kid);

      expect(jwk.kid).toBe(kid);
    });

    it('should not include kid when not provided', async () => {
      const { publicKey } = await generateRSAKeyPair();
      const jwk = await exportPublicJWK(publicKey);

      expect(jwk.kid).toBeUndefined();
    });
  });

  describe('exportPrivateKey', () => {
    it('should export private key as PEM format', async () => {
      const { privateKey } = await generateRSAKeyPair();
      const pem = await exportPrivateKey(privateKey);

      expect(pem).toBeDefined();
      expect(pem).toContain('-----BEGIN PRIVATE KEY-----');
      expect(pem).toContain('-----END PRIVATE KEY-----');
    });
  });

  describe('generateKeySet', () => {
    it('should generate complete key set', async () => {
      const kid = 'test-key-set-1';
      const keySet = await generateKeySet(kid);

      expect(keySet).toBeDefined();
      expect(keySet.publicJWK).toBeDefined();
      expect(keySet.privatePEM).toBeDefined();
      expect(keySet.publicKey).toBeDefined();
      expect(keySet.privateKey).toBeDefined();

      // Verify JWK format
      expect(keySet.publicJWK.kty).toBe('RSA');
      expect(keySet.publicJWK.kid).toBe(kid);

      // Verify PEM format
      expect(keySet.privatePEM).toContain('-----BEGIN PRIVATE KEY-----');
    });

    it('should generate key set with custom modulus length', async () => {
      const kid = 'test-key-set-2';
      const keySet = await generateKeySet(kid, 4096);

      expect(keySet).toBeDefined();
      expect(keySet.publicJWK).toBeDefined();
      expect(keySet.privatePEM).toBeDefined();
    });
  });
});
