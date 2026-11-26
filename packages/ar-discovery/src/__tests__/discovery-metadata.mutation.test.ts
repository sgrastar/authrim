import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  ALLOWED_DPOP_ALGS,
  CLIENT_ASSERTION_SIGNING_ALGS,
  FAPI2_MESSAGE_SIGNING_ALGS,
  PREDEFINED_TRANSFORMED_CLAIMS,
  REQUEST_OBJECT_ENCRYPTION_ALGS,
  REQUEST_OBJECT_ENCRYPTION_ENCS,
  SUPPORTED_JWE_ALG,
  SUPPORTED_JWE_ENC,
  clearNativeSSOConfigCache,
  type Env,
  type OIDCProviderMetadata,
} from '@authrim/ar-lib-core';
import { systemSettingsPlatformDocuments } from '@authrim/ar-lib-core/utils/system-settings-fields';
import { clearDiscoveryMetadataCache, discoveryHandler } from '../discovery';

const ISSUER = 'https://test.example.com';
const URL = `${ISSUER}/.well-known/openid-configuration`;
const RSA_JWK = {
  kty: 'RSA',
  use: 'sig',
  alg: 'RS256',
  kid: 'test-kid',
  n: 'test-modulus',
  e: 'AQAB',
};

type Documents = Record<string, unknown>;

function kv(documents: Documents = {}): KVNamespace {
  return {
    get: async (key: string) => (key in documents ? JSON.stringify(documents[key]) : null),
  } as unknown as KVNamespace;
}

/** Platform-scope Settings API documents for an older `system_settings`-shaped document. */
function platform(document: Record<string, unknown>): Documents {
  return systemSettingsPlatformDocuments(document);
}

function env(extra: Record<string, unknown> = {}, documents?: Documents): Env {
  return {
    ISSUER_URL: ISSUER,
    PUBLIC_JWK_JSON: JSON.stringify(RSA_JWK),
    ...(documents ? { SETTINGS: kv(documents) } : {}),
    ...extra,
  } as unknown as Env;
}

function app(): Hono<{ Bindings: Env }> {
  const instance = new Hono<{ Bindings: Env }>();
  instance.use('*', async (c, next) => {
    (c as unknown as { set: (key: string, value: string) => void }).set('tenantId', 'default');
    await next();
  });
  instance.get('/.well-known/openid-configuration', discoveryHandler);
  return instance;
}

type Metadata = OIDCProviderMetadata & Record<string, unknown>;

async function fetchMetadata(environment: Env): Promise<Metadata> {
  const response = await app().fetch(new Request(URL), environment);
  expect(response.status).toBe(200);
  return response.json<Metadata>();
}

describe('discovery metadata (exact values)', () => {
  beforeEach(() => {
    clearDiscoveryMetadataCache();
    clearNativeSSOConfigCache();
  });

  it('publishes the complete default metadata document', async () => {
    const metadata = await fetchMetadata(env());
    expect(metadata).toEqual({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      userinfo_endpoint: `${ISSUER}/userinfo`,
      jwks_uri: `${ISSUER}/.well-known/jwks.json`,
      registration_endpoint: `${ISSUER}/register`,
      introspection_endpoint: `${ISSUER}/introspect`,
      revocation_endpoint: `${ISSUER}/revoke`,
      pushed_authorization_request_endpoint: `${ISSUER}/par`,
      require_pushed_authorization_requests: false,
      authorization_response_iss_parameter_supported: true,
      device_authorization_endpoint: `${ISSUER}/device_authorization`,
      backchannel_authentication_endpoint: `${ISSUER}/bc-authorize`,
      backchannel_token_delivery_modes_supported: ['poll', 'ping', 'push'],
      backchannel_authentication_request_signing_alg_values_supported: ['RS256', 'ES256', 'PS256'],
      backchannel_user_code_parameter_supported: false,
      tls_client_certificate_bound_access_tokens: true,
      response_types_supported: [
        'code',
        'id_token',
        'id_token token',
        'code id_token',
        'code token',
        'code id_token token',
        'none',
      ],
      grant_types_supported: [
        'authorization_code',
        'refresh_token',
        'implicit',
        'urn:ietf:params:oauth:grant-type:jwt-bearer',
        'urn:ietf:params:oauth:grant-type:device_code',
        'urn:openid:params:grant-type:ciba',
      ],
      id_token_signing_alg_values_supported: ['RS256'],
      subject_types_supported: ['public', 'pairwise'],
      scopes_supported: [
        'openid',
        'account:lifecycle:read',
        'profile',
        'email',
        'address',
        'phone',
        'offline_access',
      ],
      claims_supported: [
        'authrim_account_lifecycle',
        'sub',
        'iss',
        'aud',
        'exp',
        'iat',
        'nonce',
        'at_hash',
        'auth_time',
        'acr',
        'amr',
        'ds_hash',
        'name',
        'family_name',
        'given_name',
        'middle_name',
        'nickname',
        'preferred_username',
        'profile',
        'picture',
        'website',
        'gender',
        'birthdate',
        'zoneinfo',
        'locale',
        'updated_at',
        'email',
        'email_verified',
        'address',
        'phone_number',
        'phone_number_verified',
      ],
      token_endpoint_auth_methods_supported: [
        'client_secret_basic',
        'client_secret_post',
        'private_key_jwt',
        'none',
      ],
      token_endpoint_auth_signing_alg_values_supported: [...CLIENT_ASSERTION_SIGNING_ALGS],
      code_challenge_methods_supported: ['S256'],
      dpop_signing_alg_values_supported: [...ALLOWED_DPOP_ALGS],
      request_parameter_supported: true,
      request_uri_parameter_supported: true,
      request_object_signing_alg_values_supported: ['RS256'],
      request_object_encryption_alg_values_supported: [...REQUEST_OBJECT_ENCRYPTION_ALGS],
      request_object_encryption_enc_values_supported: [...REQUEST_OBJECT_ENCRYPTION_ENCS],
      response_modes_supported: [
        'query',
        'fragment',
        'form_post',
        'query.jwt',
        'fragment.jwt',
        'form_post.jwt',
        'jwt',
      ],
      authorization_signing_alg_values_supported: ['RS256'],
      authorization_encryption_alg_values_supported: [...SUPPORTED_JWE_ALG],
      authorization_encryption_enc_values_supported: [...SUPPORTED_JWE_ENC],
      id_token_encryption_alg_values_supported: [...SUPPORTED_JWE_ALG],
      id_token_encryption_enc_values_supported: [...SUPPORTED_JWE_ENC],
      userinfo_encryption_alg_values_supported: [...SUPPORTED_JWE_ALG],
      userinfo_encryption_enc_values_supported: [...SUPPORTED_JWE_ENC],
      userinfo_signing_alg_values_supported: ['RS256'],
      claim_types_supported: ['normal'],
      claims_parameter_supported: true,
      selective_abort_omit_supported: true,
      selective_abort_omit_schema_supported: false,
      transformed_claims_functions_supported: [
        'years_ago',
        'gte',
        'domain',
        'phone_country_code',
        'country',
      ],
      transformed_claims_predefined: PREDEFINED_TRANSFORMED_CLAIMS,
      transformed_claims_max_depth: 2,
      transformed_claims_max_count: 0,
      acr_values_supported: ['urn:mace:incommon:iap:silver', 'urn:mace:incommon:iap:bronze'],
      service_documentation: `${ISSUER}/docs`,
      ui_locales_supported: ['en', 'ja'],
      claims_locales_supported: ['en', 'ja'],
      display_values_supported: ['page', 'popup'],
      end_session_endpoint: `${ISSUER}/logout`,
      frontchannel_logout_supported: true,
      frontchannel_logout_session_supported: true,
      backchannel_logout_supported: true,
      backchannel_logout_session_supported: true,
      check_session_iframe: `${ISSUER}/session/check`,
      native_sso_supported: true,
    });
  });

  it('leaves Native SSO out of the metadata while it is turned off', async () => {
    const metadata = await fetchMetadata(env({ NATIVE_SSO_ENABLED: 'false' }));
    expect(metadata).not.toHaveProperty('native_sso_supported');
    expect(metadata.claims_supported).not.toContain('ds_hash');
    expect(metadata.claims_supported).toContain('amr');
    expect(metadata.claims_supported).toContain('name');
  });

  it('lists exactly the grant types that apply when implicit and async flows are off', async () => {
    const metadata = await fetchMetadata(
      env({ ASYNC_ENABLED: 'false' }, platform({ oidc: { responseTypesSupported: ['code'] } }))
    );
    expect(metadata.grant_types_supported).toEqual([
      'authorization_code',
      'refresh_token',
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
    ]);
  });

  it.each([
    [['code token'], true],
    [['code id_token'], true],
    [['id_token'], true],
    [['token'], true],
    [['code', 'none'], false],
    [['code'], false],
  ])('advertises implicit for response types %j: %s', async (responseTypes, implicit) => {
    clearDiscoveryMetadataCache();
    const metadata = await fetchMetadata(
      env({}, platform({ oidc: { responseTypesSupported: responseTypes } }))
    );
    expect(metadata.grant_types_supported.includes('implicit')).toBe(implicit);
  });

  it('lists exactly the claims of the default set when Native SSO is off', async () => {
    const withSso = await fetchMetadata(env());
    clearDiscoveryMetadataCache();
    clearNativeSSOConfigCache();
    const withoutSso = await fetchMetadata(env({ NATIVE_SSO_ENABLED: 'false' }));
    expect(withoutSso.claims_supported).toEqual(
      withSso.claims_supported.filter((claim) => claim !== 'ds_hash')
    );
    expect(withoutSso.claims_supported).toHaveLength(withSso.claims_supported.length - 1);
  });

  it('ignores an acr value list that is not text', async () => {
    const metadata = await fetchMetadata(
      env({}, { 'settings:platform:discovery': { 'discovery.acr_values_supported': 123 } })
    );
    expect(metadata.acr_values_supported).toBeUndefined();
  });

  it('lists the AI scopes in order, and nothing of them when off', async () => {
    const on = await fetchMetadata(env({ ENABLE_AI_SCOPES: 'true' }));
    expect(on.scopes_supported).toEqual([
      'openid',
      'account:lifecycle:read',
      'profile',
      'email',
      'address',
      'phone',
      'offline_access',
      'ai:read',
      'ai:write',
      'ai:execute',
      'ai:admin',
    ]);
  });

  it('lists the RAR authorization details types in order when enabled', async () => {
    const metadata = await fetchMetadata(env({ ENABLE_RAR: 'true' }));
    expect(metadata.authorization_details_types_supported).toEqual([
      'ai_agent_action',
      'payment_initiation',
      'account_information',
    ]);
  });

  describe('Token Exchange, ID-JAG and Flow Engine', () => {
    const exchangeOn = { 'settings:platform:tokens': { 'tokens.exchange_enabled': true } };
    const idJagOn = { 'settings:platform:feature-flags': { 'feature.enable_id_jag': true } };

    it('advertises ID-JAG only while Token Exchange and the ID-JAG flag are both on', async () => {
      const both = await fetchMetadata(env({}, { ...exchangeOn, ...idJagOn }));
      expect(both.identity_chaining_requested_token_types_supported).toEqual([
        'urn:ietf:params:oauth:token-type:id-jag',
      ]);
      expect(both.id_jag_subject_token_types_supported).toEqual([
        'urn:ietf:params:oauth:token-type:id_token',
        'urn:ietf:params:oauth:token-type:jwt',
        'urn:ietf:params:oauth:token-type:saml2',
      ]);
      expect(both.grant_types_supported).toContain(
        'urn:ietf:params:oauth:grant-type:token-exchange'
      );
    });

    it('leaves ID-JAG out without the flag, or without Token Exchange', async () => {
      clearDiscoveryMetadataCache();
      const exchangeOnly = await fetchMetadata(env({}, exchangeOn));
      expect(exchangeOnly).not.toHaveProperty('identity_chaining_requested_token_types_supported');
      expect(exchangeOnly).not.toHaveProperty('id_jag_subject_token_types_supported');
      expect(exchangeOnly.grant_types_supported).toContain(
        'urn:ietf:params:oauth:grant-type:token-exchange'
      );

      clearDiscoveryMetadataCache();
      const flagOnly = await fetchMetadata(env({}, idJagOn));
      expect(flagOnly).not.toHaveProperty('identity_chaining_requested_token_types_supported');
      expect(flagOnly).not.toHaveProperty('id_jag_subject_token_types_supported');
      expect(flagOnly.grant_types_supported).not.toContain(
        'urn:ietf:params:oauth:grant-type:token-exchange'
      );
    });

    it('advertises the Flow Engine only while its flag is on', async () => {
      const off = await fetchMetadata(env());
      expect(off).not.toHaveProperty('flow_engine_supported');
      clearDiscoveryMetadataCache();
      const on = await fetchMetadata(
        env({}, { 'settings:platform:feature-flags': { 'feature.enable_flow_engine': true } })
      );
      expect(on.flow_engine_supported).toBe(true);
    });
  });

  describe('request object and authorization signing', () => {
    const keyManager = {
      getAllPublicKeys: vi.fn(async () => [
        RSA_JWK,
        { kty: 'EC', use: 'sig', alg: 'ES256', kid: 'ec-key', crv: 'P-256', x: 'x', y: 'y' },
      ]),
    };

    it('offers RS256 and none for request objects when the unsigned algorithm is allowed', async () => {
      const metadata = await fetchMetadata(
        env({}, platform({ oidc: { allowNoneAlgorithm: true } }))
      );
      expect(metadata.request_object_signing_alg_values_supported).toEqual(['RS256', 'none']);
    });

    it('offers the FAPI 2.0 Message Signing algorithms when none are configured', async () => {
      const metadata = await fetchMetadata(
        env(
          { KEY_MANAGER_PUBLIC: keyManager },
          platform({
            fapi: { enabled: true, messageSigning: { enabled: true } },
            oidc: { allowNoneAlgorithm: true },
          })
        )
      );
      expect(metadata.request_object_signing_alg_values_supported).toEqual([
        ...FAPI2_MESSAGE_SIGNING_ALGS,
      ]);
      expect(metadata.authorization_signing_alg_values_supported).toEqual(['ES256']);
      expect(metadata.token_endpoint_auth_signing_alg_values_supported).toEqual([
        ...FAPI2_MESSAGE_SIGNING_ALGS,
      ]);
    });

    it('keeps only the authorization signing algorithms that have a published key', async () => {
      const metadata = await fetchMetadata(
        env(
          { KEY_MANAGER_PUBLIC: keyManager },
          platform({
            fapi: {
              enabled: true,
              messageSigning: {
                enabled: true,
                authorizationSigningAlgorithms: ['ES256', 'PS256', 'RS256'],
              },
            },
          })
        )
      );
      expect(metadata.authorization_signing_alg_values_supported).toEqual(['ES256', 'RS256']);
    });
  });

  describe('token endpoint authentication methods', () => {
    it('does not list attest_jwt_client_auth unless a wallet is allowlisted', async () => {
      const metadata = await fetchMetadata(
        env(
          {},
          {
            'settings:platform:oauth': {
              'oauth.token_endpoint_auth_methods_supported': [
                'client_secret_basic',
                'attest_jwt_client_auth',
                'none',
              ],
            },
          }
        )
      );
      expect(metadata.token_endpoint_auth_methods_supported).toEqual([
        'client_secret_basic',
        'none',
      ]);
    });
  });

  describe('caching and failures', () => {
    it('serves a repeated request from memory with the plain cache headers', async () => {
      const environment = env();
      const first = await app().fetch(new Request(URL), environment);
      expect(first.headers.get('X-Discovery-Cache')).toBe('MISS');
      expect(first.headers.get('Cache-Control')).toMatch(/^public, max-age=\d+$/u);
      expect(first.headers.get('Vary')).toBe('Accept-Encoding, Host');

      const second = await app().fetch(new Request(URL), environment);
      expect(second.status).toBe(200);
      expect(second.headers.get('Cache-Control')).toBe('public, max-age=300');
      expect(second.headers.get('Vary')).toBe('Accept-Encoding, Host');
      expect(second.headers.get('X-Discovery-Cache')).toBeNull();
      await expect(second.json()).resolves.toEqual(await first.json());
    });

    it('labels a metadata document found in the KV cache', async () => {
      const cached = { issuer: ISSUER, marker: 'from-kv' };
      const response = await app().fetch(
        new Request(URL),
        env({
          AUTHRIM_CONFIG: {
            get: vi.fn(async (key: string) => (key.startsWith('v1:discovery:') ? cached : null)),
            put: vi.fn(),
          },
        })
      );
      expect(response.headers.get('X-Discovery-Cache')).toBe('HIT');
      expect(response.headers.get('Vary')).toBe('Accept-Encoding, Host');
      expect(response.headers.get('Cache-Control')).toMatch(/^public, max-age=\d+$/u);
      await expect(response.json()).resolves.toEqual(cached);
    });

    it('reports unreadable settings with the exact error', async () => {
      const response = await app().fetch(
        new Request(URL),
        env({ SETTINGS: { get: vi.fn().mockRejectedValue(new Error('KV down')) } })
      );
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: 'temporarily_unavailable',
        error_description: 'Security profile settings are temporarily unavailable',
      });
    });
  });
});
