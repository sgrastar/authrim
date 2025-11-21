/**
 * JWT and JWE Utility Tests
 * Testing token format detection and JWE operations
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import type { JWK } from 'jose';
import { getTokenFormat } from '../jwt';
import { encryptJWT, decryptJWT, validateJWEOptions, getClientPublicKey } from '../jwe';

describe('JWT/JWE Utilities', () => {
  let keyPair: { publicKey: CryptoKey; privateKey: CryptoKey };
  let publicJWK: JWK;
  let privateJWK: JWK;

  beforeAll(async () => {
    keyPair = await generateKeyPair('RS256', { extractable: true });
    publicJWK = await exportJWK(keyPair.publicKey);
    privateJWK = await exportJWK(keyPair.privateKey);

    publicJWK.kid = 'test-key-1';
    publicJWK.use = 'enc';
    publicJWK.alg = 'RSA-OAEP';
    privateJWK.alg = 'RSA-OAEP';
  });

  describe('getTokenFormat', () => {
    it('should detect JWT format (3 parts)', () => {
      const jwt = 'header.payload.signature';
      expect(getTokenFormat(jwt)).toBe('jwt');
    });

    it('should detect JWE format (5 parts)', () => {
      const jwe = 'header.encrypted_key.iv.ciphertext.tag';
      expect(getTokenFormat(jwe)).toBe('jwe');
    });

    it('should return unknown for invalid formats', () => {
      expect(getTokenFormat('invalid')).toBe('unknown');
      expect(getTokenFormat('only.two')).toBe('unknown');
      expect(getTokenFormat('too.many.parts.here.foo.bar')).toBe('unknown');
      expect(getTokenFormat('')).toBe('unknown');
    });

    it('should handle edge cases', () => {
      expect(getTokenFormat('...')).toBe('unknown'); // 4 empty parts
      expect(getTokenFormat('a.b')).toBe('unknown'); // 2 parts
      expect(getTokenFormat('a.b.c.d')).toBe('unknown'); // 4 parts
    });
  });

  describe('encryptJWT', () => {
    it('should encrypt a JWT string to JWE', async () => {
      const signedJWT = await new SignJWT({ sub: 'user123' })
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
        .sign(keyPair.privateKey);

      const jwe = await encryptJWT(signedJWT, publicJWK, {
        alg: 'RSA-OAEP',
        enc: 'A256GCM',
        cty: 'JWT',
      });

      expect(getTokenFormat(jwe)).toBe('jwe');
      expect(jwe.split('.')).toHaveLength(5);
    });

    it('should include cty header for nested JWT', async () => {
      const jwt = 'eyJhbGc.payload.signature';

      const jwe = await encryptJWT(jwt, publicJWK, {
        alg: 'RSA-OAEP',
        enc: 'A256GCM',
        cty: 'JWT',
      });

      // Extract and verify header
      const parts = jwe.split('.');
      const headerB64 = parts[0].replace(/-/g, '+').replace(/_/g, '/');
      const header = JSON.parse(Buffer.from(headerB64, 'base64').toString());

      expect(header.cty).toBe('JWT');
      expect(header.alg).toBe('RSA-OAEP');
      expect(header.enc).toBe('A256GCM');
    });

    it('should support different encryption algorithms', async () => {
      const payload = 'test-payload';

      const algorithms = [
        { alg: 'RSA-OAEP' as const, enc: 'A256GCM' as const },
        { alg: 'RSA-OAEP' as const, enc: 'A128GCM' as const },
        { alg: 'RSA-OAEP-256' as const, enc: 'A256GCM' as const },
      ];

      for (const { alg, enc } of algorithms) {
        const jwe = await encryptJWT(payload, publicJWK, { alg, enc });
        expect(getTokenFormat(jwe)).toBe('jwe');
      }
    });

    it('should optionally include kid in header', async () => {
      const payload = 'test';

      const jweWithKid = await encryptJWT(payload, publicJWK, {
        alg: 'RSA-OAEP',
        enc: 'A256GCM',
        kid: 'custom-key-id',
      });

      const parts = jweWithKid.split('.');
      const headerB64 = parts[0].replace(/-/g, '+').replace(/_/g, '/');
      const header = JSON.parse(Buffer.from(headerB64, 'base64').toString());

      expect(header.kid).toBe('custom-key-id');
    });
  });

  describe('decryptJWT', () => {
    it('should decrypt JWE back to original payload', async () => {
      const originalPayload = 'test-secret-data';

      const jwe = await encryptJWT(originalPayload, publicJWK, {
        alg: 'RSA-OAEP',
        enc: 'A256GCM',
      });

      const decrypted = await decryptJWT(jwe, privateJWK);
      expect(decrypted).toBe(originalPayload);
    });

    it('should decrypt nested JWT', async () => {
      // Create signed JWT
      const signedJWT = await new SignJWT({ user: 'alice', role: 'admin' })
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
        .sign(keyPair.privateKey);

      // Encrypt it
      const jwe = await encryptJWT(signedJWT, publicJWK, {
        alg: 'RSA-OAEP',
        enc: 'A256GCM',
        cty: 'JWT',
      });

      // Decrypt to get signed JWT back
      const decrypted = await decryptJWT(jwe, privateJWK);
      expect(decrypted).toBe(signedJWT);
      expect(getTokenFormat(decrypted)).toBe('jwt');
    });

    it('should handle JSON payloads', async () => {
      const jsonPayload = JSON.stringify({ foo: 'bar', num: 123 });

      const jwe = await encryptJWT(jsonPayload, publicJWK, {
        alg: 'RSA-OAEP',
        enc: 'A256GCM',
      });

      const decrypted = await decryptJWT(jwe, privateJWK);
      const parsed = JSON.parse(decrypted);

      expect(parsed.foo).toBe('bar');
      expect(parsed.num).toBe(123);
    });
  });

  describe('validateJWEOptions', () => {
    it('should accept valid algorithm combinations', () => {
      const validCombinations = [
        { alg: 'RSA-OAEP', enc: 'A256GCM' },
        { alg: 'RSA-OAEP-256', enc: 'A128GCM' },
        { alg: 'ECDH-ES', enc: 'A192GCM' },
        { alg: 'ECDH-ES+A256KW', enc: 'A256CBC-HS512' },
      ];

      validCombinations.forEach(({ alg, enc }) => {
        expect(() => validateJWEOptions(alg, enc)).not.toThrow();
        expect(validateJWEOptions(alg, enc)).toBe(true);
      });
    });

    it('should reject unsupported algorithms', () => {
      expect(() => validateJWEOptions('AES128', 'A256GCM')).toThrow('Unsupported JWE key management algorithm');
      expect(() => validateJWEOptions('RSA-OAEP', 'AES128')).toThrow('Unsupported JWE content encryption algorithm');
    });

    it('should reject invalid algorithm names', () => {
      expect(() => validateJWEOptions('invalid-alg', 'A256GCM')).toThrow();
      expect(() => validateJWEOptions('RSA-OAEP', 'invalid-enc')).toThrow();
    });
  });

  describe('getClientPublicKey', () => {
    it('should retrieve key from embedded jwks', async () => {
      const clientMetadata = {
        jwks: {
          keys: [publicJWK],
        },
      };

      const key = await getClientPublicKey(clientMetadata);
      expect(key).toBeTruthy();
      expect(key?.kid).toBe('test-key-1');
    });

    it('should find key by kid', async () => {
      const key1: JWK = { ...publicJWK, kid: 'key-1' };
      const key2: JWK = { ...publicJWK, kid: 'key-2' };

      const clientMetadata = {
        jwks: {
          keys: [key1, key2],
        },
      };

      const foundKey = await getClientPublicKey(clientMetadata, 'key-2');
      expect(foundKey?.kid).toBe('key-2');
    });

    it('should return null if no keys available', async () => {
      const clientMetadata = {};
      const key = await getClientPublicKey(clientMetadata);
      expect(key).toBeNull();
    });

    it('should return null if jwks is empty', async () => {
      const clientMetadata = {
        jwks: { keys: [] },
      };

      const key = await getClientPublicKey(clientMetadata);
      expect(key).toBeNull();
    });

    it('should return first key if no kid specified', async () => {
      const key1: JWK = { ...publicJWK, kid: 'first' };
      const key2: JWK = { ...publicJWK, kid: 'second' };

      const clientMetadata = {
        jwks: {
          keys: [key1, key2],
        },
      };

      const foundKey = await getClientPublicKey(clientMetadata);
      expect(foundKey?.kid).toBe('first');
    });
  });

  describe('Encryption/Decryption Round-trip', () => {
    it('should successfully round-trip encrypt and decrypt', async () => {
      const originalData = 'sensitive-information-12345';

      // Encrypt
      const encrypted = await encryptJWT(originalData, publicJWK, {
        alg: 'RSA-OAEP',
        enc: 'A256GCM',
      });

      // Decrypt
      const decrypted = await decryptJWT(encrypted, privateJWK);

      expect(decrypted).toBe(originalData);
    });

    it('should preserve complex JSON structures', async () => {
      const complexData = {
        user: {
          id: 123,
          name: 'Alice',
          roles: ['admin', 'user'],
        },
        metadata: {
          created: '2024-01-01',
          updated: '2024-01-15',
        },
      };

      const jsonString = JSON.stringify(complexData);

      const encrypted = await encryptJWT(jsonString, publicJWK, {
        alg: 'RSA-OAEP',
        enc: 'A256GCM',
      });

      const decrypted = await decryptJWT(encrypted, privateJWK);
      const parsed = JSON.parse(decrypted);

      expect(parsed.user.name).toBe('Alice');
      expect(parsed.user.roles).toEqual(['admin', 'user']);
      expect(parsed.metadata.created).toBe('2024-01-01');
    });

    it('should handle empty strings', async () => {
      const empty = '';

      const encrypted = await encryptJWT(empty, publicJWK, {
        alg: 'RSA-OAEP',
        enc: 'A256GCM',
      });

      const decrypted = await decryptJWT(encrypted, privateJWK);
      expect(decrypted).toBe('');
    });

    it('should handle special characters', async () => {
      const specialChars = '!@#$%^&*()_+-=[]{}|;:,.<>?/~`"\' 日本語';

      const encrypted = await encryptJWT(specialChars, publicJWK, {
        alg: 'RSA-OAEP',
        enc: 'A256GCM',
      });

      const decrypted = await decryptJWT(encrypted, privateJWK);
      expect(decrypted).toBe(specialChars);
    });
  });

  describe('Error Handling', () => {
    it('should throw error when decrypting with wrong key', async () => {
      const encrypted = await encryptJWT('secret', publicJWK, {
        alg: 'RSA-OAEP',
        enc: 'A256GCM',
      });

      const wrongKeyPair = await generateKeyPair('RS256', { extractable: true });
      const wrongPrivateJWK = await exportJWK(wrongKeyPair.privateKey);
      wrongPrivateJWK.alg = 'RSA-OAEP';

      await expect(decryptJWT(encrypted, wrongPrivateJWK)).rejects.toThrow();
    });

    it('should throw error for tampered JWE', async () => {
      const encrypted = await encryptJWT('secret', publicJWK, {
        alg: 'RSA-OAEP',
        enc: 'A256GCM',
      });

      // Tamper with the ciphertext
      const parts = encrypted.split('.');
      const tamperedJWE = `${parts[0]}.${parts[1]}.${parts[2]}.tampered.${parts[4]}`;

      await expect(decryptJWT(tamperedJWE, privateJWK)).rejects.toThrow();
    });
  });

  describe('Security Best Practices', () => {
    it('should use recommended encryption algorithms', () => {
      const recommendedAlgs = ['RSA-OAEP', 'RSA-OAEP-256', 'ECDH-ES+A256KW'];
      const recommendedEncs = ['A256GCM', 'A192GCM'];

      recommendedAlgs.forEach(alg => {
        expect(() => validateJWEOptions(alg, 'A256GCM')).not.toThrow();
      });

      recommendedEncs.forEach(enc => {
        expect(() => validateJWEOptions('RSA-OAEP', enc)).not.toThrow();
      });
    });

    it('should prefer A256GCM for content encryption', () => {
      const preferredEnc = 'A256GCM';
      expect(() => validateJWEOptions('RSA-OAEP', preferredEnc)).not.toThrow();
    });
  });
});
