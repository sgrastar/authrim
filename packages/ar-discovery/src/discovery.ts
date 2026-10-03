import type { Context } from 'hono';
import type {
  Env,
  Logger,
  OIDCProviderMetadata,
  LogoutConfig,
  TenantProfile,
} from '@authrim/ar-lib-core';
import {
  SUPPORTED_JWE_ALG,
  SUPPORTED_JWE_ENC,
  ALLOWED_DPOP_ALGS,
  buildRequestIssuerUrl,
  DEFAULT_LOGOUT_CONFIG,
  resolveLogoutConfig,
  getTenantIdFromContext,
  resolveEffectiveSettings,
  AAL_ACR_VALUES,
  isNativeSSOEnabled,
  loadTenantProfileCached,
  filterGrantTypesByProfile,
  getLogger,
  // Request-level caching for feature flags (Phase 2)
  getTenantFeatureFlagsCached,
  readSettingsFlag,
  getFeatureFlagCached,
  // KV caching utilities (Phase 2)
  buildVersionedKey,
  getCacheTTL,
  PREDEFINED_TRANSFORMED_CLAIMS,
  resolveProtocolSettings,
  type FAPIProtocolSettings,
  type OIDCProtocolSettings,
  FAPI2_MESSAGE_SIGNING_ALGS,
  CLIENT_ASSERTION_SIGNING_ALGS,
  setBoundedMapEntry,
} from '@authrim/ar-lib-core';
import type { JWK } from 'jose';
import {
  getPublishedOIDCSigningAlgorithms,
  type OIDCSigningAlgorithm,
} from '@authrim/ar-lib-core/utils/oidc-signing';

// Cache for metadata to improve performance
// Key: tenantId:settingsHash, Value: metadata
const metadataCache = new Map<string, OIDCProviderMetadata>();
const MAX_METADATA_CACHE_ENTRIES = 100;

export function clearDiscoveryMetadataCache(): void {
  metadataCache.clear();
}

async function resolvePublishedSigningAlgorithms(
  env: Env,
  tenantId: string,
  log: Logger
): Promise<OIDCSigningAlgorithm[]> {
  let keys: JWK[] = [];
  try {
    if (env.KEY_MANAGER_PUBLIC) {
      keys = await env.KEY_MANAGER_PUBLIC.getAllPublicKeys(tenantId);
    }
  } catch (error) {
    log.warn('Failed to load OIDC signing keys for discovery', { tenantId }, error as Error);
  }

  if (keys.length === 0 && env.PUBLIC_JWK_JSON) {
    try {
      keys = [JSON.parse(env.PUBLIC_JWK_JSON) as JWK];
    } catch (error) {
      log.warn('Failed to parse fallback OIDC public key for discovery', {}, error as Error);
    }
  }

  return getPublishedOIDCSigningAlgorithms(keys);
}

/**
 * OpenID Connect Discovery Endpoint Handler
 * https://openid.net/specs/openid-connect-discovery-1_0.html
 *
 * Returns metadata about the OpenID Provider's configuration
 */
export async function discoveryHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('DISCOVERY');

  // Get tenant ID from request context (set by requestContextMiddleware)
  const tenantId = getTenantIdFromContext(c);
  const asyncEnabled = (c.env as Env & { ASYNC_ENABLED?: string }).ASYNC_ENABLED !== 'false';

  // Build issuer URL for this tenant.
  const issuer = buildRequestIssuerUrl(c.req.raw, c.env, tenantId);
  const publishedSigningAlgorithms = await resolvePublishedSigningAlgorithms(c.env, tenantId, log);

  // Load dynamic configuration from SETTINGS KV
  let oidcConfig: OIDCProtocolSettings = {};
  let fapiConfig: FAPIProtocolSettings = {};
  let logoutConfig: LogoutConfig = DEFAULT_LOGOUT_CONFIG;
  let currentSettingsJson = '';
  // Token Exchange and ID-JAG, as the token endpoint reads them (the Settings API for the tenant).
  let tokenExchangeEnabled = false;
  let idJagEnabled = false;
  // The acr values advertised: discovery.acr_values_supported, and with assurance enabled the
  // values Authrim issues for each AAL (urn:authrim:aal:1..3).
  let acrValuesSupported: string[] = [];

  try {
    const [tokens, flags, discoverySettings, assurance] = await Promise.all([
      resolveEffectiveSettings(c.env, 'tokens', {
        tenantId,
      }),
      resolveEffectiveSettings(c.env, 'feature-flags', {
        tenantId,
      }),
      resolveEffectiveSettings(c.env, 'discovery', { tenantId }),
      resolveEffectiveSettings(c.env, 'assurance', { tenantId }),
    ]);
    const configuredAcrValues = discoverySettings['discovery.acr_values_supported'];
    acrValuesSupported = [
      ...new Set([
        ...(typeof configuredAcrValues === 'string'
          ? configuredAcrValues
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean)
          : []),
        ...(assurance['assurance.enabled'] === true ? AAL_ACR_VALUES : []),
      ]),
    ];
    tokenExchangeEnabled = tokens['tokens.exchange_enabled'] === true;
    // ID-JAG is a Token Exchange token type: advertised only with Token Exchange.
    idJagEnabled = tokenExchangeEnabled && flags['feature.enable_id_jag'] === true;

    const settings = await resolveProtocolSettings(c.env, tenantId, {
      sections: ['fapi', 'oidc'],
    });
    currentSettingsJson = JSON.stringify(settings);
    oidcConfig = settings.oidc;
    fapiConfig = settings.fapi;

    // Logout settings, as the logout handler reads them (the Settings API for the tenant).
    logoutConfig = await resolveLogoutConfig(c.env, tenantId);
  } catch (error) {
    log.error('Failed to load settings from KV', { tenantId }, error as Error);
    return c.json(
      {
        error: 'temporarily_unavailable',
        error_description: 'Security profile settings are temporarily unavailable',
      },
      503
    );
  }

  // HTTPS request_uri support status
  // Check SETTINGS KV first, then fall back to environment variable
  const savedHttpsRequestUriEnabled = oidcConfig.httpsRequestUri?.enabled;
  const httpsRequestUriEnabled =
    typeof savedHttpsRequestUriEnabled === 'boolean'
      ? savedHttpsRequestUriEnabled
      : c.env.ENABLE_HTTPS_REQUEST_URI === 'true';
  // request_uri is always supported (PAR), but HTTPS variant depends on config
  const requestUriSupported = true; // PAR always supported

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

  // Flow Engine (UI Contract) feature flag (request-level cached)
  // When enabled, server-driven UI flows are available
  // Check Settings Manager KV format first (settings:tenant:<tenantId>:feature-flags)
  // then fall back to legacy flag format (flag:ENABLE_FLOW_ENGINE)
  const tenantFlags = await getTenantFeatureFlagsCached(c, c.env, tenantId);
  // An explicit setting wins; the legacy flag (flag:ENABLE_FLOW_ENGINE or env) applies only
  // when the tenant and platform documents leave it unset (request-level cached).
  const flowEngineEnabled =
    readSettingsFlag(tenantFlags as Record<string, unknown> | null, 'feature.enable_flow_engine') ??
    (await getFeatureFlagCached(c, 'ENABLE_FLOW_ENGINE', c.env, false));

  // Load TenantProfile for profile-based grant_types filtering (request-level cached)
  // §16: Human Auth / AI Ephemeral Auth two-layer model
  const tenantProfile: TenantProfile = await loadTenantProfileCached(
    c,
    c.env.AUTHRIM_CONFIG,
    c.env,
    tenantId
  );

  // Check if cached metadata is still valid. The cache key must include env-derived
  // capabilities such as issuer/async mode, otherwise deployments can keep serving
  // stale metadata for a different environment or component set.
  const logoutHash = `bc=${logoutConfig.backchannel.enabled}:fc=${logoutConfig.frontchannel.enabled}:sm=${logoutConfig.session_management.enabled}:sm_iframe=${logoutConfig.session_management.check_session_iframe_enabled}`;
  const profileHash = `profile=${tenantProfile.type}`;
  const signingAlgorithmsHash = `oidc_algs=${publishedSigningAlgorithms.join(',')}`;
  const settingsHash = `${currentSettingsJson}:acr=${acrValuesSupported.join(',')}:issuer=${issuer}:async=${asyncEnabled}:te=${tokenExchangeEnabled}:cc=${clientCredentialsEnabled}:ns=${nativeSSOEnabled}:rar=${rarEnabled}:ai=${aiScopesEnabled}:idjag=${idJagEnabled}:fe=${flowEngineEnabled}:${profileHash}:${logoutHash}:${signingAlgorithmsHash}`;
  // A digest of everything the metadata depends on: a fixed-length key, however long the settings
  // (a KV key is at most 512 bytes).
  const settingsDigest = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(settingsHash))),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('');
  const cacheKey = `${tenantId}:${settingsDigest}`;
  const discoveryTTL = await getCacheTTL(c.env, 'discovery');
  const kvCacheKey = buildVersionedKey('discovery', cacheKey);

  const cachedMetadata = metadataCache.get(cacheKey);
  if (cachedMetadata) {
    // Cache hit - return cached metadata
    c.header('Cache-Control', 'public, max-age=300');
    c.header('Vary', 'Accept-Encoding, Host');
    return c.json(cachedMetadata);
  }

  // =========================================================================
  // Phase 2: KV Cache Check (safe after the cache key is fully derived)
  // =========================================================================
  if (c.env.AUTHRIM_CONFIG) {
    try {
      const cached = await c.env.AUTHRIM_CONFIG.get(kvCacheKey, {
        type: 'json',
        cacheTtl: discoveryTTL,
      });
      if (cached) {
        c.header('Cache-Control', `public, max-age=${discoveryTTL}`);
        c.header('Vary', 'Accept-Encoding, Host');
        c.header('X-Discovery-Cache', 'HIT');
        return c.json(cached as OIDCProviderMetadata);
      }
    } catch (error) {
      log.warn('Failed to read discovery cache from KV', { tenantId }, error as Error);
    }
  }
  // =========================================================================

  // Determine PAR requirement (FAPI 2.0 mode or OIDC config)
  const requirePar = fapiConfig.enabled ? true : oidcConfig.requirePar || false;
  const messageSigningEnabled = fapiConfig.messageSigning?.enabled === true;
  const requestObjectSigningAlgorithms = messageSigningEnabled
    ? (fapiConfig.messageSigning?.requestObjectSigningAlgorithms ?? [...FAPI2_MESSAGE_SIGNING_ALGS])
    : oidcConfig.allowNoneAlgorithm
      ? ['RS256', 'none']
      : ['RS256'];
  const authorizationSigningAlgorithms = messageSigningEnabled
    ? (fapiConfig.messageSigning?.authorizationSigningAlgorithms ?? ['ES256']).filter((algorithm) =>
        publishedSigningAlgorithms.includes(algorithm)
      )
    : publishedSigningAlgorithms;
  const responseTypesSupported = (Array.isArray(oidcConfig.responseTypesSupported)
    ? (oidcConfig.responseTypesSupported as string[])
    : null) || [
    'code',
    'id_token',
    'id_token token',
    'code id_token',
    'code token',
    'code id_token token',
    'none',
  ];
  const implicitGrantSupported = responseTypesSupported.some((responseType) => {
    const values = responseType.split(/\s+/);
    return values.includes('id_token') || values.includes('token');
  });

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
    // RFC 9207: /authorize includes iss in successful and error responses
    authorization_response_iss_parameter_supported: true,
    ...(asyncEnabled
      ? {
          // RFC 8628: Device Authorization endpoint
          device_authorization_endpoint: `${issuer}/device_authorization`,
          // OIDC CIBA: Backchannel Authentication endpoint
          backchannel_authentication_endpoint: `${issuer}/bc-authorize`,
          backchannel_token_delivery_modes_supported: ['poll', 'ping', 'push'],
          backchannel_authentication_request_signing_alg_values_supported: [
            'RS256',
            'ES256',
            'PS256',
          ],
          backchannel_user_code_parameter_supported: true,
          tls_client_certificate_bound_access_tokens: true,
        }
      : {}),
    response_types_supported: responseTypesSupported,
    // Grant types filtered by TenantProfile capabilities (§16: Two-layer model)
    // RFC 8414 §2: Discovery metadata SHOULD reflect actual capabilities
    grant_types_supported: filterGrantTypesByProfile(
      [
        'authorization_code',
        'refresh_token',
        ...(implicitGrantSupported ? ['implicit'] : []),
        'urn:ietf:params:oauth:grant-type:jwt-bearer', // RFC 7523: JWT Bearer Flow
        ...(asyncEnabled
          ? [
              'urn:ietf:params:oauth:grant-type:device_code', // RFC 8628: Device Authorization Grant
              'urn:openid:params:grant-type:ciba', // OIDC CIBA: Client Initiated Backchannel Authentication
            ]
          : []),
        'urn:ietf:params:oauth:grant-type:token-exchange', // RFC 8693: Token Exchange
        'client_credentials', // RFC 6749 Section 4.4: Client Credentials
      ],
      tenantProfile,
      { tokenExchangeEnabled, clientCredentialsEnabled }
    ),
    id_token_signing_alg_values_supported: publishedSigningAlgorithms,
    // OIDC Core 8: Both public and pairwise subject identifiers are supported
    subject_types_supported: ['public', 'pairwise'],
    // Dynamic scopes based on AI Ephemeral Auth configuration
    scopes_supported: [
      'openid',
      'account:lifecycle:read',
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
      'authrim_account_lifecycle',
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
      'amr', // OIDC Core: Authentication Methods References
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
    token_endpoint_auth_methods_supported: fapiConfig.enabled
      ? ['private_key_jwt']
      : oidcConfig.tokenEndpointAuthMethodsSupported || [
          'client_secret_basic',
          'client_secret_post',
          'private_key_jwt',
          'none',
        ],
    token_endpoint_auth_signing_alg_values_supported: fapiConfig.enabled
      ? [...FAPI2_MESSAGE_SIGNING_ALGS]
      : [...CLIENT_ASSERTION_SIGNING_ALGS],
    code_challenge_methods_supported: ['S256'],
    // RFC 9449: DPoP (Demonstrating Proof of Possession) support
    dpop_signing_alg_values_supported: [...ALLOWED_DPOP_ALGS],
    // RFC 9101 (JAR): Request Object support
    request_parameter_supported: true,
    request_uri_parameter_supported: true,
    request_object_signing_alg_values_supported: requestObjectSigningAlgorithms,
    request_object_encryption_alg_values_supported: [...SUPPORTED_JWE_ALG],
    request_object_encryption_enc_values_supported: [...SUPPORTED_JWE_ENC],
    // JARM (JWT-Secured Authorization Response Mode) support
    // Authorization requires a JARM response mode whenever requireJarm is set.
    response_modes_supported: fapiConfig.messageSigning?.requireJarm
      ? ['query.jwt', 'fragment.jwt', 'form_post.jwt', 'jwt']
      : ['query', 'fragment', 'form_post', 'query.jwt', 'fragment.jwt', 'form_post.jwt', 'jwt'],
    authorization_signing_alg_values_supported: authorizationSigningAlgorithms,
    authorization_encryption_alg_values_supported: [...SUPPORTED_JWE_ALG],
    authorization_encryption_enc_values_supported: [...SUPPORTED_JWE_ENC],
    // RFC 7516: JWE (JSON Web Encryption) support
    id_token_encryption_alg_values_supported: [...SUPPORTED_JWE_ALG],
    id_token_encryption_enc_values_supported: [...SUPPORTED_JWE_ENC],
    userinfo_encryption_alg_values_supported: [...SUPPORTED_JWE_ALG],
    userinfo_encryption_enc_values_supported: [...SUPPORTED_JWE_ENC],
    // Unsigned UserInfo is JSON; this field lists only implemented JWS algorithms with JWKS keys.
    userinfo_signing_alg_values_supported: publishedSigningAlgorithms,
    // OIDC Core: Additional metadata
    claim_types_supported: ['normal'],
    claims_parameter_supported: true,
    // OpenID Connect Advanced Syntax for Claims (ASC) 1.0 draft 01.
    // Authrim supports SAO without JSON Schema and OP-predefined transformed claims only.
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
    // ACR (Authentication Context Class Reference) support
    ...(acrValuesSupported.length > 0 ? { acr_values_supported: acrValuesSupported } : {}),
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
    // OIDC Native SSO - conditionally included when enabled
    ...(nativeSSOEnabled
      ? {
          native_sso_supported: true,
        }
      : {}),
    // ID-JAG (Identity Assertion Authorization Grant) - conditionally included when enabled
    // draft-ietf-oauth-identity-assertion-authz-grant: Identity chaining via Token Exchange
    ...(idJagEnabled
      ? {
          // Supported token types that can be requested via identity chaining
          identity_chaining_requested_token_types_supported: [
            'urn:ietf:params:oauth:token-type:id-jag',
          ],
          // Supported subject_token_type values for ID-JAG requests
          id_jag_subject_token_types_supported: [
            'urn:ietf:params:oauth:token-type:id_token',
            'urn:ietf:params:oauth:token-type:jwt',
            'urn:ietf:params:oauth:token-type:saml2',
          ],
        }
      : {}),
    // Flow Engine (UI Contract) - conditionally included when enabled
    // Authrim-specific extension for server-driven UI flows
    ...(flowEngineEnabled
      ? {
          flow_engine_supported: true,
        }
      : {}),
  };

  // Update in-memory cache (with size limit to prevent memory issues)
  setBoundedMapEntry(metadataCache, cacheKey, metadata, MAX_METADATA_CACHE_ENTRIES);

  // =========================================================================
  // Phase 2: Store in KV cache (best-effort, don't block response)
  // =========================================================================
  if (c.env.AUTHRIM_CONFIG) {
    c.env.AUTHRIM_CONFIG.put(kvCacheKey, JSON.stringify(metadata), {
      expirationTtl: discoveryTTL,
    }).catch((error) => {
      // Log but don't fail the request
      log.warn('Failed to write discovery cache to KV', { tenantId }, error as Error);
    });
  }
  // =========================================================================

  // Add cache headers for better performance
  c.header('Cache-Control', `public, max-age=${discoveryTTL}`);
  c.header('Vary', 'Accept-Encoding, Host');
  c.header('X-Discovery-Cache', 'MISS');

  return c.json(metadata);
}
