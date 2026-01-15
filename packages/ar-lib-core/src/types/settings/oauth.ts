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
  'oauth.refresh_token_remaining_expiry_inherit': boolean;

  // Security Settings (note: pkce_required, pkce_s256_required, nonce_required moved to security.ts)
  'oauth.state_required': boolean;
  'oauth.scope_required': boolean;

  // UserInfo Settings
  'oauth.userinfo_require_openid': boolean;

  // Error Response Settings
  'oauth.error_description': boolean;
  'oauth.error_uri': boolean;
  'oauth.iss_response_param': boolean;

  // ID Token Settings
  'oauth.id_token_aud_format': 'array' | 'string';
  'oauth.id_token_signing_alg': string;

  // DDoS Protection
  'oauth.max_codes_per_user': number;

  // PAR Settings (note: par_required moved to security.ts)
  'oauth.par_default_ttl': number;
  'oauth.par_fapi_ttl': number;

  // JARM Settings
  'oauth.jarm_enabled': boolean;

  // Loopback Settings moved to security.ts

  // HTTP Request URI Settings
  'oauth.https_request_uri_enabled': boolean;
  'oauth.https_request_uri_max_size': number;
  'oauth.https_request_uri_timeout_ms': number;

  // Prompt Settings
  'oauth.prompt_none_behavior': 'error' | 'login';

  // Error Response Format Settings
  'oauth.error_response_format': 'oauth' | 'problem_details';
  'oauth.error_id_mode': 'all' | '5xx' | 'security_only' | 'none';

  // Response Mode Settings
  'oauth.default_response_mode': 'query' | 'fragment' | 'form_post';
  'oauth.response_modes_supported': string;

  // Backchannel Token Delivery Settings
  'oauth.backchannel_token_delivery_mode': 'poll' | 'ping' | 'push';
  'oauth.backchannel_token_delivery_modes_supported': string;

  // HTTPS Request URI Allowed Domains
  'oauth.https_request_uri_allowed_domains': string;
}

/**
 * OAuth Settings Metadata
 */
export const OAUTH_SETTINGS_META: Record<keyof OAuthSettings, SettingMeta> = {
  // Token Expiry Settings
  'oauth.access_token_expiry': {
    key: 'oauth.access_token_expiry',
    type: 'duration',
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
    unit: 'seconds',
    visibility: 'public',
  },

  // Token Behavior Settings
  'oauth.refresh_token_rotation': {
    key: 'oauth.refresh_token_rotation',
    type: 'boolean',
    default: true,
    envKey: 'ENABLE_REFRESH_TOKEN_ROTATION',
    label: 'Refresh Token Rotation',
    description: 'Enable refresh token rotation (security best practice)',
    visibility: 'public',
  },
  'oauth.refresh_id_token_reissue': {
    key: 'oauth.refresh_id_token_reissue',
    type: 'boolean',
    default: true,
    envKey: 'REFRESH_ID_TOKEN_REISSUE',
    label: 'Reissue ID Token on Refresh',
    description: 'Issue new ID token when refresh token is used',
    visibility: 'public',
  },
  'oauth.offline_access_required': {
    key: 'oauth.offline_access_required',
    type: 'boolean',
    default: true,
    envKey: 'OFFLINE_ACCESS_REQUIRED_FOR_REFRESH',
    label: 'Require offline_access for Refresh',
    description: 'Require offline_access scope to issue refresh tokens',
    visibility: 'public',
  },
  'oauth.refresh_token_sliding_window_enabled': {
    key: 'oauth.refresh_token_sliding_window_enabled',
    type: 'boolean',
    default: true,
    envKey: 'REFRESH_TOKEN_SLIDING_WINDOW',
    label: 'Sliding Window Refresh',
    description: 'Enable sliding window for refresh token expiry',
    visibility: 'public',
  },
  'oauth.refresh_token_absolute_expiry_enabled': {
    key: 'oauth.refresh_token_absolute_expiry_enabled',
    type: 'boolean',
    default: false,
    envKey: 'REFRESH_TOKEN_ABSOLUTE_EXPIRY_ENABLED',
    label: 'Absolute Expiry Enabled',
    description: 'Enable absolute expiry limit for refresh tokens',
    visibility: 'public',
  },
  'oauth.refresh_token_absolute_expiry': {
    key: 'oauth.refresh_token_absolute_expiry',
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
  'oauth.refresh_token_remaining_expiry_inherit': {
    key: 'oauth.refresh_token_remaining_expiry_inherit',
    type: 'boolean',
    default: false,
    envKey: 'REFRESH_TOKEN_REMAINING_EXPIRY_INHERIT',
    label: 'Inherit Remaining Expiry',
    description: 'New refresh token inherits remaining expiry from old token',
    visibility: 'public',
  },

  // Security Settings
  'oauth.state_required': {
    key: 'oauth.state_required',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_STATE_REQUIRED',
    label: 'State Required',
    description: 'Require state parameter for CSRF protection (recommended for production)',
    visibility: 'public',
  },
  'oauth.scope_required': {
    key: 'oauth.scope_required',
    type: 'boolean',
    default: false,
    envKey: 'SCOPE_REQUIRED',
    label: 'Scope Required',
    description: 'Require scope parameter in authorization requests',
    visibility: 'public',
  },
  // Note: pkce_required, pkce_s256_required, nonce_required moved to security.ts

  // UserInfo Settings
  'oauth.userinfo_require_openid': {
    key: 'oauth.userinfo_require_openid',
    type: 'boolean',
    default: true,
    envKey: 'ENABLE_USERINFO_REQUIRE_OPENID_SCOPE',
    label: 'UserInfo Requires OpenID Scope',
    description: 'Require openid scope for UserInfo endpoint (OIDC compliance)',
    visibility: 'public',
  },

  // Error Response Settings
  'oauth.error_description': {
    key: 'oauth.error_description',
    type: 'boolean',
    default: true,
    envKey: 'ENABLE_ERROR_DESCRIPTION',
    label: 'Error Description',
    description: 'Include error_description in error responses',
    visibility: 'public',
  },
  'oauth.error_uri': {
    key: 'oauth.error_uri',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_ERROR_URI',
    label: 'Error URI',
    description: 'Include error_uri in error responses',
    visibility: 'public',
  },
  'oauth.iss_response_param': {
    key: 'oauth.iss_response_param',
    type: 'boolean',
    default: true,
    envKey: 'ENABLE_ISS_RESPONSE_PARAM',
    label: 'Include iss in Response',
    description: 'Include iss parameter in authorization response (RFC 9207)',
    visibility: 'public',
  },

  // ID Token Settings
  'oauth.id_token_aud_format': {
    key: 'oauth.id_token_aud_format',
    type: 'enum',
    default: 'array',
    envKey: 'ID_TOKEN_AUD_FORMAT',
    label: 'ID Token aud Format',
    description: 'Format of aud claim in ID token (array or string)',
    enum: ['array', 'string'],
    visibility: 'public',
  },
  'oauth.id_token_signing_alg': {
    key: 'oauth.id_token_signing_alg',
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
    type: 'number',
    default: 100,
    envKey: 'MAX_CODES_PER_USER',
    label: 'Max Codes Per User',
    description: 'Maximum authorization codes per user (DDoS protection)',
    min: 10,
    max: 1000000,
    visibility: 'admin',
  },

  // PAR Settings (note: par_required moved to security.ts)
  'oauth.par_default_ttl': {
    key: 'oauth.par_default_ttl',
    type: 'duration',
    default: 60,
    envKey: 'PAR_DEFAULT_TTL',
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
    default: 60,
    envKey: 'REQUEST_URI_EXPIRY_FAPI',
    label: 'PAR FAPI TTL',
    description: 'PAR request_uri lifetime for FAPI profile (strict, max 60s)',
    min: 30,
    max: 60,
    unit: 'seconds',
    visibility: 'admin',
  },

  // JARM Settings
  'oauth.jarm_enabled': {
    key: 'oauth.jarm_enabled',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_JARM',
    label: 'JARM Enabled',
    description: 'Enable JWT Secured Authorization Response Mode',
    visibility: 'public',
  },

  // Loopback Settings moved to security.ts

  // HTTP Request URI Settings
  'oauth.https_request_uri_enabled': {
    key: 'oauth.https_request_uri_enabled',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_HTTPS_REQUEST_URI',
    label: 'Request URI Enabled',
    description: 'Enable request_uri parameter support',
    visibility: 'public',
  },
  'oauth.https_request_uri_max_size': {
    key: 'oauth.https_request_uri_max_size',
    type: 'number',
    default: 51200,
    envKey: 'HTTPS_REQUEST_URI_MAX_SIZE',
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

  // Prompt Settings
  'oauth.prompt_none_behavior': {
    key: 'oauth.prompt_none_behavior',
    type: 'enum',
    default: 'error',
    envKey: 'PROMPT_NONE_BEHAVIOR',
    label: 'Prompt None Behavior',
    description: 'Behavior when prompt=none and no session exists',
    enum: ['error', 'login'],
    visibility: 'public',
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
    visibility: 'admin',
  },

  // Response Mode Settings
  'oauth.default_response_mode': {
    key: 'oauth.default_response_mode',
    type: 'enum',
    default: 'query',
    envKey: 'DEFAULT_RESPONSE_MODE',
    label: 'Default Response Mode',
    description: 'Default response mode for authorization requests',
    enum: ['query', 'fragment', 'form_post'],
    visibility: 'admin',
  },
  'oauth.response_modes_supported': {
    key: 'oauth.response_modes_supported',
    type: 'string',
    default: 'query,fragment,form_post',
    envKey: 'RESPONSE_MODES_SUPPORTED',
    label: 'Supported Response Modes',
    description: 'Comma-separated list of supported response modes',
    visibility: 'admin',
  },

  // Backchannel Token Delivery Settings
  'oauth.backchannel_token_delivery_mode': {
    key: 'oauth.backchannel_token_delivery_mode',
    type: 'enum',
    default: 'poll',
    envKey: 'BACKCHANNEL_TOKEN_DELIVERY_MODE',
    label: 'Backchannel Token Delivery Mode',
    description: 'Default token delivery mode for CIBA',
    enum: ['poll', 'ping', 'push'],
    visibility: 'admin',
  },
  'oauth.backchannel_token_delivery_modes_supported': {
    key: 'oauth.backchannel_token_delivery_modes_supported',
    type: 'string',
    default: 'poll,ping',
    envKey: 'BACKCHANNEL_TOKEN_DELIVERY_MODES_SUPPORTED',
    label: 'Supported Token Delivery Modes',
    description: 'Comma-separated list of supported CIBA token delivery modes',
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
  'oauth.refresh_token_remaining_expiry_inherit': false,
  'oauth.state_required': false,
  'oauth.scope_required': false,
  // Note: pkce_required, pkce_s256_required, nonce_required moved to security.ts
  'oauth.userinfo_require_openid': true,
  'oauth.error_description': true,
  'oauth.error_uri': false,
  'oauth.iss_response_param': true,
  'oauth.id_token_aud_format': 'array',
  'oauth.id_token_signing_alg': 'RS256',
  'oauth.max_codes_per_user': 100,
  // Note: par_required moved to security.ts
  'oauth.par_default_ttl': 60,
  'oauth.par_fapi_ttl': 60,
  'oauth.jarm_enabled': false,
  // Note: loopback_flexible_port moved to security.ts
  'oauth.https_request_uri_enabled': false,
  'oauth.https_request_uri_max_size': 51200,
  'oauth.https_request_uri_timeout_ms': 5000,
  'oauth.prompt_none_behavior': 'error',
  'oauth.error_response_format': 'oauth',
  'oauth.error_id_mode': 'security_only',
  'oauth.default_response_mode': 'query',
  'oauth.response_modes_supported': 'query,fragment,form_post',
  'oauth.backchannel_token_delivery_mode': 'poll',
  'oauth.backchannel_token_delivery_modes_supported': 'poll,ping',
  'oauth.https_request_uri_allowed_domains': '',
};
