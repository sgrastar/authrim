import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { clearDiscoveryMetadataCache, discoveryHandler } from '../discovery';
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
    PUBLIC_JWK_JSON: JSON.stringify({
      kty: 'RSA',
      use: 'sig',
      alg: 'RS256',
      kid: 'test-kid',
      n: 'test-modulus',
      e: 'AQAB',
    }),
  } as Env;
}

function createTenantApp(tenantId: string): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    (c as { set: (key: string, value: string) => void }).set('tenantId', tenantId);
    await next();
  });
  app.get('/.well-known/openid-configuration', discoveryHandler);
  return app;
}

async function fetchDiscoveryMetadata(
  tenantId: string,
  requestUrl: string,
  env: Env
): Promise<OIDCProviderMetadata> {
  const response = await createTenantApp(tenantId).fetch(new Request(requestUrl), env);
  expect(response.status).toBe(200);
  return (await response.json()) as OIDCProviderMetadata;
}

function expectIssuerBoundMetadata(metadata: OIDCProviderMetadata, issuer: string): void {
  expect(metadata.issuer).toBe(issuer);
  expect(metadata.authorization_endpoint).toBe(`${issuer}/authorize`);
  expect(metadata.token_endpoint).toBe(`${issuer}/token`);
  expect(metadata.userinfo_endpoint).toBe(`${issuer}/userinfo`);
  expect(metadata.jwks_uri).toBe(`${issuer}/.well-known/jwks.json`);
  expect(metadata.registration_endpoint).toBe(`${issuer}/register`);
  expect(metadata.introspection_endpoint).toBe(`${issuer}/introspect`);
  expect(metadata.revocation_endpoint).toBe(`${issuer}/revoke`);
  expect(metadata.pushed_authorization_request_endpoint).toBe(`${issuer}/par`);
  expect(metadata.end_session_endpoint).toBe(`${issuer}/logout`);
}

function createMockKV(options: {
  get?: (key: string, init?: unknown) => Promise<unknown>;
  put?: (key: string, value: string, init?: unknown) => Promise<void>;
}): KVNamespace & {
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn(options.get ?? (async () => null)),
    put: vi.fn(options.put ?? (async () => undefined)),
  } as unknown as KVNamespace & {
    get: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
  };
}

describe('Discovery Handler', () => {
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    clearDiscoveryMetadataCache();
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
      expect(metadata.authorization_response_iss_parameter_supported).toBe(true);
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

    describe('issuer domain matrix', () => {
      it('uses the configured ISSUER_URL in single-tenant mode', async () => {
        const env = {
          ...createMockEnv(),
          ISSUER_URL: 'https://auth.single.example.com',
        } as Env;

        const metadata = await fetchDiscoveryMetadata(
          'default',
          'https://tenant-a.example.com/.well-known/openid-configuration',
          env
        );

        expectIssuerBoundMetadata(metadata, 'https://auth.single.example.com');
      });

      it('uses each tenant subdomain as issuer in multi-tenant mode', async () => {
        const env = {
          ...createMockEnv(),
          BASE_DOMAIN: 'example.com',
          DEFAULT_TENANT_ID: 'default',
        } as Env;

        const tenantA = await fetchDiscoveryMetadata(
          'tenant-a',
          'https://tenant-a.example.com/.well-known/openid-configuration',
          env
        );
        const tenantB = await fetchDiscoveryMetadata(
          'tenant-b',
          'https://tenant-b.example.com/.well-known/openid-configuration',
          env
        );

        expectIssuerBoundMetadata(tenantA, 'https://tenant-a.example.com');
        expectIssuerBoundMetadata(tenantB, 'https://tenant-b.example.com');
      });

      it('keeps the primary/default tenant on a subdomain when naked-domain issuer is disabled', async () => {
        const env = {
          ...createMockEnv(),
          BASE_DOMAIN: 'example.com',
          DEFAULT_TENANT_ID: 'first',
        } as Env;

        const metadata = await fetchDiscoveryMetadata(
          'first',
          'https://first.example.com/.well-known/openid-configuration',
          env
        );

        expectIssuerBoundMetadata(metadata, 'https://first.example.com');
      });

      it('uses the naked domain for the default tenant when naked-domain issuer is enabled', async () => {
        const env = {
          ...createMockEnv(),
          BASE_DOMAIN: 'example.com',
          DEFAULT_TENANT_ID: 'first',
          NAKED_DOMAIN_AS_ISSUER: 'true',
        } as Env;

        const metadata = await fetchDiscoveryMetadata(
          'first',
          'https://example.com/.well-known/openid-configuration',
          env
        );

        expectIssuerBoundMetadata(metadata, 'https://example.com');
      });

      it('uses PRIMARY_TENANT_ID for naked-domain issuer selection', async () => {
        const env = {
          ...createMockEnv(),
          BASE_DOMAIN: 'example.com',
          DEFAULT_TENANT_ID: 'default',
          PRIMARY_TENANT_ID: 'first',
          NAKED_DOMAIN_AS_ISSUER: 'true',
        } as Env;

        const metadata = await fetchDiscoveryMetadata(
          'first',
          'https://example.com/.well-known/openid-configuration',
          env
        );

        expectIssuerBoundMetadata(metadata, 'https://example.com');
      });

      it('keeps non-primary tenants on subdomain issuers even when naked-domain issuer is enabled', async () => {
        const env = {
          ...createMockEnv(),
          BASE_DOMAIN: 'example.com',
          DEFAULT_TENANT_ID: 'default',
          PRIMARY_TENANT_ID: 'first',
          NAKED_DOMAIN_AS_ISSUER: 'true',
        } as Env;

        const metadata = await fetchDiscoveryMetadata(
          'tenant-b',
          'https://tenant-b.example.com/.well-known/openid-configuration',
          env
        );

        expectIssuerBoundMetadata(metadata, 'https://tenant-b.example.com');
      });
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
      expect(metadata.token_endpoint_auth_signing_alg_values_supported).toEqual([
        'RS256',
        'ES256',
        'PS256',
        'EdDSA',
      ]);
    });

    it('advertises ES256 only when a purpose-compatible key is published', async () => {
      const env = createMockEnv();
      env.KEY_MANAGER_PUBLIC = {
        getAllPublicKeys: vi.fn().mockResolvedValue([
          JSON.parse(env.PUBLIC_JWK_JSON!) as JsonWebKey,
          {
            kty: 'EC',
            use: 'sig',
            alg: 'ES256',
            kid: 'oidc-es256-test',
            crv: 'P-256',
            x: 'test-x',
            y: 'test-y',
          },
        ]),
      } as Env['KEY_MANAGER_PUBLIC'];

      const response = await app.request(
        '/.well-known/openid-configuration',
        { method: 'GET' },
        env
      );
      const metadata = (await response.json()) as OIDCProviderMetadata;

      expect(metadata.id_token_signing_alg_values_supported).toEqual(['RS256', 'ES256']);
      expect(metadata.userinfo_signing_alg_values_supported).toEqual(['RS256', 'ES256']);
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
      expect(metadata.claims_supported).toContain('auth_time');
      expect(metadata.claims_supported).toContain('acr');
      expect(metadata.claims_supported).toContain('amr');
      expect(metadata.claims_supported).toContain('name');
      expect(metadata.claims_supported).toContain('email');
    });

    it('should advertise implemented ASC capabilities', async () => {
      const env = createMockEnv();
      const response = await app.request(
        '/.well-known/openid-configuration',
        {
          method: 'GET',
        },
        env
      );

      const metadata = (await response.json()) as OIDCProviderMetadata;
      expect(metadata.selective_abort_omit_supported).toBe(true);
      expect(metadata.selective_abort_omit_schema_supported).toBe(false);
      expect(metadata.transformed_claims_functions_supported).toContain('years_ago');
      expect(metadata.transformed_claims_max_count).toBe(0);
      expect(metadata.transformed_claims_predefined).toHaveProperty('age_over_18');
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

    it('should expose Phase 1 DPoP signing algorithms', async () => {
      const env = createMockEnv();
      const response = await app.request(
        '/.well-known/openid-configuration',
        {
          method: 'GET',
        },
        env
      );

      const metadata = (await response.json()) as OIDCProviderMetadata;
      expect(metadata.dpop_signing_alg_values_supported).toEqual(['ES256', 'PS256', 'EdDSA']);
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
      expect(metadata.token_endpoint_auth_methods_supported).toContain('private_key_jwt');
      expect(metadata.token_endpoint_auth_methods_supported).not.toContain('client_secret_jwt');
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

    it('serves metadata from AUTHRIM_CONFIG discovery cache when present', async () => {
      const cachedMetadata = {
        issuer: 'https://cached.example.com',
        authorization_endpoint: 'https://cached.example.com/authorize',
        token_endpoint: 'https://cached.example.com/token',
        userinfo_endpoint: 'https://cached.example.com/userinfo',
        jwks_uri: 'https://cached.example.com/.well-known/jwks.json',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        id_token_signing_alg_values_supported: ['RS256'],
        subject_types_supported: ['public'],
        scopes_supported: ['openid'],
        claims_supported: ['sub'],
        token_endpoint_auth_methods_supported: ['private_key_jwt'],
      } as OIDCProviderMetadata;
      const authrimConfig = createMockKV({
        get: async (key: string) => {
          if (key.startsWith('v1:discovery:')) {
            return cachedMetadata;
          }
          return null;
        },
      });
      const env = {
        ...createMockEnv(),
        AUTHRIM_CONFIG: authrimConfig,
      } as Env;

      const response = await app.request(
        '/.well-known/openid-configuration',
        {
          method: 'GET',
        },
        env
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('X-Discovery-Cache')).toBe('HIT');
      expect(response.headers.get('Cache-Control')).toContain('max-age=300');
      await expect(response.json()).resolves.toEqual(cachedMetadata);
      expect(
        authrimConfig.put.mock.calls.some(([key]) => String(key).startsWith('v1:discovery:'))
      ).toBe(false);
    });

    it('returns fresh metadata when AUTHRIM_CONFIG cache write fails', async () => {
      const authrimConfig = createMockKV({
        put: async () => {
          throw new Error('kv write unavailable');
        },
      });
      const env = {
        ...createMockEnv(),
        AUTHRIM_CONFIG: authrimConfig,
      } as Env;

      const response = await app.request(
        '/.well-known/openid-configuration',
        {
          method: 'GET',
        },
        env
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('X-Discovery-Cache')).toBe('MISS');
      const metadata = (await response.json()) as OIDCProviderMetadata;
      expectIssuerBoundMetadata(metadata, 'https://test.example.com');
      expect(authrimConfig.put).toHaveBeenCalledWith(
        expect.stringMatching(/^v1:discovery:/),
        expect.any(String),
        expect.objectContaining({ expirationTtl: 300 })
      );
    });

    it('returns fresh metadata when AUTHRIM_CONFIG discovery cache read fails', async () => {
      const authrimConfig = createMockKV({
        get: async (key: string) => {
          if (key.startsWith('v1:discovery:')) {
            throw new Error('kv read unavailable');
          }
          return null;
        },
      });
      const env = {
        ...createMockEnv(),
        AUTHRIM_CONFIG: authrimConfig,
      } as Env;

      const response = await app.request(
        '/.well-known/openid-configuration',
        {
          method: 'GET',
        },
        env
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('X-Discovery-Cache')).toBe('MISS');
      const metadata = (await response.json()) as OIDCProviderMetadata;
      expectIssuerBoundMetadata(metadata, 'https://test.example.com');
      expect(authrimConfig.put).toHaveBeenCalledWith(
        expect.stringMatching(/^v1:discovery:/),
        expect.any(String),
        expect.objectContaining({ expirationTtl: 300 })
      );
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
