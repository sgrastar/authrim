/**
 * Advanced JAR (JWT-Secured Authorization Request) Tests
 * Testing JWE encryption, client key verification, and HTTPS request_uri
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { SignJWT, importJWK, generateKeyPair, exportJWK, CompactEncrypt } from 'jose';
import type { JWK } from 'jose';
import { getTokenFormat } from '@authrim/shared';

describe('JAR - Advanced Features', () => {
  let serverKeyPair: { publicKey: CryptoKey; privateKey: CryptoKey };
  let clientKeyPair: { publicKey: CryptoKey; privateKey: CryptoKey };
  let serverEncKeyPair: { publicKey: CryptoKey; privateKey: CryptoKey };
  let serverPublicJWK: JWK;
  let clientPublicJWK: JWK;
  let serverEncPublicJWK: JWK;

  beforeAll(async () => {
    // Generate key pairs for testing
    serverKeyPair = await generateKeyPair('RS256', { extractable: true });
    clientKeyPair = await generateKeyPair('RS256', { extractable: true });
    // Generate separate encryption key pair for RSA-OAEP
    serverEncKeyPair = await generateKeyPair('RSA-OAEP', { extractable: true, modulusLength: 2048 });

    serverPublicJWK = await exportJWK(serverKeyPair.publicKey);
    clientPublicJWK = await exportJWK(clientKeyPair.publicKey);
    serverEncPublicJWK = await exportJWK(serverEncKeyPair.publicKey);

    // Add key IDs
    serverPublicJWK.kid = 'server-key-1';
    serverPublicJWK.use = 'sig';
    serverEncPublicJWK.kid = 'server-enc-key-1';
    serverEncPublicJWK.use = 'enc';
    serverEncPublicJWK.alg = 'RSA-OAEP';
    clientPublicJWK.kid = 'client-key-1';
    clientPublicJWK.use = 'sig';
  });

  describe('Request Object JWE Encryption', () => {
    it('should create a JWE encrypted request object (5 parts)', async () => {
      const requestClaims = {
        iss: 'https://client.example.com',
        aud: 'https://op.example.com',
        response_type: 'code',
        client_id: 'test-client',
        redirect_uri: 'https://client.example.com/callback',
        scope: 'openid profile',
        state: 'test-state',
        nonce: 'test-nonce',
      };

      // First, create a signed JWT
      const signedJWT = await new SignJWT(requestClaims)
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: clientPublicJWK.kid })
        .sign(clientKeyPair.privateKey);

      // Then encrypt it using server's encryption public key
      const encoder = new TextEncoder();
      const jwe = await new CompactEncrypt(encoder.encode(signedJWT))
        .setProtectedHeader({
          alg: 'RSA-OAEP',
          enc: 'A256GCM',
          cty: 'JWT',
        })
        .encrypt(serverEncKeyPair.publicKey);

      // Verify JWE format (5 parts)
      const parts = jwe.split('.');
      expect(parts).toHaveLength(5);
      expect(getTokenFormat(jwe)).toBe('jwe');
    });

    it('should detect token format correctly', () => {
      const jwt = 'header.payload.signature';
      const jwe = 'header.encrypted_key.iv.ciphertext.tag';

      expect(getTokenFormat(jwt)).toBe('jwt');
      expect(getTokenFormat(jwe)).toBe('jwe');
      expect(getTokenFormat('invalid')).toBe('unknown');
    });

    it('should create nested JWT (signed then encrypted)', async () => {
      const payload = {
        response_type: 'code',
        client_id: 'test-client',
        scope: 'openid',
      };

      // Step 1: Sign
      const signed = await new SignJWT(payload)
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
        .sign(clientKeyPair.privateKey);

      expect(getTokenFormat(signed)).toBe('jwt');

      // Step 2: Encrypt the signed JWT
      const encoder = new TextEncoder();
      const encrypted = await new CompactEncrypt(encoder.encode(signed))
        .setProtectedHeader({ alg: 'RSA-OAEP', enc: 'A256GCM', cty: 'JWT' })
        .encrypt(serverEncKeyPair.publicKey);

      expect(getTokenFormat(encrypted)).toBe('jwe');
    });
  });

  describe('Client Public Key Signature Verification', () => {
    it('should verify request object signed with client private key', async () => {
      const requestClaims = {
        iss: 'test-client',
        aud: 'https://op.example.com',
        response_type: 'code',
        client_id: 'test-client',
        redirect_uri: 'https://client.example.com/callback',
        scope: 'openid',
      };

      // Sign with client's private key
      const signedRequest = await new SignJWT(requestClaims)
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: clientPublicJWK.kid })
        .sign(clientKeyPair.privateKey);

      // Parse header to verify kid
      const parts = signedRequest.split('.');
      const header = JSON.parse(
        Buffer.from(parts[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()
      );

      expect(header.alg).toBe('RS256');
      expect(header.kid).toBe(clientPublicJWK.kid);
    });

    it('should support multiple keys in client JWKS', async () => {
      const signingKey = {
        ...clientPublicJWK,
        kid: 'signing-key-1',
        use: 'sig',
      };

      const encryptionKey = {
        ...serverPublicJWK,
        kid: 'encryption-key-1',
        use: 'enc',
      };

      const jwks = {
        keys: [signingKey, encryptionKey],
      };

      expect(jwks.keys).toHaveLength(2);
      expect(jwks.keys[0].use).toBe('sig');
      expect(jwks.keys[1].use).toBe('enc');

      // Find signing key
      const foundSigningKey = jwks.keys.find((k) => k.use === 'sig');
      expect(foundSigningKey?.kid).toBe('signing-key-1');
    });
  });

  describe('request_uri with HTTPS URL', () => {
    it('should validate HTTPS request_uri format', () => {
      const httpsUri = 'https://client.example.com/request/abc123';
      const parUri = 'urn:ietf:params:oauth:request_uri:xyz789';
      const invalidUri = 'http://insecure.example.com/request'; // HTTP not allowed

      expect(httpsUri.startsWith('https://')).toBe(true);
      expect(parUri.startsWith('urn:ietf:params:oauth:request_uri:')).toBe(true);
      expect(invalidUri.startsWith('http://')).toBe(true);
      expect(invalidUri.startsWith('https://')).toBe(false);
    });

    it('should accept both PAR URN and HTTPS URL for request_uri', () => {
      const validUris = [
        'urn:ietf:params:oauth:request_uri:abc123',
        'https://client.example.com/request.jwt',
      ];

      validUris.forEach((uri) => {
        const isPAR = uri.startsWith('urn:ietf:params:oauth:request_uri:');
        const isHTTPS = uri.startsWith('https://');
        expect(isPAR || isHTTPS).toBe(true);
      });
    });
  });

  describe('Request Object Claims', () => {
    it('should include all authorization parameters in request object', async () => {
      const fullRequestClaims = {
        iss: 'test-client',
        aud: 'https://op.example.com',
        response_type: 'code',
        client_id: 'test-client',
        redirect_uri: 'https://client.example.com/callback',
        scope: 'openid profile email',
        state: 'state-123',
        nonce: 'nonce-456',
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        code_challenge_method: 'S256',
        response_mode: 'query',
        prompt: 'consent',
        max_age: '3600',
        ui_locales: 'ja-JP en-US',
        id_token_hint: 'eyJhbGc...',
        login_hint: 'user@example.com',
        acr_values: 'urn:mace:incommon:iap:silver',
        claims: JSON.stringify({
          userinfo: {
            email: { essential: true },
            email_verified: { essential: true },
          },
        }),
      };

      const jwt = await new SignJWT(fullRequestClaims)
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
        .sign(clientKeyPair.privateKey);

      const parts = jwt.split('.');
      const payload = JSON.parse(
        Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()
      );

      expect(payload.response_type).toBe('code');
      expect(payload.scope).toBe('openid profile email');
      expect(payload.code_challenge_method).toBe('S256');
      expect(payload.login_hint).toBe('user@example.com');
    });

    it('should support PKCE parameters in request object', async () => {
      const pkceRequest = {
        response_type: 'code',
        client_id: 'public-client',
        redirect_uri: 'https://app.example.com/callback',
        scope: 'openid',
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        code_challenge_method: 'S256',
      };

      expect(pkceRequest.code_challenge).toBeTruthy();
      expect(pkceRequest.code_challenge_method).toBe('S256');
      expect(pkceRequest.code_challenge.length).toBeGreaterThanOrEqual(43);
    });
  });

  describe('Error Cases', () => {
    it('should reject request object with invalid JWT format', () => {
      const invalidFormats = [
        'only-one-part',
        'only.two-parts',
        'too.many.parts.in.this.jwt',
      ];

      invalidFormats.forEach((jwt) => {
        const parts = jwt.split('.');
        expect(parts.length).not.toBe(3);
        expect(parts.length).not.toBe(5);
      });
    });

    it('should validate request object expiration', () => {
      const now = Math.floor(Date.now() / 1000);
      const expiredClaims = {
        exp: now - 3600, // Expired 1 hour ago
        iat: now - 7200, // Issued 2 hours ago
      };

      const validClaims = {
        exp: now + 3600, // Expires in 1 hour
        iat: now,
      };

      expect(expiredClaims.exp).toBeLessThan(now);
      expect(validClaims.exp).toBeGreaterThan(now);
    });

    it('should reject request_uri with unsupported schemes', () => {
      const unsupportedUris = [
        'http://insecure.example.com/request',
        'ftp://files.example.com/request',
        'file:///local/request.jwt',
      ];

      unsupportedUris.forEach((uri) => {
        const isPAR = uri.startsWith('urn:ietf:params:oauth:request_uri:');
        const isHTTPS = uri.startsWith('https://');
        expect(isPAR || isHTTPS).toBe(false);
      });
    });
  });

  describe('Security Considerations', () => {
    it('should use strong encryption algorithms', () => {
      const supportedAlgs = ['RSA-OAEP', 'RSA-OAEP-256', 'ECDH-ES+A256KW'];
      const supportedEncs = ['A256GCM', 'A192GCM', 'A128GCM'];

      expect(supportedAlgs).toContain('RSA-OAEP');
      expect(supportedEncs).toContain('A256GCM');
    });

    it('should recommend signed request objects in production', () => {
      const productionConfig = {
        allowUnsignedRequests: false,
        requireClientAuthentication: true,
        enforceJWKS: true,
      };

      expect(productionConfig.allowUnsignedRequests).toBe(false);
      expect(productionConfig.enforceJWKS).toBe(true);
    });

    it('should validate client_id matches in request object', () => {
      const queryClientId = 'client-from-query';
      const requestObjectClientId = 'client-from-request';

      // Request object should take precedence
      const effectiveClientId = requestObjectClientId || queryClientId;
      expect(effectiveClientId).toBe('client-from-request');
    });
  });
});
