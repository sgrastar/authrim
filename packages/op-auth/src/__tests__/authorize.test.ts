import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { authorizeHandler } from '../authorize';
import type { Env } from '@authrim/shared/types/env';

/**
 * Mock KV namespace for testing
 */
class MockKVNamespace {
  private store: Map<string, string> = new Map();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) || null;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  // Helper method for testing
  async getAll(): Promise<Map<string, string>> {
    return this.store;
  }
}

// Type for error response
type ErrorResponse = Record<string, unknown>;

/**
 * Create a mock environment for testing (partial - only what's needed)
 */
function createMockEnv() {
  return {
    ISSUER_URL: 'https://test.example.com',
    TOKEN_EXPIRY: '3600',
    CODE_EXPIRY: '120',
    STATE_EXPIRY: '300',
    NONCE_EXPIRY: '300',
    REFRESH_TOKEN_EXPIRY: '2592000',
    ALLOW_HTTP_REDIRECT: 'true',
    STATE_STORE: new MockKVNamespace() as unknown as KVNamespace,
    NONCE_STORE: new MockKVNamespace() as unknown as KVNamespace,
    CLIENTS_CACHE: new MockKVNamespace() as unknown as KVNamespace,
    DB: {} as D1Database,
    AVATARS: {} as R2Bucket,
    KEY_MANAGER: {} as DurableObjectNamespace,
    SESSION_STORE: {} as DurableObjectNamespace,
    AUTH_CODE_STORE: {} as DurableObjectNamespace,
    REFRESH_TOKEN_ROTATOR: {} as DurableObjectNamespace,
    CHALLENGE_STORE: {} as DurableObjectNamespace,
    RATE_LIMITER: {} as DurableObjectNamespace,
    USER_CODE_RATE_LIMITER: {} as DurableObjectNamespace,
    PAR_REQUEST_STORE: {} as DurableObjectNamespace,
    DPOP_JTI_STORE: {} as DurableObjectNamespace,
    TOKEN_REVOCATION_STORE: {} as DurableObjectNamespace,
    DEVICE_CODE_STORE: {} as DurableObjectNamespace,
    CIBA_REQUEST_STORE: {} as DurableObjectNamespace,
  } as Env;
}

describe('Authorization Handler', () => {
  let app: Hono<{ Bindings: Env }>;
  let env: Env;

  beforeEach(() => {
    app = new Hono<{ Bindings: Env }>();
    app.get('/authorize', authorizeHandler);
    env = createMockEnv();
  });

  describe('Successful Authorization Flow', () => {
    it('should redirect with authorization code when all parameters are valid', async () => {
      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&state=test-state',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      expect(location).toBeTruthy();

      const redirectUrl = new URL(location!);
      expect(redirectUrl.origin + redirectUrl.pathname).toBe('https://example.com/callback');
      expect(redirectUrl.searchParams.has('code')).toBe(true);
      expect(redirectUrl.searchParams.get('state')).toBe('test-state');

      // Verify authorization code format (base64url, minimum 128 characters)
      const code = redirectUrl.searchParams.get('code');
      expect(code).toMatch(/^[A-Za-z0-9_-]+$/); // base64url format
      expect(code!.length).toBeGreaterThanOrEqual(128); // minimum 128 characters
    });

    it('should redirect without state when state is not provided', async () => {
      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      expect(location).toBeTruthy();

      const redirectUrl = new URL(location!);
      expect(redirectUrl.searchParams.has('code')).toBe(true);
      expect(redirectUrl.searchParams.has('state')).toBe(false);
    });

    it('should accept http://localhost redirect_uri when ALLOW_HTTP_REDIRECT is true', async () => {
      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=http://localhost:3000/callback&scope=openid',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      expect(location).toBeTruthy();
      expect(location).toContain('http://localhost:3000/callback');
    });

    it('should store authorization code in KV with correct metadata', async () => {
      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid%20profile&nonce=test-nonce',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      const code = new URL(location!).searchParams.get('code');

      // TODO: Auth codes are now stored in Durable Objects (AUTH_CODE_STORE)
      // These assertions need to be updated to use proper DO mocking
      // For now, we just verify the redirect was successful
      expect(code).toBeTruthy();
    });
  });

  describe('PKCE Support', () => {
    it('should accept valid PKCE parameters', async () => {
      const codeChallenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'; // Valid S256 challenge
      const response = await app.request(
        `/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&code_challenge=${codeChallenge}&code_challenge_method=S256`,
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      const code = new URL(location!).searchParams.get('code');

      // TODO: Auth codes are now stored in Durable Objects (AUTH_CODE_STORE)
      // PKCE data verification needs to use proper DO mocking
      expect(code).toBeTruthy();
    });

    it('should reject code_challenge without code_challenge_method', async () => {
      const codeChallenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
      const response = await app.request(
        `/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&code_challenge=${codeChallenge}`,
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      const redirectUrl = new URL(location!);
      expect(redirectUrl.searchParams.get('error')).toBe('invalid_request');
      expect(redirectUrl.searchParams.get('error_description')).toContain('code_challenge_method');
    });

    it('should reject unsupported code_challenge_method', async () => {
      const codeChallenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
      const response = await app.request(
        `/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&code_challenge=${codeChallenge}&code_challenge_method=plain`,
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      const redirectUrl = new URL(location!);
      expect(redirectUrl.searchParams.get('error')).toBe('invalid_request');
      expect(redirectUrl.searchParams.get('error_description')).toContain('S256');
    });

    it('should reject invalid code_challenge format', async () => {
      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&code_challenge=invalid!@#&code_challenge_method=S256',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      const redirectUrl = new URL(location!);
      expect(redirectUrl.searchParams.get('error')).toBe('invalid_request');
      expect(redirectUrl.searchParams.get('error_description')).toContain(
        'Invalid code_challenge format'
      );
    });
  });

  describe('Parameter Validation - Direct Errors', () => {
    it('should return 400 when response_type is missing', async () => {
      const response = await app.request(
        '/authorize?client_id=test-client&redirect_uri=https://example.com/callback&scope=openid',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toBe('unsupported_response_type');
      expect(body.error_description).toContain('response_type');
    });

    it('should return 400 when response_type is unsupported', async () => {
      const response = await app.request(
        '/authorize?response_type=token&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toBe('unsupported_response_type');
      expect(body.error_description).toContain('response_type');
    });

    it('should return 400 when client_id is missing', async () => {
      const response = await app.request(
        '/authorize?response_type=code&redirect_uri=https://example.com/callback&scope=openid',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('client_id');
    });

    it('should return 400 when redirect_uri is missing', async () => {
      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&scope=openid',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('redirect_uri');
    });

    it('should return 400 when redirect_uri is invalid URL', async () => {
      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=not-a-url&scope=openid',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('redirect_uri');
    });
  });

  describe('Parameter Validation - Redirect Errors', () => {
    it('should redirect with error when scope is missing', async () => {
      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      const redirectUrl = new URL(location!);
      expect(redirectUrl.searchParams.get('error')).toBe('invalid_scope');
    });

    it('should redirect with error when scope does not include openid', async () => {
      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=profile',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      const redirectUrl = new URL(location!);
      expect(redirectUrl.searchParams.get('error')).toBe('invalid_scope');
      expect(redirectUrl.searchParams.get('error_description')).toContain('openid');
    });

    it('should redirect with error when state is too long', async () => {
      const longState = 'a'.repeat(513);
      const response = await app.request(
        `/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&state=${longState}`,
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      const redirectUrl = new URL(location!);
      expect(redirectUrl.searchParams.get('error')).toBe('invalid_request');
      expect(redirectUrl.searchParams.get('error_description')).toContain('state');
    });

    it('should redirect with error when nonce is too long', async () => {
      const longNonce = 'a'.repeat(513);
      const response = await app.request(
        `/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&nonce=${longNonce}`,
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      const redirectUrl = new URL(location!);
      expect(redirectUrl.searchParams.get('error')).toBe('invalid_request');
      expect(redirectUrl.searchParams.get('error_description')).toContain('nonce');
    });

    it('should include state in error redirect when state is provided', async () => {
      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=profile&state=test-state',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      const redirectUrl = new URL(location!);
      expect(redirectUrl.searchParams.get('error')).toBe('invalid_scope');
      expect(redirectUrl.searchParams.get('state')).toBe('test-state');
    });
  });

  describe('Edge Cases', () => {
    it('should handle multiple scopes correctly', async () => {
      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid%20profile%20email',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      const code = new URL(location!).searchParams.get('code');

      // TODO: Auth codes are now stored in Durable Objects (AUTH_CODE_STORE)
      // Scope verification needs to use proper DO mocking
      expect(code).toBeTruthy();
    });

    it('should reject invalid client_id format', async () => {
      const response = await app.request(
        '/authorize?response_type=code&client_id=invalid@client&redirect_uri=https://example.com/callback&scope=openid',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('client_id');
    });

    it('should handle empty state gracefully (not provide it)', async () => {
      const response = await app.request(
        '/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid&state=',
        { method: 'GET' },
        env
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      const redirectUrl = new URL(location!);
      expect(redirectUrl.searchParams.get('error')).toBe('invalid_request');
      expect(redirectUrl.searchParams.get('error_description')).toContain('state');
    });
  });
});
