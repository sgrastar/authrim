import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { discoveryHandler } from '../../src/handlers/discovery';
import type { Env } from '../../src/types/env';

/**
 * Create a mock environment for testing
 */
function createMockEnv(): Env {
  return {
    ISSUER_URL: 'https://test.example.com',
    TOKEN_EXPIRY: '3600',
    CODE_EXPIRY: '600',
    STATE_EXPIRY: '600',
    NONCE_EXPIRY: '600',
    PRIVATE_KEY_PEM: 'test-key',
    KEY_ID: 'test-kid',
  } as Env;
}

describe('Discovery Handler', () => {
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    app = new Hono<{ Bindings: Env }>();
    app.get('/.well-known/openid-configuration', discoveryHandler);
  });

  describe('OpenID Connect Discovery Endpoint', () => {
    it('should return valid OIDC metadata', async () => {
      const env = createMockEnv();
      const response = await app.request('/.well-known/openid-configuration', {
        method: 'GET',
      }, env);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('application/json');

      const metadata = await response.json();

      // Required OIDC fields
      expect(metadata).toHaveProperty('issuer');
      expect(metadata).toHaveProperty('authorization_endpoint');
      expect(metadata).toHaveProperty('token_endpoint');
      expect(metadata).toHaveProperty('userinfo_endpoint');
      expect(metadata).toHaveProperty('jwks_uri');
      expect(metadata).toHaveProperty('response_types_supported');
      expect(metadata).toHaveProperty('grant_types_supported');
      expect(metadata).toHaveProperty('id_token_signing_alg_values_supported');
      expect(metadata).toHaveProperty('subject_types_supported');
      expect(metadata).toHaveProperty('scopes_supported');
      expect(metadata).toHaveProperty('claims_supported');
      expect(metadata).toHaveProperty('token_endpoint_auth_methods_supported');
    });

    it('should use correct issuer URL from environment', async () => {
      const env = createMockEnv();
      env.ISSUER_URL = 'https://custom.example.com';

      const response = await app.request('/.well-known/openid-configuration', {
        method: 'GET',
      }, env);

      const metadata = await response.json();
      expect(metadata.issuer).toBe('https://custom.example.com');
      expect(metadata.authorization_endpoint).toBe('https://custom.example.com/authorize');
      expect(metadata.token_endpoint).toBe('https://custom.example.com/token');
      expect(metadata.userinfo_endpoint).toBe('https://custom.example.com/userinfo');
      expect(metadata.jwks_uri).toBe('https://custom.example.com/.well-known/jwks.json');
    });

    it('should return correct response types', async () => {
      const env = createMockEnv();
      const response = await app.request('/.well-known/openid-configuration', {
        method: 'GET',
      }, env);

      const metadata = await response.json();
      expect(metadata.response_types_supported).toEqual(['code']);
    });

    it('should return correct grant types', async () => {
      const env = createMockEnv();
      const response = await app.request('/.well-known/openid-configuration', {
        method: 'GET',
      }, env);

      const metadata = await response.json();
      expect(metadata.grant_types_supported).toEqual(['authorization_code']);
    });

    it('should support RS256 signing algorithm', async () => {
      const env = createMockEnv();
      const response = await app.request('/.well-known/openid-configuration', {
        method: 'GET',
      }, env);

      const metadata = await response.json();
      expect(metadata.id_token_signing_alg_values_supported).toEqual(['RS256']);
    });

    it('should support public subject type', async () => {
      const env = createMockEnv();
      const response = await app.request('/.well-known/openid-configuration', {
        method: 'GET',
      }, env);

      const metadata = await response.json();
      expect(metadata.subject_types_supported).toEqual(['public']);
    });

    it('should include standard OIDC scopes', async () => {
      const env = createMockEnv();
      const response = await app.request('/.well-known/openid-configuration', {
        method: 'GET',
      }, env);

      const metadata = await response.json();
      expect(metadata.scopes_supported).toContain('openid');
      expect(metadata.scopes_supported).toContain('profile');
      expect(metadata.scopes_supported).toContain('email');
    });

    it('should include standard OIDC claims', async () => {
      const env = createMockEnv();
      const response = await app.request('/.well-known/openid-configuration', {
        method: 'GET',
      }, env);

      const metadata = await response.json();
      expect(metadata.claims_supported).toContain('sub');
      expect(metadata.claims_supported).toContain('iss');
      expect(metadata.claims_supported).toContain('aud');
      expect(metadata.claims_supported).toContain('exp');
      expect(metadata.claims_supported).toContain('iat');
      expect(metadata.claims_supported).toContain('name');
      expect(metadata.claims_supported).toContain('email');
    });

    it('should support multiple token endpoint auth methods', async () => {
      const env = createMockEnv();
      const response = await app.request('/.well-known/openid-configuration', {
        method: 'GET',
      }, env);

      const metadata = await response.json();
      expect(metadata.token_endpoint_auth_methods_supported).toContain('client_secret_post');
      expect(metadata.token_endpoint_auth_methods_supported).toContain('client_secret_basic');
      expect(metadata.token_endpoint_auth_methods_supported).toContain('none');
    });
  });

  describe('Cache Headers', () => {
    it('should include Cache-Control header', async () => {
      const env = createMockEnv();
      const response = await app.request('/.well-known/openid-configuration', {
        method: 'GET',
      }, env);

      const cacheControl = response.headers.get('Cache-Control');
      expect(cacheControl).toBeDefined();
      expect(cacheControl).toContain('public');
      expect(cacheControl).toContain('max-age=3600');
    });

    it('should include Vary header', async () => {
      const env = createMockEnv();
      const response = await app.request('/.well-known/openid-configuration', {
        method: 'GET',
      }, env);

      const vary = response.headers.get('Vary');
      expect(vary).toBeDefined();
      expect(vary).toContain('Accept-Encoding');
    });
  });

  describe('OIDC Compliance', () => {
    it('should have matching issuer in all endpoint URLs', async () => {
      const env = createMockEnv();
      const response = await app.request('/.well-known/openid-configuration', {
        method: 'GET',
      }, env);

      const metadata = await response.json();
      const issuer = metadata.issuer;

      expect(metadata.authorization_endpoint).toMatch(new RegExp(`^${issuer}`));
      expect(metadata.token_endpoint).toMatch(new RegExp(`^${issuer}`));
      expect(metadata.userinfo_endpoint).toMatch(new RegExp(`^${issuer}`));
      expect(metadata.jwks_uri).toMatch(new RegExp(`^${issuer}`));
    });

    it('should return proper JSON content type', async () => {
      const env = createMockEnv();
      const response = await app.request('/.well-known/openid-configuration', {
        method: 'GET',
      }, env);

      expect(response.headers.get('Content-Type')).toContain('application/json');
    });

    it('should return 200 OK status', async () => {
      const env = createMockEnv();
      const response = await app.request('/.well-known/openid-configuration', {
        method: 'GET',
      }, env);

      expect(response.status).toBe(200);
    });
  });
});
