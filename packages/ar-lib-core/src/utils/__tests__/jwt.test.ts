import { describe, it, expect, beforeAll } from 'vitest';
import {
  createIDToken,
  createAccessToken,
  createRefreshToken,
  verifyToken,
  parseToken,
  importPrivateKeyFromPEM,
  importPublicKeyFromJWK,
  type IDTokenClaims,
  type AccessTokenClaims,
} from '../jwt';
import { generateKeySet } from '../keys';
import { decodeProtectedHeader, generateKeyPair, jwtVerify, type KeyLike, type JWK } from 'jose';

describe('JWT Utilities', () => {
  let privateKey: KeyLike;
  let publicKey: KeyLike;
  let differentPublicKey: KeyLike;
  let publicJWK: JWK;
  let privatePEM: string;
  const kid = 'test-key-1';
  const issuer = 'http://localhost:8787';
  const clientId = 'test-client';

  beforeAll(async () => {
    const keySet = await generateKeySet(kid);
    const differentKeySet = await generateKeySet('different-key');
    privateKey = keySet.privateKey;
    publicKey = keySet.publicKey;
    differentPublicKey = differentKeySet.publicKey;
    publicJWK = keySet.publicJWK;
    privatePEM = keySet.privatePEM;
  });

  describe('createIDToken', () => {
    it('signs with a client-selected ES256 key', async () => {
      const { privateKey: ecPrivateKey, publicKey: ecPublicKey } = await generateKeyPair('ES256');
      const token = await createIDToken(
        { iss: issuer, sub: 'user123', aud: clientId },
        ecPrivateKey,
        'oidc-es256-test',
        3600,
        'ES256'
      );

      expect(decodeProtectedHeader(token)).toMatchObject({
        alg: 'ES256',
        kid: 'oidc-es256-test',
      });
      await expect(
        jwtVerify(token, ecPublicKey, { issuer, audience: clientId, algorithms: ['ES256'] })
      ).resolves.toBeDefined();
    });

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
      const claims: Omit<AccessTokenClaims, 'iat' | 'exp' | 'jti'> = {
        iss: issuer,
        sub: 'user123',
        aud: clientId,
        scope: 'openid profile',
        client_id: clientId,
      };

      const result = await createAccessToken(claims, privateKey, kid, 3600);

      expect(result).toBeDefined();
      expect(result.token).toBeDefined();
      expect(result.jti).toBeDefined();
      expect(typeof result.token).toBe('string');
      expect(typeof result.jti).toBe('string');
      expect(result.token.split('.').length).toBe(3);
    });

    it('should include scope in access token', async () => {
      const claims: Omit<AccessTokenClaims, 'iat' | 'exp' | 'jti'> = {
        iss: issuer,
        sub: 'user123',
        aud: clientId,
        scope: 'openid profile email',
        client_id: clientId,
      };

      const result = await createAccessToken(claims, privateKey, kid);
      const parsed = parseToken(result.token);

      expect(parsed.scope).toBe('openid profile email');
      expect(parsed.jti).toBe(result.jti);
      expect(parsed.token_use).toBe('access');
    });

    it('should preserve a narrower internal token-use discriminator', async () => {
      const result = await createAccessToken(
        {
          iss: issuer,
          sub: 'user123',
          aud: clientId,
          scope: 'elevation:use',
          client_id: clientId,
          token_use: 'elevation_grant_subject',
        },
        privateKey,
        kid
      );

      expect(parseToken(result.token).token_use).toBe('elevation_grant_subject');
    });
  });

  describe('createRefreshToken', () => {
    it('should include the refresh token-use discriminator', async () => {
      const result = await createRefreshToken(
        {
          iss: issuer,
          sub: 'user123',
          aud: clientId,
          scope: 'openid offline_access',
          client_id: clientId,
        },
        privateKey,
        kid
      );

      const parsed = parseToken(result.token);

      expect(parsed.token_use).toBe('refresh');
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
      const verified = await verifyToken(token, publicKey, issuer, { audience: clientId });

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

      await expect(
        verifyToken(tamperedToken, differentPublicKey, issuer, { audience: clientId })
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
        verifyToken(token, publicKey, 'http://wrong-issuer.com', { audience: clientId })
      ).rejects.toThrow();
    });

    it('should reject token with wrong audience', async () => {
      const claims: Omit<IDTokenClaims, 'iat' | 'exp'> = {
        iss: issuer,
        sub: 'user123',
        aud: clientId,
      };

      const token = await createIDToken(claims, privateKey, kid);

      await expect(
        verifyToken(token, publicKey, issuer, { audience: 'wrong-audience' })
      ).rejects.toThrow();
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

    it('should reject oversized JWTs before decoding', () => {
      const token = ['e30', 'x'.repeat(17 * 1024), 'sig'].join('.');

      expect(() => parseToken(token)).toThrow('exceeds maximum size');
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
      const verified = await verifyToken(token, imported, issuer, { audience: clientId });

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
      const verified = await verifyToken(token, publicKey, issuer, { audience: clientId });

      expect(verified.sub).toBe('user123');
      expect(verified.nonce).toBe('test-nonce');
      expect(verified.email).toBe('test@example.com');
    });

    it('should create and verify access token successfully', async () => {
      const claims: Omit<AccessTokenClaims, 'iat' | 'exp' | 'jti'> = {
        iss: issuer,
        sub: 'user123',
        aud: clientId,
        scope: 'openid profile email',
        client_id: clientId,
      };

      const result = await createAccessToken(claims, privateKey, kid);
      const verified = await verifyToken(result.token, publicKey, issuer, { audience: clientId });

      expect(verified.sub).toBe('user123');
      expect(verified.scope).toBe('openid profile email');
      expect(verified.jti).toBe(result.jti);
    });
  });
});
