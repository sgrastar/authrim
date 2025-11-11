import { describe, it, expect, beforeAll } from 'vitest';
import {
  createIDToken,
  createAccessToken,
  verifyToken,
  parseToken,
  importPrivateKeyFromPEM,
  importPublicKeyFromJWK,
  type IDTokenClaims,
  type AccessTokenClaims,
} from '../../src/utils/jwt';
import { generateKeySet } from '../../src/utils/keys';
import type { KeyLike, JWK } from 'jose';

describe('JWT Utilities', () => {
  let privateKey: KeyLike;
  let publicKey: KeyLike;
  let publicJWK: JWK;
  let privatePEM: string;
  const kid = 'test-key-1';
  const issuer = 'http://localhost:8787';
  const clientId = 'test-client';

  beforeAll(async () => {
    const keySet = await generateKeySet(kid);
    privateKey = keySet.privateKey;
    publicKey = keySet.publicKey;
    publicJWK = keySet.publicJWK;
    privatePEM = keySet.privatePEM;
  });

  describe('createIDToken', () => {
    it('should create valid ID token', async () => {
      const claims: Omit<IDTokenClaims, 'iat' | 'exp'> = {
        iss: issuer,
        sub: 'user123',
        aud: clientId,
      };

      const token = await createIDToken(claims, privateKey, kid, 3600);

      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.split('.').length).toBe(3); // JWT has 3 parts
    });

    it('should create ID token with nonce', async () => {
      const claims: Omit<IDTokenClaims, 'iat' | 'exp'> = {
        iss: issuer,
        sub: 'user123',
        aud: clientId,
        nonce: 'test-nonce-123',
      };

      const token = await createIDToken(claims, privateKey, kid);
      const parsed = parseToken(token);

      expect(parsed.nonce).toBe('test-nonce-123');
    });

    it('should create ID token with user claims', async () => {
      const claims: Omit<IDTokenClaims, 'iat' | 'exp'> = {
        iss: issuer,
        sub: 'user123',
        aud: clientId,
        email: 'test@example.com',
        email_verified: true,
        name: 'Test User',
      };

      const token = await createIDToken(claims, privateKey, kid);
      const parsed = parseToken(token);

      expect(parsed.email).toBe('test@example.com');
      expect(parsed.email_verified).toBe(true);
      expect(parsed.name).toBe('Test User');
    });

    it('should set correct expiration time', async () => {
      const claims: Omit<IDTokenClaims, 'iat' | 'exp'> = {
        iss: issuer,
        sub: 'user123',
        aud: clientId,
      };

      const expiresIn = 7200;
      const token = await createIDToken(claims, privateKey, kid, expiresIn);
      const parsed = parseToken(token);

      expect(parsed.exp).toBeDefined();
      expect(parsed.iat).toBeDefined();
      expect(parsed.exp! - parsed.iat!).toBe(expiresIn);
    });
  });

  describe('createAccessToken', () => {
    it('should create valid access token', async () => {
      const claims: Omit<AccessTokenClaims, 'iat' | 'exp'> = {
        iss: issuer,
        sub: 'user123',
        aud: clientId,
        scope: 'openid profile',
        client_id: clientId,
      };

      const token = await createAccessToken(claims, privateKey, kid, 3600);

      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.split('.').length).toBe(3);
    });

    it('should include scope in access token', async () => {
      const claims: Omit<AccessTokenClaims, 'iat' | 'exp'> = {
        iss: issuer,
        sub: 'user123',
        aud: clientId,
        scope: 'openid profile email',
        client_id: clientId,
      };

      const token = await createAccessToken(claims, privateKey, kid);
      const parsed = parseToken(token);

      expect(parsed.scope).toBe('openid profile email');
    });
  });

  describe('verifyToken', () => {
    it('should verify valid token', async () => {
      const claims: Omit<IDTokenClaims, 'iat' | 'exp'> = {
        iss: issuer,
        sub: 'user123',
        aud: clientId,
      };

      const token = await createIDToken(claims, privateKey, kid);
      const verified = await verifyToken(token, publicKey, issuer, clientId);

      expect(verified).toBeDefined();
      expect(verified.iss).toBe(issuer);
      expect(verified.sub).toBe('user123');
      expect(verified.aud).toBe(clientId);
    });

    it('should reject token with invalid signature', async () => {
      const claims: Omit<IDTokenClaims, 'iat' | 'exp'> = {
        iss: issuer,
        sub: 'user123',
        aud: clientId,
      };

      const token = await createIDToken(claims, privateKey, kid);
      const tamperedToken = token.slice(0, -10) + 'tampered12';

      // Generate a different key pair
      const differentKeySet = await generateKeySet('different-key');

      await expect(
        verifyToken(tamperedToken, differentKeySet.publicKey, issuer, clientId)
      ).rejects.toThrow();
    });

    it('should reject token with wrong issuer', async () => {
      const claims: Omit<IDTokenClaims, 'iat' | 'exp'> = {
        iss: issuer,
        sub: 'user123',
        aud: clientId,
      };

      const token = await createIDToken(claims, privateKey, kid);

      await expect(
        verifyToken(token, publicKey, 'http://wrong-issuer.com', clientId)
      ).rejects.toThrow();
    });

    it('should reject token with wrong audience', async () => {
      const claims: Omit<IDTokenClaims, 'iat' | 'exp'> = {
        iss: issuer,
        sub: 'user123',
        aud: clientId,
      };

      const token = await createIDToken(claims, privateKey, kid);

      await expect(verifyToken(token, publicKey, issuer, 'wrong-audience')).rejects.toThrow();
    });
  });

  describe('parseToken', () => {
    it('should parse token without verification', async () => {
      const claims: Omit<IDTokenClaims, 'iat' | 'exp'> = {
        iss: issuer,
        sub: 'user123',
        aud: clientId,
        nonce: 'test-nonce',
      };

      const token = await createIDToken(claims, privateKey, kid);
      const parsed = parseToken(token);

      expect(parsed.iss).toBe(issuer);
      expect(parsed.sub).toBe('user123');
      expect(parsed.aud).toBe(clientId);
      expect(parsed.nonce).toBe('test-nonce');
    });

    it('should throw error for invalid JWT format', () => {
      expect(() => parseToken('invalid.jwt')).toThrow('Invalid JWT format');
    });
  });

  describe('importPrivateKeyFromPEM', () => {
    it('should import private key from PEM', async () => {
      const imported = await importPrivateKeyFromPEM(privatePEM);

      expect(imported).toBeDefined();

      // Verify we can sign with imported key
      const claims: Omit<IDTokenClaims, 'iat' | 'exp'> = {
        iss: issuer,
        sub: 'user123',
        aud: clientId,
      };

      const token = await createIDToken(claims, imported, kid);
      expect(token).toBeDefined();
    });
  });

  describe('importPublicKeyFromJWK', () => {
    it('should import public key from JWK', async () => {
      const imported = await importPublicKeyFromJWK(publicJWK);

      expect(imported).toBeDefined();

      // Verify we can verify with imported key
      const claims: Omit<IDTokenClaims, 'iat' | 'exp'> = {
        iss: issuer,
        sub: 'user123',
        aud: clientId,
      };

      const token = await createIDToken(claims, privateKey, kid);
      const verified = await verifyToken(token, imported, issuer, clientId);

      expect(verified).toBeDefined();
    });
  });

  describe('Token Round Trip', () => {
    it('should create and verify ID token successfully', async () => {
      const claims: Omit<IDTokenClaims, 'iat' | 'exp'> = {
        iss: issuer,
        sub: 'user123',
        aud: clientId,
        nonce: 'test-nonce',
        email: 'test@example.com',
        email_verified: true,
      };

      const token = await createIDToken(claims, privateKey, kid);
      const verified = await verifyToken(token, publicKey, issuer, clientId);

      expect(verified.sub).toBe('user123');
      expect(verified.nonce).toBe('test-nonce');
      expect(verified.email).toBe('test@example.com');
    });

    it('should create and verify access token successfully', async () => {
      const claims: Omit<AccessTokenClaims, 'iat' | 'exp'> = {
        iss: issuer,
        sub: 'user123',
        aud: clientId,
        scope: 'openid profile email',
        client_id: clientId,
      };

      const token = await createAccessToken(claims, privateKey, kid);
      const verified = await verifyToken(token, publicKey, issuer, clientId);

      expect(verified.sub).toBe('user123');
      expect(verified.scope).toBe('openid profile email');
    });
  });
});
