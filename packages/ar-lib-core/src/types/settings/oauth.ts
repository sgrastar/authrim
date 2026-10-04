/**
 * OAuth Settings Category
 *
 * Settings related to OAuth 2.0 and OIDC core functionality.
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/oauth
 * Config Level: tenant
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

/**
 * OAuth Settings Interface
 */
export interface OAuthSettings {
  // Token Expiry Settings
  'oauth.access_token_expiry': number;
  'oauth.id_token_expiry': number;
  'oauth.refresh_token_expiry': number;
  'oauth.auth_code_ttl': number;
  'oauth.state_expiry': number;
  'oauth.nonce_expiry': number;

  // Token Behavior Settings
  'oauth.refresh_token_rotation': boolean;
  'oauth.refresh_id_token_reissue': boolean;
  'oauth.offline_access_required': boolean;
  'oauth.refresh_token_sliding_window_enabled': boolean;
  'oauth.refresh_token_absolute_expiry_enabled': boolean;
  'oauth.refresh_token_absolute_expiry': number;

  // Security Settings (note: pkce_required, pkce_s256_required, nonce_required moved to security.ts)
  'oauth.state_required': boolean;

  // UserInfo Settings
  'oauth.userinfo_require_openid': boolean;

  // SSO Settings
  'oauth.sso_enabled': boolean;

  'oauth.id_token_signing_alg': string;

  // DDoS Protection
  'oauth.max_codes_per_user': number;

  // PAR Settings (note: par_required moved to security.ts)
  'oauth.par_default_ttl': number;
  'oauth.par_fapi_ttl': number;

  // Loopback Settings moved to security.ts

  // HTTP Request URI Settings
  'oauth.https_request_uri_enabled': boolean;
  'oauth.https_request_uri_max_size': number;
  'oauth.https_request_uri_timeout_ms': number;

  // Error Response Format Settings
  'oauth.error_response_format': 'oauth' | 'problem_details';
  'oauth.error_id_mode': 'all' | '5xx' | 'security_only' | 'none';

  // HTTPS Request URI Allowed Domains
  'oauth.https_request_uri_allowed_domains': string;
  'oauth.error_locale': 'en' | 'ja';
  'oauth.response_types_supported': string[];
  'oauth.token_endpoint_auth_methods_supported': string[];
}

/**
 * OAuth Settings Metadata
 */
export const OAUTH_SETTINGS_META: Record<keyof OAuthSettings, SettingMeta> = {
  // Token Expiry Settings
  'oauth.access_token_expiry': {
    key: 'oauth.access_token_expiry',
    type: 'duration',
    integer: true,
    default: 3600,
    envKey: 'ACCESS_TOKEN_EXPIRY',
    label: 'Access Token TTL',
    description: 'Access token lifetime in seconds (default: 1 hour)',
    min: 60,
    max: 86400,
    unit: 'seconds',
    visibility: 'public',
  },
  'oauth.id_token_expiry': {
    key: 'oauth.id_token_expiry',
    // Per tenant (or app) only, as before the category had platform values.
    scopes: ['tenant', 'client'],
    type: 'duration',
    default: 3600,
    envKey: 'ID_TOKEN_EXPIRY',
    label: 'ID Token TTL',
    description: 'ID token lifetime in seconds (default: 1 hour)',
    min: 60,
    max: 86400,
    unit: 'seconds',
    visibility: 'public',
  },
  'oauth.refresh_token_expiry': {
    key: 'oauth.refresh_token_expiry',
    type: 'duration',
    integer: true,
    default: 7776000,
    envKey: 'REFRESH_TOKEN_EXPIRY',
    label: 'Refresh Token TTL',
    description: 'Refresh token lifetime in seconds (default: 90 days)',
    min: 3600,
    max: 31536000,
    unit: 'seconds',
    visibility: 'public',
  },
  'oauth.auth_code_ttl': {
    key: 'oauth.auth_code_ttl',
    type: 'duration',
    integer: true,
    default: 60,
    envKey: 'AUTH_CODE_EXPIRY',
    label: 'Authorization Code TTL',
    description: 'Authorization code lifetime in seconds (OAuth 2.0 BCP: 60s)',
    min: 10,
    max: 86400,
    unit: 'seconds',
    visibility: 'public',
  },
  'oauth.state_expiry': {
    key: 'oauth.state_expiry',
    type: 'duration',
    default: 300,
    envKey: 'STATE_EXPIRY',
    label: 'State Parameter TTL',
    description: 'OAuth state parameter lifetime in seconds',
    min: 60,
    max: 3600,
    integer: true,
    unit: 'seconds',
    visibility: 'public',
  },
  'oauth.nonce_expiry': {
    key: 'oauth.nonce_expiry',
    type: 'duration',
    default: 300,
    envKey: 'NONCE_EXPIRY',
    label: 'Nonce TTL',
    description: 'OIDC nonce lifetime in seconds',
    min: 60,
    max: 3600,
    integer: true,
    unit: 'seconds',
    visibility: 'public',
  },

  // Token Behavior Settings
  'oauth.refresh_token_rotation': {
    key: 'oauth.refresh_token_rotation',
    // Per tenant (or app) only, as before the category had platform values.
    scopes: ['tenant', 'client'],
    type: 'boolean',
    default: true,
    envKey: 'ENABLE_REFRESH_TOKEN_ROTATION',
    // As the token endpoint read it: only an explicit `false` turns rotation off.
    envBoolean: 'unless-exactly-false',
    label: 'Refresh Token Rotation',
    description:
      'Issue a new refresh token on each refresh and detect reuse of an old one (security best practice). FAPI 2.0 tenants never rotate, as the profile requires.',
    visibility: 'public',
  },
  'oauth.refresh_id_token_reissue': {
    key: 'oauth.refresh_id_token_reissue',
    // Per tenant (or app) only, as before the category had platform values.
    scopes: ['tenant', 'client'],
    type: 'boolean',
    default: true,
    envKey: 'REFRESH_ID_TOKEN_REISSUE',
    label: 'Reissue ID Token on Refresh',
    description: 'Issue new ID token when refresh token is used',
    visibility: 'public',
  },
  'oauth.offline_access_required': {
    key: 'oauth.offline_access_required',
    // Per tenant (or app) only, as before the category had platform values.
    scopes: ['tenant', 'client'],
    type: 'boolean',
    default: true,
    envKey: 'OFFLINE_ACCESS_REQUIRED_FOR_REFRESH',
    label: 'Require offline_access for Refresh',
    description: 'Require offline_access scope to issue refresh tokens',
    visibility: 'public',
  },
  'oauth.refresh_token_sliding_window_enabled': {
    key: 'oauth.refresh_token_sliding_window_enabled',
    // Per tenant (or app) only, as before the category had platform values.
    scopes: ['tenant', 'client'],
    type: 'boolean',
    default: true,
    envKey: 'REFRESH_TOKEN_SLIDING_WINDOW',
    label: 'Sliding Window Refresh',
    description: 'Enable sliding window for refresh token expiry',
    visibility: 'public',
  },
  'oauth.refresh_token_absolute_expiry_enabled': {
    key: 'oauth.refresh_token_absolute_expiry_enabled',
    // Per tenant (or app) only, as before the category had platform values.
    scopes: ['tenant', 'client'],
    type: 'boolean',
    default: false,
    envKey: 'REFRESH_TOKEN_ABSOLUTE_EXPIRY_ENABLED',
    label: 'Absolute Expiry Enabled',
    description: 'Enable absolute expiry limit for refresh tokens',
    visibility: 'public',
  },
  'oauth.refresh_token_absolute_expiry': {
    key: 'oauth.refresh_token_absolute_expiry',
    // Per tenant (or app) only, as before the category had platform values.
    scopes: ['tenant', 'client'],
    type: 'duration',
    default: 31536000,
    envKey: 'REFRESH_TOKEN_ABSOLUTE_EXPIRY',
    label: 'Absolute Expiry',
    description: 'Absolute maximum refresh token lifetime in seconds (1 year)',
    min: 86400,
    max: 63072000,
    unit: 'seconds',
    visibility: 'public',
  },

  // Security Settings
  'oauth.state_required': {
    key: 'oauth.state_required',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_STATE_REQUIRED',
    envBoolean: 'unless-false',
    label: 'State Required',
    description: 'Require state parameter for CSRF protection (recommended for production)',
    visibility: 'public',
  },
  // Note: pkce_required, pkce_s256_required, nonce_required moved to security.ts

  // UserInfo Settings
  'oauth.userinfo_require_openid': {
    key: 'oauth.userinfo_require_openid',
    type: 'boolean',
    default: true,
    envKey: 'ENABLE_USERINFO_REQUIRE_OPENID_SCOPE',
    envBoolean: 'unless-false',
    label: 'UserInfo Requires OpenID Scope',
    description: 'Require openid scope for UserInfo endpoint (OIDC compliance)',
    visibility: 'public',
  },

  // SSO Settings
  'oauth.sso_enabled': {
    key: 'oauth.sso_enabled',
    // Per tenant (or app) only, as before the category had platform values.
    scopes: ['tenant', 'client'],
    type: 'boolean',
    default: false,
    envKey: 'OAUTH_SSO_ENABLED',
    label: 'SSO Enabled',
    description:
      'Enable Single Sign-On (session sharing across clients). When disabled, users must re-authenticate for each client.',
    visibility: 'public',
  },

  'oauth.id_token_signing_alg': {
    key: 'oauth.id_token_signing_alg',
    // Per tenant (or app) only, as before the category had platform values.
    scopes: ['tenant', 'client'],
    type: 'string',
    default: 'RS256',
    envKey: 'ID_TOKEN_SIGNING_ALG',
    label: 'ID Token Signing Algorithm',
    description: 'Default signing algorithm for ID tokens',
    visibility: 'admin',
  },

  // DDoS Protection
  'oauth.max_codes_per_user': {
    key: 'oauth.max_codes_per_user',
    // Codes are counted per tenant (one code store each): not per app.
    scopes: ['platform', 'tenant'],
    type: 'number',
    default: 100,
    envKey: 'MAX_CODES_PER_USER',
    label: 'Max Codes Per User',
    description: 'Maximum authorization codes per user (DDoS protection)',
    min: 10,
    max: 1000000,
    integer: true,
    visibility: 'admin',
  },

  // PAR Settings (note: par_required moved to security.ts)
  'oauth.par_default_ttl': {
    key: 'oauth.par_default_ttl',
    type: 'duration',
    // RFC 9126's example lifetime, which PAR has always used.
    default: 600,
    label: 'PAR Request TTL',
    description: 'PAR request_uri lifetime in seconds',
    min: 30,
    max: 600,
    unit: 'seconds',
    visibility: 'public',
  },
  'oauth.par_fapi_ttl': {
    key: 'oauth.par_fapi_ttl',
    type: 'duration',
    // None: FAPI mode uses the PAR Request TTL, as it always has.
    default: 0,
    label: 'PAR FAPI TTL',
    description: 'PAR request_uri lifetime in FAPI mode (at most 60s); 0 uses the PAR Request TTL',
    min: 0,
    max: 60,
    unit: 'seconds',
    visibility: 'admin',
  },

  // Loopback Settings moved to security.ts

  // HTTP Request URI Settings
  'oauth.https_request_uri_enabled': {
    key: 'oauth.https_request_uri_enabled',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_HTTPS_REQUEST_URI',
    envBoolean: 'exactly-true',
    label: 'Request URI Enabled',
    description: 'Enable request_uri parameter support',
    visibility: 'public',
  },
  'oauth.https_request_uri_max_size': {
    key: 'oauth.https_request_uri_max_size',
    type: 'number',
    default: 102400,
    envKey: 'HTTPS_REQUEST_URI_MAX_SIZE_BYTES',
    label: 'Request URI Max Size',
    description: 'Maximum size of request object in bytes',
    min: 1024,
    max: 524288,
    unit: 'bytes',
    visibility: 'admin',
  },
  'oauth.https_request_uri_timeout_ms': {
    key: 'oauth.https_request_uri_timeout_ms',
    type: 'duration',
    default: 5000,
    envKey: 'HTTPS_REQUEST_URI_TIMEOUT_MS',
    label: 'Request URI Timeout',
    description: 'Timeout for fetching request_uri in milliseconds',
    min: 1000,
    max: 30000,
    unit: 'ms',
    visibility: 'admin',
  },

  // Error Response Format Settings
  'oauth.error_response_format': {
    key: 'oauth.error_response_format',
    type: 'enum',
    default: 'oauth',
    envKey: 'ERROR_RESPONSE_FORMAT',
    label: 'Error Response Format',
    description: 'Error response format: oauth (standard) or problem_details (RFC 7807)',
    enum: ['oauth', 'problem_details'],
    // Error responses are built before a client is known: not per client.
    scopes: ['platform', 'tenant'],
    visibility: 'admin',
  },
  'oauth.error_id_mode': {
    key: 'oauth.error_id_mode',
    type: 'enum',
    default: 'security_only',
    envKey: 'ERROR_ID_MODE',
    label: 'Error ID Mode',
    description: 'When to include error IDs for support tracking',
    enum: ['all', '5xx', 'security_only', 'none'],
    // Error responses are built before a client is known: not per client.
    scopes: ['platform', 'tenant'],
    visibility: 'admin',
  },

  // HTTPS Request URI Allowed Domains
  'oauth.https_request_uri_allowed_domains': {
    key: 'oauth.https_request_uri_allowed_domains',
    type: 'string',
    default: '',
    envKey: 'HTTPS_REQUEST_URI_ALLOWED_DOMAINS',
    label: 'Allowed Request URI Domains',
    description: 'Comma-separated list of allowed domains for HTTPS request_uri (empty for any)',
    visibility: 'admin',
  },
  'oauth.error_locale': {
    key: 'oauth.error_locale',
    type: 'enum',
    enum: ['en', 'ja'],
    label: 'Error Locale',
    description: 'Language of error descriptions in error responses',
    // Error responses are built before a client is known: not per client.
    scopes: ['platform', 'tenant'],
    visibility: 'admin',
    default: 'en',
  },
  'oauth.response_types_supported': {
    key: 'oauth.response_types_supported',
    type: 'json',
    label: 'Supported Response Types',
    description: 'Response types authorization accepts and discovery advertises',
    visibility: 'admin',
    default: [
      'code',
      'id_token',
      'id_token token',
      'code id_token',
      'code token',
      'code id_token token',
      'none',
    ],
  },
  'oauth.token_endpoint_auth_methods_supported': {
    key: 'oauth.token_endpoint_auth_methods_supported',
    type: 'json',
    label: 'Token Endpoint Auth Methods',
    description:
      'Client authentication methods discovery advertises (FAPI mode advertises private_key_jwt only)',
    visibility: 'admin',
    default: ['client_secret_basic', 'client_secret_post', 'private_key_jwt', 'none'],
  },
};

/**
 * OAuth Category Metadata
 */
export const OAUTH_CATEGORY_META: CategoryMeta = {
  category: 'oauth',
  label: 'OAuth/OIDC Core',
  description: 'OAuth 2.0 and OpenID Connect core settings',
  settings: OAUTH_SETTINGS_META,
};

/**
 * Default OAuth settings values
 */
export const OAUTH_DEFAULTS: OAuthSettings = {
  'oauth.access_token_expiry': 3600,
  'oauth.id_token_expiry': 3600,
  'oauth.refresh_token_expiry': 7776000,
  'oauth.auth_code_ttl': 60,
  'oauth.state_expiry': 300,
  'oauth.nonce_expiry': 300,
  'oauth.refresh_token_rotation': true,
  'oauth.refresh_id_token_reissue': true,
  'oauth.offline_access_required': true,
  'oauth.refresh_token_sliding_window_enabled': true,
  'oauth.refresh_token_absolute_expiry_enabled': false,
  'oauth.refresh_token_absolute_expiry': 31536000,
  'oauth.state_required': false,
  // Note: pkce_required, pkce_s256_required, nonce_required moved to security.ts
  'oauth.userinfo_require_openid': true,
  'oauth.sso_enabled': false,
  'oauth.id_token_signing_alg': 'RS256',
  'oauth.max_codes_per_user': 100,
  // Note: par_required moved to security.ts
  'oauth.par_default_ttl': 600,
  'oauth.par_fapi_ttl': 0,
  // Note: loopback_flexible_port moved to security.ts
  'oauth.https_request_uri_enabled': false,
  'oauth.https_request_uri_max_size': 102400,
  'oauth.https_request_uri_timeout_ms': 5000,
  'oauth.error_response_format': 'oauth',
  'oauth.error_id_mode': 'security_only',
  'oauth.https_request_uri_allowed_domains': '',
  'oauth.error_locale': 'en',
  'oauth.response_types_supported': [
    'code',
    'id_token',
    'id_token token',
    'code id_token',
    'code token',
    'code id_token token',
    'none',
  ],
  'oauth.token_endpoint_auth_methods_supported': [
    'client_secret_basic',
    'client_secret_post',
    'private_key_jwt',
    'none',
  ],
};
