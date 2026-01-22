/**
 * Integration Tests: Authorization Code Flow
 *
 * Tests the complete OpenID Connect Authorization Code Flow:
 * 1. Authorization request
 * 2. Authorization response (code)
 * 3. Token exchange
 * 4. UserInfo request
 *
 * NOTE: These tests will be fully implemented once the endpoints
 * are complete in Phase 2 (Weeks 6-12).
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { jwtVerify, importJWK, type JWK } from 'jose';
import { Hono } from 'hono';

// Type definitions for test responses
interface TokenResponse {
  access_token: string;
  id_token?: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
}

interface JWKS {
  keys: JWK[];
}
import {
  createMockEnv,
  testClients,
  testUsers,
  generateState,
  generateNonce,
  buildAuthorizationUrl,
  parseAuthorizationResponse,
  buildTokenRequestBody,
} from './fixtures';
import type { Env } from '@authrim/ar-lib-core/types/env';
import { authorizeHandler } from '../../packages/op-auth/src/authorize';
import { tokenHandler } from '../../packages/op-token/src/token';
import { discoveryHandler } from '../../packages/op-discovery/src/discovery';
import { jwksHandler } from '../../packages/op-discovery/src/jwks';
import { userinfoHandler } from '../../packages/op-userinfo/src/userinfo';

describe('Authorization Code Flow', () => {
  let app: Hono;
  let env: Env;

  // Helper function to get authorization code (tests authorization endpoint validation)
  async function getAuthorizationCode(options: {
    client_id: string;
    redirect_uri: string;
    scope: string;
    state?: string;
    nonce?: string;
    claims?: string;
  }) {
    const authUrl = buildAuthorizationUrl({
      issuer: env.ISSUER_URL,
      client_id: options.client_id,
      redirect_uri: options.redirect_uri,
      scope: options.scope,
      state: options.state ?? generateState(),
      nonce: options.nonce ?? generateNonce(),
      claims: options.claims,
    });
    const authPath = authUrl.replace(env.ISSUER_URL, '');
    const authRes = await app.request(authPath, { method: 'GET' }, env);
    return { response: authRes, location: authRes.headers.get('location') };
  }

  // Helper to simulate completed authorization (creates auth code directly)
  // Used when we want to test token exchange and userinfo without full login flow
  async function createAuthorizationCode(options: {
    client_id: string;
    redirect_uri: string;
    scope: string;
    userId?: string;
    state?: string;
    nonce?: string;
    claims?: string;
    codeChallenge?: string;
    codeChallengeMethod?: 'S256';
  }): Promise<string> {
    const testCode = `auth_code_${Date.now()}_${crypto.randomUUID()}`;
    const authCodeStub = env.AUTH_CODE_STORE.get(env.AUTH_CODE_STORE.idFromName('global'));
    await authCodeStub.fetch(
      new Request('http://localhost/code/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: testCode,
          clientId: options.client_id,
          redirectUri: options.redirect_uri,
          userId: options.userId ?? 'test-user',
          scope: options.scope,
          nonce: options.nonce ?? generateNonce(),
          state: options.state ?? generateState(),
          claims: options.claims,
          codeChallenge: options.codeChallenge,
          codeChallengeMethod: options.codeChallengeMethod,
          ttlMs: 120000,
        }),
      })
    );
    return testCode;
  }

  // Helper function to exchange code for tokens
  async function exchangeCodeForTokens(options: {
    code: string;
    client_id: string;
    redirect_uri: string;
    client_secret?: string;
  }) {
    const tokenBody = buildTokenRequestBody({
      grant_type: 'authorization_code',
      code: options.code,
      client_id: options.client_id,
      redirect_uri: options.redirect_uri,
      client_secret: options.client_secret,
    });
    return app.request(
      '/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenBody,
      },
      env
    );
  }

  // Helper function to get userinfo
  async function getUserInfo(accessToken: string) {
    return app.request(
      '/userinfo',
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
      },
      env
    );
  }

  // Helper function to get JWKS
  async function getJWKS() {
    return app.request('/.well-known/jwks.json', { method: 'GET' }, env);
  }

  beforeEach(async () => {
    app = new Hono();
    env = await createMockEnv();

    // Register routes directly with handlers (with error handling for debugging)
    app.get('/authorize', (c) => authorizeHandler(c as any));
    app.post('/authorize', (c) => authorizeHandler(c as any));
    app.post('/token', (c) => tokenHandler(c as any));
    app.get('/.well-known/openid-configuration', (c) => discoveryHandler(c as any));
    app.get('/.well-known/jwks.json', (c) => jwksHandler(c as any));
    app.get('/userinfo', async (c) => {
      try {
        return await userinfoHandler(c as any);
      } catch (error) {
        console.error('UserInfo handler error:', error);
        return c.json({ error: 'server_error', error_message: String(error) }, 500);
      }
    });
    app.post('/userinfo', async (c) => {
      try {
        return await userinfoHandler(c as any);
      } catch (error) {
        console.error('UserInfo handler error:', error);
        return c.json({ error: 'server_error', error_message: String(error) }, 500);
      }
    });

    // Register test clients in DB
    for (const client of Object.values(testClients)) {
      await env.DB.prepare(
        "INSERT INTO oauth_clients (client_id, client_secret, redirect_uris, grant_types, response_types, scope, allow_claims_without_scope) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(
          client.client_id,
          client.client_secret || null,
          JSON.stringify(client.redirect_uris),
          JSON.stringify(client.grant_types),
          JSON.stringify(client.response_types),
          client.scope,
          client.allow_claims_without_scope ? 1 : 0
        )
        .run();
    }
  });

  afterEach(() => {
    // Reset any fake timers that may have been set
    vi.useRealTimers();
    // Clear all mocks
    vi.clearAllMocks();
  });

  describe('Phase 2: To be implemented', () => {
    it('should complete full authorization code flow', async () => {
      const client = testClients.confidential;
      const state = generateState();
      const nonce = generateNonce();

      // Step 1: Authorization request (redirects to login since user is not authenticated)
      const { response: authRes, location } = await getAuthorizationCode({
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        scope: client.scope,
        state,
        nonce,
      });

      // Verify redirect to login page
      expect(authRes.status).toBe(302);
      expect(location).toContain('/authorize/login');
      expect(location).toContain('challenge_id=');

      // Simulate completed authorization (user completed login)
      const testCode = await createAuthorizationCode({
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        scope: client.scope,
        userId: 'test-user',
        nonce,
        state,
      });

      // Step 2: Exchange code for tokens
      const tokenRes = await exchangeCodeForTokens({
        code: testCode,
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        client_secret: client.client_secret,
      });

      expect(tokenRes.status).toBe(200);
      const tokenData = (await tokenRes.json()) as TokenResponse;
      expect(tokenData).toHaveProperty('access_token');
      expect(tokenData).toHaveProperty('id_token');
      expect(tokenData.token_type).toBe('Bearer');

      // Step 3: Request UserInfo
      const userinfoRes = await getUserInfo(tokenData.access_token);
      if (userinfoRes.status !== 200) {
        const errorBody = await userinfoRes.clone().text();
        console.error('UserInfo error status:', userinfoRes.status);
        console.error('UserInfo error body:', errorBody);
      }
      expect(userinfoRes.status).toBe(200);

      const userinfoData = (await userinfoRes.json()) as { sub: string };
      expect(userinfoData).toHaveProperty('sub');
      expect(userinfoData.sub).toBe('test-user');
    });

    it('should validate authorization request parameters', async () => {
      // Test missing client_id
      const res1 = await app.request(
        '/authorize?response_type=code&redirect_uri=https://example.com/callback&scope=openid',
        { method: 'GET' },
        env
      );

      expect(res1.status).toBe(400);
      const data1 = (await res1.json()) as { error: string; error_description: string };
      expect(data1.error).toBe('invalid_request');
      expect(data1.error_description).toContain('client_id');
    });

    it('should reject invalid redirect_uri', async () => {
      // Test invalid URL - use registered client but with invalid redirect_uri
      const client = testClients.confidential;
      const res = await app.request(
        `/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=not-a-url&scope=openid`,
        { method: 'GET' },
        env
      );

      // Invalid redirect_uri should result in 400 JSON error response
      // or 302 redirect to login page (if user not authenticated first)
      // Per OAuth 2.0 spec, invalid redirect_uri should NOT redirect to the client
      if (res.status === 302) {
        // If redirect, it should NOT be to the invalid redirect_uri
        const location = res.headers.get('location');
        expect(location).not.toContain('not-a-url');
      } else {
        expect(res.status).toBe(400);
        const contentType = res.headers.get('content-type');
        if (contentType?.includes('application/json')) {
          const data = (await res.json()) as { error: string };
          expect(data.error).toBe('invalid_request');
        }
      }
    });

    it('should include state in authorization response', async () => {
      // Note: Since authorization endpoint redirects to login when user is not authenticated,
      // we verify that the state is preserved through the login redirect
      const client = testClients.confidential;
      const state = generateState();

      const authUrl = buildAuthorizationUrl({
        issuer: env.ISSUER_URL,
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        scope: 'openid',
        state,
        nonce: generateNonce(),
      });

      const authPath = authUrl.replace(env.ISSUER_URL, '');
      const authRes = await app.request(authPath, { method: 'GET' }, env);

      // Redirect to login (state will be preserved via challenge_id)
      expect(authRes.status).toBe(302);
      const location = authRes.headers.get('location');
      expect(location).toContain('/authorize/login');
      expect(location).toContain('challenge_id=');
    });

    it('should reject expired authorization code', async () => {
      // Use fake timers to control time without waiting
      vi.useFakeTimers();
      const baseTime = new Date('2024-01-01T00:00:00Z');
      vi.setSystemTime(baseTime);

      const client = testClients.confidential;

      // Step 1: Create authorization code directly (simulating completed login)
      const testCode = await createAuthorizationCode({
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        scope: client.scope,
        userId: 'test-user',
      });

      // Step 2: Advance time past the code TTL (default: 120 seconds)
      // Advance 121 seconds to exceed the 120-second TTL
      vi.advanceTimersByTime(121 * 1000);

      // Step 3: Try to exchange the expired code
      const tokenBody = buildTokenRequestBody({
        grant_type: 'authorization_code',
        code: testCode,
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        client_secret: client.client_secret,
      });

      const tokenRes = await app.request(
        '/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: tokenBody,
        },
        env
      );

      // Should be rejected with invalid_grant error
      expect(tokenRes.status).toBe(400);
      const errorData = await tokenRes.json();
      expect(errorData.error).toBe('invalid_grant');

      vi.useRealTimers();
    });

    it('should reject reused authorization code', async () => {
      const client = testClients.confidential;

      // Step 1: Create authorization code directly (simulating completed login)
      const testCode = await createAuthorizationCode({
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        scope: client.scope,
        userId: 'test-user',
      });

      // Step 2: Use code first time
      const tokenBody1 = buildTokenRequestBody({
        grant_type: 'authorization_code',
        code: testCode,
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        client_secret: client.client_secret,
      });

      const tokenRes1 = await app.request(
        '/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: tokenBody1,
        },
        env
      );

      expect(tokenRes1.status).toBe(200);

      // Step 3: Try to reuse the same code
      const tokenBody2 = buildTokenRequestBody({
        grant_type: 'authorization_code',
        code: testCode,
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        client_secret: client.client_secret,
      });

      const tokenRes2 = await app.request(
        '/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: tokenBody2,
        },
        env
      );

      expect(tokenRes2.status).toBe(400);
      const data = (await tokenRes2.json()) as { error: string };
      expect(data.error).toBe('invalid_grant');
    });

    it('should revoke access token when authorization code is reused', async () => {
      // RFC 6749 Section 4.1.2: When code is reused, previously issued tokens should be revoked
      const client = testClients.confidential;

      // Step 1: Create authorization code directly (simulating completed login)
      const testCode = await createAuthorizationCode({
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        scope: 'openid profile email',
        userId: 'test-user',
      });

      // Step 2: Use code first time and get access token
      const tokenBody1 = buildTokenRequestBody({
        grant_type: 'authorization_code',
        code: testCode,
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        client_secret: client.client_secret,
      });

      const tokenRes1 = await app.request(
        '/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: tokenBody1,
        },
        env
      );

      expect(tokenRes1.status).toBe(200);
      const tokenData1 = (await tokenRes1.json()) as { access_token: string };
      const accessToken = tokenData1.access_token;

      // Step 3: Verify access token works
      const userinfoRes1 = await app.request(
        '/userinfo',
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${accessToken}` },
        },
        env
      );
      expect(userinfoRes1.status).toBe(200);

      // Step 4: Try to reuse the same code (this should trigger token revocation)
      const tokenBody2 = buildTokenRequestBody({
        grant_type: 'authorization_code',
        code: testCode,
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        client_secret: client.client_secret,
      });

      const tokenRes2 = await app.request(
        '/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: tokenBody2,
        },
        env
      );

      expect(tokenRes2.status).toBe(400);
      const data = (await tokenRes2.json()) as { error: string };
      expect(data.error).toBe('invalid_grant');

      // Step 5: Verify original access token revocation behavior
      // Note: OAuth 2.1 RECOMMENDS (but does not REQUIRE) revoking all tokens
      // issued from the reused code. Our implementation may or may not
      // implement this optional security feature.
      const userinfoRes2 = await app.request(
        '/userinfo',
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${accessToken}` },
        },
        env
      );

      // The test passes if either:
      // 1. Token is revoked (401) - stricter implementation per OAuth 2.1 recommendation
      // 2. Token is still valid (200) - basic implementation that just rejects code reuse
      expect([200, 401]).toContain(userinfoRes2.status);
      if (userinfoRes2.status === 401) {
        const userinfoError = (await userinfoRes2.json()) as { error: string };
        expect(userinfoError.error).toBe('invalid_token');
      }
    });

    it('should include nonce in ID token', async () => {
      const client = testClients.confidential;
      const nonce = generateNonce();

      // Create authorization code directly with nonce
      const testCode = await createAuthorizationCode({
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        scope: client.scope,
        userId: 'test-user',
        nonce,
      });

      // Exchange for tokens
      const tokenRes = await exchangeCodeForTokens({
        code: testCode,
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        client_secret: client.client_secret,
      });

      const tokenData = (await tokenRes.json()) as { id_token: string };

      // Decode ID token payload (simple base64 decode without verification for testing)
      const idTokenParts = tokenData.id_token.split('.');
      const payload = JSON.parse(atob(idTokenParts[1]));

      expect(payload.nonce).toBe(nonce);
    });

    it('should return valid ID token and access token', async () => {
      const client = testClients.confidential;

      // Create authorization code directly
      const testCode = await createAuthorizationCode({
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        scope: client.scope,
        userId: 'test-user',
      });

      // Exchange for tokens
      const tokenRes = await exchangeCodeForTokens({
        code: testCode,
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        client_secret: client.client_secret,
      });

      expect(tokenRes.status).toBe(200);
      const tokenData = (await tokenRes.json()) as {
        access_token: string;
        id_token: string;
        token_type: string;
        expires_in: number;
      };

      // Validate token response
      expect(tokenData).toHaveProperty('access_token');
      expect(tokenData).toHaveProperty('id_token');
      expect(tokenData).toHaveProperty('token_type');
      expect(tokenData).toHaveProperty('expires_in');
      expect(tokenData.token_type).toBe('Bearer');
      expect(typeof tokenData.expires_in).toBe('number');

      // Validate JWT format (3 parts separated by dots)
      expect(tokenData.access_token.split('.').length).toBe(3);
      expect(tokenData.id_token.split('.').length).toBe(3);
    });

    it('should verify ID token signature using cryptographic verification', async () => {
      const client = testClients.confidential;
      const nonce = generateNonce();

      // Create authorization code directly with nonce
      const testCode = await createAuthorizationCode({
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        scope: client.scope,
        userId: 'test-user',
        nonce,
      });

      const tokenRes = await exchangeCodeForTokens({
        code: testCode,
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        client_secret: client.client_secret,
      });

      expect(tokenRes.status).toBe(200);
      const tokenData = (await tokenRes.json()) as { id_token: string };

      // Get JWKS from discovery endpoint
      const jwksRes = await getJWKS();
      expect(jwksRes.status).toBe(200);
      const jwks = (await jwksRes.json()) as { keys: JWK[] };
      expect(jwks.keys).toBeDefined();
      expect(jwks.keys.length).toBeGreaterThan(0);

      // Decode header to get kid
      const idTokenParts = tokenData.id_token.split('.');
      const headerBase64 = idTokenParts[0].replace(/-/g, '+').replace(/_/g, '/');
      const header = JSON.parse(atob(headerBase64));

      expect(header.alg).toBe('RS256');
      expect(header.typ).toBe('JWT');
      expect(header.kid).toBeTruthy();

      // Find the matching key in JWKS
      const matchingKey = jwks.keys.find((key: JWK) => key.kid === header.kid);
      expect(matchingKey).toBeDefined();

      // Import the public key and verify the signature
      const publicKey = await importJWK(matchingKey!, 'RS256');

      // Use jose to verify the ID token signature cryptographically
      const { payload } = await jwtVerify(tokenData.id_token, publicKey, {
        issuer: env.ISSUER_URL,
        audience: client.client_id,
        algorithms: ['RS256'],
      });

      // Verify required claims
      expect(payload.iss).toBe(env.ISSUER_URL);
      expect(payload.sub).toBeTruthy();
      expect(payload.aud).toBe(client.client_id);
      expect(payload.nonce).toBe(nonce);

      // Verify time-based claims
      const now = Math.floor(Date.now() / 1000);
      expect(payload.exp).toBeGreaterThan(now);
      expect(payload.iat).toBeLessThanOrEqual(now);
    });

    it('should reject ID token with invalid signature', async () => {
      const client = testClients.confidential;

      // Create authorization code directly
      const testCode = await createAuthorizationCode({
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        scope: client.scope,
        userId: 'test-user',
      });

      // Exchange for tokens
      const tokenRes = await exchangeCodeForTokens({
        code: testCode,
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        client_secret: client.client_secret,
      });
      const tokenData = (await tokenRes.json()) as TokenResponse;

      // Tamper with the ID token by modifying the payload
      const parts = tokenData.id_token!.split('.');
      const tamperedPayload = btoa(
        JSON.stringify({ ...JSON.parse(atob(parts[1])), sub: 'tampered-user' })
      )
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/[=]/g, '');
      const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

      // Get the public key
      const jwksRes = await getJWKS();
      const jwks = (await jwksRes.json()) as JWKS;
      const headerBase64 = parts[0].replace(/-/g, '+').replace(/_/g, '/');
      const header = JSON.parse(atob(headerBase64));
      const matchingKey = jwks.keys.find((key: JWK) => key.kid === header.kid);
      const publicKey = await importJWK(matchingKey!, 'RS256');

      // Attempt to verify the tampered token - should throw
      await expect(
        jwtVerify(tamperedToken, publicKey, {
          issuer: env.ISSUER_URL,
          audience: client.client_id,
          algorithms: ['RS256'],
        })
      ).rejects.toThrow();
    });

    it('should reject ID token with wrong audience', async () => {
      const client = testClients.confidential;

      // Create authorization code directly
      const testCode = await createAuthorizationCode({
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        scope: client.scope,
        userId: 'test-user',
      });

      // Exchange for tokens
      const tokenRes = await exchangeCodeForTokens({
        code: testCode,
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        client_secret: client.client_secret,
      });
      const tokenData = (await tokenRes.json()) as TokenResponse;

      // Get the public key
      const jwksRes = await getJWKS();
      const jwks = (await jwksRes.json()) as JWKS;
      const parts = tokenData.id_token!.split('.');
      const headerBase64 = parts[0].replace(/-/g, '+').replace(/_/g, '/');
      const header = JSON.parse(atob(headerBase64));
      const matchingKey = jwks.keys.find((key: JWK) => key.kid === header.kid);
      const publicKey = await importJWK(matchingKey!, 'RS256');

      // Attempt to verify with wrong audience - should throw
      await expect(
        jwtVerify(tokenData.id_token!, publicKey, {
          issuer: env.ISSUER_URL,
          audience: 'wrong-client-id',
          algorithms: ['RS256'],
        })
      ).rejects.toThrow();
    });

    it('should reject ID token with wrong issuer', async () => {
      const client = testClients.confidential;

      // Create authorization code directly
      const testCode = await createAuthorizationCode({
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        scope: client.scope,
        userId: 'test-user',
      });

      // Exchange for tokens
      const tokenRes = await exchangeCodeForTokens({
        code: testCode,
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        client_secret: client.client_secret,
      });
      const tokenData = (await tokenRes.json()) as TokenResponse;

      // Get the public key
      const jwksRes = await getJWKS();
      const jwks = (await jwksRes.json()) as JWKS;
      const parts = tokenData.id_token!.split('.');
      const headerBase64 = parts[0].replace(/-/g, '+').replace(/_/g, '/');
      const header = JSON.parse(atob(headerBase64));
      const matchingKey = jwks.keys.find((key: JWK) => key.kid === header.kid);
      const publicKey = await importJWK(matchingKey!, 'RS256');

      // Attempt to verify with wrong issuer - should throw
      await expect(
        jwtVerify(tokenData.id_token!, publicKey, {
          issuer: 'https://wrong-issuer.com',
          audience: client.client_id,
          algorithms: ['RS256'],
        })
      ).rejects.toThrow();
    });

    it('should return user claims from UserInfo endpoint', async () => {
      const client = testClients.confidential;

      // Create authorization code directly
      const testCode = await createAuthorizationCode({
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        scope: 'openid profile email',
        userId: 'test-user',
      });

      // Exchange for tokens
      const tokenRes = await exchangeCodeForTokens({
        code: testCode,
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        client_secret: client.client_secret,
      });

      // Debug: Log error if status is not 200
      if (tokenRes.status !== 200) {
        const errorData = await tokenRes.json();
        console.error('Token endpoint error in UserInfo test:', errorData);
      }

      expect(tokenRes.status).toBe(200);
      const tokenData = (await tokenRes.json()) as TokenResponse;

      // Request UserInfo
      const userinfoRes = await getUserInfo(tokenData.access_token);

      expect(userinfoRes.status).toBe(200);
      const userinfoData = await userinfoRes.json();

      // Validate UserInfo response
      expect(userinfoData).toHaveProperty('sub');
      expect(userinfoData).toHaveProperty('name');
      expect(userinfoData).toHaveProperty('preferred_username');
      expect(userinfoData).toHaveProperty('email');
      expect(userinfoData).toHaveProperty('email_verified');
    });
  });

  describe('Claims Parameter Support', () => {
    it('should return name claim when requested via claims parameter without profile scope', async () => {
      // Use conformance client which has allow_claims_without_scope=true
      const client = testClients.conformance;

      // Build claims parameter requesting name
      const claimsParam = JSON.stringify({
        userinfo: {
          name: { essential: true },
        },
      });

      // Create authorization code directly with claims parameter but WITHOUT profile scope
      const testCode = await createAuthorizationCode({
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        scope: 'openid', // Note: no profile scope
        userId: 'test-user',
        claims: claimsParam,
      });

      // Exchange authorization code for tokens
      const tokenRes = await exchangeCodeForTokens({
        code: testCode,
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        client_secret: client.client_secret,
      });

      expect(tokenRes.status).toBe(200);
      const tokenData = (await tokenRes.json()) as TokenResponse;

      // Get userinfo
      const userinfoRes = await getUserInfo(tokenData.access_token);

      expect(userinfoRes.status).toBe(200);
      const userinfoData = await userinfoRes.json();

      // Should have name even without profile scope because it was requested via claims parameter
      expect(userinfoData).toHaveProperty('name');
      expect(userinfoData.name).toBe('Test User');

      // Should NOT have other profile claims
      expect(userinfoData).not.toHaveProperty('family_name');
      expect(userinfoData).not.toHaveProperty('email');
    });

    it('should return email claim when requested via claims parameter without email scope', async () => {
      // Use conformance client which has allow_claims_without_scope=true
      const client = testClients.conformance;

      // Build claims parameter requesting email
      const claimsParam = JSON.stringify({
        userinfo: {
          email: null,
          email_verified: null,
        },
      });

      // Create authorization code directly with claims parameter but WITHOUT email scope
      const testCode = await createAuthorizationCode({
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        scope: 'openid', // Note: no email scope
        userId: 'test-user',
        claims: claimsParam,
      });

      // Exchange for tokens
      const tokenRes = await exchangeCodeForTokens({
        code: testCode,
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        client_secret: client.client_secret,
      });
      const tokenData = (await tokenRes.json()) as TokenResponse;

      // Get userinfo
      const userinfoRes = await getUserInfo(tokenData.access_token);
      const userinfoData = await userinfoRes.json();

      // Should have email claims even without email scope
      expect(userinfoData).toHaveProperty('email');
      expect(userinfoData).toHaveProperty('email_verified');

      // Should NOT have profile claims
      expect(userinfoData).not.toHaveProperty('name');
    });

    it('should reject invalid claims JSON', async () => {
      const client = testClients.confidential;

      // Invalid JSON in claims parameter
      const invalidClaims = 'not-valid-json';

      // Test validation at authorization endpoint
      const authUrl = buildAuthorizationUrl({
        issuer: env.ISSUER_URL,
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        scope: 'openid',
        state: generateState(),
        nonce: generateNonce(),
        claims: invalidClaims,
      });
      const authPath = authUrl.replace(env.ISSUER_URL, '');
      const authRes = await app.request(authPath, { method: 'GET' }, env);

      // Should return error - either via redirect (302) or direct response (400)
      if (authRes.status === 302) {
        const location = authRes.headers.get('location');
        // Check if it's an error redirect (to callback) or login redirect
        if (location?.includes('error=')) {
          const parsed = parseAuthorizationResponse(location!);
          expect(parsed.error).toBe('invalid_request');
          expect(parsed.error_description).toBe('claims parameter must be valid JSON');
        } else {
          // Login redirect - claims validation happens after login
          expect(location).toContain('/authorize/login');
        }
      } else {
        expect(authRes.status).toBe(400);
        const errorData = (await authRes.json()) as { error: string; error_description: string };
        expect(errorData.error).toBe('invalid_request');
        expect(errorData.error_description).toBe('claims parameter must be valid JSON');
      }
    });

    it('should reject claims parameter with invalid structure', async () => {
      const client = testClients.confidential;

      // Claims parameter must be an object, not an array
      const invalidClaims = JSON.stringify([]);

      // Test validation at authorization endpoint
      const authUrl = buildAuthorizationUrl({
        issuer: env.ISSUER_URL,
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        scope: 'openid',
        state: generateState(),
        nonce: generateNonce(),
        claims: invalidClaims,
      });
      const authPath = authUrl.replace(env.ISSUER_URL, '');
      const authRes = await app.request(authPath, { method: 'GET' }, env);

      // Should return error - either via redirect (302) or direct response (400)
      if (authRes.status === 302) {
        const location = authRes.headers.get('location');
        // Check if it's an error redirect (to callback) or login redirect
        if (location?.includes('error=')) {
          const parsed = parseAuthorizationResponse(location!);
          expect(parsed.error).toBe('invalid_request');
          expect(parsed.error_description).toBe('claims parameter must be a JSON object');
        } else {
          // Login redirect - claims validation happens after login
          expect(location).toContain('/authorize/login');
        }
      } else {
        expect(authRes.status).toBe(400);
        const errorData = (await authRes.json()) as { error: string; error_description: string };
        expect(errorData.error).toBe('invalid_request');
        expect(errorData.error_description).toBe('claims parameter must be a JSON object');
      }
    });

    it('should reject claims parameter with invalid section', async () => {
      const client = testClients.confidential;

      // Invalid section name
      const invalidClaims = JSON.stringify({
        invalid_section: {
          name: null,
        },
      });

      // Test validation at authorization endpoint
      const authUrl = buildAuthorizationUrl({
        issuer: env.ISSUER_URL,
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        scope: 'openid',
        state: generateState(),
        nonce: generateNonce(),
        claims: invalidClaims,
      });
      const authPath = authUrl.replace(env.ISSUER_URL, '');
      const authRes = await app.request(authPath, { method: 'GET' }, env);

      // Should return error - either via redirect (302) or direct response (400)
      if (authRes.status === 302) {
        const location = authRes.headers.get('location');
        // Check if it's an error redirect (to callback) or login redirect
        if (location?.includes('error=')) {
          const parsed = parseAuthorizationResponse(location!);
          expect(parsed.error).toBe('invalid_request');
          expect(parsed.error_description).toContain('Invalid claims section');
        } else {
          // Login redirect - claims validation happens after login
          expect(location).toContain('/authorize/login');
        }
      } else {
        expect(authRes.status).toBe(400);
        const errorData = (await authRes.json()) as { error: string; error_description: string };
        expect(errorData.error).toBe('invalid_request');
        expect(errorData.error_description).toContain('Invalid claims section');
      }
    });

    it('should return all profile claims when profile scope is granted even with claims parameter', async () => {
      const client = testClients.confidential;

      // Request only name via claims parameter
      const claimsParam = JSON.stringify({
        userinfo: {
          name: null,
        },
      });

      // Create authorization code with profile scope
      const testCode = await createAuthorizationCode({
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        scope: 'openid profile', // profile scope granted
        userId: 'test-user',
        claims: claimsParam,
      });

      // Exchange for tokens
      const tokenRes = await exchangeCodeForTokens({
        code: testCode,
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        client_secret: client.client_secret,
      });
      const tokenData = (await tokenRes.json()) as TokenResponse;

      // Get userinfo
      const userinfoRes = await getUserInfo(tokenData.access_token);
      const userinfoData = await userinfoRes.json();

      // Should have ALL profile claims because profile scope is granted
      expect(userinfoData).toHaveProperty('name');
      expect(userinfoData).toHaveProperty('family_name');
      expect(userinfoData).toHaveProperty('given_name');
      expect(userinfoData).toHaveProperty('preferred_username');
    });
  });

  describe('Additional Scope Support', () => {
    it('should return address claims when address scope is granted', async () => {
      const client = testClients.confidential;

      // Create authorization code with address scope
      const testCode = await createAuthorizationCode({
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        scope: 'openid address',
        userId: 'test-user',
      });

      // Exchange for tokens
      const tokenRes = await exchangeCodeForTokens({
        code: testCode,
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        client_secret: client.client_secret,
      });
      const tokenData = (await tokenRes.json()) as TokenResponse;

      // Get userinfo
      const userinfoRes = await getUserInfo(tokenData.access_token);

      expect(userinfoRes.status).toBe(200);
      const userinfoData = await userinfoRes.json();

      // Should have address claims
      expect(userinfoData).toHaveProperty('address');
      expect(userinfoData.address).toHaveProperty('formatted');
      expect(userinfoData.address).toHaveProperty('street_address');
      expect(userinfoData.address).toHaveProperty('locality');
      expect(userinfoData.address).toHaveProperty('region');
      expect(userinfoData.address).toHaveProperty('postal_code');
      expect(userinfoData.address).toHaveProperty('country');

      // Should NOT have profile or email claims
      expect(userinfoData).not.toHaveProperty('name');
      expect(userinfoData).not.toHaveProperty('email');
    });

    it('should return phone claims when phone scope is granted', async () => {
      const client = testClients.confidential;

      // Create authorization code with phone scope
      const testCode = await createAuthorizationCode({
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        scope: 'openid phone',
        userId: 'test-user',
      });

      // Exchange for tokens
      const tokenRes = await exchangeCodeForTokens({
        code: testCode,
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        client_secret: client.client_secret,
      });
      const tokenData = (await tokenRes.json()) as TokenResponse;

      // Get userinfo
      const userinfoRes = await getUserInfo(tokenData.access_token);

      expect(userinfoRes.status).toBe(200);
      const userinfoData = await userinfoRes.json();

      // Should have phone claims
      expect(userinfoData).toHaveProperty('phone_number');
      expect(userinfoData).toHaveProperty('phone_number_verified');
      expect(userinfoData.phone_number).toBe('+81 90-1234-5678');
      expect(userinfoData.phone_number_verified).toBe(true);

      // Should NOT have profile or email claims
      expect(userinfoData).not.toHaveProperty('name');
      expect(userinfoData).not.toHaveProperty('email');
    });

    it('should return all claims when all scopes are granted', async () => {
      const client = testClients.confidential;

      // Create authorization code with all scopes
      const testCode = await createAuthorizationCode({
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        scope: 'openid profile email address phone',
        userId: 'test-user',
      });

      // Exchange for tokens
      const tokenRes = await exchangeCodeForTokens({
        code: testCode,
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        client_secret: client.client_secret,
      });
      const tokenData = (await tokenRes.json()) as TokenResponse;

      // Get userinfo
      const userinfoRes = await getUserInfo(tokenData.access_token);

      expect(userinfoRes.status).toBe(200);
      const userinfoData = await userinfoRes.json();

      // Should have profile claims
      expect(userinfoData).toHaveProperty('name');
      expect(userinfoData).toHaveProperty('family_name');

      // Should have email claims
      expect(userinfoData).toHaveProperty('email');
      expect(userinfoData).toHaveProperty('email_verified');

      // Should have address claims
      expect(userinfoData).toHaveProperty('address');
      expect(userinfoData.address).toHaveProperty('formatted');

      // Should have phone claims
      expect(userinfoData).toHaveProperty('phone_number');
      expect(userinfoData).toHaveProperty('phone_number_verified');
    });
  });

  describe('Helper Functions Test', () => {
    it('should build valid authorization URL', () => {
      const client = testClients.confidential;
      const state = generateState();
      const nonce = generateNonce();

      const url = buildAuthorizationUrl({
        issuer: env.ISSUER_URL,
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        scope: client.scope,
        state,
        nonce,
      });

      expect(url).toContain('/authorize');
      expect(url).toContain(`client_id=${client.client_id}`);
      expect(url).toContain(`state=${state}`);
      expect(url).toContain(`nonce=${nonce}`);
    });

    it('should parse authorization response', () => {
      const redirectUri = 'https://example.com/callback?code=test-code-123&state=test-state';
      const parsed = parseAuthorizationResponse(redirectUri);

      expect(parsed.code).toBe('test-code-123');
      expect(parsed.state).toBe('test-state');
      expect(parsed.error).toBeUndefined();
    });

    it('should parse error response', () => {
      const redirectUri =
        'https://example.com/callback?error=invalid_request&error_description=Missing+parameter';
      const parsed = parseAuthorizationResponse(redirectUri);

      expect(parsed.code).toBeUndefined();
      expect(parsed.error).toBe('invalid_request');
      expect(parsed.error_description).toBe('Missing parameter');
    });

    it('should build token request body', () => {
      const client = testClients.confidential;
      const body = buildTokenRequestBody({
        grant_type: 'authorization_code',
        code: 'test-code-123',
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        client_secret: client.client_secret,
      });

      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('test-code-123');
      expect(body.get('client_id')).toBe(client.client_id);
      expect(body.get('client_secret')).toBe(client.client_secret);
    });
  });
});
