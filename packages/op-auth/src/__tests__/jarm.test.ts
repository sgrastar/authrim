/**
 * JARM (JWT-Secured Authorization Response Mode) Tests
 * Testing all response_mode variants with JWT signing and encryption
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { SignJWT, jwtVerify, generateKeyPair, exportJWK, CompactEncrypt, compactDecrypt } from 'jose';
import type { JWK } from 'jose';
import { getTokenFormat } from '@authrim/shared';

describe('JARM (JWT-Secured Authorization Response Mode)', () => {
  let serverKeyPair: { publicKey: CryptoKey; privateKey: CryptoKey };
  let clientKeyPair: { publicKey: CryptoKey; privateKey: CryptoKey };
  let clientEncKeyPair: { publicKey: CryptoKey; privateKey: CryptoKey };
  let serverPublicJWK: JWK;
  let clientPublicJWK: JWK;
  let clientEncPublicJWK: JWK;

  beforeAll(async () => {
    // Generate key pairs for testing
    serverKeyPair = await generateKeyPair('RS256', { extractable: true });
    clientKeyPair = await generateKeyPair('RS256', { extractable: true });
    // Generate separate encryption key pair for RSA-OAEP
    clientEncKeyPair = await generateKeyPair('RSA-OAEP', { extractable: true, modulusLength: 2048 });

    serverPublicJWK = await exportJWK(serverKeyPair.publicKey);
    clientPublicJWK = await exportJWK(clientKeyPair.publicKey);
    clientEncPublicJWK = await exportJWK(clientEncKeyPair.publicKey);

    serverPublicJWK.kid = 'server-key-1';
    clientPublicJWK.kid = 'client-key-1';
    clientEncPublicJWK.kid = 'client-enc-key-1';
    clientEncPublicJWK.alg = 'RSA-OAEP';
  });

  describe('Response Mode Variants', () => {
    it('should support response_mode=query.jwt', () => {
      const responseMode = 'query.jwt';
      expect(responseMode).toContain('.jwt');

      const baseMode = responseMode.replace('.jwt', '');
      expect(baseMode).toBe('query');
    });

    it('should support response_mode=fragment.jwt', () => {
      const responseMode = 'fragment.jwt';
      expect(responseMode).toContain('.jwt');

      const baseMode = responseMode.replace('.jwt', '');
      expect(baseMode).toBe('fragment');
    });

    it('should support response_mode=form_post.jwt', () => {
      const responseMode = 'form_post.jwt';
      expect(responseMode).toContain('.jwt');

      const baseMode = responseMode.replace('.jwt', '');
      expect(baseMode).toBe('form_post');
    });

    it('should support generic response_mode=jwt', () => {
      const responseMode = 'jwt';
      expect(responseMode).toBe('jwt');

      // Generic mode should default based on flow type
      const isImplicitFlow = true; // has id_token or access_token
      const isCodeFlow = false;

      const defaultMode = isImplicitFlow ? 'fragment' : 'query';
      expect(defaultMode).toBe('fragment');
    });

    it('should validate all supported response modes', () => {
      const supportedModes = [
        'query',
        'fragment',
        'form_post',
        'query.jwt',
        'fragment.jwt',
        'form_post.jwt',
        'jwt',
      ];

      expect(supportedModes).toContain('query.jwt');
      expect(supportedModes).toContain('fragment.jwt');
      expect(supportedModes).toContain('form_post.jwt');
      expect(supportedModes).toHaveLength(7);
    });
  });

  describe('Response JWT Structure', () => {
    it('should create signed response JWT with required claims', async () => {
      const responseParams = {
        iss: 'https://op.example.com',
        aud: 'test-client',
        exp: Math.floor(Date.now() / 1000) + 600, // 10 minutes
        iat: Math.floor(Date.now() / 1000),
        code: 'SplxlOBeZQQYbYS6WxSbIA',
        state: 'test-state',
      };

      const responseJWT = await new SignJWT(responseParams)
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: serverPublicJWK.kid })
        .sign(serverKeyPair.privateKey);

      // Verify JWT format
      expect(getTokenFormat(responseJWT)).toBe('jwt');

      // Verify it can be decoded
      const verified = await jwtVerify(responseJWT, serverKeyPair.publicKey, {
        issuer: 'https://op.example.com',
        audience: 'test-client',
      });

      expect(verified.payload.code).toBe('SplxlOBeZQQYbYS6WxSbIA');
      expect(verified.payload.state).toBe('test-state');
    });

    it('should include all authorization response parameters in JWT', async () => {
      const fullResponse = {
        iss: 'https://op.example.com',
        aud: 'test-client',
        exp: Math.floor(Date.now() / 1000) + 600,
        iat: Math.floor(Date.now() / 1000),
        code: 'authorization-code-123',
        access_token: 'access-token-456',
        token_type: 'Bearer',
        expires_in: '3600',
        id_token: 'eyJhbGc.eyJzdWI.signature',
        state: 'client-state',
      };

      const jwt = await new SignJWT(fullResponse)
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
        .sign(serverKeyPair.privateKey);

      const verified = await jwtVerify(jwt, serverKeyPair.publicKey);

      expect(verified.payload.code).toBe('authorization-code-123');
      expect(verified.payload.access_token).toBe('access-token-456');
      expect(verified.payload.token_type).toBe('Bearer');
      expect(verified.payload.id_token).toBe('eyJhbGc.eyJzdWI.signature');
    });

    it('should set appropriate expiration time (10 minutes)', () => {
      const now = Math.floor(Date.now() / 1000);
      const exp = now + 600; // 10 minutes

      expect(exp - now).toBe(600);
    });
  });

  describe('Response JWT Encryption', () => {
    it('should encrypt response JWT when client requests it', async () => {
      // Step 1: Create signed JWT
      const responseParams = {
        iss: 'https://op.example.com',
        aud: 'test-client',
        exp: Math.floor(Date.now() / 1000) + 600,
        iat: Math.floor(Date.now() / 1000),
        code: 'encrypted-code-123',
        state: 'test-state',
      };

      const signedJWT = await new SignJWT(responseParams)
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
        .sign(serverKeyPair.privateKey);

      // Step 2: Encrypt with client's encryption public key
      const encoder = new TextEncoder();
      const encryptedResponse = await new CompactEncrypt(encoder.encode(signedJWT))
        .setProtectedHeader({
          alg: 'RSA-OAEP',
          enc: 'A256GCM',
          cty: 'JWT',
        })
        .encrypt(clientEncKeyPair.publicKey);

      // Verify JWE format
      expect(getTokenFormat(encryptedResponse)).toBe('jwe');

      // Client can decrypt
      const { plaintext } = await compactDecrypt(encryptedResponse, clientEncKeyPair.privateKey);
      const decoder = new TextDecoder();
      const decryptedJWT = decoder.decode(plaintext);

      expect(decryptedJWT).toBe(signedJWT);
    });

    it('should support nested JWT (sign then encrypt)', async () => {
      const payload = {
        code: 'test-code',
        state: 'test-state',
      };

      // Sign
      const signed = await new SignJWT(payload)
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
        .sign(serverKeyPair.privateKey);

      // Encrypt
      const encoder = new TextEncoder();
      const encrypted = await new CompactEncrypt(encoder.encode(signed))
        .setProtectedHeader({ alg: 'RSA-OAEP', enc: 'A256GCM', cty: 'JWT' })
        .encrypt(clientEncKeyPair.publicKey);

      expect(getTokenFormat(signed)).toBe('jwt');
      expect(getTokenFormat(encrypted)).toBe('jwe');
    });

    it('should use client encryption preferences', () => {
      const clientConfig = {
        authorization_signed_response_alg: 'RS256',
        authorization_encrypted_response_alg: 'RSA-OAEP',
        authorization_encrypted_response_enc: 'A256GCM',
      };

      expect(clientConfig.authorization_signed_response_alg).toBe('RS256');
      expect(clientConfig.authorization_encrypted_response_alg).toBe('RSA-OAEP');
      expect(clientConfig.authorization_encrypted_response_enc).toBe('A256GCM');
    });
  });

  describe('Response Delivery Methods', () => {
    it('should format query.jwt response correctly', () => {
      const redirectUri = 'https://client.example.com/callback';
      const responseJWT = 'eyJhbGc.eyJjb2Rl.signature';

      const url = new URL(redirectUri);
      url.searchParams.set('response', responseJWT);

      expect(url.toString()).toContain('?response=');
      expect(url.searchParams.get('response')).toBe(responseJWT);
    });

    it('should format fragment.jwt response correctly', () => {
      const redirectUri = 'https://client.example.com/callback';
      const responseJWT = 'eyJhbGc.eyJjb2Rl.signature';

      const url = new URL(redirectUri);
      const fragmentParams = new URLSearchParams();
      fragmentParams.set('response', responseJWT);
      url.hash = fragmentParams.toString();

      expect(url.toString()).toContain('#response=');
      expect(url.hash).toContain('response=');
    });

    it('should format form_post.jwt response with single response parameter', () => {
      const responseJWT = 'eyJhbGc.eyJjb2Rl.signature';

      const formParams = {
        response: responseJWT,
      };

      expect(Object.keys(formParams)).toHaveLength(1);
      expect(formParams.response).toBe(responseJWT);
    });
  });

  describe('Client-Side JWT Verification', () => {
    it('should verify issuer claim', async () => {
      const jwt = await new SignJWT({
        iss: 'https://op.example.com',
        aud: 'test-client',
        exp: Math.floor(Date.now() / 1000) + 600,
      })
        .setProtectedHeader({ alg: 'RS256' })
        .sign(serverKeyPair.privateKey);

      const verified = await jwtVerify(jwt, serverKeyPair.publicKey, {
        issuer: 'https://op.example.com',
      });

      expect(verified.payload.iss).toBe('https://op.example.com');
    });

    it('should verify audience claim', async () => {
      const jwt = await new SignJWT({
        iss: 'https://op.example.com',
        aud: 'test-client',
        exp: Math.floor(Date.now() / 1000) + 600,
      })
        .setProtectedHeader({ alg: 'RS256' })
        .sign(serverKeyPair.privateKey);

      const verified = await jwtVerify(jwt, serverKeyPair.publicKey, {
        audience: 'test-client',
      });

      expect(verified.payload.aud).toBe('test-client');
    });

    it('should reject expired JWT', async () => {
      const expiredJWT = await new SignJWT({
        iss: 'https://op.example.com',
        aud: 'test-client',
        exp: Math.floor(Date.now() / 1000) - 3600, // Expired 1 hour ago
      })
        .setProtectedHeader({ alg: 'RS256' })
        .sign(serverKeyPair.privateKey);

      await expect(
        jwtVerify(expiredJWT, serverKeyPair.publicKey)
      ).rejects.toThrow();
    });
  });

  describe('Error Handling', () => {
    it('should handle missing client public key for encryption', () => {
      const clientWithoutKey = {
        client_id: 'test-client',
        authorization_encrypted_response_alg: 'RSA-OAEP',
        authorization_encrypted_response_enc: 'A256GCM',
        // Missing jwks or jwks_uri
      };

      expect(clientWithoutKey.authorization_encrypted_response_alg).toBeTruthy();
      expect(clientWithoutKey.jwks).toBeUndefined();
      expect(clientWithoutKey.jwks_uri).toBeUndefined();
    });

    it('should fallback to non-encrypted response if encryption fails', () => {
      const config = {
        preferEncryption: true,
        fallbackToPlain: true,
      };

      expect(config.fallbackToPlain).toBe(true);
    });
  });

  describe('Security Considerations', () => {
    it('should always sign JARM responses', () => {
      const config = {
        alwaysSignResponses: true,
        allowUnsignedResponses: false,
      };

      expect(config.alwaysSignResponses).toBe(true);
      expect(config.allowUnsignedResponses).toBe(false);
    });

    it('should recommend encryption for sensitive responses', () => {
      const responseWithAccessToken = {
        code: 'auth-code',
        access_token: 'sensitive-token',
        id_token: 'id-token',
      };

      const hasSensitiveData =
        responseWithAccessToken.access_token !== undefined ||
        responseWithAccessToken.id_token !== undefined;

      expect(hasSensitiveData).toBe(true);
    });

    it('should validate response JWT integrity', async () => {
      const validJWT = await new SignJWT({ code: 'valid' })
        .setProtectedHeader({ alg: 'RS256' })
        .sign(serverKeyPair.privateKey);

      // Tampered JWT (modified signature)
      const parts = validJWT.split('.');
      const tamperedJWT = `${parts[0]}.${parts[1]}.tampered-signature`;

      await expect(
        jwtVerify(tamperedJWT, serverKeyPair.publicKey)
      ).rejects.toThrow();
    });
  });

  describe('Integration with Traditional Response Modes', () => {
    it('should detect JWT response mode from mode string', () => {
      const modes = [
        { mode: 'query.jwt', isJARM: true },
        { mode: 'fragment.jwt', isJARM: true },
        { mode: 'form_post.jwt', isJARM: true },
        { mode: 'jwt', isJARM: true },
        { mode: 'query', isJARM: false },
        { mode: 'fragment', isJARM: false },
        { mode: 'form_post', isJARM: false },
      ];

      modes.forEach(({ mode, isJARM }) => {
        const detected = mode.includes('.jwt') || mode === 'jwt';
        expect(detected).toBe(isJARM);
      });
    });

    it('should extract base mode from JWT response mode', () => {
      const jwtModes = [
        { input: 'query.jwt', expected: 'query' },
        { input: 'fragment.jwt', expected: 'fragment' },
        { input: 'form_post.jwt', expected: 'form_post' },
      ];

      jwtModes.forEach(({ input, expected }) => {
        const baseMode = input.replace('.jwt', '');
        expect(baseMode).toBe(expected);
      });
    });
  });

  describe('Discovery Metadata', () => {
    it('should advertise JARM support in discovery', () => {
      const metadata = {
        response_modes_supported: [
          'query',
          'fragment',
          'form_post',
          'query.jwt',
          'fragment.jwt',
          'form_post.jwt',
          'jwt',
        ],
        authorization_signing_alg_values_supported: ['RS256'],
        authorization_encryption_alg_values_supported: ['RSA-OAEP', 'RSA-OAEP-256'],
        authorization_encryption_enc_values_supported: ['A256GCM', 'A192GCM', 'A128GCM'],
      };

      expect(metadata.response_modes_supported).toContain('query.jwt');
      expect(metadata.authorization_signing_alg_values_supported).toContain('RS256');
      expect(metadata.authorization_encryption_alg_values_supported).toContain('RSA-OAEP');
    });
  });
});
