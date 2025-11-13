/**
 * Integration Tests for Refresh Token Flow, Token Introspection, and Token Revocation
 * RFC 6749 Section 6 (Refresh Token)
 * RFC 7662 (Token Introspection)
 * RFC 7009 (Token Revocation)
 */

import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../packages/shared/src/types/env';
import { tokenHandler } from '../packages/op-token/src/token';
import { introspectHandler } from '../packages/op-management/src/introspect';
import { revokeHandler } from '../packages/op-management/src/revoke';
import { generateKeySet } from '../packages/shared/src/utils/keys';
import { generateSecureRandomString } from '../packages/shared/src/utils/crypto';

// Store generated test key
let testPrivateKey: string;
let testPublicJWK: string;
let testKeyId: string;

// Mock environment
const mockEnv: Env = {
  ISSUER_URL: 'https://id.example.com',
  TOKEN_EXPIRY: '3600',
  CODE_EXPIRY: '120',
  STATE_EXPIRY: '300',
  NONCE_EXPIRY: '300',
  REFRESH_TOKEN_EXPIRY: '2592000', // 30 days
  ALLOW_HTTP_REDIRECT: 'true',
  PRIVATE_KEY_PEM: '',
  PUBLIC_JWK_JSON: '',
  KEY_ID: 'test-key-id',
  AUTH_CODES: {} as KVNamespace,
  STATE_STORE: {} as KVNamespace,
  NONCE_STORE: {} as KVNamespace,
  CLIENTS: {} as KVNamespace,
  REVOKED_TOKENS: {} as KVNamespace,
  REFRESH_TOKENS: {} as KVNamespace,
};

// Mock KV storage
const mockKVStores: Record<string, Map<string, string>> = {
  AUTH_CODES: new Map(),
  REFRESH_TOKENS: new Map(),
  REVOKED_TOKENS: new Map(),
};

// Mock KV namespace
const createMockKV = (storeName: string): KVNamespace => {
  const store = mockKVStores[storeName];
  return {
    get: async (key: string) => store.get(key) || null,
    put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as KVNamespace;
};

describe('Refresh Token Flow, Introspection, and Revocation', () => {
  let app: Hono<{ Bindings: Env }>;

  // Generate a test key before running tests
  beforeAll(async () => {
    const keySet = await generateKeySet('test-key', 2048);
    testPrivateKey = keySet.privatePEM;
    testPublicJWK = JSON.stringify(keySet.publicJWK);
    testKeyId = 'test-key';

    mockEnv.PRIVATE_KEY_PEM = testPrivateKey;
    mockEnv.PUBLIC_JWK_JSON = testPublicJWK;
    mockEnv.KEY_ID = testKeyId;
  });

  beforeEach(async () => {
    // Reset mock KV stores
    Object.values(mockKVStores).forEach((store) => store.clear());

    // Create fresh app instance
    app = new Hono<{ Bindings: Env }>();
    app.post('/token', tokenHandler);
    app.post('/introspect', introspectHandler);
    app.post('/revoke', revokeHandler);

    // Setup mock KV namespaces
    mockEnv.AUTH_CODES = createMockKV('AUTH_CODES');
    mockEnv.REFRESH_TOKENS = createMockKV('REFRESH_TOKENS');
    mockEnv.REVOKED_TOKENS = createMockKV('REVOKED_TOKENS');
  });

  describe('Refresh Token Flow', () => {
    it('should issue refresh token on authorization code exchange', async () => {
      // Store auth code (must be base64url format, minimum 128 characters)
      const authCode = generateSecureRandomString(96);
      await mockKVStores.AUTH_CODES.set(
        authCode,
        JSON.stringify({
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          scope: 'openid profile email',
          sub: 'user-123',
          nonce: 'test-nonce',
          timestamp: Date.now(),
        })
      );

      const res = await app.request(
        '/token',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: authCode,
            client_id: 'test-client',
            redirect_uri: 'https://example.com/callback',
          }).toString(),
        },
        mockEnv
      );

      const json = await res.json();

      // Debug: log error if test fails
      if (res.status !== 200) {
        console.log('Error response:', JSON.stringify(json, null, 2));
      }

      expect(res.status).toBe(200);
      expect(json).toHaveProperty('access_token');
      expect(json).toHaveProperty('id_token');
      expect(json).toHaveProperty('refresh_token');
      expect(json.token_type).toBe('Bearer');
      expect(json.expires_in).toBe(3600);
    });

    it('should exchange refresh token for new tokens', async () => {
      // First, get initial tokens via authorization code
      const authCode = generateSecureRandomString(96);
      await mockKVStores.AUTH_CODES.set(
        authCode,
        JSON.stringify({
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          scope: 'openid profile',
          sub: 'user-456',
          timestamp: Date.now(),
        })
      );

      const initialRes = await app.request(
        '/token',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: authCode,
            client_id: 'test-client',
            redirect_uri: 'https://example.com/callback',
          }).toString(),
        },
        mockEnv
      );

      const initialJson = await initialRes.json();
      const refreshToken = initialJson.refresh_token;

      // Now use refresh token to get new tokens
      const refreshRes = await app.request(
        '/token',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: 'test-client',
          }).toString(),
        },
        mockEnv
      );

      expect(refreshRes.status).toBe(200);

      const refreshJson = await refreshRes.json();
      expect(refreshJson).toHaveProperty('access_token');
      expect(refreshJson).toHaveProperty('id_token');
      expect(refreshJson).toHaveProperty('refresh_token');
      expect(refreshJson.token_type).toBe('Bearer');

      // New refresh token should be different (token rotation)
      expect(refreshJson.refresh_token).not.toBe(refreshToken);
    });

    it('should reject invalid refresh token', async () => {
      const res = await app.request(
        '/token',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: 'invalid-refresh-token',
            client_id: 'test-client',
          }).toString(),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toBe('invalid_grant');
    });

    it('should support scope reduction in refresh request', async () => {
      // Get initial tokens
      const authCode = generateSecureRandomString(96);
      await mockKVStores.AUTH_CODES.set(
        authCode,
        JSON.stringify({
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          scope: 'openid profile email',
          sub: 'user-789',
          timestamp: Date.now(),
        })
      );

      const initialRes = await app.request(
        '/token',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: authCode,
            client_id: 'test-client',
            redirect_uri: 'https://example.com/callback',
          }).toString(),
        },
        mockEnv
      );

      const initialJson = await initialRes.json();
      const refreshToken = initialJson.refresh_token;

      // Request reduced scope
      const refreshRes = await app.request(
        '/token',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: 'test-client',
            scope: 'openid profile', // Reduced from 'openid profile email'
          }).toString(),
        },
        mockEnv
      );

      expect(refreshRes.status).toBe(200);

      const refreshJson = await refreshRes.json();
      expect(refreshJson.scope).toBe('openid profile');
    });

    it('should reject scope expansion in refresh request', async () => {
      // Get initial tokens
      const authCode = generateSecureRandomString(96);
      await mockKVStores.AUTH_CODES.set(
        authCode,
        JSON.stringify({
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          scope: 'openid profile',
          sub: 'user-scope',
          timestamp: Date.now(),
        })
      );

      const initialRes = await app.request(
        '/token',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: authCode,
            client_id: 'test-client',
            redirect_uri: 'https://example.com/callback',
          }).toString(),
        },
        mockEnv
      );

      const initialJson = await initialRes.json();
      const refreshToken = initialJson.refresh_token;

      // Try to expand scope
      const refreshRes = await app.request(
        '/token',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: 'test-client',
            scope: 'openid profile email address', // Trying to expand
          }).toString(),
        },
        mockEnv
      );

      expect(refreshRes.status).toBe(400);

      const json = await refreshRes.json();
      expect(json.error).toBe('invalid_scope');
    });
  });

  describe('Token Introspection', () => {
    it('should introspect active access token', async () => {
      // Get tokens first
      const authCode = generateSecureRandomString(96);
      await mockKVStores.AUTH_CODES.set(
        authCode,
        JSON.stringify({
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          scope: 'openid profile',
          sub: 'user-introspect',
          timestamp: Date.now(),
        })
      );

      const tokenRes = await app.request(
        '/token',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: authCode,
            client_id: 'test-client',
            redirect_uri: 'https://example.com/callback',
          }).toString(),
        },
        mockEnv
      );

      const tokenJson = await tokenRes.json();
      const accessToken = tokenJson.access_token;

      // Introspect the access token
      const introspectRes = await app.request(
        '/introspect',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            token: accessToken,
            token_type_hint: 'access_token',
            client_id: 'test-client',
          }).toString(),
        },
        mockEnv
      );

      expect(introspectRes.status).toBe(200);

      const introspectJson = await introspectRes.json();
      expect(introspectJson.active).toBe(true);
      expect(introspectJson.scope).toBe('openid profile');
      expect(introspectJson.client_id).toBe('test-client');
      expect(introspectJson.token_type).toBe('Bearer');
      expect(introspectJson.sub).toBe('user-introspect');
    });

    it('should introspect active refresh token', async () => {
      // Get tokens first
      const authCode = generateSecureRandomString(96);
      await mockKVStores.AUTH_CODES.set(
        authCode,
        JSON.stringify({
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          scope: 'openid',
          sub: 'user-refresh-introspect',
          timestamp: Date.now(),
        })
      );

      const tokenRes = await app.request(
        '/token',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: authCode,
            client_id: 'test-client',
            redirect_uri: 'https://example.com/callback',
          }).toString(),
        },
        mockEnv
      );

      const tokenJson = await tokenRes.json();
      const refreshToken = tokenJson.refresh_token;

      // Introspect the refresh token
      const introspectRes = await app.request(
        '/introspect',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            token: refreshToken,
            token_type_hint: 'refresh_token',
            client_id: 'test-client',
          }).toString(),
        },
        mockEnv
      );

      expect(introspectRes.status).toBe(200);

      const introspectJson = await introspectRes.json();
      expect(introspectJson.active).toBe(true);
      expect(introspectJson.client_id).toBe('test-client');
    });

    it('should return inactive for invalid token', async () => {
      const introspectRes = await app.request(
        '/introspect',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            token: 'invalid-token',
            client_id: 'test-client',
          }).toString(),
        },
        mockEnv
      );

      expect(introspectRes.status).toBe(200);

      const introspectJson = await introspectRes.json();
      expect(introspectJson.active).toBe(false);
    });
  });

  describe('Token Revocation', () => {
    it('should revoke access token', async () => {
      // Get tokens first
      const authCode = generateSecureRandomString(96);
      await mockKVStores.AUTH_CODES.set(
        authCode,
        JSON.stringify({
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          scope: 'openid',
          sub: 'user-revoke',
          timestamp: Date.now(),
        })
      );

      const tokenRes = await app.request(
        '/token',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: authCode,
            client_id: 'test-client',
            redirect_uri: 'https://example.com/callback',
          }).toString(),
        },
        mockEnv
      );

      const tokenJson = await tokenRes.json();
      const accessToken = tokenJson.access_token;

      // Revoke the access token
      const revokeRes = await app.request(
        '/revoke',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            token: accessToken,
            token_type_hint: 'access_token',
            client_id: 'test-client',
          }).toString(),
        },
        mockEnv
      );

      expect(revokeRes.status).toBe(200);

      // Verify token is now revoked via introspection
      const introspectRes = await app.request(
        '/introspect',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            token: accessToken,
            token_type_hint: 'access_token',
            client_id: 'test-client',
          }).toString(),
        },
        mockEnv
      );

      const introspectJson = await introspectRes.json();
      expect(introspectJson.active).toBe(false);
    });

    it('should revoke refresh token', async () => {
      // Get tokens first
      const authCode = generateSecureRandomString(96);
      await mockKVStores.AUTH_CODES.set(
        authCode,
        JSON.stringify({
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          scope: 'openid',
          sub: 'user-revoke-refresh',
          timestamp: Date.now(),
        })
      );

      const tokenRes = await app.request(
        '/token',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: authCode,
            client_id: 'test-client',
            redirect_uri: 'https://example.com/callback',
          }).toString(),
        },
        mockEnv
      );

      const tokenJson = await tokenRes.json();
      const refreshToken = tokenJson.refresh_token;

      // Revoke the refresh token
      const revokeRes = await app.request(
        '/revoke',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            token: refreshToken,
            token_type_hint: 'refresh_token',
            client_id: 'test-client',
          }).toString(),
        },
        mockEnv
      );

      expect(revokeRes.status).toBe(200);

      // Try to use the revoked refresh token
      const refreshRes = await app.request(
        '/token',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: 'test-client',
          }).toString(),
        },
        mockEnv
      );

      expect(refreshRes.status).toBe(400);

      const refreshJson = await refreshRes.json();
      expect(refreshJson.error).toBe('invalid_grant');
    });

    it('should return success for invalid token (security)', async () => {
      // Per RFC 7009: Return success even for invalid tokens
      const revokeRes = await app.request(
        '/revoke',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            token: 'invalid-token-xyz',
            client_id: 'test-client',
          }).toString(),
        },
        mockEnv
      );

      expect(revokeRes.status).toBe(200);
    });
  });
});
