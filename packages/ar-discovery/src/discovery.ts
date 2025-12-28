import type { Context } from 'hono';
import type { Env, OIDCProviderMetadata } from '@authrim/ar-lib-core';
import {
  SUPPORTED_JWE_ALG,
  SUPPORTED_JWE_ENC,
  buildIssuerUrl,
  DEFAULT_LOGOUT_CONFIG,
  LOGOUT_SETTINGS_KEY,
  getTenantIdFromContext,
  isNativeSSOEnabled,
  loadTenantProfile,
  filterGrantTypesByProfile,
} from '@authrim/ar-lib-core';
import type { LogoutConfig, TenantProfile } from '@authrim/ar-lib-core';

// Cache for metadata to improve performance
// Key: tenantId:settingsHash, Value: metadata
const metadataCache = new Map<string, OIDCProviderMetadata>();

/**
 * OpenID Connect Discovery Endpoint Handler
 * https://openid.net/specs/openid-connect-discovery-1_0.html
 *
 * Returns metadata about the OpenID Provider's configuration
 */
export async function discoveryHandler(c: Context<{ Bindings: Env }>) {
  // Get tenant ID from request context (set by requestContextMiddleware)
  const tenantId = getTenantIdFromContext(c);

  // Build issuer URL for this tenant
  const issuer = buildIssuerUrl(c.env, tenantId);

  // Load dynamic configuration from SETTINGS KV
  let oidcConfig: any = {};
  let fapiConfig: any = {};
  let logoutConfig: LogoutConfig = DEFAULT_LOGOUT_CONFIG;
  let currentSettingsJson = '';

  try {
    const settingsJson = await c.env.SETTINGS?.get('system_settings');
    currentSettingsJson = settingsJson || '';
    if (settingsJson) {
      const settings = JSON.parse(settingsJson);
      oidcConfig = settings.oidc || {};
      fapiConfig = settings.fapi || {};
    }

    // Load logout configuration
    const logoutSettingsJson = await c.env.SETTINGS?.get(LOGOUT_SETTINGS_KEY);
    if (logoutSettingsJson) {
      const parsed = JSON.parse(logoutSettingsJson);
      logoutConfig = {
        backchannel: { ...DEFAULT_LOGOUT_CONFIG.backchannel, ...(parsed.backchannel || {}) },
        frontchannel: { ...DEFAULT_LOGOUT_CONFIG.frontchannel, ...(parsed.frontchannel || {}) },
        session_management: {
          ...DEFAULT_LOGOUT_CONFIG.session_management,
          ...(parsed.session_management || {}),
        },
      };
    }
  } catch (error) {
    console.error('Failed to load settings from KV:', error);
    // Continue with default values
  }

  // HTTPS request_uri support status
  // Check SETTINGS KV first, then fall back to environment variable
  const httpsRequestUriEnabled =
    oidcConfig.httpsRequestUri?.enabled ?? c.env.ENABLE_HTTPS_REQUEST_URI === 'true';
  // request_uri is always supported (PAR), but HTTPS variant depends on config
  const requestUriSupported = true; // PAR always supported

  // RFC 8693 Token Exchange feature flag
  // Check SETTINGS KV first, then fall back to environment variable
  const tokenExchangeEnabled =
    oidcConfig.tokenExchange?.enabled ?? c.env.ENABLE_TOKEN_EXCHANGE === 'true';

  // RFC 6749 Section 4.4 Client Credentials feature flag
  // Check SETTINGS KV first, then fall back to environment variable
  const clientCredentialsEnabled =
    oidcConfig.clientCredentials?.enabled ?? c.env.ENABLE_CLIENT_CREDENTIALS === 'true';

  // OIDC Native SSO 1.0 (draft-07) feature flag
  // Check KV → env → default (using isNativeSSOEnabled from native-sso-config.ts)
  const nativeSSOEnabled = await isNativeSSOEnabled(c.env);

  // RFC 9396 Rich Authorization Requests (RAR) feature flag
  // Check SETTINGS KV first, then fall back to environment variable
  const rarEnabled = oidcConfig.rar?.enabled ?? c.env.ENABLE_RAR === 'true';

  // AI Ephemeral Auth scopes feature flag
  // Check SETTINGS KV first, then fall back to environment variable
  const aiScopesEnabled = oidcConfig.aiScopes?.enabled ?? c.env.ENABLE_AI_SCOPES === 'true';

  // Load TenantProfile for profile-based grant_types filtering
  // §16: Human Auth / AI Ephemeral Auth two-layer model
  const tenantProfile: TenantProfile = await loadTenantProfile(
    c.env.AUTHRIM_CONFIG,
    c.env,
    tenantId
  );

  // Check if cached metadata is still valid (include feature flags, profile, and tenant in cache key)
  const logoutHash = `bc=${logoutConfig.backchannel.enabled}:fc=${logoutConfig.frontchannel.enabled}:sm=${logoutConfig.session_management.enabled}`;
  const profileHash = `profile=${tenantProfile.type}`;
  const settingsHash = `${currentSettingsJson}:te=${tokenExchangeEnabled}:cc=${clientCredentialsEnabled}:ns=${nativeSSOEnabled}:rar=${rarEnabled}:ai=${aiScopesEnabled}:${profileHash}:${logoutHash}`;
  const cacheKey = `${tenantId}:${settingsHash}`;

  const cachedMetadata = metadataCache.get(cacheKey);
  if (cachedMetadata) {
    // Cache hit - return cached metadata
    c.header('Cache-Control', 'public, max-age=300');
    c.header('Vary', 'Accept-Encoding, Host');
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
    pushed_authorization_request_endpoint: `${issuer}/par`,
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
    // Grant types filtered by TenantProfile capabilities (§16: Two-layer model)
    // RFC 8414 §2: Discovery metadata SHOULD reflect actual capabilities
    grant_types_supported: filterGrantTypesByProfile(
      [
        'authorization_code',
        'refresh_token',
        'implicit', // Required for Dynamic OP certification (id_token/token response types)
        'urn:ietf:params:oauth:grant-type:jwt-bearer', // RFC 7523: JWT Bearer Flow
        'urn:ietf:params:oauth:grant-type:device_code', // RFC 8628: Device Authorization Grant
        'urn:openid:params:grant-type:ciba', // OIDC CIBA: Client Initiated Backchannel Authentication
        'urn:ietf:params:oauth:grant-type:token-exchange', // RFC 8693: Token Exchange
        'client_credentials', // RFC 6749 Section 4.4: Client Credentials
      ],
      tenantProfile,
      { tokenExchangeEnabled, clientCredentialsEnabled }
    ),
    id_token_signing_alg_values_supported: ['RS256'],
    // OIDC Core 8: Both public and pairwise subject identifiers are supported
    subject_types_supported: ['public', 'pairwise'],
    // Dynamic scopes based on AI Ephemeral Auth configuration
    scopes_supported: [
      'openid',
      'profile',
      'email',
      'address',
      'phone',
      // Include AI scopes when enabled
      ...(aiScopesEnabled ? ['ai:read', 'ai:write', 'ai:execute', 'ai:admin'] : []),
    ],
    // RFC 9396: RAR authorization_details_types_supported (when enabled)
    ...(rarEnabled
      ? {
          authorization_details_types_supported: [
            'ai_agent_action', // Authrim-specific AI Agent capability
            'payment_initiation', // RFC 9396 example type
            'account_information', // RFC 9396 example type
          ],
        }
      : {}),
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
      // OIDC Native SSO 1.0: ds_hash (conditionally included when enabled)
      ...(nativeSSOEnabled ? ['ds_hash'] : []),
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
    // OIDC Discovery: Recommended metadata fields
    service_documentation: `${issuer}/docs`,
    ui_locales_supported: ['en', 'ja'],
    claims_locales_supported: ['en', 'ja'],
    display_values_supported: ['page', 'popup'],
    // OIDC RP-Initiated Logout 1.0 (always enabled)
    end_session_endpoint: `${issuer}/logout`,
    // OIDC Session Management 1.0 (configurable via KV)
    ...(logoutConfig.session_management.enabled &&
    logoutConfig.session_management.check_session_iframe_enabled
      ? { check_session_iframe: `${issuer}/session/check` }
      : {}),
    // OIDC Front-Channel Logout 1.0 (configurable via KV)
    frontchannel_logout_supported: logoutConfig.frontchannel.enabled,
    frontchannel_logout_session_supported: logoutConfig.frontchannel.enabled,
    // OIDC Back-Channel Logout 1.0 (configurable via KV)
    backchannel_logout_supported: logoutConfig.backchannel.enabled,
    backchannel_logout_session_supported: logoutConfig.backchannel.enabled,
    // OIDC Native SSO 1.0 (draft-07) - conditionally included when enabled
    ...(nativeSSOEnabled
      ? {
          native_sso_token_exchange_supported: true,
          native_sso_device_secret_supported: true,
        }
      : {}),
  };

  // Update cache (with size limit to prevent memory issues)
  if (metadataCache.size > 100) {
    // Simple LRU: clear oldest entries when cache gets too large
    const keysToDelete = Array.from(metadataCache.keys()).slice(0, 50);
    keysToDelete.forEach((key) => metadataCache.delete(key));
  }
  metadataCache.set(cacheKey, metadata);

  // Add cache headers for better performance
  // Reduced from 3600 to 300 seconds (5 minutes) for dynamic configuration
  c.header('Cache-Control', 'public, max-age=300');
  c.header('Vary', 'Accept-Encoding, Host');

  return c.json(metadata);
}
