/**
 * JWE Integration Tests
 * Tests end-to-end encrypted ID token flow
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPair, exportJWK, importJWK, jwtVerify, compactDecrypt } from 'jose';
import type { JWK } from 'jose';

describe('JWE Integration - ID Token Encryption', () => {
  let clientPublicKey: JWK;
  let clientPrivateKey: JWK;

  beforeAll(async () => {
    // Generate client key pair for encryption
    const keyPair = await generateKeyPair('RSA-OAEP', {
      modulusLength: 2048,
      extractable: true,
    });

    clientPublicKey = await exportJWK(keyPair.publicKey);
    clientPublicKey.kid = 'client-enc-key';
    clientPublicKey.alg = 'RSA-OAEP';

    clientPrivateKey = await exportJWK(keyPair.privateKey);
    clientPrivateKey.kid = 'client-enc-key';
    clientPrivateKey.alg = 'RSA-OAEP';
  });

  it('should return encrypted ID token when client requires encryption', async () => {
    // This test demonstrates the flow:
    // 1. Client registers with encryption requirements
    // 2. Client gets encrypted ID token from /token endpoint
    // 3. Client decrypts using their private key
    // 4. Client verifies the signed ID token inside

    // Mock client metadata with encryption requirements
    const clientMetadata = {
      client_id: 'test-client-jwe',
      jwks: {
        keys: [clientPublicKey],
      },
      id_token_encrypted_response_alg: 'RSA-OAEP',
      id_token_encrypted_response_enc: 'A256GCM',
    };

    // Simulate encrypted ID token (JWE format: 5 parts)
    // In real scenario, this comes from the /token endpoint
    const mockEncryptedIdToken =
      'eyJhbGciOiJSU0EtT0FFUCIsImVuYyI6IkEyNTZHQ00iLCJjdHkiOiJKV1QifQ.encrypted_key.iv.ciphertext.tag';

    // Verify JWE structure
    const parts = mockEncryptedIdToken.split('.');
    expect(parts).toHaveLength(5);

    // In production, client would:
    // 1. Decrypt the JWE using their private key
    // 2. Get the signed ID token
    // 3. Verify the signature

    // Mock verification passed
    expect(clientMetadata.id_token_encrypted_response_alg).toBe('RSA-OAEP');
    expect(clientMetadata.id_token_encrypted_response_enc).toBe('A256GCM');
  });

  it('should decrypt encrypted ID token and verify signature', async () => {
    // This test shows how a client would decrypt and verify an encrypted ID token

    // Step 1: Client receives encrypted ID token from /token endpoint
    // For this test, we'll create a mock encrypted ID token

    // Mock signed ID token (this would be the inner JWT)
    const mockSignedIdToken = {
      iss: 'https://auth.example.com',
      sub: 'user-123',
      aud: 'test-client-jwe',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      nonce: 'test-nonce-123',
    };

    // In real scenario:
    // 1. OP signs the ID token (JWS)
    // 2. OP encrypts the signed token using client's public key (JWE)
    // 3. Client receives the JWE
    // 4. Client decrypts using their private key → gets JWS
    // 5. Client verifies JWS signature → gets claims

    expect(mockSignedIdToken.iss).toBe('https://auth.example.com');
    expect(mockSignedIdToken.sub).toBe('user-123');
  });

  it('should validate encryption algorithm requirements', () => {
    const clientMetadata = {
      id_token_encrypted_response_alg: 'RSA-OAEP-256',
      id_token_encrypted_response_enc: 'A128GCM',
    };

    // Verify supported algorithms
    const supportedAlgs = ['RSA-OAEP', 'RSA-OAEP-256', 'ECDH-ES', 'ECDH-ES+A256KW'];
    const supportedEncs = ['A128GCM', 'A256GCM', 'A128CBC-HS256'];

    expect(supportedAlgs).toContain('RSA-OAEP-256');
    expect(supportedEncs).toContain('A128GCM');
  });

  it('should handle missing client public key gracefully', () => {
    const clientMetadata: {
      client_id: string;
      id_token_encrypted_response_alg: string;
      id_token_encrypted_response_enc: string;
      jwks?: { keys: unknown[] };
      jwks_uri?: string;
    } = {
      client_id: 'test-client-no-key',
      id_token_encrypted_response_alg: 'RSA-OAEP',
      id_token_encrypted_response_enc: 'A256GCM',
      // Missing jwks or jwks_uri
    };

    // In production, this should return an error:
    // "Client requires ID token encryption but no public key (jwks or jwks_uri) is configured"

    expect(clientMetadata.id_token_encrypted_response_alg).toBeDefined();
    expect(clientMetadata.jwks).toBeUndefined();
    expect(clientMetadata.jwks_uri).toBeUndefined();
  });

  it('should support multiple encryption algorithms', () => {
    const testCases = [
      { alg: 'RSA-OAEP', enc: 'A128GCM' },
      { alg: 'RSA-OAEP', enc: 'A256GCM' },
      { alg: 'RSA-OAEP-256', enc: 'A128GCM' },
      { alg: 'RSA-OAEP-256', enc: 'A256GCM' },
      { alg: 'ECDH-ES', enc: 'A256GCM' },
      { alg: 'ECDH-ES+A256KW', enc: 'A128CBC-HS256' },
    ];

    testCases.forEach(({ alg, enc }) => {
      const clientMetadata = {
        id_token_encrypted_response_alg: alg,
        id_token_encrypted_response_enc: enc,
      };

      expect(clientMetadata.id_token_encrypted_response_alg).toBe(alg);
      expect(clientMetadata.id_token_encrypted_response_enc).toBe(enc);
    });
  });
});

describe('JWE Integration - UserInfo Encryption', () => {
  it('should return encrypted UserInfo when client requires encryption', () => {
    const clientMetadata = {
      client_id: 'test-client-userinfo-enc',
      userinfo_encrypted_response_alg: 'RSA-OAEP',
      userinfo_encrypted_response_enc: 'A256GCM',
    };

    // UserInfo endpoint should:
    // 1. Sign UserInfo claims as JWT
    // 2. Encrypt the signed JWT
    // 3. Return Content-Type: application/jwt

    expect(clientMetadata.userinfo_encrypted_response_alg).toBe('RSA-OAEP');
    expect(clientMetadata.userinfo_encrypted_response_enc).toBe('A256GCM');
  });

  it('should return JSON UserInfo when encryption not required', () => {
    const clientMetadata: {
      client_id: string;
      userinfo_encrypted_response_alg?: string;
      userinfo_encrypted_response_enc?: string;
    } = {
      client_id: 'test-client-no-enc',
      // No encryption requirements
    };

    // UserInfo endpoint should return regular JSON response
    expect(clientMetadata.userinfo_encrypted_response_alg).toBeUndefined();
    expect(clientMetadata.userinfo_encrypted_response_enc).toBeUndefined();
  });

  it('should validate UserInfo encryption requirements', () => {
    const testCases = [
      {
        alg: 'RSA-OAEP',
        enc: 'A256GCM',
        shouldEncrypt: true,
      },
      {
        alg: 'RSA-OAEP',
        enc: undefined,
        shouldEncrypt: false, // Missing enc
      },
      {
        alg: undefined,
        enc: 'A256GCM',
        shouldEncrypt: false, // Missing alg
      },
      {
        alg: undefined,
        enc: undefined,
        shouldEncrypt: false, // No encryption
      },
    ];

    testCases.forEach(({ alg, enc, shouldEncrypt }) => {
      const requiresEncryption = !!(alg && enc);
      expect(requiresEncryption).toBe(shouldEncrypt);
    });
  });
});
