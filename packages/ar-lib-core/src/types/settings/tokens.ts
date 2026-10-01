/**
 * Tokens Settings Category
 *
 * Settings related to token exchange and introspection.
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/tokens
 * Config Level: tenant
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

/**
 * Tokens Settings Interface
 */
export interface TokensSettings {
  // Token Exchange
  'tokens.exchange_enabled': boolean;
  'tokens.exchange_delegation_enabled': boolean;
  'tokens.exchange_impersonation_enabled': boolean;

  // Token Introspection
  'tokens.introspection_cache_ttl': number;
  'tokens.introspection_require_client_auth': boolean;
  'tokens.introspection_strict_validation': boolean;
  'tokens.introspection_cache_max_size': number;
  'tokens.introspection_cache_inactive': number;
  'tokens.introspection_extended_claims': boolean;

  // Token Signing Key Selection
  'tokens.access_token_signing_key_id': string;
  'tokens.id_token_signing_key_id': string;
  'tokens.userinfo_signing_key_id': string;
  'tokens.access_token_singularization': boolean;

  // RBAC Claims Embedding
  'tokens.rbac_id_token_claims': string;
  'tokens.rbac_access_token_claims': string;
}

/**
 * Tokens Settings Metadata
 */
export const TOKENS_SETTINGS_META: Record<keyof TokensSettings, SettingMeta> = {
  'tokens.exchange_enabled': {
    key: 'tokens.exchange_enabled',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_TOKEN_EXCHANGE',
    envBoolean: 'exactly-true',
    label: 'Token Exchange Enabled',
    description: 'Enable OAuth 2.0 Token Exchange (RFC 8693)',
    visibility: 'public',
  },
  'tokens.exchange_delegation_enabled': {
    key: 'tokens.exchange_delegation_enabled',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_TOKEN_EXCHANGE_DELEGATION',
    label: 'Delegation Enabled',
    description: 'Allow delegation use case in token exchange',
    visibility: 'admin',
    dependsOn: [{ key: 'tokens.exchange_enabled', value: true }],
  },
  'tokens.exchange_impersonation_enabled': {
    key: 'tokens.exchange_impersonation_enabled',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_TOKEN_EXCHANGE_IMPERSONATION',
    label: 'Impersonation Enabled',
    description: 'Allow impersonation use case in token exchange (security sensitive)',
    visibility: 'admin',
    dependsOn: [{ key: 'tokens.exchange_enabled', value: true }],
  },
  'tokens.introspection_cache_ttl': {
    key: 'tokens.introspection_cache_ttl',
    type: 'duration',
    integer: true,
    default: 60,
    envKey: 'INTROSPECTION_CACHE_TTL',
    envNumber: 'positive',
    label: 'Introspection Cache TTL',
    description: 'Token introspection result cache lifetime in seconds',
    min: 1,
    max: 300,
    unit: 'seconds',
    visibility: 'admin',
  },
  'tokens.introspection_require_client_auth': {
    key: 'tokens.introspection_require_client_auth',
    type: 'boolean',
    default: true,
    envKey: 'INTROSPECTION_REQUIRE_CLIENT_AUTH',
    label: 'Require Client Auth for Introspection',
    description: 'Require client authentication for token introspection',
    visibility: 'admin',
  },
  'tokens.introspection_strict_validation': {
    key: 'tokens.introspection_strict_validation',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_INTROSPECTION_STRICT_VALIDATION',
    envBoolean: 'exactly-true',
    label: 'Strict Introspection Validation',
    description: 'Enforce strict token validation during introspection',
    visibility: 'admin',
  },
  'tokens.introspection_cache_max_size': {
    key: 'tokens.introspection_cache_max_size',
    type: 'number',
    default: 10000,
    envKey: 'INTROSPECTION_CACHE_MAX_SIZE',
    label: 'Introspection Cache Max Size',
    description: 'Maximum number of tokens to cache for introspection',
    min: 100,
    max: 100000,
    visibility: 'admin',
  },
  'tokens.introspection_cache_inactive': {
    key: 'tokens.introspection_cache_inactive',
    type: 'duration',
    default: 300,
    envKey: 'INTROSPECTION_CACHE_INACTIVE',
    label: 'Introspection Cache Inactive TTL',
    description: 'Time in seconds before inactive cache entries are evicted',
    min: 60,
    max: 3600,
    unit: 'seconds',
    visibility: 'admin',
  },
  'tokens.introspection_extended_claims': {
    key: 'tokens.introspection_extended_claims',
    type: 'boolean',
    default: false,
    envKey: 'INTROSPECTION_EXTENDED_CLAIMS',
    label: 'Extended Introspection Claims',
    description: 'Include extended claims in introspection response',
    visibility: 'admin',
  },

  // Token Signing Key Selection
  'tokens.access_token_signing_key_id': {
    key: 'tokens.access_token_signing_key_id',
    type: 'string',
    default: '',
    envKey: 'ACCESS_TOKEN_SIGNING_KEY_ID',
    label: 'Access Token Signing Key ID',
    description: 'Key ID for signing access tokens (empty for default)',
    visibility: 'admin',
  },
  'tokens.id_token_signing_key_id': {
    key: 'tokens.id_token_signing_key_id',
    type: 'string',
    default: '',
    envKey: 'ID_TOKEN_SIGNING_KEY_ID',
    label: 'ID Token Signing Key ID',
    description: 'Key ID for signing ID tokens (empty for default)',
    visibility: 'admin',
  },
  'tokens.userinfo_signing_key_id': {
    key: 'tokens.userinfo_signing_key_id',
    type: 'string',
    default: '',
    envKey: 'USERINFO_SIGNING_KEY_ID',
    label: 'UserInfo Signing Key ID',
    description: 'Key ID for signing UserInfo responses (empty for default)',
    visibility: 'admin',
  },
  'tokens.access_token_singularization': {
    key: 'tokens.access_token_singularization',
    type: 'boolean',
    default: false,
    envKey: 'ACCESS_TOKEN_SINGULARIZATION',
    label: 'Access Token Singularization',
    description: 'Revoke previous access token when new one is issued',
    visibility: 'admin',
  },

  // RBAC Claims Embedding
  'tokens.rbac_id_token_claims': {
    key: 'tokens.rbac_id_token_claims',
    type: 'string',
    default: 'roles,user_type,org_id,plan,org_type',
    envKey: 'RBAC_ID_TOKEN_CLAIMS',
    label: 'ID Token RBAC Claims',
    description: 'Comma-separated list of RBAC claims to embed in ID tokens (none to disable)',
    visibility: 'admin',
  },
  'tokens.rbac_access_token_claims': {
    key: 'tokens.rbac_access_token_claims',
    type: 'string',
    default: 'roles,org_id,org_type',
    envKey: 'RBAC_ACCESS_TOKEN_CLAIMS',
    label: 'Access Token RBAC Claims',
    description: 'Comma-separated list of RBAC claims to embed in access tokens (none to disable)',
    visibility: 'admin',
  },
};

/**
 * Tokens Category Metadata
 */
export const TOKENS_CATEGORY_META: CategoryMeta = {
  category: 'tokens',
  label: 'Tokens',
  description: 'Token exchange and introspection settings',
  settings: TOKENS_SETTINGS_META,
};

/**
 * Default Tokens settings values
 */
export const TOKENS_DEFAULTS: TokensSettings = {
  'tokens.exchange_enabled': false,
  'tokens.exchange_delegation_enabled': false,
  'tokens.exchange_impersonation_enabled': false,
  'tokens.introspection_cache_ttl': 60,
  'tokens.introspection_require_client_auth': true,
  'tokens.introspection_strict_validation': false,
  'tokens.introspection_cache_max_size': 10000,
  'tokens.introspection_cache_inactive': 300,
  'tokens.introspection_extended_claims': false,
  'tokens.access_token_signing_key_id': '',
  'tokens.id_token_signing_key_id': '',
  'tokens.userinfo_signing_key_id': '',
  'tokens.access_token_singularization': false,
  'tokens.rbac_id_token_claims': 'roles,user_type,org_id,plan,org_type',
  'tokens.rbac_access_token_claims': 'roles,org_id,org_type',
};
