/**
 * Internal Token Introspection Tests
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { introspectToken } from '../token-introspection';
import { createAccessToken } from '../jwt';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import type { Env } from '../../types/env';

const TEST_TENANT_ID = 'tenant_test';

describe('Token Introspection Utility', () => {
  let mockEnv: Env;
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;

  beforeAll(async () => {
    // Generate test key pair
    const keyPair = await generateKeyPair('RS256');
    privateKey = keyPair.privateKey;
    publicKey = keyPair.publicKey;

    const publicJWK = await exportJWK(publicKey);

    // Create mock KV namespace with get method
    const mockKV = {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], cursor: undefined, list_complete: true }),
    } as unknown as KVNamespace;

    mockEnv = {
      ISSUER_URL: 'https://test.example.com',
      PUBLIC_JWK_JSON: JSON.stringify(publicJWK),
      KEY_ID: 'test-key',
      ACCESS_TOKEN_EXPIRY: '3600',
      AUTH_CODE_EXPIRY: '600',
      STATE_EXPIRY: '600',
      NONCE_EXPIRY: '600',
      REFRESH_TOKEN_EXPIRY: '2592000',
      NONCE_STORE: mockKV,
      REVOKED_TOKENS: mockKV,
    } as Env;
  });

  describe('Valid Bearer Token', () => {
    it('should return valid result for valid Bearer token', async () => {
      // Create test access token
      const claims = {
        iss: mockEnv.ISSUER_URL,
        sub: 'user123',
        aud: mockEnv.ISSUER_URL,
        scope: 'openid profile',
        client_id: 'test-client',
      };

      const tokenResult = await createAccessToken(
        claims,
        privateKey as unknown as Parameters<typeof createAccessToken>[1],
        mockEnv.KEY_ID!,
        3600
      );

      const headers = new Headers();
      headers.set('Authorization', `Bearer ${tokenResult.token}`);

      const result = await introspectToken({
        method: 'GET',
        url: 'https://test.example.com/userinfo',
        headers,
        env: mockEnv,
        tenantId: TEST_TENANT_ID,
      });

      expect(result.valid).toBe(true);
      expect(result.claims).toBeDefined();
      expect(result.claims?.sub).toBe('user123');
      expect(result.claims?.scope).toBe('openid profile');
      expect(result.error).toBeUndefined();
    });

    it('should return error for missing Authorization header', async () => {
      const headers = new Headers();

      const result = await introspectToken({
        method: 'GET',
        url: 'https://test.example.com/userinfo',
        headers,
        env: mockEnv,
        tenantId: TEST_TENANT_ID,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.error).toBe('invalid_request');
      expect(result.error?.error_description).toContain('Missing Authorization header');
      expect(result.error?.statusCode).toBe(401);
    });

    it('should return error for invalid Authorization header format', async () => {
      const headers = new Headers();
      headers.set('Authorization', 'InvalidFormat');

      const result = await introspectToken({
        method: 'GET',
        url: 'https://test.example.com/userinfo',
        headers,
        env: mockEnv,
        tenantId: TEST_TENANT_ID,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.error).toBe('invalid_request');
      expect(result.error?.statusCode).toBe(401);
    });

    it('should return error for expired token', async () => {
      // Create expired token
      const expiredToken = await new SignJWT({
        iss: mockEnv.ISSUER_URL,
        sub: 'user123',
        aud: mockEnv.ISSUER_URL,
        scope: 'openid',
        client_id: 'test-client',
        jti: 'test-jti',
        iat: Math.floor(Date.now() / 1000) - 7200,
        exp: Math.floor(Date.now() / 1000) - 3600, // Expired 1 hour ago
      })
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: mockEnv.KEY_ID })
        .sign(privateKey);

      const headers = new Headers();
      headers.set('Authorization', `Bearer ${expiredToken}`);

      const result = await introspectToken({
        method: 'GET',
        url: 'https://test.example.com/userinfo',
        headers,
        env: mockEnv,
        tenantId: TEST_TENANT_ID,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.error).toBe('invalid_token');
      expect(result.error?.wwwAuthenticate).toContain('Bearer');
    });
  });

  describe('DPoP Token Validation', () => {
    it('should return error when DPoP token is used without DPoP proof', async () => {
      const claims = {
        iss: mockEnv.ISSUER_URL,
        sub: 'user123',
        aud: mockEnv.ISSUER_URL,
        scope: 'openid profile',
        client_id: 'test-client',
      };

      const tokenResult = await createAccessToken(
        claims,
        privateKey as unknown as Parameters<typeof createAccessToken>[1],
        mockEnv.KEY_ID!,
        3600
      );

      const headers = new Headers();
      headers.set('Authorization', `DPoP ${tokenResult.token}`);
      // No DPoP header provided

      const result = await introspectToken({
        method: 'GET',
        url: 'https://test.example.com/userinfo',
        headers,
        env: mockEnv,
        tenantId: TEST_TENANT_ID,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.error).toBe('invalid_dpop_proof');
      expect(result.error?.wwwAuthenticate).toContain('DPoP');
    });

    it('should return error when Bearer token has cnf claim (DPoP-bound)', async () => {
      // Create DPoP-bound token
      const dpopBoundToken = await new SignJWT({
        iss: mockEnv.ISSUER_URL,
        sub: 'user123',
        aud: mockEnv.ISSUER_URL,
        scope: 'openid',
        client_id: 'test-client',
        jti: 'test-jti',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        cnf: { jkt: 'test-thumbprint' }, // DPoP binding
      })
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: mockEnv.KEY_ID })
        .sign(privateKey);

      const headers = new Headers();
      headers.set('Authorization', `Bearer ${dpopBoundToken}`);

      const result = await introspectToken({
        method: 'GET',
        url: 'https://test.example.com/userinfo',
        headers,
        env: mockEnv,
        tenantId: TEST_TENANT_ID,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.error).toBe('invalid_token');
      expect(result.error?.error_description).toContain('DPoP-bound');
    });
  });

  describe('Error Response Building', () => {
    it('should build RFC 6750-compliant error response for Bearer token', async () => {
      const headers = new Headers();
      headers.set('Authorization', 'Bearer invalid_token');

      const result = await introspectToken({
        method: 'GET',
        url: 'https://test.example.com/userinfo',
        headers,
        env: mockEnv,
        tenantId: TEST_TENANT_ID,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.wwwAuthenticate).toContain('Bearer');
      expect(result.error?.wwwAuthenticate).toContain('error="invalid_token"');
      expect(result.error?.statusCode).toBe(401);
    });

    it('should include appropriate status code for each error type', async () => {
      // Missing header - 401
      const result1 = await introspectToken({
        method: 'GET',
        url: 'https://test.example.com/userinfo',
        headers: new Headers(),
        env: mockEnv,
        tenantId: TEST_TENANT_ID,
      });
      expect(result1.error?.statusCode).toBe(401);

      // Invalid format - 401
      const headers2 = new Headers();
      headers2.set('Authorization', 'Invalid');
      const result2 = await introspectToken({
        method: 'GET',
        url: 'https://test.example.com/userinfo',
        headers: headers2,
        env: mockEnv,
        tenantId: TEST_TENANT_ID,
      });
      expect(result2.error?.statusCode).toBe(401);
    });
  });

  describe('Configuration Validation', () => {
    it('should return server error when PUBLIC_JWK_JSON is missing', async () => {
      const invalidEnv = { ...mockEnv, PUBLIC_JWK_JSON: undefined };

      const headers = new Headers();
      headers.set('Authorization', 'Bearer some_token');

      const result = await introspectToken({
        method: 'GET',
        url: 'https://test.example.com/userinfo',
        headers,
        env: invalidEnv as Env,
        tenantId: TEST_TENANT_ID,
      });

      expect(result.valid).toBe(false);
      expect(result.error?.error).toBe('server_error');
      expect(result.error?.statusCode).toBe(500);
    });

    it('should return server error when ISSUER_URL is missing', async () => {
      const invalidEnv = { ...mockEnv, ISSUER_URL: undefined };

      const headers = new Headers();
      headers.set('Authorization', 'Bearer some_token');

      const result = await introspectToken({
        method: 'GET',
        url: 'https://test.example.com/userinfo',
        headers,
        env: invalidEnv as Env,
        tenantId: TEST_TENANT_ID,
      });

      expect(result.valid).toBe(false);
      expect(result.error?.error).toBe('server_error');
      expect(result.error?.statusCode).toBe(500);
    });

    it('should validate the default tenant with the naked-domain issuer when enabled', async () => {
      const multiTenantEnv = {
        ...mockEnv,
        BASE_DOMAIN: 'oidc.example.com',
        NAKED_DOMAIN_AS_ISSUER: 'true',
        PRIMARY_TENANT_ID: 'default',
      } as Env;

      const token = await new SignJWT({
        iss: 'https://oidc.example.com',
        sub: 'user123',
        aud: 'https://oidc.example.com',
        scope: 'openid',
        client_id: 'test-client',
        jti: 'test-jti',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      })
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: multiTenantEnv.KEY_ID })
        .sign(privateKey);

      const headers = new Headers();
      headers.set('Authorization', `Bearer ${token}`);
      headers.set('Host', 'oidc.example.com');

      const result = await introspectToken({
        method: 'GET',
        url: 'https://oidc.example.com/userinfo',
        headers,
        env: multiTenantEnv,
        tenantId: 'default',
      });

      expect(result.valid).toBe(true);
      expect(result.claims?.iss).toBe('https://oidc.example.com');
    });

    it('should validate non-primary tenants against their subdomain issuer', async () => {
      const multiTenantEnv = {
        ...mockEnv,
        BASE_DOMAIN: 'oidc.example.com',
        NAKED_DOMAIN_AS_ISSUER: 'true',
        PRIMARY_TENANT_ID: 'default',
      } as Env;

      const token = await new SignJWT({
        iss: 'https://acme.oidc.example.com',
        sub: 'user123',
        aud: 'https://acme.oidc.example.com',
        scope: 'openid',
        client_id: 'test-client',
        jti: 'test-jti',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      })
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: multiTenantEnv.KEY_ID })
        .sign(privateKey);

      const headers = new Headers();
      headers.set('Authorization', `Bearer ${token}`);
      headers.set('Host', 'acme.oidc.example.com');

      const result = await introspectToken({
        method: 'GET',
        url: 'https://acme.oidc.example.com/userinfo',
        headers,
        env: multiTenantEnv,
        tenantId: 'acme',
      });

      expect(result.valid).toBe(true);
      expect(result.claims?.iss).toBe('https://acme.oidc.example.com');
    });

    it('should validate issuer from request tenant instead of defaulting from an unresolved host', async () => {
      const multiTenantEnv = {
        ...mockEnv,
        BASE_DOMAIN: 'oidc.example.com',
        NAKED_DOMAIN_AS_ISSUER: 'true',
        PRIMARY_TENANT_ID: 'default',
      } as Env;

      const token = await new SignJWT({
        iss: 'https://acme.oidc.example.com',
        sub: 'user123',
        aud: 'https://acme.oidc.example.com',
        scope: 'openid',
        client_id: 'test-client',
        jti: 'test-jti',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      })
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: multiTenantEnv.KEY_ID })
        .sign(privateKey);

      const headers = new Headers();
      headers.set('Authorization', `Bearer ${token}`);
      headers.set('Host', 'api.internal.example.com');

      const result = await introspectToken({
        method: 'GET',
        url: 'https://api.internal.example.com/userinfo',
        headers,
        env: multiTenantEnv,
        tenantId: 'acme',
      });

      expect(result.valid).toBe(true);
      expect(result.claims?.iss).toBe('https://acme.oidc.example.com');
    });
  });
});
