import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { discoveryHandler } from '../discovery';
import type { Env } from '@authrim/ar-lib-core/types/env';
import type { OIDCProviderMetadata } from '@authrim/ar-lib-core/types/oidc';
import { clearNativeSSOConfigCache, LOGOUT_SETTINGS_KEY } from '@authrim/ar-lib-core';

/**
 * Create a mock environment for testing
 */
function createMockEnv(): Env {
  return {
    ISSUER_URL: 'https://test.example.com',
    ACCESS_TOKEN_EXPIRY: '3600',
    AUTH_CODE_EXPIRY: '600',
    STATE_EXPIRY: '600',
    NONCE_EXPIRY: '600',
    PRIVATE_KEY_PEM: 'test-key',
    KEY_ID: 'test-kid',
  } as Env;
}

describe('Discovery Handler', () => {
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    clearNativeSSOConfigCache();
    app = new Hono<{ Bindings: Env }>();
    app.get('/.well-known/openid-configuration', discoveryHandler);
  });

  describe('OpenID Connect Discovery Endpoint', () => {
    it('should return valid OIDC metadata', async () => {
      const env = createMockEnv();
      const response = await app.request(
        '/.well-known/openid-configuration',
        {
          method: 'GET',
        },
        env
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('application/json');

      const metadata = (await response.json()) as OIDCProviderMetadata;

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

      const response = await app.request(
        '/.well-known/openid-configuration',
        {
          method: 'GET',
        },
        env
      );

      const metadata = (await response.json()) as OIDCProviderMetadata;
      expect(metadata.issuer).toBe('https://custom.example.com');
      expect(metadata.authorization_endpoint).toBe('https://custom.example.com/authorize');
      expect(metadata.token_endpoint).toBe('https://custom.example.com/token');
      expect(metadata.userinfo_endpoint).toBe('https://custom.example.com/userinfo');
      expect(metadata.jwks_uri).toBe('https://custom.example.com/.well-known/jwks.json');
    });

    it('uses the request host as issuer in multi-tenant mode', async () => {
      const env = {
        ...createMockEnv(),
        BASE_DOMAIN: 'example.com',
        DEFAULT_TENANT_ID: 'tenant1',
      } as Env;
      const localApp = new Hono<{ Bindings: Env }>();
      localApp.use('*', async (c, next) => {
        (c as any).set('tenantId', 'tenant1');
        await next();
      });
      localApp.get('/.well-known/openid-configuration', discoveryHandler);

      const response = await localApp.fetch(
        new Request('https://tenant1.example.com/.well-known/openid-configuration'),
        env
      );

      const metadata = (await response.json()) as OIDCProviderMetadata;
      expect(metadata.issuer).toBe('https://tenant1.example.com');
      expect(metadata.token_endpoint).toBe('https://tenant1.example.com/token');
    });

    it('should return correct response types', async () => {
      const env = createMockEnv();
      const response = await app.request(
        '/.well-known/openid-configuration',
        {
          method: 'GET',
        },
        env
      );

      const metadata = (await response.json()) as OIDCProviderMetadata;
      expect(metadata.response_types_supported).toEqual([
        'code',
        'id_token',
        'id_token token',
        'code id_token',
        'code token',
        'code id_token token',
        'none',
      ]);
    });

    it('should return correct grant types', async () => {
      const env = createMockEnv();
      const response = await app.request(
        '/.well-known/openid-configuration',
        {
          method: 'GET',
        },
        env
      );

      const metadata = (await response.json()) as OIDCProviderMetadata;
      // Dynamic grant types include multiple grant types
      expect(metadata.grant_types_supported).toContain('authorization_code');
      expect(metadata.grant_types_supported).toContain('refresh_token');
      expect(metadata.grant_types_supported).toContain(
        'urn:ietf:params:oauth:grant-type:jwt-bearer'
      );
      expect(metadata.grant_types_supported).toContain(
        'urn:ietf:params:oauth:grant-type:device_code'
      );
      expect(metadata.grant_types_supported).toContain('urn:openid:params:grant-type:ciba');
    });

    it('should support RS256 signing algorithm', async () => {
      const env = createMockEnv();
      const response = await app.request(
        '/.well-known/openid-configuration',
        {
          method: 'GET',
        },
        env
      );

      const metadata = (await response.json()) as OIDCProviderMetadata;
      expect(metadata.id_token_signing_alg_values_supported).toEqual(['RS256']);
    });

    it('should support public and pairwise subject types', async () => {
      const env = createMockEnv();
      const response = await app.request(
        '/.well-known/openid-configuration',
        {
          method: 'GET',
        },
        env
      );

      const metadata = (await response.json()) as OIDCProviderMetadata;
      expect(metadata.subject_types_supported).toEqual(['public', 'pairwise']);
    });

    it('should include standard OIDC scopes', async () => {
      const env = createMockEnv();
      const response = await app.request(
        '/.well-known/openid-configuration',
        {
          method: 'GET',
        },
        env
      );

      const metadata = (await response.json()) as OIDCProviderMetadata;
      expect(metadata.scopes_supported).toContain('openid');
      expect(metadata.scopes_supported).toContain('profile');
      expect(metadata.scopes_supported).toContain('email');
    });

    it('should include standard OIDC claims', async () => {
      const env = createMockEnv();
      const response = await app.request(
        '/.well-known/openid-configuration',
        {
          method: 'GET',
        },
        env
      );

      const metadata = (await response.json()) as OIDCProviderMetadata;
      expect(metadata.claims_supported).toContain('sub');
      expect(metadata.claims_supported).toContain('iss');
      expect(metadata.claims_supported).toContain('aud');
      expect(metadata.claims_supported).toContain('exp');
      expect(metadata.claims_supported).toContain('iat');
      expect(metadata.claims_supported).toContain('name');
      expect(metadata.claims_supported).toContain('email');
    });

    it('should expose only the canonical Native SSO discovery field when enabled', async () => {
      const env = {
        ...createMockEnv(),
        NATIVE_SSO_ENABLED: 'true',
      } as Env;

      const response = await app.request(
        '/.well-known/openid-configuration',
        {
          method: 'GET',
        },
        env
      );

      const metadata = (await response.json()) as OIDCProviderMetadata & Record<string, unknown>;
      expect(metadata.native_sso_supported).toBe(true);
      expect(metadata.native_sso_token_exchange_supported).toBeUndefined();
      expect(metadata.native_sso_device_secret_supported).toBeUndefined();
    });

    it('should support multiple token endpoint auth methods', async () => {
      const env = createMockEnv();
      const response = await app.request(
        '/.well-known/openid-configuration',
        {
          method: 'GET',
        },
        env
      );

      const metadata = (await response.json()) as OIDCProviderMetadata;
      expect(metadata.token_endpoint_auth_methods_supported).toContain('client_secret_post');
      expect(metadata.token_endpoint_auth_methods_supported).toContain('client_secret_basic');
      expect(metadata.token_endpoint_auth_methods_supported).toContain('none');
    });
  });

  describe('Cache Headers', () => {
    it('should include Cache-Control header', async () => {
      const env = createMockEnv();
      const response = await app.request(
        '/.well-known/openid-configuration',
        {
          method: 'GET',
        },
        env
      );

      const cacheControl = response.headers.get('Cache-Control');
      expect(cacheControl).toBeDefined();
      expect(cacheControl).toContain('public');
      // Reduced to 300 seconds (5 minutes) for dynamic configuration
      expect(cacheControl).toContain('max-age=300');
    });

    it('should include Vary header', async () => {
      const env = createMockEnv();
      const response = await app.request(
        '/.well-known/openid-configuration',
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

  describe('OIDC Compliance', () => {
    it('should have matching issuer in all endpoint URLs', async () => {
      const env = createMockEnv();
      const response = await app.request(
        '/.well-known/openid-configuration',
        {
          method: 'GET',
        },
        env
      );

      const metadata = (await response.json()) as OIDCProviderMetadata;
      const issuer = metadata.issuer;

      expect(metadata.authorization_endpoint).toMatch(new RegExp(`^${issuer}`));
      expect(metadata.token_endpoint).toMatch(new RegExp(`^${issuer}`));
      expect(metadata.userinfo_endpoint).toMatch(new RegExp(`^${issuer}`));
      expect(metadata.jwks_uri).toMatch(new RegExp(`^${issuer}`));
    });

    it('should return proper JSON content type', async () => {
      const env = createMockEnv();
      const response = await app.request(
        '/.well-known/openid-configuration',
        {
          method: 'GET',
        },
        env
      );

      expect(response.headers.get('Content-Type')).toContain('application/json');
    });

    it('should return 200 OK status', async () => {
      const env = createMockEnv();
      const response = await app.request(
        '/.well-known/openid-configuration',
        {
          method: 'GET',
        },
        env
      );

      expect(response.status).toBe(200);
    });
  });

  describe('Logout Metadata', () => {
    it('should include end_session_endpoint (RP-Initiated Logout)', async () => {
      const env = createMockEnv();
      const response = await app.request(
        '/.well-known/openid-configuration',
        {
          method: 'GET',
        },
        env
      );

      const metadata = (await response.json()) as OIDCProviderMetadata;
      expect(metadata.end_session_endpoint).toBe('https://test.example.com/logout');
    });

    it('should include frontchannel_logout_supported', async () => {
      const env = createMockEnv();
      const response = await app.request(
        '/.well-known/openid-configuration',
        {
          method: 'GET',
        },
        env
      );

      const metadata = (await response.json()) as OIDCProviderMetadata;
      // Default is enabled (from DEFAULT_LOGOUT_CONFIG)
      expect(metadata).toHaveProperty('frontchannel_logout_supported');
      expect(metadata).toHaveProperty('frontchannel_logout_session_supported');
    });

    it('should include backchannel_logout_supported', async () => {
      const env = createMockEnv();
      const response = await app.request(
        '/.well-known/openid-configuration',
        {
          method: 'GET',
        },
        env
      );

      const metadata = (await response.json()) as OIDCProviderMetadata;
      // Default is enabled (from DEFAULT_LOGOUT_CONFIG)
      expect(metadata).toHaveProperty('backchannel_logout_supported');
      expect(metadata).toHaveProperty('backchannel_logout_session_supported');
    });

    it('should respect logout configuration from KV', async () => {
      const env = createMockEnv();
      // Mock SETTINGS KV with logout config
      env.SETTINGS = {
        get: async (key: string) => {
          if (key === LOGOUT_SETTINGS_KEY) {
            return JSON.stringify({
              frontchannel: { enabled: false },
              backchannel: { enabled: true },
              session_management: { enabled: true, check_session_iframe_enabled: true },
            });
          }
          return null;
        },
      } as unknown as KVNamespace;

      const response = await app.request(
        '/.well-known/openid-configuration',
        {
          method: 'GET',
        },
        env
      );

      const metadata = (await response.json()) as OIDCProviderMetadata;

      // Frontchannel disabled
      expect(metadata.frontchannel_logout_supported).toBe(false);
      expect(metadata.frontchannel_logout_session_supported).toBe(false);

      // Backchannel enabled
      expect(metadata.backchannel_logout_supported).toBe(true);
      expect(metadata.backchannel_logout_session_supported).toBe(true);

      // Session management enabled
      expect(metadata.check_session_iframe).toBe('https://test.example.com/session/check');
    });

    it('should not include check_session_iframe when session management is disabled', async () => {
      const env = createMockEnv();
      // Mock SETTINGS KV with session management disabled
      env.SETTINGS = {
        get: async (key: string) => {
          if (key === LOGOUT_SETTINGS_KEY) {
            return JSON.stringify({
              frontchannel: { enabled: true },
              backchannel: { enabled: true },
              session_management: { enabled: false },
            });
          }
          return null;
        },
      } as unknown as KVNamespace;

      const response = await app.request(
        '/.well-known/openid-configuration',
        {
          method: 'GET',
        },
        env
      );

      const metadata = (await response.json()) as OIDCProviderMetadata;

      // Session management disabled - no check_session_iframe
      expect(metadata.check_session_iframe).toBeUndefined();
    });
  });

  describe('Optional component metadata', () => {
    it('omits async endpoints and grant types when async is disabled', async () => {
      const env = createMockEnv();
      (env as typeof env & { ASYNC_ENABLED?: string }).ASYNC_ENABLED = 'false';

      const response = await app.request(
        '/.well-known/openid-configuration',
        {
          method: 'GET',
        },
        env
      );

      const metadata = (await response.json()) as OIDCProviderMetadata;
      expect(metadata.device_authorization_endpoint).toBeUndefined();
      expect(metadata.backchannel_authentication_endpoint).toBeUndefined();
      expect(metadata.backchannel_token_delivery_modes_supported).toBeUndefined();
      expect(metadata.grant_types_supported).not.toContain(
        'urn:ietf:params:oauth:grant-type:device_code'
      );
      expect(metadata.grant_types_supported).not.toContain('urn:openid:params:grant-type:ciba');
    });
  });
});
