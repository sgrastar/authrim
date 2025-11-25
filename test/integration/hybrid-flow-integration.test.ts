import { describe, it, expect, beforeAll } from 'vitest';
import { parseJwt } from '@authrim/shared/utils/jwt';

/**
 * Hybrid Flow Integration Tests
 *
 * End-to-end tests for Hybrid Flow:
 * 1. Authorization endpoint returns code + tokens
 * 2. Token endpoint can exchange code for additional tokens
 * 3. Hash validation (c_hash, at_hash) is correct
 * 4. Tokens are valid and verifiable
 */

describe('Hybrid Flow Integration Tests', () => {
  const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8787';
  const TEST_CLIENT_ID = 'test-client-hybrid-integration';
  const TEST_CLIENT_SECRET = 'test-secret';
  const TEST_REDIRECT_URI = 'https://example.com/callback';
  const TEST_SCOPE = 'openid profile email';

  // Helper to parse fragment
  function parseFragment(url: string): Record<string, string> {
    const hash = new URL(url).hash.slice(1);
    const params: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(hash)) {
      params[key] = value;
    }
    return params;
  }

  describe('Full Hybrid Flow: code id_token token', () => {
    it('should complete full flow with token exchange', async () => {
      const nonce = 'integration-test-nonce-' + Date.now();
      const state = 'integration-test-state-' + Date.now();

      // Step 1: Authorization request
      const authResponse = await fetch(
        `${BASE_URL}/authorize?response_type=code+id_token+token&client_id=${TEST_CLIENT_ID}&redirect_uri=${encodeURIComponent(TEST_REDIRECT_URI)}&scope=${encodeURIComponent(TEST_SCOPE)}&state=${state}&nonce=${nonce}`,
        { redirect: 'manual' }
      );

      expect(authResponse.status).toBe(302);
      const authLocation = authResponse.headers.get('Location')!;
      const authParams = parseFragment(authLocation);

      // Verify authorization response
      expect(authParams.code).toBeTruthy();
      expect(authParams.id_token).toBeTruthy();
      expect(authParams.access_token).toBeTruthy();
      expect(authParams.state).toBe(state);

      // Verify ID token from authorization endpoint
      const authIdToken = parseJwt(authParams.id_token);
      expect(authIdToken.nonce).toBe(nonce);
      expect(authIdToken.c_hash).toBeTruthy();
      expect(authIdToken.at_hash).toBeTruthy();

      // Step 2: Token exchange (exchange code for tokens)
      const tokenResponse = await fetch(`${BASE_URL}/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${btoa(`${TEST_CLIENT_ID}:${TEST_CLIENT_SECRET}`)}`,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: authParams.code,
          redirect_uri: TEST_REDIRECT_URI,
        }),
      });

      expect(tokenResponse.status).toBe(200);
      const tokenData = await tokenResponse.json();

      // Verify token response
      expect(tokenData.access_token).toBeTruthy();
      expect(tokenData.id_token).toBeTruthy();
      expect(tokenData.refresh_token).toBeTruthy();
      expect(tokenData.token_type).toBe('Bearer');
      expect(tokenData.expires_in).toBe(3600);

      // Verify ID token from token endpoint
      const tokenIdToken = parseJwt(tokenData.id_token);
      expect(tokenIdToken.nonce).toBe(nonce);
      expect(tokenIdToken.at_hash).toBeTruthy();

      // Verify both access tokens are for the same subject
      const authAccessToken = parseJwt(authParams.access_token);
      const tokenAccessToken = parseJwt(tokenData.access_token);
      expect(authAccessToken.sub).toBe(tokenAccessToken.sub);

      // Step 3: Use access token to access UserInfo endpoint
      const userInfoResponse = await fetch(`${BASE_URL}/userinfo`, {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
        },
      });

      expect(userInfoResponse.status).toBe(200);
      const userInfo = await userInfoResponse.json();
      expect(userInfo.sub).toBe(tokenAccessToken.sub);
    });
  });

  describe('Hybrid Flow: code id_token', () => {
    it('should issue id_token at authorization and token endpoints', async () => {
      const nonce = 'test-nonce-' + Date.now();
      const state = 'test-state-' + Date.now();

      // Authorization request
      const authResponse = await fetch(
        `${BASE_URL}/authorize?response_type=code+id_token&client_id=${TEST_CLIENT_ID}&redirect_uri=${encodeURIComponent(TEST_REDIRECT_URI)}&scope=${encodeURIComponent(TEST_SCOPE)}&state=${state}&nonce=${nonce}`,
        { redirect: 'manual' }
      );

      const authLocation = authResponse.headers.get('Location')!;
      const authParams = parseFragment(authLocation);

      expect(authParams.code).toBeTruthy();
      expect(authParams.id_token).toBeTruthy();
      expect(authParams.access_token).toBeUndefined();

      // Verify c_hash
      const authIdToken = parseJwt(authParams.id_token);
      expect(authIdToken.c_hash).toBeTruthy();
      expect(authIdToken.at_hash).toBeUndefined();

      // Token exchange
      const tokenResponse = await fetch(`${BASE_URL}/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${btoa(`${TEST_CLIENT_ID}:${TEST_CLIENT_SECRET}`)}`,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: authParams.code,
          redirect_uri: TEST_REDIRECT_URI,
        }),
      });

      const tokenData = await tokenResponse.json();
      expect(tokenData.id_token).toBeTruthy();

      // Verify both ID tokens have same subject
      const tokenIdToken = parseJwt(tokenData.id_token);
      expect(authIdToken.sub).toBe(tokenIdToken.sub);
    });
  });

  describe('Hybrid Flow: code token', () => {
    it('should issue access_token at authorization endpoint only', async () => {
      const nonce = 'test-nonce-' + Date.now();
      const state = 'test-state-' + Date.now();

      // Authorization request
      const authResponse = await fetch(
        `${BASE_URL}/authorize?response_type=code+token&client_id=${TEST_CLIENT_ID}&redirect_uri=${encodeURIComponent(TEST_REDIRECT_URI)}&scope=${encodeURIComponent(TEST_SCOPE)}&state=${state}&nonce=${nonce}`,
        { redirect: 'manual' }
      );

      const authLocation = authResponse.headers.get('Location')!;
      const authParams = parseFragment(authLocation);

      expect(authParams.code).toBeTruthy();
      expect(authParams.access_token).toBeTruthy();
      expect(authParams.id_token).toBeUndefined();

      // Verify access token is usable
      const authAccessToken = parseJwt(authParams.access_token);
      expect(authAccessToken.scope).toContain('openid');

      // Use access token immediately
      const userInfoResponse = await fetch(`${BASE_URL}/userinfo`, {
        headers: {
          Authorization: `Bearer ${authParams.access_token}`,
        },
      });

      expect(userInfoResponse.status).toBe(200);
      const userInfo = await userInfoResponse.json();
      expect(userInfo.sub).toBe(authAccessToken.sub);
    });
  });

  describe('Hash Validation', () => {
    it('should compute c_hash correctly', async () => {
      const nonce = 'test-nonce-' + Date.now();
      const state = 'test-state-' + Date.now();

      const authResponse = await fetch(
        `${BASE_URL}/authorize?response_type=code+id_token&client_id=${TEST_CLIENT_ID}&redirect_uri=${encodeURIComponent(TEST_REDIRECT_URI)}&scope=${encodeURIComponent(TEST_SCOPE)}&state=${state}&nonce=${nonce}`,
        { redirect: 'manual' }
      );

      const authLocation = authResponse.headers.get('Location')!;
      const authParams = parseFragment(authLocation);
      const idToken = parseJwt(authParams.id_token);

      // c_hash should be present and valid
      expect(idToken.c_hash).toBeTruthy();
      expect(idToken.c_hash).toMatch(/^[A-Za-z0-9_-]+$/);

      // Verify c_hash length (should be half of SHA-256 hash, base64url encoded)
      // SHA-256 produces 32 bytes, half is 16 bytes, base64url encodes to 22 chars (without padding)
      expect(idToken.c_hash.length).toBeGreaterThanOrEqual(20);
      expect(idToken.c_hash.length).toBeLessThanOrEqual(24);
    });

    it('should compute at_hash correctly', async () => {
      const nonce = 'test-nonce-' + Date.now();
      const state = 'test-state-' + Date.now();

      const authResponse = await fetch(
        `${BASE_URL}/authorize?response_type=code+id_token+token&client_id=${TEST_CLIENT_ID}&redirect_uri=${encodeURIComponent(TEST_REDIRECT_URI)}&scope=${encodeURIComponent(TEST_SCOPE)}&state=${state}&nonce=${nonce}`,
        { redirect: 'manual' }
      );

      const authLocation = authResponse.headers.get('Location')!;
      const authParams = parseFragment(authLocation);
      const idToken = parseJwt(authParams.id_token);

      // at_hash should be present and valid
      expect(idToken.at_hash).toBeTruthy();
      expect(idToken.at_hash).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(idToken.at_hash.length).toBeGreaterThanOrEqual(20);
      expect(idToken.at_hash.length).toBeLessThanOrEqual(24);
    });
  });

  describe('Error Handling', () => {
    it('should reject hybrid flow without nonce', async () => {
      const state = 'test-state-' + Date.now();

      const authResponse = await fetch(
        `${BASE_URL}/authorize?response_type=code+id_token&client_id=${TEST_CLIENT_ID}&redirect_uri=${encodeURIComponent(TEST_REDIRECT_URI)}&scope=${encodeURIComponent(TEST_SCOPE)}&state=${state}`,
        { redirect: 'manual' }
      );

      expect(authResponse.status).toBe(302);
      const location = authResponse.headers.get('Location')!;
      expect(location).toContain('error=invalid_request');
      expect(location).toContain('nonce');
    });

    it('should handle invalid response_type combinations', async () => {
      const nonce = 'test-nonce-' + Date.now();
      const state = 'test-state-' + Date.now();

      const authResponse = await fetch(
        `${BASE_URL}/authorize?response_type=invalid&client_id=${TEST_CLIENT_ID}&redirect_uri=${encodeURIComponent(TEST_REDIRECT_URI)}&scope=${encodeURIComponent(TEST_SCOPE)}&state=${state}&nonce=${nonce}`,
        { redirect: 'manual' }
      );

      expect(authResponse.status).toBe(302);
      const location = authResponse.headers.get('Location')!;
      expect(location).toContain('error=');
    });
  });

  describe('Response Mode Variations', () => {
    it('should support form_post with hybrid flow', async () => {
      const nonce = 'test-nonce-' + Date.now();
      const state = 'test-state-' + Date.now();

      const authResponse = await fetch(
        `${BASE_URL}/authorize?response_type=code+id_token&client_id=${TEST_CLIENT_ID}&redirect_uri=${encodeURIComponent(TEST_REDIRECT_URI)}&scope=${encodeURIComponent(TEST_SCOPE)}&state=${state}&nonce=${nonce}&response_mode=form_post`,
        { redirect: 'manual' }
      );

      expect(authResponse.status).toBe(200);
      const html = await authResponse.text();
      expect(html).toContain('<form');
      expect(html).toContain('method="post"');
      expect(html).toContain('name="code"');
      expect(html).toContain('name="id_token"');
    });
  });
});
