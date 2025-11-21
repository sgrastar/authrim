import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { parseJwt } from '../../packages/shared/src/utils/jwt';

/**
 * Hybrid Flow Tests
 *
 * Tests for OIDC Core 3.3 Hybrid Flow implementation:
 * - response_type=code id_token
 * - response_type=code token
 * - response_type=code id_token token
 *
 * These tests verify:
 * - Fragment encoding for responses
 * - ID token generation with c_hash
 * - Access token generation
 * - Nonce validation (required for hybrid flows)
 */

describe('Hybrid Flow - OIDC Core 3.3', () => {
  const BASE_URL = 'http://localhost:8787';
  const TEST_CLIENT_ID = 'test-client-hybrid';
  const TEST_REDIRECT_URI = 'https://example.com/callback';
  const TEST_SCOPE = 'openid profile email';
  const TEST_NONCE = 'test-nonce-' + Date.now();
  const TEST_STATE = 'test-state-' + Date.now();

  // Helper function to parse fragment parameters
  function parseFragment(url: string): Record<string, string> {
    const hash = new URL(url).hash.slice(1); // Remove #
    const params: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(hash)) {
      params[key] = value;
    }
    return params;
  }

  describe('Response Type Validation', () => {
    it('should accept response_type=code id_token', async () => {
      const response = await fetch(
        `${BASE_URL}/authorize?response_type=code+id_token&client_id=${TEST_CLIENT_ID}&redirect_uri=${encodeURIComponent(TEST_REDIRECT_URI)}&scope=${encodeURIComponent(TEST_SCOPE)}&state=${TEST_STATE}&nonce=${TEST_NONCE}`,
        { redirect: 'manual' }
      );

      // Should not return error
      expect(response.status).not.toBe(400);
    });

    it('should accept response_type=code token', async () => {
      const response = await fetch(
        `${BASE_URL}/authorize?response_type=code+token&client_id=${TEST_CLIENT_ID}&redirect_uri=${encodeURIComponent(TEST_REDIRECT_URI)}&scope=${encodeURIComponent(TEST_SCOPE)}&state=${TEST_STATE}&nonce=${TEST_NONCE}`,
        { redirect: 'manual' }
      );

      expect(response.status).not.toBe(400);
    });

    it('should accept response_type=code id_token token', async () => {
      const response = await fetch(
        `${BASE_URL}/authorize?response_type=code+id_token+token&client_id=${TEST_CLIENT_ID}&redirect_uri=${encodeURIComponent(TEST_REDIRECT_URI)}&scope=${encodeURIComponent(TEST_SCOPE)}&state=${TEST_STATE}&nonce=${TEST_NONCE}`,
        { redirect: 'manual' }
      );

      expect(response.status).not.toBe(400);
    });

    it('should reject implicit/hybrid flows without nonce', async () => {
      const response = await fetch(
        `${BASE_URL}/authorize?response_type=code+id_token&client_id=${TEST_CLIENT_ID}&redirect_uri=${encodeURIComponent(TEST_REDIRECT_URI)}&scope=${encodeURIComponent(TEST_SCOPE)}&state=${TEST_STATE}`,
        { redirect: 'manual' }
      );

      // Should redirect with error
      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      expect(location).toContain('error=invalid_request');
      expect(location).toContain('nonce');
    });
  });

  describe('Hybrid Flow 1: code id_token', () => {
    it('should return code and id_token in fragment', async () => {
      const response = await fetch(
        `${BASE_URL}/authorize?response_type=code+id_token&client_id=${TEST_CLIENT_ID}&redirect_uri=${encodeURIComponent(TEST_REDIRECT_URI)}&scope=${encodeURIComponent(TEST_SCOPE)}&state=${TEST_STATE}&nonce=${TEST_NONCE}`,
        { redirect: 'manual' }
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      expect(location).toBeTruthy();

      // Verify fragment encoding
      expect(location).toContain('#');

      const params = parseFragment(location!);

      // Verify code is present
      expect(params.code).toBeTruthy();
      expect(params.code.length).toBeGreaterThanOrEqual(128);

      // Verify id_token is present
      expect(params.id_token).toBeTruthy();

      // Verify state
      expect(params.state).toBe(TEST_STATE);

      // Verify no access_token
      expect(params.access_token).toBeUndefined();

      // Decode and verify ID token
      const idTokenPayload = parseJwt(params.id_token);
      expect(idTokenPayload.nonce).toBe(TEST_NONCE);
      expect(idTokenPayload.c_hash).toBeTruthy(); // c_hash must be present
      expect(idTokenPayload.at_hash).toBeUndefined(); // at_hash should not be present
    });

    it('should use fragment as default response_mode', async () => {
      const response = await fetch(
        `${BASE_URL}/authorize?response_type=code+id_token&client_id=${TEST_CLIENT_ID}&redirect_uri=${encodeURIComponent(TEST_REDIRECT_URI)}&scope=${encodeURIComponent(TEST_SCOPE)}&state=${TEST_STATE}&nonce=${TEST_NONCE}`,
        { redirect: 'manual' }
      );

      const location = response.headers.get('Location');
      expect(location).toContain('#');
      expect(location).not.toContain('?code=');
    });
  });

  describe('Hybrid Flow 2: code token', () => {
    it('should return code and access_token in fragment', async () => {
      const response = await fetch(
        `${BASE_URL}/authorize?response_type=code+token&client_id=${TEST_CLIENT_ID}&redirect_uri=${encodeURIComponent(TEST_REDIRECT_URI)}&scope=${encodeURIComponent(TEST_SCOPE)}&state=${TEST_STATE}&nonce=${TEST_NONCE}`,
        { redirect: 'manual' }
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      expect(location).toBeTruthy();

      const params = parseFragment(location!);

      // Verify code is present
      expect(params.code).toBeTruthy();

      // Verify access_token is present
      expect(params.access_token).toBeTruthy();
      expect(params.token_type).toBe('Bearer');
      expect(params.expires_in).toBe('3600');

      // Verify state
      expect(params.state).toBe(TEST_STATE);

      // Verify no id_token
      expect(params.id_token).toBeUndefined();
    });
  });

  describe('Hybrid Flow 3: code id_token token', () => {
    it('should return code, id_token, and access_token in fragment', async () => {
      const response = await fetch(
        `${BASE_URL}/authorize?response_type=code+id_token+token&client_id=${TEST_CLIENT_ID}&redirect_uri=${encodeURIComponent(TEST_REDIRECT_URI)}&scope=${encodeURIComponent(TEST_SCOPE)}&state=${TEST_STATE}&nonce=${TEST_NONCE}`,
        { redirect: 'manual' }
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      expect(location).toBeTruthy();

      const params = parseFragment(location!);

      // Verify all three are present
      expect(params.code).toBeTruthy();
      expect(params.access_token).toBeTruthy();
      expect(params.id_token).toBeTruthy();

      // Verify token metadata
      expect(params.token_type).toBe('Bearer');
      expect(params.expires_in).toBe('3600');

      // Verify state
      expect(params.state).toBe(TEST_STATE);

      // Decode and verify ID token
      const idTokenPayload = parseJwt(params.id_token);
      expect(idTokenPayload.nonce).toBe(TEST_NONCE);
      expect(idTokenPayload.c_hash).toBeTruthy(); // c_hash must be present
      expect(idTokenPayload.at_hash).toBeTruthy(); // at_hash must be present
    });

    it('should generate valid JWT tokens', async () => {
      const response = await fetch(
        `${BASE_URL}/authorize?response_type=code+id_token+token&client_id=${TEST_CLIENT_ID}&redirect_uri=${encodeURIComponent(TEST_REDIRECT_URI)}&scope=${encodeURIComponent(TEST_SCOPE)}&state=${TEST_STATE}&nonce=${TEST_NONCE}`,
        { redirect: 'manual' }
      );

      const location = response.headers.get('Location')!;
      const params = parseFragment(location);

      // Verify ID token structure
      const idTokenPayload = parseJwt(params.id_token);
      expect(idTokenPayload.iss).toBeTruthy();
      expect(idTokenPayload.sub).toBeTruthy();
      expect(idTokenPayload.aud).toBe(TEST_CLIENT_ID);
      expect(idTokenPayload.exp).toBeGreaterThan(Date.now() / 1000);
      expect(idTokenPayload.iat).toBeLessThanOrEqual(Date.now() / 1000);
      expect(idTokenPayload.auth_time).toBeTruthy();

      // Verify access token structure
      const accessTokenPayload = parseJwt(params.access_token);
      expect(accessTokenPayload.iss).toBeTruthy();
      expect(accessTokenPayload.sub).toBeTruthy();
      expect(accessTokenPayload.aud).toBeTruthy();
      expect(accessTokenPayload.scope).toContain('openid');
      expect(accessTokenPayload.client_id).toBe(TEST_CLIENT_ID);
    });
  });

  describe('Response Mode Override', () => {
    it('should support response_mode=form_post for hybrid flow', async () => {
      const response = await fetch(
        `${BASE_URL}/authorize?response_type=code+id_token&client_id=${TEST_CLIENT_ID}&redirect_uri=${encodeURIComponent(TEST_REDIRECT_URI)}&scope=${encodeURIComponent(TEST_SCOPE)}&state=${TEST_STATE}&nonce=${TEST_NONCE}&response_mode=form_post`,
        { redirect: 'manual' }
      );

      expect(response.status).toBe(200);
      const html = await response.text();

      // Verify form_post HTML response
      expect(html).toContain('<form');
      expect(html).toContain('method="post"');
      expect(html).toContain(`action="${TEST_REDIRECT_URI}"`);
      expect(html).toContain('name="code"');
      expect(html).toContain('name="id_token"');
      expect(html).toContain('name="state"');
    });

    it('should allow explicit response_mode=fragment', async () => {
      const response = await fetch(
        `${BASE_URL}/authorize?response_type=code+id_token&client_id=${TEST_CLIENT_ID}&redirect_uri=${encodeURIComponent(TEST_REDIRECT_URI)}&scope=${encodeURIComponent(TEST_SCOPE)}&state=${TEST_STATE}&nonce=${TEST_NONCE}&response_mode=fragment`,
        { redirect: 'manual' }
      );

      const location = response.headers.get('Location');
      expect(location).toContain('#');
    });
  });

  describe('Hash Validation', () => {
    it('should include c_hash in ID token when code is present', async () => {
      const response = await fetch(
        `${BASE_URL}/authorize?response_type=code+id_token&client_id=${TEST_CLIENT_ID}&redirect_uri=${encodeURIComponent(TEST_REDIRECT_URI)}&scope=${encodeURIComponent(TEST_SCOPE)}&state=${TEST_STATE}&nonce=${TEST_NONCE}`,
        { redirect: 'manual' }
      );

      const location = response.headers.get('Location')!;
      const params = parseFragment(location);
      const idTokenPayload = parseJwt(params.id_token);

      expect(idTokenPayload.c_hash).toBeTruthy();
      expect(idTokenPayload.c_hash).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('should include at_hash in ID token when access_token is present', async () => {
      const response = await fetch(
        `${BASE_URL}/authorize?response_type=code+id_token+token&client_id=${TEST_CLIENT_ID}&redirect_uri=${encodeURIComponent(TEST_REDIRECT_URI)}&scope=${encodeURIComponent(TEST_SCOPE)}&state=${TEST_STATE}&nonce=${TEST_NONCE}`,
        { redirect: 'manual' }
      );

      const location = response.headers.get('Location')!;
      const params = parseFragment(location);
      const idTokenPayload = parseJwt(params.id_token);

      expect(idTokenPayload.at_hash).toBeTruthy();
      expect(idTokenPayload.at_hash).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });
});

describe('Implicit Flow - OIDC Core 3.2', () => {
  const BASE_URL = 'http://localhost:8787';
  const TEST_CLIENT_ID = 'test-client-implicit';
  const TEST_REDIRECT_URI = 'https://example.com/callback';
  const TEST_SCOPE = 'openid profile';
  const TEST_NONCE = 'test-nonce-implicit-' + Date.now();
  const TEST_STATE = 'test-state-implicit-' + Date.now();

  function parseFragment(url: string): Record<string, string> {
    const hash = new URL(url).hash.slice(1);
    const params: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(hash)) {
      params[key] = value;
    }
    return params;
  }

  describe('Implicit Flow 1: id_token', () => {
    it('should return only id_token in fragment', async () => {
      const response = await fetch(
        `${BASE_URL}/authorize?response_type=id_token&client_id=${TEST_CLIENT_ID}&redirect_uri=${encodeURIComponent(TEST_REDIRECT_URI)}&scope=${encodeURIComponent(TEST_SCOPE)}&state=${TEST_STATE}&nonce=${TEST_NONCE}`,
        { redirect: 'manual' }
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      expect(location).toContain('#');

      const params = parseFragment(location!);

      // Verify id_token is present
      expect(params.id_token).toBeTruthy();

      // Verify no code or access_token
      expect(params.code).toBeUndefined();
      expect(params.access_token).toBeUndefined();

      // Verify state
      expect(params.state).toBe(TEST_STATE);

      // Decode and verify ID token
      const idTokenPayload = parseJwt(params.id_token);
      expect(idTokenPayload.nonce).toBe(TEST_NONCE);
      expect(idTokenPayload.c_hash).toBeUndefined();
      expect(idTokenPayload.at_hash).toBeUndefined();
    });
  });

  describe('Implicit Flow 2: id_token token', () => {
    it('should return id_token and access_token in fragment', async () => {
      const response = await fetch(
        `${BASE_URL}/authorize?response_type=id_token+token&client_id=${TEST_CLIENT_ID}&redirect_uri=${encodeURIComponent(TEST_REDIRECT_URI)}&scope=${encodeURIComponent(TEST_SCOPE)}&state=${TEST_STATE}&nonce=${TEST_NONCE}`,
        { redirect: 'manual' }
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      const params = parseFragment(location!);

      // Verify both tokens are present
      expect(params.id_token).toBeTruthy();
      expect(params.access_token).toBeTruthy();
      expect(params.token_type).toBe('Bearer');

      // Verify no code
      expect(params.code).toBeUndefined();

      // Decode and verify ID token
      const idTokenPayload = parseJwt(params.id_token);
      expect(idTokenPayload.nonce).toBe(TEST_NONCE);
      expect(idTokenPayload.at_hash).toBeTruthy(); // at_hash must be present
      expect(idTokenPayload.c_hash).toBeUndefined();
    });
  });
});
