/**
 * Security Settings Category
 *
 * Settings related to security policies and features.
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/security
 * Config Level: tenant
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

/**
 * Security Settings Interface
 */
export interface SecuritySettings {
  // FAPI Settings
  'security.fapi_enabled': boolean;
  'security.fapi_strict_dpop': boolean;
  'security.fapi_allow_public_clients': boolean;

  // DPoP Settings
  'security.dpop_bound_access_tokens': boolean;
  'security.dpop_nonce_enabled': boolean;
  'security.dpop_nonce_ttl': number;
  'security.dpop_jti_ttl': number;

  // Feature Flags (Security-related)
  'security.enable_abac': boolean;
  'security.enable_rebac': boolean;
  'security.enable_policy_logging': boolean;
  'security.enable_verified_attributes': boolean;

  // OAuth Security Requirements
  'security.pkce_required': boolean;
  'security.pkce_s256_required': boolean;
  'security.par_required': boolean;
  'security.nonce_required': boolean;
  'security.https_redirect_only': boolean;
  'security.allow_http_redirect': boolean;
  'security.loopback_flexible_port': boolean;
  'security.https_request_uri': boolean;

  // Clock Skew Settings
  'security.jwt_clock_skew_seconds': number;
  'security.saml_clock_skew_seconds': number;

  // Timing Attack Protection
  'security.min_response_time': number;
  'security.jitter': number;

  // Advanced Security
  'security.token_binding_required': boolean;
  'security.mutual_tls_required': boolean;
  'security.sender_constrained_tokens': boolean;

  // Request Object Requirements
  'security.require_signed_request_object': boolean;
  'security.require_encrypted_request_object': boolean;

  // IP Filtering
  'security.ip_allowlist_enabled': boolean;
  'security.ip_blocklist_enabled': boolean;
}

/**
 * Security Settings Metadata
 */
export const SECURITY_SETTINGS_META: Record<keyof SecuritySettings, SettingMeta> = {
  // FAPI Settings
  'security.fapi_enabled': {
    key: 'security.fapi_enabled',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_FAPI',
    label: 'FAPI Mode',
    description: 'Enable Financial-grade API security profile',
    visibility: 'public',
  },
  'security.fapi_strict_dpop': {
    key: 'security.fapi_strict_dpop',
    type: 'boolean',
    default: false,
    envKey: 'FAPI_STRICT_DPOP',
    label: 'FAPI Strict DPoP',
    description: 'Require DPoP for all FAPI requests',
    visibility: 'public',
    dependsOn: [{ key: 'security.fapi_enabled', value: true }],
  },
  'security.fapi_allow_public_clients': {
    key: 'security.fapi_allow_public_clients',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_FAPI_PUBLIC_CLIENTS',
    label: 'FAPI Allow Public Clients',
    description: 'Allow public clients in FAPI mode (not recommended)',
    visibility: 'admin',
    dependsOn: [{ key: 'security.fapi_enabled', value: true }],
  },

  // DPoP Settings
  'security.dpop_bound_access_tokens': {
    key: 'security.dpop_bound_access_tokens',
    type: 'boolean',
    default: false,
    envKey: 'DPOP_BOUND_ACCESS_TOKENS',
    label: 'DPoP Bound Tokens',
    description: 'Bind access tokens to DPoP keys by default',
    visibility: 'public',
  },
  'security.dpop_nonce_enabled': {
    key: 'security.dpop_nonce_enabled',
    type: 'boolean',
    default: true,
    envKey: 'ENABLE_DPOP_NONCE',
    label: 'DPoP Nonce Required',
    description: 'Require server-provided nonce in DPoP proofs',
    visibility: 'public',
  },
  'security.dpop_nonce_ttl': {
    key: 'security.dpop_nonce_ttl',
    type: 'duration',
    default: 300,
    envKey: 'DPOP_NONCE_TTL',
    label: 'DPoP Nonce TTL',
    description: 'DPoP nonce lifetime in seconds',
    min: 60,
    max: 3600,
    unit: 'seconds',
    visibility: 'admin',
  },
  'security.dpop_jti_ttl': {
    key: 'security.dpop_jti_ttl',
    type: 'duration',
    default: 300,
    envKey: 'DPOP_JTI_DEFAULT_TTL',
    label: 'DPoP JTI TTL',
    description: 'DPoP proof JTI replay prevention window in seconds',
    min: 60,
    max: 3600,
    unit: 'seconds',
    visibility: 'admin',
  },

  // Feature Flags (Security-related)
  'security.enable_abac': {
    key: 'security.enable_abac',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_ABAC',
    label: 'Enable ABAC',
    description: 'Enable Attribute-Based Access Control policy evaluation',
    visibility: 'admin',
  },
  'security.enable_rebac': {
    key: 'security.enable_rebac',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_REBAC',
    label: 'Enable ReBAC',
    description: 'Enable Relationship-Based Access Control',
    visibility: 'admin',
  },
  'security.enable_policy_logging': {
    key: 'security.enable_policy_logging',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_POLICY_LOGGING',
    label: 'Policy Logging',
    description: 'Enable detailed logging of policy evaluations',
    visibility: 'admin',
  },
  'security.enable_verified_attributes': {
    key: 'security.enable_verified_attributes',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_VERIFIED_ATTRIBUTES',
    label: 'Verified Attributes',
    description: 'Enable verified attribute checking in policies',
    visibility: 'admin',
  },

  // OAuth Security Requirements (canonical location - oauth.ts redirects here)
  'security.pkce_required': {
    key: 'security.pkce_required',
    type: 'boolean',
    default: false,
    envKey: 'SECURITY_PKCE_REQUIRED',
    label: 'PKCE Required',
    description: 'Require PKCE for all authorization code flows',
    visibility: 'public',
  },
  'security.pkce_s256_required': {
    key: 'security.pkce_s256_required',
    type: 'boolean',
    default: true,
    envKey: 'SECURITY_PKCE_S256_REQUIRED',
    label: 'PKCE S256 Required',
    description: 'Require S256 code challenge method when PKCE is used (plain disallowed)',
    visibility: 'public',
  },
  'security.par_required': {
    key: 'security.par_required',
    type: 'boolean',
    default: false,
    envKey: 'SECURITY_PAR_REQUIRED',
    label: 'PAR Required',
    description: 'Require Pushed Authorization Requests',
    visibility: 'public',
  },
  'security.nonce_required': {
    key: 'security.nonce_required',
    type: 'boolean',
    default: true,
    envKey: 'SECURITY_NONCE_REQUIRED',
    label: 'Nonce Required',
    description: 'Require nonce for implicit/hybrid flows',
    visibility: 'public',
  },
  'security.https_redirect_only': {
    key: 'security.https_redirect_only',
    type: 'boolean',
    default: true,
    envKey: 'HTTPS_REDIRECT_ONLY',
    label: 'HTTPS Redirect Only',
    description: 'Only allow HTTPS redirect URIs (except localhost)',
    visibility: 'admin',
  },
  'security.allow_http_redirect': {
    key: 'security.allow_http_redirect',
    type: 'boolean',
    default: false,
    envKey: 'ALLOW_HTTP_REDIRECT',
    label: 'Allow HTTP Redirect',
    description: 'Allow HTTP redirect URIs for non-production environments',
    visibility: 'admin',
  },
  'security.loopback_flexible_port': {
    key: 'security.loopback_flexible_port',
    type: 'boolean',
    default: true,
    envKey: 'SECURITY_LOOPBACK_FLEXIBLE_PORT',
    label: 'Loopback Flexible Port',
    description: 'Allow any port for localhost/loopback redirect URIs (RFC 8252)',
    visibility: 'admin',
  },
  'security.https_request_uri': {
    key: 'security.https_request_uri',
    type: 'boolean',
    default: true,
    envKey: 'HTTPS_REQUEST_URI',
    label: 'HTTPS Request URI',
    description: 'Require HTTPS for request_uri parameter (JAR)',
    visibility: 'admin',
  },

  // Clock Skew Settings
  'security.jwt_clock_skew_seconds': {
    key: 'security.jwt_clock_skew_seconds',
    type: 'number',
    default: 60,
    envKey: 'JWT_CLOCK_SKEW_SECONDS',
    label: 'JWT Clock Skew',
    description: 'Allowed clock skew for JWT validation in seconds',
    min: 0,
    max: 600,
    unit: 'seconds',
    visibility: 'admin',
  },
  'security.saml_clock_skew_seconds': {
    key: 'security.saml_clock_skew_seconds',
    type: 'number',
    default: 180,
    envKey: 'SAML_CLOCK_SKEW_SECONDS',
    label: 'SAML Clock Skew',
    description: 'Allowed clock skew for SAML assertion validation',
    min: 0,
    max: 600,
    unit: 'seconds',
    visibility: 'admin',
  },

  // Timing Attack Protection
  'security.min_response_time': {
    key: 'security.min_response_time',
    type: 'duration',
    default: 500,
    envKey: 'MIN_RESPONSE_TIME_MS',
    label: 'Minimum Response Time',
    description: 'Minimum response time for security-sensitive endpoints',
    min: 0,
    max: 5000,
    unit: 'ms',
    visibility: 'admin',
  },
  'security.jitter': {
    key: 'security.jitter',
    type: 'duration',
    default: 100,
    envKey: 'RESPONSE_JITTER_MS',
    label: 'Response Jitter',
    description: 'Random jitter added to responses to prevent timing attacks',
    min: 0,
    max: 1000,
    unit: 'ms',
    visibility: 'admin',
  },

  // Advanced Security
  'security.token_binding_required': {
    key: 'security.token_binding_required',
    type: 'boolean',
    default: false,
    envKey: 'TOKEN_BINDING_REQUIRED',
    label: 'Token Binding Required',
    description: 'Require token binding for enhanced security',
    visibility: 'admin',
  },
  'security.mutual_tls_required': {
    key: 'security.mutual_tls_required',
    type: 'boolean',
    default: false,
    envKey: 'MTLS_REQUIRED',
    label: 'Mutual TLS Required',
    description: 'Require mutual TLS client authentication',
    visibility: 'admin',
  },
  'security.sender_constrained_tokens': {
    key: 'security.sender_constrained_tokens',
    type: 'boolean',
    default: false,
    envKey: 'SENDER_CONSTRAINED_TOKENS',
    label: 'Sender Constrained Tokens',
    description: 'Enable sender-constrained access tokens',
    visibility: 'admin',
  },

  // Request Object Requirements
  'security.require_signed_request_object': {
    key: 'security.require_signed_request_object',
    type: 'boolean',
    default: false,
    envKey: 'REQUIRE_SIGNED_REQUEST_OBJECT',
    label: 'Signed Request Required',
    description: 'Require signed request objects (JAR)',
    visibility: 'admin',
  },
  'security.require_encrypted_request_object': {
    key: 'security.require_encrypted_request_object',
    type: 'boolean',
    default: false,
    envKey: 'REQUIRE_ENCRYPTED_REQUEST_OBJECT',
    label: 'Encrypted Request Required',
    description: 'Require encrypted request objects',
    visibility: 'admin',
  },

  // IP Filtering
  'security.ip_allowlist_enabled': {
    key: 'security.ip_allowlist_enabled',
    type: 'boolean',
    default: false,
    envKey: 'IP_ALLOWLIST_ENABLED',
    label: 'IP Allowlist Enabled',
    description: 'Enable IP allowlist filtering',
    visibility: 'admin',
  },
  'security.ip_blocklist_enabled': {
    key: 'security.ip_blocklist_enabled',
    type: 'boolean',
    default: false,
    envKey: 'IP_BLOCKLIST_ENABLED',
    label: 'IP Blocklist Enabled',
    description: 'Enable IP blocklist filtering',
    visibility: 'admin',
  },
};

/**
 * Security Category Metadata
 */
export const SECURITY_CATEGORY_META: CategoryMeta = {
  category: 'security',
  label: 'Security',
  description: 'Security policies and feature flags',
  settings: SECURITY_SETTINGS_META,
};

/**
 * Default Security settings values
 */
export const SECURITY_DEFAULTS: SecuritySettings = {
  'security.fapi_enabled': false,
  'security.fapi_strict_dpop': false,
  'security.fapi_allow_public_clients': false,
  'security.dpop_bound_access_tokens': false,
  'security.dpop_nonce_enabled': true,
  'security.dpop_nonce_ttl': 300,
  'security.dpop_jti_ttl': 300,
  'security.enable_abac': false,
  'security.enable_rebac': false,
  'security.enable_policy_logging': false,
  'security.enable_verified_attributes': false,
  // New settings
  'security.pkce_required': false,
  'security.pkce_s256_required': true,
  'security.par_required': false,
  'security.nonce_required': true,
  'security.https_redirect_only': true,
  'security.allow_http_redirect': false,
  'security.loopback_flexible_port': true,
  'security.https_request_uri': true,
  'security.jwt_clock_skew_seconds': 60,
  'security.saml_clock_skew_seconds': 180,
  'security.min_response_time': 500,
  'security.jitter': 100,
  'security.token_binding_required': false,
  'security.mutual_tls_required': false,
  'security.sender_constrained_tokens': false,
  'security.require_signed_request_object': false,
  'security.require_encrypted_request_object': false,
  'security.ip_allowlist_enabled': false,
  'security.ip_blocklist_enabled': false,
};
