import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { Hono } from 'hono';
import { jwksHandler } from '../jwks';
import type { Env } from '@authrim/shared/types/env';
import { generateKeySet } from '@authrim/shared/utils/keys';

// Store generated test key
let testPrivateKey: string;
let testPublicJWK: string;

/**
 * Create a mock environment for testing
 */
function createMockEnv(privateKey?: string, keyId?: string, publicJWK?: string): Env {
  return {
    ISSUER_URL: 'https://test.example.com',
    TOKEN_EXPIRY: '3600',
    CODE_EXPIRY: '600',
    STATE_EXPIRY: '600',
    NONCE_EXPIRY: '600',
    PRIVATE_KEY_PEM: privateKey,
    KEY_ID: keyId,
    PUBLIC_JWK_JSON: publicJWK,
  } as Env;
}

describe('JWKS Handler', () => {
  let app: Hono<{ Bindings: Env }>;

  // Generate a test key before running tests
  beforeAll(async () => {
    const keySet = await generateKeySet('test-key', 2048);
    testPrivateKey = keySet.privatePEM;
    testPublicJWK = JSON.stringify(keySet.publicJWK);
  });

  beforeEach(() => {
    app = new Hono<{ Bindings: Env }>();
    app.get('/.well-known/jwks.json', jwksHandler);
  });

  describe('JWKS Endpoint', () => {
    it('should return valid JWKS with configured key', async () => {
      const env = createMockEnv(testPrivateKey, 'test-key-id', testPublicJWK);
      const response = await app.request(
        '/.well-known/jwks.json',
        {
          method: 'GET',
        },
        env
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('application/json');

      const jwks = (await response.json()) as { keys: Record<string, unknown>[] };
      expect(jwks).toHaveProperty('keys');
      expect(Array.isArray(jwks.keys)).toBe(true);
      expect(jwks.keys.length).toBe(1);
    });

    it('should return empty key set when no private key configured', async () => {
      const env = createMockEnv(undefined, undefined);
      const response = await app.request(
        '/.well-known/jwks.json',
        {
          method: 'GET',
        },
        env
      );

      expect(response.status).toBe(200);
      const jwks = (await response.json()) as { keys: Record<string, unknown>[] };
      expect(jwks).toHaveProperty('keys');
      expect(jwks.keys).toEqual([]);
    });

    it('should include correct JWK fields', async () => {
      const env = createMockEnv(testPrivateKey, 'test-key-id', testPublicJWK);
      const response = await app.request(
        '/.well-known/jwks.json',
        {
          method: 'GET',
        },
        env
      );

      const jwks = (await response.json()) as { keys: Record<string, unknown>[] };
      const jwk = jwks.keys[0];

      expect(jwk).toHaveProperty('kty', 'RSA');
      expect(jwk).toHaveProperty('use', 'sig');
      expect(jwk).toHaveProperty('alg', 'RS256');
      expect(jwk).toHaveProperty('kid');
      expect(jwk).toHaveProperty('n');
      expect(jwk).toHaveProperty('e');
    });

    it('should use provided key ID', async () => {
      const keySet = await generateKeySet('custom-key-id-123', 2048);
      const env = createMockEnv(
        testPrivateKey,
        'custom-key-id-123',
        JSON.stringify(keySet.publicJWK)
      );
      const response = await app.request(
        '/.well-known/jwks.json',
        {
          method: 'GET',
        },
        env
      );

      const jwks = (await response.json()) as { keys: Record<string, unknown>[] };
      const jwk = jwks.keys[0];

      expect(jwk.kid).toBe('custom-key-id-123');
    });

    it('should use default key ID when not provided', async () => {
      const keySet = await generateKeySet('default', 2048);
      const env = createMockEnv(testPrivateKey, undefined, JSON.stringify(keySet.publicJWK));
      const response = await app.request(
        '/.well-known/jwks.json',
        {
          method: 'GET',
        },
        env
      );

      const jwks = (await response.json()) as { keys: Record<string, unknown>[] };
      const jwk = jwks.keys[0];

      expect(jwk.kid).toBe('default');
    });
  });

  describe('Cache Headers', () => {
    it('should include Cache-Control header', async () => {
      const env = createMockEnv(testPrivateKey, 'test-key-id', testPublicJWK);
      const response = await app.request(
        '/.well-known/jwks.json',
        {
          method: 'GET',
        },
        env
      );

      const cacheControl = response.headers.get('Cache-Control');
      expect(cacheControl).toBeDefined();
      expect(cacheControl).toContain('public');
      expect(cacheControl).toContain('max-age=3600');
    });

    it('should include Vary header', async () => {
      const env = createMockEnv(testPrivateKey, 'test-key-id', testPublicJWK);
      const response = await app.request(
        '/.well-known/jwks.json',
        {
          method: 'GET',
        },
        env
      );

      const vary = response.headers.get('Vary');
      expect(vary).toBeDefined();
      expect(vary).toContain('Accept-Encoding');
    });
  });

  describe('JWK Structure', () => {
    it('should include RSA modulus (n)', async () => {
      const env = createMockEnv(testPrivateKey, 'test-key-id', testPublicJWK);
      const response = await app.request(
        '/.well-known/jwks.json',
        {
          method: 'GET',
        },
        env
      );

      const jwks = (await response.json()) as { keys: Record<string, unknown>[] };
      const jwk = jwks.keys[0];

      expect(jwk.n).toBeDefined();
      expect(typeof jwk.n).toBe('string');
      expect((jwk.n as string).length).toBeGreaterThan(0);
    });

    it('should include RSA exponent (e)', async () => {
      const env = createMockEnv(testPrivateKey, 'test-key-id', testPublicJWK);
      const response = await app.request(
        '/.well-known/jwks.json',
        {
          method: 'GET',
        },
        env
      );

      const jwks = (await response.json()) as { keys: Record<string, unknown>[] };
      const jwk = jwks.keys[0];

      expect(jwk.e).toBeDefined();
      expect(typeof jwk.e).toBe('string');
      // RSA exponent is typically "AQAB" (65537 in base64url)
      expect((jwk.e as string).length).toBeGreaterThan(0);
    });

    it('should not include private key material', async () => {
      const env = createMockEnv(testPrivateKey, 'test-key-id', testPublicJWK);
      const response = await app.request(
        '/.well-known/jwks.json',
        {
          method: 'GET',
        },
        env
      );

      const jwks = (await response.json()) as { keys: Record<string, unknown>[] };
      const jwk = jwks.keys[0];

      // Private JWK fields should not be present
      expect(jwk.d).toBeUndefined();
      expect(jwk.p).toBeUndefined();
      expect(jwk.q).toBeUndefined();
      expect(jwk.dp).toBeUndefined();
      expect(jwk.dq).toBeUndefined();
      expect(jwk.qi).toBeUndefined();
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid JWK JSON gracefully', async () => {
      const env = createMockEnv(testPrivateKey, 'test-key-id', 'invalid-json{');
      const response = await app.request(
        '/.well-known/jwks.json',
        {
          method: 'GET',
        },
        env
      );

      expect(response.status).toBe(500);
      const error = await response.json();
      expect(error).toHaveProperty('error');
      expect(error).toHaveProperty('message');
    });

    it('should return JSON content type for errors', async () => {
      const env = createMockEnv(testPrivateKey, 'test-key-id', 'invalid-json{');
      const response = await app.request(
        '/.well-known/jwks.json',
        {
          method: 'GET',
        },
        env
      );

      expect(response.headers.get('Content-Type')).toContain('application/json');
    });
  });

  describe('JWKS Compliance', () => {
    it('should return proper JSON content type', async () => {
      const env = createMockEnv(testPrivateKey, 'test-key-id', testPublicJWK);
      const response = await app.request(
        '/.well-known/jwks.json',
        {
          method: 'GET',
        },
        env
      );

      expect(response.headers.get('Content-Type')).toContain('application/json');
    });

    it('should return valid JSON structure', async () => {
      const env = createMockEnv(testPrivateKey, 'test-key-id', testPublicJWK);
      const response = await app.request(
        '/.well-known/jwks.json',
        {
          method: 'GET',
        },
        env
      );

      const jwks = (await response.json()) as { keys: Record<string, unknown>[] };

      // JWKS must have "keys" array
      expect(jwks).toHaveProperty('keys');
      expect(Array.isArray(jwks.keys)).toBe(true);
    });

    it('should return 200 OK status on success', async () => {
      const env = createMockEnv(testPrivateKey, 'test-key-id', testPublicJWK);
      const response = await app.request(
        '/.well-known/jwks.json',
        {
          method: 'GET',
        },
        env
      );

      expect(response.status).toBe(200);
    });
  });
});
