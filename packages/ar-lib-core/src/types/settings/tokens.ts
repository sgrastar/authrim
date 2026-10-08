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
  'tokens.introspection_strict_validation': boolean;
  'tokens.introspection_extended_claims': boolean;

  // RBAC Claims Embedding
  'tokens.rbac_id_token_claims': string;
  'tokens.rbac_access_token_claims': string;
  'tokens.exchange_allowed_subject_token_types': string;
  'tokens.id_jag_allowed_issuers': string[];
  'tokens.id_jag_max_token_lifetime': number;
  'tokens.id_jag_include_tenant_claim': boolean;
  'tokens.id_jag_require_confidential_client': boolean;
  'tokens.introspection_expected_audience': string;
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
    // Per tenant (or app) only, as before the category had platform values.
    scopes: ['tenant'],
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_TOKEN_EXCHANGE_DELEGATION',
    label: 'Delegation Enabled',
    description:
      "Allow delegation use case in token exchange. In development: each app's delegation_mode decides it; this setting is not read yet.",
    visibility: 'admin',
    status: 'in_development',
    dependsOn: [{ key: 'tokens.exchange_enabled', value: true }],
  },
  'tokens.exchange_impersonation_enabled': {
    key: 'tokens.exchange_impersonation_enabled',
    // Per tenant (or app) only, as before the category had platform values.
    scopes: ['tenant'],
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_TOKEN_EXCHANGE_IMPERSONATION',
    label: 'Impersonation Enabled',
    description: 'Allow impersonation use case in token exchange (security sensitive)',
    visibility: 'admin',
    dependsOn: [{ key: 'tokens.exchange_enabled', value: true }],
    status: 'in_development',
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
  'tokens.introspection_extended_claims': {
    key: 'tokens.introspection_extended_claims',
    // Per tenant (or app) only, as before the category had platform values.
    scopes: ['tenant'],
    type: 'boolean',
    default: false,
    envKey: 'INTROSPECTION_EXTENDED_CLAIMS',
    label: 'Extended Introspection Claims',
    description: 'Include extended claims in introspection response',
    visibility: 'admin',
    status: 'in_development',
  },

  // RBAC Claims Embedding
  'tokens.rbac_id_token_claims': {
    key: 'tokens.rbac_id_token_claims',
    // Per tenant (or app) only, as before the category had platform values.
    scopes: ['tenant'],
    type: 'string',
    default: 'roles,user_type,org_id,plan,org_type',
    envKey: 'RBAC_ID_TOKEN_CLAIMS',
    label: 'ID Token RBAC Claims',
    description: 'Comma-separated list of RBAC claims to embed in ID tokens (none to disable)',
    visibility: 'admin',
  },
  'tokens.rbac_access_token_claims': {
    key: 'tokens.rbac_access_token_claims',
    // Per tenant (or app) only, as before the category had platform values.
    scopes: ['tenant'],
    type: 'string',
    default: 'roles,org_id,org_type',
    envKey: 'RBAC_ACCESS_TOKEN_CLAIMS',
    label: 'Access Token RBAC Claims',
    description: 'Comma-separated list of RBAC claims to embed in access tokens (none to disable)',
    visibility: 'admin',
  },
  'tokens.exchange_allowed_subject_token_types': {
    key: 'tokens.exchange_allowed_subject_token_types',
    type: 'string',
    envKey: 'TOKEN_EXCHANGE_ALLOWED_TYPES',
    label: 'Token Exchange: Subject Token Types',
    description:
      'Comma-separated subject token types accepted by Token Exchange: access_token, jwt, id_token (refresh_token is never accepted)',
    visibility: 'admin',
    default: 'access_token',
  },
  'tokens.id_jag_allowed_issuers': {
    key: 'tokens.id_jag_allowed_issuers',
    type: 'json',
    label: 'ID-JAG: Allowed Issuers',
    description:
      'Issuers (https URLs) whose ID tokens may be exchanged for an ID-JAG; an empty list trusts none, so ID-JAG requests are refused',
    visibility: 'admin',
    default: [],
  },
  'tokens.id_jag_max_token_lifetime': {
    key: 'tokens.id_jag_max_token_lifetime',
    type: 'number',
    label: 'ID-JAG: Max Lifetime',
    description: 'Longest lifetime of an issued ID-JAG',
    unit: 'seconds',
    min: 60,
    max: 86400,
    integer: true,
    visibility: 'admin',
    default: 3600,
  },
  'tokens.id_jag_include_tenant_claim': {
    key: 'tokens.id_jag_include_tenant_claim',
    type: 'boolean',
    label: 'ID-JAG: Tenant Claim',
    description: 'Put the tenant claim in issued ID-JAGs',
    visibility: 'admin',
    default: true,
  },
  'tokens.id_jag_require_confidential_client': {
    key: 'tokens.id_jag_require_confidential_client',
    type: 'boolean',
    label: 'ID-JAG: Confidential Clients Only',
    description: 'Issue ID-JAGs only to confidential clients',
    visibility: 'admin',
    default: true,
  },
  'tokens.introspection_expected_audience': {
    key: 'tokens.introspection_expected_audience',
    type: 'string',
    envKey: 'INTROSPECTION_EXPECTED_AUDIENCE',
    label: 'Introspection: Expected Audience',
    description:
      'Report tokens whose audience does not include this value as inactive; empty skips the check',
    visibility: 'admin',
    default: '',
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
  'tokens.introspection_strict_validation': false,
  'tokens.introspection_extended_claims': false,
  'tokens.rbac_id_token_claims': 'roles,user_type,org_id,plan,org_type',
  'tokens.rbac_access_token_claims': 'roles,org_id,org_type',
  'tokens.exchange_allowed_subject_token_types': 'access_token',
  'tokens.id_jag_allowed_issuers': [],
  'tokens.id_jag_max_token_lifetime': 3600,
  'tokens.id_jag_include_tenant_claim': true,
  'tokens.id_jag_require_confidential_client': true,
  'tokens.introspection_expected_audience': '',
};
