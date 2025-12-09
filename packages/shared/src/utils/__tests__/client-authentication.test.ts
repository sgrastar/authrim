/**
 * Client Authentication Unit Tests
 *
 * Tests for private_key_jwt and client_secret_jwt authentication methods
 * RFC 7523: JSON Web Token (JWT) Profile for OAuth 2.0 Client Authentication
 *
 * Security-critical tests:
 * - Algorithm validation (reject 'none')
 * - Signature verification
 * - Claims validation
 * - Key retrieval security
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateClientAssertion } from '../client-authentication';
import type { ClientMetadata } from '../../types/oidc';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

// Mock fetch for JWKS URI tests
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('Client Authentication', () => {
  let rsaKeyPair: Awaited<ReturnType<typeof generateKeyPair>>;
  let publicJwk: Awaited<ReturnType<typeof exportJWK>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Generate RSA key pair for tests
    rsaKeyPair = await generateKeyPair('RS256');
    publicJwk = await exportJWK(rsaKeyPair.publicKey);
    publicJwk.alg = 'RS256';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Helper to create a valid client assertion JWT
   */
  async function createClientAssertion(
    clientId: string,
    audience: string,
    overrides: Record<string, unknown> = {},
    algorithm: string = 'RS256'
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);

    const builder = new SignJWT({
      iss: overrides.iss ?? clientId,
      sub: overrides.sub ?? clientId,
      aud: overrides.aud ?? audience,
      exp: overrides.exp ?? now + 300, // 5 minutes
      iat: overrides.iat ?? now,
      jti: overrides.jti ?? `jti-${Math.random()}`,
      ...(overrides.nbf !== undefined ? { nbf: overrides.nbf } : {}),
    }).setProtectedHeader({ alg: algorithm });

    return builder.sign(rsaKeyPair.privateKey);
  }

  /**
   * Helper to create a client with JWKS
   */
  function createClientWithJWKS(clientId: string): ClientMetadata {
    return {
      client_id: clientId,
      redirect_uris: ['https://example.com/callback'],
      token_endpoint_auth_method: 'private_key_jwt',
      jwks: {
        keys: [publicJwk],
      },
    } as ClientMetadata;
  }

  describe('Valid Client Assertions', () => {
    const tokenEndpoint = 'https://op.example.com/token';
    const clientId = 'test-client-123';

    it('should validate a correctly formed client assertion', async () => {
      const client = createClientWithJWKS(clientId);
      const assertion = await createClientAssertion(clientId, tokenEndpoint);

      const result = await validateClientAssertion(assertion, tokenEndpoint, client);

      expect(result.valid).toBe(true);
      expect(result.client_id).toBe(clientId);
      expect(result.error).toBeUndefined();
    });

    it('should accept assertion with array audience including token endpoint', async () => {
      const client = createClientWithJWKS(clientId);
      const assertion = await createClientAssertion(clientId, tokenEndpoint, {
        aud: [tokenEndpoint, 'https://other.example.com'],
      });

      const result = await validateClientAssertion(assertion, tokenEndpoint, client);

      expect(result.valid).toBe(true);
    });

    it('should accept assertion with jti claim for replay protection', async () => {
      const client = createClientWithJWKS(clientId);
      const assertion = await createClientAssertion(clientId, tokenEndpoint, {
        jti: 'unique-jti-12345',
      });

      const result = await validateClientAssertion(assertion, tokenEndpoint, client);

      expect(result.valid).toBe(true);
    });

    it('should accept assertion with nbf in the past', async () => {
      const now = Math.floor(Date.now() / 1000);
      const client = createClientWithJWKS(clientId);
      const assertion = await createClientAssertion(clientId, tokenEndpoint, {
        nbf: now - 60, // 1 minute ago
      });

      const result = await validateClientAssertion(assertion, tokenEndpoint, client);

      expect(result.valid).toBe(true);
    });
  });

  describe('JWT Format Validation', () => {
    const tokenEndpoint = 'https://op.example.com/token';
    const clientId = 'test-client';

    it('should reject assertion with less than 3 parts', async () => {
      const client = createClientWithJWKS(clientId);

      const result = await validateClientAssertion('only.two', tokenEndpoint, client);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid_client');
      expect(result.error_description).toContain('JWT format');
    });

    it('should reject assertion with more than 3 parts', async () => {
      const client = createClientWithJWKS(clientId);

      const result = await validateClientAssertion('one.two.three.four', tokenEndpoint, client);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid_client');
    });

    it('should reject assertion with empty header', async () => {
      const client = createClientWithJWKS(clientId);

      const result = await validateClientAssertion('.payload.signature', tokenEndpoint, client);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid_client');
    });

    it('should reject assertion with empty payload', async () => {
      const client = createClientWithJWKS(clientId);

      const result = await validateClientAssertion('header..signature', tokenEndpoint, client);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid_client');
    });
  });

  describe('Algorithm Security', () => {
    const tokenEndpoint = 'https://op.example.com/token';
    const clientId = 'test-client';

    it('should reject assertion with alg=none (algorithm confusion attack)', async () => {
      const client = createClientWithJWKS(clientId);

      // Manually craft a JWT with alg=none
      const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
      const payload = btoa(
        JSON.stringify({
          iss: clientId,
          sub: clientId,
          aud: tokenEndpoint,
          exp: Math.floor(Date.now() / 1000) + 300,
        })
      )
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');

      const unsignedJwt = `${header}.${payload}.`;

      const result = await validateClientAssertion(unsignedJwt, tokenEndpoint, client);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid_client');
      expect(result.error_description).toContain('alg=none');
    });

    it('should reject assertion with missing algorithm', async () => {
      const client = createClientWithJWKS(clientId);

      const header = btoa(JSON.stringify({ typ: 'JWT' })) // No alg
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
      const payload = btoa(
        JSON.stringify({
          iss: clientId,
          sub: clientId,
          aud: tokenEndpoint,
          exp: Math.floor(Date.now() / 1000) + 300,
        })
      )
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');

      const result = await validateClientAssertion(
        `${header}.${payload}.signature`,
        tokenEndpoint,
        client
      );

      expect(result.valid).toBe(false);
      expect(result.error_description).toContain('alg=none');
    });
  });

  describe('Required Claims Validation', () => {
    const tokenEndpoint = 'https://op.example.com/token';
    const clientId = 'test-client';

    it('should reject assertion missing iss claim', async () => {
      const client = createClientWithJWKS(clientId);

      const header = btoa(JSON.stringify({ alg: 'RS256' }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
      const payload = btoa(
        JSON.stringify({
          // Missing iss
          sub: clientId,
          aud: tokenEndpoint,
          exp: Math.floor(Date.now() / 1000) + 300,
        })
      )
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');

      const result = await validateClientAssertion(
        `${header}.${payload}.signature`,
        tokenEndpoint,
        client
      );

      expect(result.valid).toBe(false);
      expect(result.error_description).toContain('missing required claims');
    });

    it('should reject assertion missing sub claim', async () => {
      const client = createClientWithJWKS(clientId);

      const header = btoa(JSON.stringify({ alg: 'RS256' }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
      const payload = btoa(
        JSON.stringify({
          iss: clientId,
          // Missing sub
          aud: tokenEndpoint,
          exp: Math.floor(Date.now() / 1000) + 300,
        })
      )
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');

      const result = await validateClientAssertion(
        `${header}.${payload}.signature`,
        tokenEndpoint,
        client
      );

      expect(result.valid).toBe(false);
      expect(result.error_description).toContain('missing required claims');
    });

    it('should reject assertion missing aud claim', async () => {
      const client = createClientWithJWKS(clientId);

      const header = btoa(JSON.stringify({ alg: 'RS256' }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
      const payload = btoa(
        JSON.stringify({
          iss: clientId,
          sub: clientId,
          // Missing aud
          exp: Math.floor(Date.now() / 1000) + 300,
        })
      )
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');

      const result = await validateClientAssertion(
        `${header}.${payload}.signature`,
        tokenEndpoint,
        client
      );

      expect(result.valid).toBe(false);
      expect(result.error_description).toContain('missing required claims');
    });

    it('should reject assertion missing exp claim', async () => {
      const client = createClientWithJWKS(clientId);

      const header = btoa(JSON.stringify({ alg: 'RS256' }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
      const payload = btoa(
        JSON.stringify({
          iss: clientId,
          sub: clientId,
          aud: tokenEndpoint,
          // Missing exp
        })
      )
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');

      const result = await validateClientAssertion(
        `${header}.${payload}.signature`,
        tokenEndpoint,
        client
      );

      expect(result.valid).toBe(false);
      expect(result.error_description).toContain('missing required claims');
    });
  });

  describe('Issuer and Subject Validation', () => {
    const tokenEndpoint = 'https://op.example.com/token';
    const clientId = 'test-client';

    it('should reject assertion where iss does not match client_id', async () => {
      const client = createClientWithJWKS(clientId);
      const assertion = await createClientAssertion(clientId, tokenEndpoint, {
        iss: 'wrong-client-id',
      });

      const result = await validateClientAssertion(assertion, tokenEndpoint, client);

      expect(result.valid).toBe(false);
      expect(result.error_description).toContain('iss and sub must be the client_id');
    });

    it('should reject assertion where sub does not match client_id', async () => {
      const client = createClientWithJWKS(clientId);
      const assertion = await createClientAssertion(clientId, tokenEndpoint, {
        sub: 'wrong-client-id',
      });

      const result = await validateClientAssertion(assertion, tokenEndpoint, client);

      expect(result.valid).toBe(false);
      expect(result.error_description).toContain('iss and sub must be the client_id');
    });

    it('should reject assertion where both iss and sub mismatch', async () => {
      const client = createClientWithJWKS(clientId);
      const assertion = await createClientAssertion(clientId, tokenEndpoint, {
        iss: 'attacker-client',
        sub: 'attacker-client',
      });

      const result = await validateClientAssertion(assertion, tokenEndpoint, client);

      expect(result.valid).toBe(false);
    });
  });

  describe('Audience Validation', () => {
    const tokenEndpoint = 'https://op.example.com/token';
    const clientId = 'test-client';

    it('should reject assertion with wrong audience', async () => {
      const client = createClientWithJWKS(clientId);
      const assertion = await createClientAssertion(clientId, tokenEndpoint, {
        aud: 'https://wrong.example.com/token',
      });

      const result = await validateClientAssertion(assertion, tokenEndpoint, client);

      expect(result.valid).toBe(false);
      expect(result.error_description).toContain('Audience does not match');
    });

    it('should reject assertion with empty audience array', async () => {
      const client = createClientWithJWKS(clientId);

      const header = btoa(JSON.stringify({ alg: 'RS256' }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
      const payload = btoa(
        JSON.stringify({
          iss: clientId,
          sub: clientId,
          aud: [],
          exp: Math.floor(Date.now() / 1000) + 300,
        })
      )
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');

      const result = await validateClientAssertion(
        `${header}.${payload}.signature`,
        tokenEndpoint,
        client
      );

      expect(result.valid).toBe(false);
      expect(result.error_description).toContain('Audience does not match');
    });

    it('should reject assertion with audience array not containing token endpoint', async () => {
      const client = createClientWithJWKS(clientId);
      const assertion = await createClientAssertion(clientId, tokenEndpoint, {
        aud: ['https://other1.example.com', 'https://other2.example.com'],
      });

      const result = await validateClientAssertion(assertion, tokenEndpoint, client);

      expect(result.valid).toBe(false);
      expect(result.error_description).toContain('Audience does not match');
    });
  });

  describe('Expiration Validation', () => {
    const tokenEndpoint = 'https://op.example.com/token';
    const clientId = 'test-client';

    it('should reject expired assertion', async () => {
      const client = createClientWithJWKS(clientId);
      const assertion = await createClientAssertion(clientId, tokenEndpoint, {
        exp: Math.floor(Date.now() / 1000) - 60, // Expired 1 minute ago
      });

      const result = await validateClientAssertion(assertion, tokenEndpoint, client);

      expect(result.valid).toBe(false);
      expect(result.error_description).toContain('expired');
    });

    it('should accept assertion expiring exactly now (edge case)', async () => {
      const client = createClientWithJWKS(clientId);
      const now = Math.floor(Date.now() / 1000);
      const assertion = await createClientAssertion(clientId, tokenEndpoint, {
        exp: now + 1, // Just barely valid
      });

      const result = await validateClientAssertion(assertion, tokenEndpoint, client);

      expect(result.valid).toBe(true);
    });
  });

  describe('Not Before (nbf) Validation', () => {
    const tokenEndpoint = 'https://op.example.com/token';
    const clientId = 'test-client';

    it('should reject assertion with nbf in the future', async () => {
      const client = createClientWithJWKS(clientId);
      const assertion = await createClientAssertion(clientId, tokenEndpoint, {
        nbf: Math.floor(Date.now() / 1000) + 3600, // 1 hour in the future
      });

      const result = await validateClientAssertion(assertion, tokenEndpoint, client);

      expect(result.valid).toBe(false);
      expect(result.error_description).toContain('not yet valid');
    });

    it('should accept assertion without nbf claim', async () => {
      const client = createClientWithJWKS(clientId);
      const assertion = await createClientAssertion(clientId, tokenEndpoint, {
        nbf: undefined,
      });

      const result = await validateClientAssertion(assertion, tokenEndpoint, client);

      expect(result.valid).toBe(true);
    });
  });

  describe('Public Key Retrieval', () => {
    const tokenEndpoint = 'https://op.example.com/token';
    const clientId = 'test-client';

    it('should validate using embedded JWKS', async () => {
      const client = createClientWithJWKS(clientId);
      const assertion = await createClientAssertion(clientId, tokenEndpoint);

      const result = await validateClientAssertion(assertion, tokenEndpoint, client);

      expect(result.valid).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should fetch JWKS from jwks_uri when embedded JWKS not present', async () => {
      const client: ClientMetadata = {
        client_id: clientId,
        redirect_uris: ['https://example.com/callback'],
        token_endpoint_auth_method: 'private_key_jwt',
        jwks_uri: 'https://client.example.com/.well-known/jwks.json',
      } as ClientMetadata;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ keys: [publicJwk] }),
      });

      const assertion = await createClientAssertion(clientId, tokenEndpoint);
      const result = await validateClientAssertion(assertion, tokenEndpoint, client);

      expect(result.valid).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(client.jwks_uri, {
        headers: { Accept: 'application/json' },
      });
    });

    it('should fail when jwks_uri fetch fails', async () => {
      const client: ClientMetadata = {
        client_id: clientId,
        redirect_uris: ['https://example.com/callback'],
        token_endpoint_auth_method: 'private_key_jwt',
        jwks_uri: 'https://client.example.com/.well-known/jwks.json',
      } as ClientMetadata;

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const assertion = await createClientAssertion(clientId, tokenEndpoint);
      const result = await validateClientAssertion(assertion, tokenEndpoint, client);

      expect(result.valid).toBe(false);
      expect(result.error_description).toContain('Failed to fetch client JWKS');
    });

    it('should fail when jwks_uri returns empty keys', async () => {
      const client: ClientMetadata = {
        client_id: clientId,
        redirect_uris: ['https://example.com/callback'],
        token_endpoint_auth_method: 'private_key_jwt',
        jwks_uri: 'https://client.example.com/.well-known/jwks.json',
      } as ClientMetadata;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ keys: [] }),
      });

      const assertion = await createClientAssertion(clientId, tokenEndpoint);
      const result = await validateClientAssertion(assertion, tokenEndpoint, client);

      expect(result.valid).toBe(false);
      expect(result.error_description).toContain('No public key available');
    });

    it('should fail when no JWKS or jwks_uri configured', async () => {
      const client: ClientMetadata = {
        client_id: clientId,
        redirect_uris: ['https://example.com/callback'],
        token_endpoint_auth_method: 'private_key_jwt',
        // No jwks or jwks_uri
      } as ClientMetadata;

      const assertion = await createClientAssertion(clientId, tokenEndpoint);
      const result = await validateClientAssertion(assertion, tokenEndpoint, client);

      expect(result.valid).toBe(false);
      expect(result.error_description).toContain('No public key available');
    });

    it('should prioritize jwks_uri over embedded jwks (for key rotation support)', async () => {
      // This tests the RP key rotation scenario:
      // - Client is registered with both jwks and jwks_uri
      // - RP rotates keys (updates jwks_uri)
      // - OP should fetch from jwks_uri to get updated keys, not use stale embedded jwks

      // Create two different key pairs
      const oldKeyPair = await generateKeyPair('RS256');
      const oldPublicJwk = await exportJWK(oldKeyPair.publicKey);
      oldPublicJwk.alg = 'RS256';
      oldPublicJwk.kid = 'old-key';

      const newKeyPair = await generateKeyPair('RS256');
      const newPublicJwk = await exportJWK(newKeyPair.publicKey);
      newPublicJwk.alg = 'RS256';
      newPublicJwk.kid = 'new-key';

      // Client has OLD key in embedded jwks, but jwks_uri returns NEW key
      const client: ClientMetadata = {
        client_id: clientId,
        redirect_uris: ['https://example.com/callback'],
        token_endpoint_auth_method: 'private_key_jwt',
        jwks: { keys: [oldPublicJwk] }, // Stale embedded JWKS
        jwks_uri: 'https://client.example.com/.well-known/jwks.json', // Has updated keys
      } as ClientMetadata;

      // Mock jwks_uri to return the NEW key
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ keys: [newPublicJwk] }),
      });

      // Create assertion signed with NEW key (simulating RP key rotation)
      const now = Math.floor(Date.now() / 1000);
      const assertion = await new SignJWT({
        iss: clientId,
        sub: clientId,
        aud: tokenEndpoint,
        exp: now + 300,
        iat: now,
        jti: `jti-${Math.random()}`,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'new-key' })
        .sign(newKeyPair.privateKey);

      const result = await validateClientAssertion(assertion, tokenEndpoint, client);

      // Should succeed because jwks_uri is prioritized and has the new key
      expect(result.valid).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(client.jwks_uri, {
        headers: { Accept: 'application/json' },
      });
    });

    it('should fall back to embedded jwks when jwks_uri fetch fails', async () => {
      // Client has BOTH jwks and jwks_uri, but jwks_uri is unreachable
      const client = createClientWithJWKS(clientId);
      client.jwks_uri = 'https://client.example.com/.well-known/jwks.json';

      // Mock jwks_uri to fail
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const assertion = await createClientAssertion(clientId, tokenEndpoint);
      const result = await validateClientAssertion(assertion, tokenEndpoint, client);

      // Should succeed because it falls back to embedded jwks
      expect(result.valid).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(client.jwks_uri, {
        headers: { Accept: 'application/json' },
      });
    });
  });

  describe('Signature Verification', () => {
    const tokenEndpoint = 'https://op.example.com/token';
    const clientId = 'test-client';

    it('should reject assertion with invalid signature', async () => {
      const client = createClientWithJWKS(clientId);
      const assertion = await createClientAssertion(clientId, tokenEndpoint);

      // Tamper with the signature
      const parts = assertion.split('.');
      const tamperedAssertion = `${parts[0]}.${parts[1]}.tampered_signature`;

      const result = await validateClientAssertion(tamperedAssertion, tokenEndpoint, client);

      expect(result.valid).toBe(false);
    });

    it('should reject assertion signed with different key', async () => {
      // Generate a different key pair
      const differentKeyPair = await generateKeyPair('RS256');

      const client = createClientWithJWKS(clientId);
      const now = Math.floor(Date.now() / 1000);

      // Sign with different private key
      const assertion = await new SignJWT({
        iss: clientId,
        sub: clientId,
        aud: tokenEndpoint,
        exp: now + 300,
      })
        .setProtectedHeader({ alg: 'RS256' })
        .sign(differentKeyPair.privateKey);

      const result = await validateClientAssertion(assertion, tokenEndpoint, client);

      expect(result.valid).toBe(false);
    });
  });

  describe('Security Edge Cases', () => {
    const tokenEndpoint = 'https://op.example.com/token';
    const clientId = 'test-client';

    it('should handle malformed JSON in header', async () => {
      const client = createClientWithJWKS(clientId);

      // Invalid base64 that doesn't decode to valid JSON
      const invalidHeader = 'not_valid_base64!!!';
      const payload = btoa(
        JSON.stringify({
          iss: clientId,
          sub: clientId,
          aud: tokenEndpoint,
          exp: Math.floor(Date.now() / 1000) + 300,
        })
      )
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');

      const result = await validateClientAssertion(
        `${invalidHeader}.${payload}.signature`,
        tokenEndpoint,
        client
      );

      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid_client');
    });

    it('should handle malformed JSON in payload', async () => {
      const client = createClientWithJWKS(clientId);

      const header = btoa(JSON.stringify({ alg: 'RS256' }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
      const invalidPayload = btoa('not valid json')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');

      const result = await validateClientAssertion(
        `${header}.${invalidPayload}.signature`,
        tokenEndpoint,
        client
      );

      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid_client');
    });

    it('should handle network errors when fetching jwks_uri', async () => {
      const client: ClientMetadata = {
        client_id: clientId,
        redirect_uris: ['https://example.com/callback'],
        token_endpoint_auth_method: 'private_key_jwt',
        jwks_uri: 'https://client.example.com/.well-known/jwks.json',
      } as ClientMetadata;

      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const assertion = await createClientAssertion(clientId, tokenEndpoint);
      const result = await validateClientAssertion(assertion, tokenEndpoint, client);

      expect(result.valid).toBe(false);
      expect(result.error_description).toContain('Failed to fetch client JWKS');
    });

    it('should handle assertion with very long claims', async () => {
      const client = createClientWithJWKS(clientId);
      const assertion = await createClientAssertion(clientId, tokenEndpoint, {
        jti: 'a'.repeat(10000),
      });

      const result = await validateClientAssertion(assertion, tokenEndpoint, client);

      // Should still validate (long JTI is allowed)
      expect(result.valid).toBe(true);
    });
  });

  describe('Key ID (kid) Selection', () => {
    const tokenEndpoint = 'https://op.example.com/token';
    const clientId = 'test-client';

    /**
     * Helper to create a client assertion with a specific kid in the header
     */
    async function createClientAssertionWithKid(
      clientId: string,
      audience: string,
      keyPair: Awaited<ReturnType<typeof generateKeyPair>>,
      kid: string
    ): Promise<string> {
      const now = Math.floor(Date.now() / 1000);

      return new SignJWT({
        iss: clientId,
        sub: clientId,
        aud: audience,
        exp: now + 300,
        iat: now,
        jti: `jti-${Math.random()}`,
      })
        .setProtectedHeader({ alg: 'RS256', kid })
        .sign(keyPair.privateKey);
    }

    it('should select key by kid from embedded JWKS', async () => {
      // Create a JWK with a specific kid
      const jwkWithKid = { ...publicJwk, kid: 'test-key-1' };

      const client: ClientMetadata = {
        client_id: clientId,
        redirect_uris: ['https://example.com/callback'],
        token_endpoint_auth_method: 'private_key_jwt',
        jwks: {
          keys: [jwkWithKid],
        },
      } as ClientMetadata;

      const assertion = await createClientAssertionWithKid(
        clientId,
        tokenEndpoint,
        rsaKeyPair,
        'test-key-1'
      );

      const result = await validateClientAssertion(assertion, tokenEndpoint, client);

      expect(result.valid).toBe(true);
      expect(result.client_id).toBe(clientId);
    });

    it('should select correct key from multiple keys in JWKS by kid', async () => {
      // Generate a second key pair
      const secondKeyPair = await generateKeyPair('RS256');
      const secondPublicJwk = await exportJWK(secondKeyPair.publicKey);
      secondPublicJwk.alg = 'RS256';
      secondPublicJwk.kid = 'key-2';

      // First key with kid
      const firstJwk = { ...publicJwk, kid: 'key-1' };

      const client: ClientMetadata = {
        client_id: clientId,
        redirect_uris: ['https://example.com/callback'],
        token_endpoint_auth_method: 'private_key_jwt',
        jwks: {
          keys: [firstJwk, secondPublicJwk], // key-1 is first, key-2 is second
        },
      } as ClientMetadata;

      // Sign with second key pair but specify kid: 'key-2'
      const assertion = await createClientAssertionWithKid(
        clientId,
        tokenEndpoint,
        secondKeyPair,
        'key-2'
      );

      const result = await validateClientAssertion(assertion, tokenEndpoint, client);

      expect(result.valid).toBe(true);
    });

    it('should fail when kid is specified but not found in JWKS', async () => {
      const jwkWithKid = { ...publicJwk, kid: 'existing-key' };

      const client: ClientMetadata = {
        client_id: clientId,
        redirect_uris: ['https://example.com/callback'],
        token_endpoint_auth_method: 'private_key_jwt',
        jwks: {
          keys: [jwkWithKid],
        },
      } as ClientMetadata;

      const assertion = await createClientAssertionWithKid(
        clientId,
        tokenEndpoint,
        rsaKeyPair,
        'non-existent-key'
      );

      const result = await validateClientAssertion(assertion, tokenEndpoint, client);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid_client');
      expect(result.error_description).toContain("No public key found with kid 'non-existent-key'");
    });

    it('should select key by kid from jwks_uri', async () => {
      const client: ClientMetadata = {
        client_id: clientId,
        redirect_uris: ['https://example.com/callback'],
        token_endpoint_auth_method: 'private_key_jwt',
        jwks_uri: 'https://client.example.com/.well-known/jwks.json',
      } as ClientMetadata;

      const jwkWithKid = { ...publicJwk, kid: 'remote-key-1' };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ keys: [jwkWithKid] }),
      });

      const assertion = await createClientAssertionWithKid(
        clientId,
        tokenEndpoint,
        rsaKeyPair,
        'remote-key-1'
      );

      const result = await validateClientAssertion(assertion, tokenEndpoint, client);

      expect(result.valid).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(client.jwks_uri, {
        headers: { Accept: 'application/json' },
      });
    });

    it('should use first key when no kid is specified in assertion', async () => {
      // Create multiple keys but don't specify kid in assertion
      const secondKeyPair = await generateKeyPair('RS256');
      const secondPublicJwk = await exportJWK(secondKeyPair.publicKey);
      secondPublicJwk.alg = 'RS256';
      secondPublicJwk.kid = 'key-2';

      const firstJwk = { ...publicJwk, kid: 'key-1' };

      const client: ClientMetadata = {
        client_id: clientId,
        redirect_uris: ['https://example.com/callback'],
        token_endpoint_auth_method: 'private_key_jwt',
        jwks: {
          keys: [firstJwk, secondPublicJwk],
        },
      } as ClientMetadata;

      // Sign without kid in header (uses first key pair which matches firstJwk)
      const assertion = await createClientAssertion(clientId, tokenEndpoint);

      const result = await validateClientAssertion(assertion, tokenEndpoint, client);

      expect(result.valid).toBe(true);
    });

    it('should fail when kid specified but JWKS has multiple keys without matching kid', async () => {
      const secondKeyPair = await generateKeyPair('RS256');
      const secondPublicJwk = await exportJWK(secondKeyPair.publicKey);
      secondPublicJwk.alg = 'RS256';
      secondPublicJwk.kid = 'key-2';

      const firstJwk = { ...publicJwk, kid: 'key-1' };

      const client: ClientMetadata = {
        client_id: clientId,
        redirect_uris: ['https://example.com/callback'],
        token_endpoint_auth_method: 'private_key_jwt',
        jwks: {
          keys: [firstJwk, secondPublicJwk],
        },
      } as ClientMetadata;

      // Sign with first key but request key-3 which doesn't exist
      const assertion = await createClientAssertionWithKid(
        clientId,
        tokenEndpoint,
        rsaKeyPair,
        'key-3'
      );

      const result = await validateClientAssertion(assertion, tokenEndpoint, client);

      expect(result.valid).toBe(false);
      expect(result.error_description).toContain("No public key found with kid 'key-3'");
    });
  });
});
