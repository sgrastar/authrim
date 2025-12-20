/**
 * EC Key Utilities Tests
 *
 * Tests for EC key generation and management utilities (Phase 9).
 */

import { describe, it, expect } from 'vitest';
import {
  generateECKeyPair,
  generateECKeySet,
  exportECPublicJWK,
  exportECPrivateKey,
  importECPublicKey,
  importECPrivateKey,
  getECCurve,
  getAlgorithmForCurve,
  validateECSigningKey,
  generateECKeyThumbprint,
  areECKeysEqual,
  ALGORITHM_TO_CURVE,
  CURVE_TO_ALGORITHM,
  type ECAlgorithm,
  type ECCurve,
} from '../ec-keys';

describe('EC Key Utilities', () => {
  describe('generateECKeyPair', () => {
    it('should generate ES256 key pair', async () => {
      const keyPair = await generateECKeyPair('ES256');

      expect(keyPair.algorithm).toBe('ES256');
      expect(keyPair.curve).toBe('P-256');
      expect(keyPair.publicKey).toBeDefined();
      expect(keyPair.privateKey).toBeDefined();
    });

    it('should generate ES384 key pair', async () => {
      const keyPair = await generateECKeyPair('ES384');

      expect(keyPair.algorithm).toBe('ES384');
      expect(keyPair.curve).toBe('P-384');
    });

    it('should generate ES512 key pair', async () => {
      const keyPair = await generateECKeyPair('ES512');

      expect(keyPair.algorithm).toBe('ES512');
      expect(keyPair.curve).toBe('P-521');
    });

    it('should default to ES256', async () => {
      const keyPair = await generateECKeyPair();

      expect(keyPair.algorithm).toBe('ES256');
      expect(keyPair.curve).toBe('P-256');
    });
  });

  describe('generateECKeySet', () => {
    it('should generate complete key set with kid', async () => {
      const kid = 'test-key-1';
      const keySet = await generateECKeySet(kid, 'ES256');

      expect(keySet.kid).toBe(kid);
      expect(keySet.algorithm).toBe('ES256');
      expect(keySet.curve).toBe('P-256');
      expect(keySet.publicJWK).toBeDefined();
      expect(keySet.publicJWK.kid).toBe(kid);
      expect(keySet.publicJWK.kty).toBe('EC');
      expect(keySet.publicJWK.use).toBe('sig');
      expect(keySet.publicJWK.alg).toBe('ES256');
      expect(keySet.privatePEM).toBeDefined();
      expect(keySet.privatePEM).toContain('-----BEGIN PRIVATE KEY-----');
    });

    it('should generate keys for all algorithms', async () => {
      const algorithms: ECAlgorithm[] = ['ES256', 'ES384', 'ES512'];

      for (const alg of algorithms) {
        const keySet = await generateECKeySet(`key-${alg}`, alg);
        expect(keySet.algorithm).toBe(alg);
        expect(keySet.publicJWK.alg).toBe(alg);
      }
    });
  });

  describe('exportECPublicJWK', () => {
    it('should export public key as JWK', async () => {
      const keyPair = await generateECKeyPair('ES256');
      const jwk = await exportECPublicJWK(keyPair.publicKey, 'ES256', 'my-key');

      expect(jwk.kty).toBe('EC');
      expect(jwk.use).toBe('sig');
      expect(jwk.alg).toBe('ES256');
      expect(jwk.kid).toBe('my-key');
      expect(jwk.x).toBeDefined();
      expect(jwk.y).toBeDefined();
      expect(jwk.d).toBeUndefined(); // No private key
    });
  });

  describe('exportECPrivateKey', () => {
    it('should export private key as PEM', async () => {
      const keyPair = await generateECKeyPair('ES256');
      const pem = await exportECPrivateKey(keyPair.privateKey);

      expect(pem).toContain('-----BEGIN PRIVATE KEY-----');
      expect(pem).toContain('-----END PRIVATE KEY-----');
    });
  });

  describe('importECPublicKey', () => {
    it('should import public key from JWK', async () => {
      const keySet = await generateECKeySet('test', 'ES256');
      const importedKey = await importECPublicKey(keySet.publicJWK);

      expect(importedKey).toBeDefined();
    });

    it('should throw for missing algorithm', async () => {
      const jwk = { kty: 'EC', crv: 'P-256', x: 'abc', y: 'def' };

      await expect(importECPublicKey(jwk)).rejects.toThrow('Unsupported or missing algorithm');
    });
  });

  describe('importECPrivateKey', () => {
    it('should throw for JWK without private key', async () => {
      const keySet = await generateECKeySet('test', 'ES256');

      await expect(importECPrivateKey(keySet.publicJWK)).rejects.toThrow(
        'JWK does not contain private key material'
      );
    });
  });

  describe('getECCurve', () => {
    it('should return curve from JWK', () => {
      expect(getECCurve({ kty: 'EC', crv: 'P-256' })).toBe('P-256');
      expect(getECCurve({ kty: 'EC', crv: 'P-384' })).toBe('P-384');
      expect(getECCurve({ kty: 'EC', crv: 'P-521' })).toBe('P-521');
    });

    it('should return null for non-EC keys', () => {
      expect(getECCurve({ kty: 'RSA' })).toBeNull();
    });

    it('should return null for unsupported curves', () => {
      expect(getECCurve({ kty: 'EC', crv: 'secp256k1' })).toBeNull();
    });
  });

  describe('getAlgorithmForCurve', () => {
    it('should return correct algorithm for curve', () => {
      expect(getAlgorithmForCurve('P-256')).toBe('ES256');
      expect(getAlgorithmForCurve('P-384')).toBe('ES384');
      expect(getAlgorithmForCurve('P-521')).toBe('ES512');
    });
  });

  describe('validateECSigningKey', () => {
    it('should validate valid EC signing key', async () => {
      const keySet = await generateECKeySet('test', 'ES256');
      const result = validateECSigningKey(keySet.publicJWK);

      expect(result.valid).toBe(true);
      expect(result.algorithm).toBe('ES256');
      expect(result.curve).toBe('P-256');
    });

    it('should reject non-EC keys', () => {
      const result = validateECSigningKey({ kty: 'RSA', n: 'abc', e: 'def' });

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Key type must be EC');
    });

    it('should reject encryption keys', () => {
      const result = validateECSigningKey({ kty: 'EC', crv: 'P-256', x: 'a', y: 'b', use: 'enc' });

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Key use must be "sig" for signing');
    });

    it('should reject keys with missing coordinates', () => {
      const result = validateECSigningKey({ kty: 'EC', crv: 'P-256', alg: 'ES256' });

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Missing x or y coordinate');
    });

    it('should reject mismatched algorithm and curve', () => {
      const result = validateECSigningKey({
        kty: 'EC',
        crv: 'P-256',
        x: 'a',
        y: 'b',
        alg: 'ES384', // Wrong algorithm for P-256
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('does not match curve');
    });
  });

  describe('generateECKeyThumbprint', () => {
    it('should generate consistent thumbprint', async () => {
      const keySet = await generateECKeySet('test', 'ES256');
      const thumbprint1 = await generateECKeyThumbprint(keySet.publicJWK);
      const thumbprint2 = await generateECKeyThumbprint(keySet.publicJWK);

      expect(thumbprint1).toBe(thumbprint2);
      expect(thumbprint1.length).toBeGreaterThan(0);
      // Should be base64url encoded (no +, /, or =)
      expect(thumbprint1).not.toMatch(/[+/=]/);
    });

    it('should generate different thumbprints for different keys', async () => {
      const keySet1 = await generateECKeySet('test1', 'ES256');
      const keySet2 = await generateECKeySet('test2', 'ES256');
      const thumbprint1 = await generateECKeyThumbprint(keySet1.publicJWK);
      const thumbprint2 = await generateECKeyThumbprint(keySet2.publicJWK);

      expect(thumbprint1).not.toBe(thumbprint2);
    });
  });

  describe('areECKeysEqual', () => {
    it('should return true for equal keys', async () => {
      const keySet = await generateECKeySet('test', 'ES256');

      expect(areECKeysEqual(keySet.publicJWK, keySet.publicJWK)).toBe(true);
    });

    it('should return false for different keys', async () => {
      const keySet1 = await generateECKeySet('test1', 'ES256');
      const keySet2 = await generateECKeySet('test2', 'ES256');

      expect(areECKeysEqual(keySet1.publicJWK, keySet2.publicJWK)).toBe(false);
    });

    it('should return false for non-EC keys', () => {
      expect(areECKeysEqual({ kty: 'RSA' }, { kty: 'RSA' })).toBe(false);
    });
  });

  describe('Constants', () => {
    it('should have correct algorithm to curve mapping', () => {
      expect(ALGORITHM_TO_CURVE.ES256).toBe('P-256');
      expect(ALGORITHM_TO_CURVE.ES384).toBe('P-384');
      expect(ALGORITHM_TO_CURVE.ES512).toBe('P-521');
    });

    it('should have correct curve to algorithm mapping', () => {
      expect(CURVE_TO_ALGORITHM['P-256']).toBe('ES256');
      expect(CURVE_TO_ALGORITHM['P-384']).toBe('ES384');
      expect(CURVE_TO_ALGORITHM['P-521']).toBe('ES512');
    });
  });
});
