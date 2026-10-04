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
  'security.dpop_nonce_resource_overrides': Record<string, boolean>;

  // OAuth Security Requirements
  'security.pkce_required': boolean;
  'security.par_required': boolean;
  'security.https_redirect_only': boolean;

  // Request Object Requirements
  'security.require_signed_request_object': boolean;
  'security.require_encrypted_request_object': boolean;

  // Redirect Safety
  'security.trusted_redirect_origins': string;
  'security.allow_unsigned_request_object': boolean;
  'security.dpop_required': 'with_fapi' | 'always' | 'never';
  'security.fapi_client_assertion_audience': 'endpoint_or_issuer' | 'issuer';
  'security.fapi_require_private_key_jwt': boolean;
  'security.fapi_message_signing_enabled': boolean;
  'security.require_jarm': boolean;
  'security.request_object_signing_algs': string;
  'security.authorization_signing_algs': string;
  'security.default_authorization_signing_alg': 'RS256' | 'ES256' | 'PS256';
  'security.request_object_max_age_seconds': number;
  'security.request_object_max_lifetime_seconds': number;
  'security.request_object_clock_skew_seconds': number;
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
    label: 'FAPI Mode',
    description:
      'Enable the FAPI 2.0 Security Profile. Requests it does not allow, such as authorization requests without PAR, are refused, so apps that do not support FAPI may stop working. Discovery keeps working as the specification describes.',
    visibility: 'public',
  },
  'security.fapi_strict_dpop': {
    key: 'security.fapi_strict_dpop',
    type: 'boolean',
    default: true,
    label: 'FAPI Strict DPoP',
    description: 'Require DPoP for all FAPI requests',
    visibility: 'public',
    dependsOn: [{ key: 'security.fapi_enabled', value: true }],
  },
  'security.fapi_allow_public_clients': {
    key: 'security.fapi_allow_public_clients',
    type: 'boolean',
    // Allowed unless set otherwise, as FAPI mode has always behaved.
    default: true,
    envKey: 'FAPI_ALLOW_PUBLIC_CLIENTS',
    // As authorization reads it: anything but 'false' (or '0') allows.
    envBoolean: 'unless-false',
    label: 'FAPI Allow Public Clients',
    description: 'Allow public clients in FAPI mode (not recommended)',
    visibility: 'admin',
    dependsOn: [{ key: 'security.fapi_enabled', value: true }],
  },

  // DPoP Settings
  'security.dpop_bound_access_tokens': {
    key: 'security.dpop_bound_access_tokens',
    // Per tenant (or app) only, as before the category had platform values.
    scopes: ['tenant', 'client'],
    type: 'boolean',
    default: false,
    envKey: 'DPOP_BOUND_ACCESS_TOKENS',
    label: 'DPoP Bound Tokens',
    description:
      "Require a DPoP proof at the token endpoint, so every access token is DPoP-bound (RFC 9449). An app can turn it on as well, but cannot waive the tenant's requirement. Authorization requests are not affected. security.dpop_required governs DPoP under FAPI",
    visibility: 'public',
  },
  'security.dpop_nonce_enabled': {
    key: 'security.dpop_nonce_enabled',
    type: 'boolean',
    default: true,
    label: 'DPoP Nonce Required',
    description: 'Require server-provided nonce in DPoP proofs',
    visibility: 'public',
  },
  'security.dpop_nonce_resource_overrides': {
    key: 'security.dpop_nonce_resource_overrides',
    type: 'json',
    default: {},
    label: 'DPoP Nonce by Resource',
    description:
      'Whether the token endpoint asks for a DPoP nonce, by resource URI (true or false); these go before DPoP Nonce Required',
    visibility: 'admin',
  },

  // OAuth Security Requirements (canonical location - oauth.ts redirects here)
  'security.pkce_required': {
    key: 'security.pkce_required',
    // Per tenant (or app) only, as before the category had platform values.
    scopes: ['tenant', 'client'],
    type: 'boolean',
    default: false,
    envKey: 'SECURITY_PKCE_REQUIRED',
    label: 'PKCE Required',
    description:
      "Require PKCE (S256) for every authorization code request. An app can require it as well, but cannot waive the tenant's requirement",
    visibility: 'public',
  },
  'security.par_required': {
    key: 'security.par_required',
    type: 'boolean',
    default: false,
    label: 'PAR Required',
    description: 'Require Pushed Authorization Requests (FAPI mode always requires them)',
    visibility: 'public',
  },
  'security.https_redirect_only': {
    key: 'security.https_redirect_only',
    // Per tenant (or app) only, as before the category had platform values.
    scopes: ['tenant', 'client'],
    type: 'boolean',
    default: true,
    envKey: 'HTTPS_REDIRECT_ONLY',
    label: 'HTTPS Redirect Only',
    description:
      "Allow only HTTPS redirect URIs, except a native app's loopback (RFC 8252). Off: a web app may also use http on a loopback host (development). An app can keep HTTPS only where the tenant allows http",
    visibility: 'admin',
  },

  // Request Object Requirements
  'security.require_signed_request_object': {
    key: 'security.require_signed_request_object',
    type: 'boolean',
    default: false,
    label: 'Signed Request Required',
    description: 'Require signed request objects (JAR)',
    visibility: 'admin',
  },
  'security.require_encrypted_request_object': {
    key: 'security.require_encrypted_request_object',
    // Per tenant (or app) only, as before the category had platform values.
    scopes: ['tenant', 'client'],
    type: 'boolean',
    default: false,
    envKey: 'REQUIRE_ENCRYPTED_REQUEST_OBJECT',
    label: 'Encrypted Request Required',
    description: 'Require encrypted request objects',
    visibility: 'admin',
    status: 'in_development',
  },

  'security.trusted_redirect_origins': {
    key: 'security.trusted_redirect_origins',
    // Per tenant (or app) only, as before the category had platform values.
    scopes: ['tenant', 'client'],
    type: 'string',
    default: '[]',
    label: 'Trusted Redirect Origins',
    description:
      'JSON array or comma-separated list of HTTPS origins allowed for Login UI post-login redirects.',
    visibility: 'admin',
  },
  'security.allow_unsigned_request_object': {
    key: 'security.allow_unsigned_request_object',
    type: 'boolean',
    label: 'Allow Unsigned Request Objects',
    description: "Accept request objects signed with alg 'none' outside production (testing only)",
    visibility: 'admin',
    default: false,
  },
  'security.dpop_required': {
    key: 'security.dpop_required',
    type: 'enum',
    enum: ['with_fapi', 'always', 'never'],
    label: 'DPoP Required',
    description: 'When the token endpoint requires DPoP: in FAPI mode, always, or never',
    visibility: 'admin',
    default: 'with_fapi',
  },
  'security.fapi_client_assertion_audience': {
    key: 'security.fapi_client_assertion_audience',
    type: 'enum',
    enum: ['endpoint_or_issuer', 'issuer'],
    label: 'Client Assertion Audience',
    description:
      'Audiences accepted in client assertions at PAR: the endpoint or issuer, or the issuer only (FAPI 2.0)',
    visibility: 'admin',
    default: 'endpoint_or_issuer',
  },
  'security.fapi_require_private_key_jwt': {
    key: 'security.fapi_require_private_key_jwt',
    type: 'boolean',
    label: 'FAPI Requires private_key_jwt',
    description: 'In FAPI mode, require private_key_jwt client authentication at PAR',
    visibility: 'admin',
    dependsOn: [{ key: 'security.fapi_enabled', value: true }],
    default: true,
  },
  'security.fapi_message_signing_enabled': {
    key: 'security.fapi_message_signing_enabled',
    type: 'boolean',
    label: 'FAPI Message Signing',
    description:
      'Apply the FAPI 2.0 Message Signing profile (request object and authorization response signing)',
    visibility: 'admin',
    default: false,
  },
  'security.require_jarm': {
    key: 'security.require_jarm',
    type: 'boolean',
    label: 'Require JARM',
    description:
      'Require JWT-secured authorization responses (JARM), with or without message signing',
    visibility: 'admin',
    default: false,
  },
  'security.request_object_signing_algs': {
    key: 'security.request_object_signing_algs',
    type: 'string',
    label: 'Request Object Algorithms',
    description: 'Comma-separated algorithms accepted for request objects under message signing',
    visibility: 'admin',
    dependsOn: [{ key: 'security.fapi_message_signing_enabled', value: true }],
    default: 'ES256,PS256,EdDSA',
  },
  'security.authorization_signing_algs': {
    key: 'security.authorization_signing_algs',
    type: 'string',
    label: 'Authorization Response Algorithms',
    description:
      'Comma-separated algorithms allowed for signed authorization responses under message signing; empty allows any the client registered (discovery advertises ES256)',
    visibility: 'admin',
    dependsOn: [{ key: 'security.fapi_message_signing_enabled', value: true }],
    // None: authorization has never limited it unless a list was saved.
    default: '',
  },
  'security.default_authorization_signing_alg': {
    key: 'security.default_authorization_signing_alg',
    type: 'enum',
    enum: ['RS256', 'ES256', 'PS256'],
    label: 'Default Authorization Response Algorithm',
    description: 'Algorithm for signed authorization responses when the client registered none',
    visibility: 'admin',
    dependsOn: [{ key: 'security.fapi_message_signing_enabled', value: true }],
    default: 'RS256',
  },
  'security.request_object_max_age_seconds': {
    key: 'security.request_object_max_age_seconds',
    type: 'number',
    label: 'Request Object Max Age',
    description: 'How far in the past a request object nbf may be under message signing',
    unit: 'seconds',
    min: 1,
    max: 86400,
    integer: true,
    visibility: 'admin',
    dependsOn: [{ key: 'security.fapi_message_signing_enabled', value: true }],
    default: 3600,
  },
  'security.request_object_max_lifetime_seconds': {
    key: 'security.request_object_max_lifetime_seconds',
    type: 'number',
    label: 'Request Object Max Lifetime',
    description: 'Longest exp - nbf of a request object under message signing',
    unit: 'seconds',
    min: 1,
    max: 86400,
    integer: true,
    visibility: 'admin',
    dependsOn: [{ key: 'security.fapi_message_signing_enabled', value: true }],
    default: 3600,
  },
  'security.request_object_clock_skew_seconds': {
    key: 'security.request_object_clock_skew_seconds',
    type: 'number',
    label: 'Request Object Clock Skew',
    description: 'Clock tolerance for request object time claims under message signing',
    unit: 'seconds',
    min: 0,
    max: 600,
    integer: true,
    visibility: 'admin',
    dependsOn: [{ key: 'security.fapi_message_signing_enabled', value: true }],
    default: 10,
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
  'security.fapi_strict_dpop': true,
  'security.fapi_allow_public_clients': true,
  'security.dpop_bound_access_tokens': false,
  'security.dpop_nonce_enabled': true,
  'security.dpop_nonce_resource_overrides': {},
  // New settings
  'security.pkce_required': false,
  'security.par_required': false,
  'security.https_redirect_only': true,
  'security.require_signed_request_object': false,
  'security.require_encrypted_request_object': false,
  'security.trusted_redirect_origins': '[]',
  'security.allow_unsigned_request_object': false,
  'security.dpop_required': 'with_fapi',
  'security.fapi_client_assertion_audience': 'endpoint_or_issuer',
  'security.fapi_require_private_key_jwt': true,
  'security.fapi_message_signing_enabled': false,
  'security.require_jarm': false,
  'security.request_object_signing_algs': 'ES256,PS256,EdDSA',
  'security.authorization_signing_algs': '',
  'security.default_authorization_signing_alg': 'RS256',
  'security.request_object_max_age_seconds': 3600,
  'security.request_object_max_lifetime_seconds': 3600,
  'security.request_object_clock_skew_seconds': 10,
};
