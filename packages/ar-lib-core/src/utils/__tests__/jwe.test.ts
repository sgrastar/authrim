/**
 * JWE (JSON Web Encryption) Utilities Tests
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  encryptJWT,
  decryptJWT,
  validateJWEOptions,
  isIDTokenEncryptionRequired,
  isUserInfoEncryptionRequired,
  getClientPublicKey,
  selectJWEEncryptionKey,
  SUPPORTED_JWE_ALG,
  SUPPORTED_JWE_ENC,
} from '../jwe';
import { generateKeyPair, exportJWK, type JWK } from 'jose';

describe('JWE Utilities', () => {
  let rsaPublicKey: JWK;
  let rsaPrivateKey: JWK;
  let ecPublicKey: JWK;
  let ecPrivateKey: JWK;

  beforeAll(async () => {
    // Generate RSA key pair for testing (RSA-OAEP uses SHA-1 by default)
    const rsaKeyPair = await generateKeyPair('RSA-OAEP', {
      modulusLength: 2048,
      extractable: true,
    });
    rsaPublicKey = await exportJWK(rsaKeyPair.publicKey);
    rsaPublicKey.kid = 'rsa-test-key';
    rsaPublicKey.alg = 'RSA-OAEP'; // Add algorithm to JWK
    rsaPrivateKey = await exportJWK(rsaKeyPair.privateKey);
    rsaPrivateKey.kid = 'rsa-test-key';
    rsaPrivateKey.alg = 'RSA-OAEP'; // Add algorithm to JWK

    // Generate EC key pair for testing (with extractable: true)
    const ecKeyPair = await generateKeyPair('ECDH-ES', {
      crv: 'P-256',
      extractable: true,
    });
    ecPublicKey = await exportJWK(ecKeyPair.publicKey);
    ecPublicKey.kid = 'ec-test-key';
    ecPublicKey.alg = 'ECDH-ES'; // Add algorithm to JWK
    ecPrivateKey = await exportJWK(ecKeyPair.privateKey);
    ecPrivateKey.kid = 'ec-test-key';
    ecPrivateKey.alg = 'ECDH-ES'; // Add algorithm to JWK
  });

  describe('encryptJWT and decryptJWT', () => {
    it('should encrypt and decrypt a JWT with RSA-OAEP + A256GCM', async () => {
      const payload =
        'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.signature';

      const encrypted = await encryptJWT(payload, rsaPublicKey, {
        alg: 'RSA-OAEP',
        enc: 'A256GCM',
        cty: 'JWT',
      });

      expect(encrypted).toBeDefined();
      expect(encrypted.split('.')).toHaveLength(5); // JWE compact serialization has 5 parts

      const decrypted = await decryptJWT(encrypted, rsaPrivateKey);
      expect(decrypted).toBe(payload);
    });

    it('should encrypt and decrypt a JWT with RSA-OAEP + A128GCM', async () => {
      const payload = 'test-payload-123';

      const encrypted = await encryptJWT(payload, rsaPublicKey, {
        alg: 'RSA-OAEP',
        enc: 'A128GCM',
      });

      expect(encrypted).toBeDefined();
      const decrypted = await decryptJWT(encrypted, rsaPrivateKey);
      expect(decrypted).toBe(payload);
    });

    it('should encrypt and decrypt with A128CBC-HS256', async () => {
      const payload = 'test-payload-cbc';

      const encrypted = await encryptJWT(payload, rsaPublicKey, {
        alg: 'RSA-OAEP',
        enc: 'A128CBC-HS256',
        cty: 'JWT',
        kid: 'rsa-test-key',
      });

      expect(encrypted).toBeDefined();
      const decrypted = await decryptJWT(encrypted, rsaPrivateKey);
      expect(decrypted).toBe(payload);
    });

    it('should encrypt and decrypt with ECDH-ES + A256GCM', async () => {
      const payload = 'test-payload-ec';

      const encrypted = await encryptJWT(payload, ecPublicKey, {
        alg: 'ECDH-ES',
        enc: 'A256GCM',
      });

      expect(encrypted).toBeDefined();
      const decrypted = await decryptJWT(encrypted, ecPrivateKey);
      expect(decrypted).toBe(payload);
    });

    it('should handle long payloads (full ID token)', async () => {
      const longPayload = JSON.stringify({
        iss: 'https://auth.example.com',
        sub: 'user-123',
        aud: 'client-abc',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        nonce: 'abc123',
        name: 'John Doe',
        email: 'john@example.com',
        email_verified: true,
        picture: 'https://example.com/avatar.jpg',
      }).repeat(10); // Make it larger

      const encrypted = await encryptJWT(longPayload, rsaPublicKey, {
        alg: 'RSA-OAEP',
        enc: 'A256GCM',
      });

      const decrypted = await decryptJWT(encrypted, rsaPrivateKey);
      expect(decrypted).toBe(longPayload);
    });
  });

  describe('validateJWEOptions', () => {
    it('should validate supported algorithms', () => {
      expect(() => validateJWEOptions('RSA-OAEP', 'A256GCM')).not.toThrow();
      expect(() => validateJWEOptions('RSA-OAEP-256', 'A128GCM')).not.toThrow();
      expect(() => validateJWEOptions('ECDH-ES', 'A256GCM')).not.toThrow();
      expect(() => validateJWEOptions('ECDH-ES+A256KW', 'A128CBC-HS256')).not.toThrow();
    });

    it('should reject unsupported key management algorithms', () => {
      expect(() => validateJWEOptions('RSA1_5', 'A256GCM')).toThrow(
        'Unsupported JWE key management algorithm'
      );
      expect(() => validateJWEOptions('dir', 'A256GCM')).toThrow(
        'Unsupported JWE key management algorithm'
      );
    });

    it('should reject unsupported content encryption algorithms', () => {
      expect(() => validateJWEOptions('RSA-OAEP', 'A128CTR')).toThrow(
        'Unsupported JWE content encryption algorithm'
      );
      expect(() => validateJWEOptions('RSA-OAEP', 'INVALID')).toThrow(
        'Unsupported JWE content encryption algorithm'
      );
    });
  });

  describe('isIDTokenEncryptionRequired', () => {
    it('should return true when both alg and enc are specified', () => {
      const metadata = {
        id_token_encrypted_response_alg: 'RSA-OAEP',
        id_token_encrypted_response_enc: 'A256GCM',
      };
      expect(isIDTokenEncryptionRequired(metadata)).toBe(true);
    });

    it('should return false when alg is missing', () => {
      const metadata = {
        id_token_encrypted_response_enc: 'A256GCM',
      };
      expect(isIDTokenEncryptionRequired(metadata)).toBe(false);
    });

    it('should return false when enc is missing', () => {
      const metadata = {
        id_token_encrypted_response_alg: 'RSA-OAEP',
      };
      expect(isIDTokenEncryptionRequired(metadata)).toBe(false);
    });

    it('should return false when both are missing', () => {
      const metadata = {};
      expect(isIDTokenEncryptionRequired(metadata)).toBe(false);
    });
  });

  describe('isUserInfoEncryptionRequired', () => {
    it('should return true when both alg and enc are specified', () => {
      const metadata = {
        userinfo_encrypted_response_alg: 'RSA-OAEP-256',
        userinfo_encrypted_response_enc: 'A128GCM',
      };
      expect(isUserInfoEncryptionRequired(metadata)).toBe(true);
    });

    it('should return false when not configured', () => {
      const metadata = {};
      expect(isUserInfoEncryptionRequired(metadata)).toBe(false);
    });
  });

  describe('getClientPublicKey', () => {
    it('should retrieve key from embedded jwks', async () => {
      const metadata = {
        jwks: {
          keys: [rsaPublicKey],
        },
      };

      const key = await getClientPublicKey(metadata);
      expect(key).toEqual(rsaPublicKey);
    });

    it('should retrieve specific key by kid from embedded jwks', async () => {
      const metadata = {
        jwks: {
          keys: [rsaPublicKey, ecPublicKey],
        },
      };

      const key = await getClientPublicKey(metadata, 'ec-test-key');
      expect(key).toEqual(ecPublicKey);
    });

    it('should select an embedded encryption key matching the requested algorithm', async () => {
      const metadata = {
        jwks: {
          keys: [
            { ...ecPublicKey, use: 'enc' },
            { ...rsaPublicKey, use: 'enc' },
          ],
        },
      };

      const key = await getClientPublicKey(metadata, undefined, 'RSA-OAEP');

      expect(key).toMatchObject({ kty: 'RSA', kid: 'rsa-test-key', alg: 'RSA-OAEP' });
    });

    it('should reject a decrypt-only key when selecting a key for encryption', async () => {
      const metadata = {
        jwks: {
          keys: [{ ...rsaPublicKey, use: 'enc', key_ops: ['decrypt'] }],
        },
      };

      await expect(getClientPublicKey(metadata, undefined, 'RSA-OAEP')).resolves.toBeNull();
    });

    it('should return null when key not found', async () => {
      const metadata = {
        jwks: {
          keys: [rsaPublicKey],
        },
      };

      const key = await getClientPublicKey(metadata, 'non-existent-kid');
      expect(key).toBeNull();
    });

    it('should return null when no jwks or jwks_uri', async () => {
      const metadata = {};
      const key = await getClientPublicKey(metadata);
      expect(key).toBeNull();
    });
  });

  describe('selectJWEEncryptionKey', () => {
    it('selects a key matching the requested algorithm and key type', () => {
      const selected = selectJWEEncryptionKey(
        [
          { ...ecPublicKey, use: 'enc', alg: 'ECDH-ES' },
          { ...rsaPublicKey, use: 'enc', alg: 'RSA-OAEP' },
        ],
        'RSA-OAEP'
      );

      expect(selected).toMatchObject({ kid: 'rsa-test-key', kty: 'RSA', alg: 'RSA-OAEP' });
    });

    it('rejects signing and decrypt-only keys', () => {
      expect(
        selectJWEEncryptionKey(
          [
            { ...rsaPublicKey, use: 'sig' },
            { ...rsaPublicKey, use: 'enc', key_ops: ['decrypt'] },
          ],
          'RSA-OAEP'
        )
      ).toBeNull();
    });

    it('rejects an RSA key for ECDH-ES and an EC key for RSA-OAEP', () => {
      expect(selectJWEEncryptionKey([rsaPublicKey], 'ECDH-ES')).toBeNull();
      expect(selectJWEEncryptionKey([ecPublicKey], 'RSA-OAEP')).toBeNull();
    });

    it('supports deterministic key rotation when every candidate has a distinct kid', () => {
      const selected = selectJWEEncryptionKey(
        [
          { ...rsaPublicKey, kid: 'rotation-b', use: 'enc' },
          { ...rsaPublicKey, kid: 'rotation-a', use: 'enc' },
        ],
        'RSA-OAEP'
      );

      expect(selected?.kid).toBe('rotation-a');
    });

    it('fails closed when multiple matching keys cannot be identified uniquely', () => {
      expect(
        selectJWEEncryptionKey(
          [
            { ...rsaPublicKey, kid: undefined, use: 'enc' },
            { ...rsaPublicKey, kid: undefined, use: 'enc' },
          ],
          'RSA-OAEP'
        )
      ).toBeNull();
    });
  });

  describe('Constants', () => {
    it('should export supported JWE algorithms', () => {
      expect(SUPPORTED_JWE_ALG).toContain('RSA-OAEP');
      expect(SUPPORTED_JWE_ALG).toContain('RSA-OAEP-256');
      expect(SUPPORTED_JWE_ALG).toContain('ECDH-ES');
      expect(SUPPORTED_JWE_ALG).toContain('ECDH-ES+A256KW');
    });

    it('should export supported JWE encryption algorithms', () => {
      expect(SUPPORTED_JWE_ENC).toContain('A128GCM');
      expect(SUPPORTED_JWE_ENC).toContain('A256GCM');
      expect(SUPPORTED_JWE_ENC).toContain('A128CBC-HS256');
      expect(SUPPORTED_JWE_ENC).toContain('A256CBC-HS512');
    });
  });
});
