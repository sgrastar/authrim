import type { Context } from 'hono';
import type { Env, OIDCProviderMetadata } from '@authrim/shared';
import { SUPPORTED_JWE_ALG, SUPPORTED_JWE_ENC, buildIssuerUrl } from '@authrim/shared';

// Cache for metadata to improve performance
let cachedMetadata: OIDCProviderMetadata | null = null;
let cachedSettingsHash: string | null = null;

/**
 * OpenID Connect Discovery Endpoint Handler
 * https://openid.net/specs/openid-connect-discovery-1_0.html
 *
 * Returns metadata about the OpenID Provider's configuration
 */
export async function discoveryHandler(c: Context<{ Bindings: Env }>) {
  // Use buildIssuerUrl for future multi-tenant support
  const issuer = buildIssuerUrl(c.env);

  // Load dynamic configuration from SETTINGS KV
  let oidcConfig: any = {};
  let fapiConfig: any = {};
  let currentSettingsJson = '';

  try {
    const settingsJson = await c.env.SETTINGS?.get('system_settings');
    currentSettingsJson = settingsJson || '';
    if (settingsJson) {
      const settings = JSON.parse(settingsJson);
      oidcConfig = settings.oidc || {};
      fapiConfig = settings.fapi || {};
    }
  } catch (error) {
    console.error('Failed to load settings from KV:', error);
    // Continue with default values
  }

  // Check if cached metadata is still valid
  const currentHash = `${issuer}:${currentSettingsJson}`;
  if (cachedMetadata && cachedSettingsHash === currentHash) {
    // Cache hit - return cached metadata
    c.header('Cache-Control', 'public, max-age=300');
    c.header('Vary', 'Accept-Encoding');
    return c.json(cachedMetadata);
  }

  // Determine PAR requirement (FAPI 2.0 mode or OIDC config)
  const requirePar = fapiConfig.enabled ? true : oidcConfig.requirePar || false;

  const metadata: OIDCProviderMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    userinfo_endpoint: `${issuer}/userinfo`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    registration_endpoint: `${issuer}/register`,
    // RFC 7662: Token Introspection endpoint
    introspection_endpoint: `${issuer}/introspect`,
    // RFC 7009: Token Revocation endpoint
    revocation_endpoint: `${issuer}/revoke`,
    // RFC 9126: PAR endpoint
    pushed_authorization_request_endpoint: `${issuer}/as/par`,
    // RFC 9126: PAR requirement (dynamic based on FAPI/OIDC config)
    require_pushed_authorization_requests: requirePar,
    // RFC 8628: Device Authorization endpoint
    device_authorization_endpoint: `${issuer}/device_authorization`,
    // OIDC CIBA: Backchannel Authentication endpoint
    backchannel_authentication_endpoint: `${issuer}/bc-authorize`,
    backchannel_token_delivery_modes_supported: ['poll', 'ping', 'push'],
    backchannel_authentication_request_signing_alg_values_supported: ['RS256', 'ES256'],
    backchannel_user_code_parameter_supported: true,
    // Dynamic OP certification requires all hybrid and implicit response types
    // Note: These are mandatory for Dynamic OP certification, not configurable
    response_types_supported: [
      'code',
      'id_token',
      'id_token token',
      'code id_token',
      'code token',
      'code id_token token',
    ],
    grant_types_supported: [
      'authorization_code',
      'refresh_token',
      'implicit', // Required for Dynamic OP certification (id_token/token response types)
      'urn:ietf:params:oauth:grant-type:jwt-bearer', // RFC 7523: JWT Bearer Flow
      'urn:ietf:params:oauth:grant-type:device_code', // RFC 8628: Device Authorization Grant
      'urn:openid:params:grant-type:ciba', // OIDC CIBA: Client Initiated Backchannel Authentication
    ],
    id_token_signing_alg_values_supported: ['RS256'],
    // OIDC Core 8: Both public and pairwise subject identifiers are supported
    subject_types_supported: ['public', 'pairwise'],
    scopes_supported: ['openid', 'profile', 'email', 'address', 'phone'],
    // Dynamic claims based on OIDC config
    claims_supported: oidcConfig.claimsSupported || [
      // Standard claims (always present)
      'sub',
      'iss',
      'aud',
      'exp',
      'iat',
      'nonce',
      'at_hash',
      'auth_time', // OIDC Core: Authentication timestamp
      'acr', // OIDC Core: Authentication Context Class Reference
      // Profile scope claims (OIDC Core 5.4)
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
      // Email scope claims
      'email',
      'email_verified',
      // Address scope claims
      'address',
      // Phone scope claims
      'phone_number',
      'phone_number_verified',
    ],
    // Dynamic token endpoint auth methods based on OIDC config
    token_endpoint_auth_methods_supported: oidcConfig.tokenEndpointAuthMethodsSupported || [
      'client_secret_basic',
      'client_secret_post',
      'client_secret_jwt',
      'private_key_jwt',
      'none',
    ],
    token_endpoint_auth_signing_alg_values_supported: ['RS256', 'ES256'],
    code_challenge_methods_supported: ['S256'],
    // RFC 9449: DPoP (Demonstrating Proof of Possession) support
    dpop_signing_alg_values_supported: ['RS256', 'ES256'],
    // RFC 9101 (JAR): Request Object support
    request_parameter_supported: true,
    request_uri_parameter_supported: true,
    request_object_signing_alg_values_supported: oidcConfig.allowNoneAlgorithm
      ? ['RS256', 'none']
      : ['RS256'],
    request_object_encryption_alg_values_supported: [...SUPPORTED_JWE_ALG],
    request_object_encryption_enc_values_supported: [...SUPPORTED_JWE_ENC],
    // JARM (JWT-Secured Authorization Response Mode) support
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
    // RFC 7516: JWE (JSON Web Encryption) support
    id_token_encryption_alg_values_supported: [...SUPPORTED_JWE_ALG],
    id_token_encryption_enc_values_supported: [...SUPPORTED_JWE_ENC],
    userinfo_encryption_alg_values_supported: [...SUPPORTED_JWE_ALG],
    userinfo_encryption_enc_values_supported: [...SUPPORTED_JWE_ENC],
    // UserInfo signing algorithm support (none = unsigned JSON, RS256 = signed JWT)
    userinfo_signing_alg_values_supported: ['none', 'RS256'],
    // OIDC Core: Additional metadata
    claim_types_supported: ['normal'],
    claims_parameter_supported: true,
    // ACR (Authentication Context Class Reference) support
    acr_values_supported: ['urn:mace:incommon:iap:silver', 'urn:mace:incommon:iap:bronze'],
    // OIDC Session Management 1.0
    check_session_iframe: `${issuer}/session/check`,
    // OIDC RP-Initiated Logout 1.0
    end_session_endpoint: `${issuer}/logout`,
    // OIDC Front-Channel Logout 1.0
    frontchannel_logout_supported: true,
    frontchannel_logout_session_supported: true,
    // OIDC Back-Channel Logout 1.0
    backchannel_logout_supported: true,
    backchannel_logout_session_supported: true,
  };

  // Update cache
  cachedMetadata = metadata;
  cachedSettingsHash = currentHash;

  // Add cache headers for better performance
  // Reduced from 3600 to 300 seconds (5 minutes) for dynamic configuration
  c.header('Cache-Control', 'public, max-age=300');
  c.header('Vary', 'Accept-Encoding');

  return c.json(metadata);
}
