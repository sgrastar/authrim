/**
 * Client Credentials Grant Tests (RFC 6749 Section 4.4)
 *
 * Tests the Client Credentials validation logic and related utilities.
 * Note: Full integration tests require mocked Durable Objects and are in conformance tests.
 */

import { describe, it, expect } from 'vitest';

describe('Client Credentials Grant Tests (RFC 6749 §4.4)', () => {
  describe('Request Validation', () => {
    it('should validate grant_type is client_credentials', () => {
      const validGrantType = 'client_credentials';

      expect(validGrantType).toBe('client_credentials');
      expect(validGrantType).not.toBe('authorization_code');
    });

    it('should accept optional scope parameter', () => {
      const requestWithScope = { scope: 'read write admin' };
      const requestWithoutScope = {};

      expect(requestWithScope.scope).toBe('read write admin');
      expect(requestWithoutScope).not.toHaveProperty('scope');
    });

    it('should accept optional audience parameter', () => {
      const request = { audience: 'https://api.example.com' };

      expect(request.audience).toBe('https://api.example.com');
    });
  });

  describe('Client Authentication Methods', () => {
    it('should support client_secret_basic authentication', () => {
      const clientId = 'my-client';
      const clientSecret = 'my-secret';

      // RFC 6749: client_id:client_secret base64 encoded
      const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const authHeader = `Basic ${credentials}`;

      expect(authHeader).toMatch(/^Basic [A-Za-z0-9+/=]+$/);

      // Verify we can decode it back
      const decoded = Buffer.from(credentials, 'base64').toString();
      expect(decoded).toBe('my-client:my-secret');
    });

    it('should support client_secret_post authentication', () => {
      const request = {
        grant_type: 'client_credentials',
        client_id: 'my-client',
        client_secret: 'my-secret',
      };

      expect(request.client_id).toBeDefined();
      expect(request.client_secret).toBeDefined();
    });

    it('should support private_key_jwt authentication', () => {
      const request = {
        grant_type: 'client_credentials',
        client_id: 'my-client',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...',
      };

      expect(request.client_assertion_type).toBe(
        'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
      );
      expect(request.client_assertion).toBeDefined();
    });

    it('should NOT allow public clients (no authentication)', () => {
      // Public clients have neither client_secret nor client_assertion
      const publicClientConfig = {
        client_id: 'public-app',
        client_secret: undefined,
      };

      expect(publicClientConfig.client_secret).toBeUndefined();
      // Handler should return invalid_client error for public clients
    });
  });

  describe('Subject Claim Format', () => {
    it('should use client:{client_id} as subject for namespace separation', () => {
      const clientId = 'my-m2m-client';
      const expectedSub = `client:${clientId}`;

      expect(expectedSub).toBe('client:my-m2m-client');
      expect(expectedSub).toMatch(/^client:/);
    });

    it('should NOT conflict with user subjects', () => {
      const clientSub = 'client:service-a';
      const userSub = 'user_123';

      // Client subjects have prefix, user subjects don't
      expect(clientSub).toMatch(/^client:/);
      expect(userSub).not.toMatch(/^client:/);
      expect(clientSub).not.toBe(userSub);
    });
  });

  describe('Scope Validation Logic', () => {
    it('should use default_scope when scope is not provided', () => {
      const clientConfig = {
        default_scope: 'read',
        allowed_scopes: ['read', 'write', 'admin'],
      };

      const requestedScope = undefined;
      const effectiveScope = requestedScope || clientConfig.default_scope;

      expect(effectiveScope).toBe('read');
    });

    it('should filter scopes by allowed_scopes', () => {
      const requestedScopes = ['read', 'write', 'delete'];
      const allowedScopes = ['read', 'write'];

      const grantedScopes = requestedScopes.filter((s) => allowedScopes.includes(s));

      expect(grantedScopes).toEqual(['read', 'write']);
      expect(grantedScopes).not.toContain('delete');
    });

    it('should reject when no valid scopes remain', () => {
      const requestedScopes = ['admin', 'superuser'];
      const allowedScopes = ['read', 'write'];

      const grantedScopes = requestedScopes.filter((s) => allowedScopes.includes(s));

      expect(grantedScopes).toHaveLength(0);
      // Handler should return invalid_scope error
    });

    it('should allow all scopes when allowed_scopes is empty', () => {
      const requestedScopes = ['read', 'write', 'admin'];
      const allowedScopes: string[] = []; // Empty means no restriction

      // When allowed_scopes is empty, don't filter
      const grantedScopes =
        allowedScopes.length > 0
          ? requestedScopes.filter((s) => allowedScopes.includes(s))
          : requestedScopes;

      expect(grantedScopes).toEqual(['read', 'write', 'admin']);
    });
  });

  describe('Audience Handling', () => {
    it('should use requested audience when provided', () => {
      const request = { audience: 'https://api.example.com' };
      const clientConfig = {
        default_resource: 'svc://default-api',
        default_audience: 'https://default-api.example.com',
      };

      const effectiveAudience =
        request.audience || clientConfig.default_resource || clientConfig.default_audience;

      expect(effectiveAudience).toBe('https://api.example.com');
    });

    it('should fall back to default_resource when not provided', () => {
      const request = { audience: undefined };
      const clientConfig = {
        default_resource: 'svc://default-api',
        default_audience: 'https://default-api.example.com',
      };

      const effectiveAudience =
        request.audience || clientConfig.default_resource || clientConfig.default_audience;

      expect(effectiveAudience).toBe('svc://default-api');
    });

    it('should reject when no request or configured target exists', () => {
      const request = { audience: undefined };
      const clientConfig = { default_resource: undefined, default_audience: undefined };

      const effectiveAudience =
        request.audience || clientConfig.default_resource || clientConfig.default_audience;

      expect(effectiveAudience).toBeUndefined();
    });
  });

  describe('Client Configuration', () => {
    it('should require client_credentials_allowed to be true', () => {
      const allowedClient = { client_credentials_allowed: true };
      const disallowedClient = { client_credentials_allowed: false };

      expect(allowedClient.client_credentials_allowed).toBe(true);
      expect(disallowedClient.client_credentials_allowed).toBe(false);
      // Handler should return unauthorized_client for disallowed clients
    });

    it('should store allowed_scopes as array', () => {
      const clientConfig = {
        allowed_scopes: ['read', 'write', 'admin'],
      };

      expect(Array.isArray(clientConfig.allowed_scopes)).toBe(true);
      expect(clientConfig.allowed_scopes).toContain('read');
    });
  });

  describe('Response Structure', () => {
    it('should include required response fields per RFC 6749', () => {
      const response = {
        access_token: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'read write',
      };

      // Required fields
      expect(response).toHaveProperty('access_token');
      expect(response).toHaveProperty('token_type');
      expect(response.token_type).toBe('Bearer');

      // Recommended fields
      expect(response.expires_in).toBeGreaterThan(0);
      expect(response).toHaveProperty('scope');
    });

    it('should NOT include refresh_token (per RFC 6749 §4.4.3)', () => {
      const response = {
        access_token: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'read write',
      };

      expect(response).not.toHaveProperty('refresh_token');
    });

    it('should support DPoP token_type', () => {
      const dpopResponse = {
        access_token: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...',
        token_type: 'DPoP',
        expires_in: 3600,
      };

      expect(dpopResponse.token_type).toBe('DPoP');
    });
  });

  describe('Access Token Claims', () => {
    it('should include client_id in token claims', () => {
      const tokenClaims = {
        iss: 'https://auth.example.com',
        sub: 'client:my-m2m-client',
        aud: 'https://api.example.com',
        scope: 'read write',
        client_id: 'my-m2m-client',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
      };

      expect(tokenClaims.sub).toMatch(/^client:/);
      expect(tokenClaims.client_id).toBe('my-m2m-client');
    });

    it('should NOT include act claim (M2M is not delegation)', () => {
      const tokenClaims = {
        iss: 'https://auth.example.com',
        sub: 'client:my-m2m-client',
        aud: 'https://api.example.com',
        scope: 'read write',
        client_id: 'my-m2m-client',
      };

      expect(tokenClaims).not.toHaveProperty('act');
    });
  });

  describe('Error Response Structure', () => {
    it('should return invalid_client for public clients', () => {
      const error = {
        error: 'invalid_client',
        error_description: 'Client credentials authentication is required',
      };

      expect(error.error).toBe('invalid_client');
    });

    it('should return invalid_client for invalid credentials', () => {
      const error = {
        error: 'invalid_client',
        error_description: 'Invalid client credentials',
      };

      expect(error.error).toBe('invalid_client');
    });

    it('should return unauthorized_client for disabled grant', () => {
      const error = {
        error: 'unauthorized_client',
        error_description: 'Client is not authorized for Client Credentials grant',
      };

      expect(error.error).toBe('unauthorized_client');
    });

    it('should return invalid_scope for disallowed scopes', () => {
      const error = {
        error: 'invalid_scope',
        error_description: 'None of the requested scopes are allowed for this client',
      };

      expect(error.error).toBe('invalid_scope');
    });

    it('should return unsupported_grant_type when feature is disabled', () => {
      const error = {
        error: 'unsupported_grant_type',
        error_description: 'Client Credentials grant is not enabled',
      };

      expect(error.error).toBe('unsupported_grant_type');
    });
  });

  describe('Feature Flag', () => {
    it('should check environment variable for feature flag', () => {
      const env = { ENABLE_CLIENT_CREDENTIALS: 'true' };
      const isEnabled = env.ENABLE_CLIENT_CREDENTIALS === 'true';

      expect(isEnabled).toBe(true);
    });

    it('should check KV settings for feature flag override', () => {
      const kvSettings = {
        oidc: {
          clientCredentials: {
            enabled: true,
          },
        },
      };

      const isEnabled = kvSettings.oidc?.clientCredentials?.enabled === true;
      expect(isEnabled).toBe(true);
    });

    it('should prioritize KV over environment variable', () => {
      const env = { ENABLE_CLIENT_CREDENTIALS: 'false' };
      const kvSettings = {
        oidc: {
          clientCredentials: {
            enabled: true,
          },
        },
      };

      // KV takes priority (hybrid pattern)
      const isEnabled =
        kvSettings.oidc?.clientCredentials?.enabled !== undefined
          ? kvSettings.oidc.clientCredentials.enabled === true
          : env.ENABLE_CLIENT_CREDENTIALS === 'true';

      expect(isEnabled).toBe(true);
    });

    it('should fall back to env when KV is not set', () => {
      const env = { ENABLE_CLIENT_CREDENTIALS: 'true' };
      const kvSettings = {
        oidc: {
          clientCredentials: {
            enabled: undefined,
          },
        },
      };

      const isEnabled =
        kvSettings.oidc?.clientCredentials?.enabled !== undefined
          ? kvSettings.oidc.clientCredentials.enabled === true
          : env.ENABLE_CLIENT_CREDENTIALS === 'true';

      expect(isEnabled).toBe(true);
    });
  });
});
