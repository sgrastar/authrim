/**
 * Feature Flags Settings Category
 *
 * Feature toggles for enabling/disabling functionality.
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/feature-flags
 * Config Level: tenant
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

/**
 * Feature Flags Settings Interface
 */
export interface FeatureFlagsSettings {
  // Policy & Authorization
  'feature.enable_abac': boolean;
  'feature.enable_rebac': boolean;
  'feature.enable_policy_logging': boolean;
  'feature.enable_verified_attributes': boolean;
  'feature.enable_custom_rules': boolean;
  'feature.enable_policy_embedding': boolean;
  'feature.enable_id_level_permissions': boolean;

  // Token Features
  'feature.enable_sd_jwt': boolean;
  'feature.enable_client_credentials': boolean;
  'feature.enable_custom_claims': boolean;
  'feature.enable_custom_claim_schemas': boolean;
  'feature.enable_custom_claim_schemas_introspection': boolean;

  'feature.enable_check_api': boolean;

  // Cache Features
  'feature.introspection_cache_enabled': boolean;

  // Conformance Testing
  'feature.conformance_enabled': boolean;

  // UI Contract / Flow Engine
  'feature.enable_flow_engine': boolean;
  'feature.enable_rar': boolean;
  'feature.enable_ai_scopes': boolean;
  'feature.enable_ai_ephemeral_auth': boolean;
  'feature.enable_id_jag': boolean;
}

/**
 * Feature Flags Settings Metadata
 */
export const FEATURE_FLAGS_SETTINGS_META: Record<keyof FeatureFlagsSettings, SettingMeta> = {
  // Policy & Authorization
  'feature.enable_abac': {
    key: 'feature.enable_abac',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_ABAC',
    label: 'Enable ABAC',
    description:
      'Evaluate attribute-based policy rules in permission checks (the Check API), after roles, ID-level permissions and relationships',
    visibility: 'page', // Managed on Attributes page
  },
  'feature.enable_rebac': {
    key: 'feature.enable_rebac',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_REBAC',
    label: 'Enable ReBAC',
    description: 'Enable the policy service relationship (ReBAC) check endpoints',
    visibility: 'page', // Managed on ReBAC page
  },
  'feature.enable_policy_logging': {
    key: 'feature.enable_policy_logging',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_POLICY_LOGGING',
    label: 'Enable Policy Logging',
    description:
      'Log each permission check decision (subject, permission, result and the rule that decided it)',
    visibility: 'admin',
  },
  'feature.enable_verified_attributes': {
    key: 'feature.enable_verified_attributes',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_VERIFIED_ATTRIBUTES',
    label: 'Enable Verified Attributes',
    description: "Use users' verified attributes in attribute-based policy rules",
    visibility: 'admin',
  },
  'feature.enable_custom_rules': {
    key: 'feature.enable_custom_rules',
    type: 'boolean',
    default: true,
    envKey: 'ENABLE_CUSTOM_RULES',
    label: 'Enable Custom Rules',
    description: "Evaluate the tenant's custom policy rules in attribute-based checks",
    visibility: 'page', // Managed on Policies page
  },
  'feature.enable_policy_embedding': {
    key: 'feature.enable_policy_embedding',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_POLICY_EMBEDDING',
    // As token issuance has always read it.
    envBoolean: 'exactly-true',
    label: 'Enable Policy Embedding',
    description: 'Enable embedding policy decisions in tokens',
    visibility: 'admin',
  },
  'feature.enable_id_level_permissions': {
    key: 'feature.enable_id_level_permissions',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_ID_LEVEL_PERMISSIONS',
    // As token issuance reads it.
    envBoolean: 'exactly-true',
    label: 'Enable ID-Level Permissions',
    description: 'Enable fine-grained ID-level permission checks',
    visibility: 'admin',
  },

  // Token Features
  'feature.enable_sd_jwt': {
    key: 'feature.enable_sd_jwt',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_SD_JWT',
    // As token issuance reads it.
    envBoolean: 'exactly-true',
    label: 'Enable SD-JWT',
    description: 'Issue SD-JWT ID tokens (RFC 9901) to clients that request them',
    visibility: 'admin',
  },
  'feature.enable_client_credentials': {
    key: 'feature.enable_client_credentials',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_CLIENT_CREDENTIALS',
    envBoolean: 'exactly-true',
    label: 'Enable Client Credentials',
    description: 'Enable Client Credentials grant type',
    visibility: 'admin',
  },
  'feature.enable_custom_claims': {
    key: 'feature.enable_custom_claims',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_CUSTOM_CLAIMS',
    // As token issuance reads it.
    envBoolean: 'exactly-true',
    label: 'Enable Token Claim Rules',
    description: 'Add the claims of the token claim rules to access tokens',
    visibility: 'admin',
  },
  'feature.enable_custom_claim_schemas': {
    key: 'feature.enable_custom_claim_schemas',
    type: 'boolean',
    default: false,
    label: 'Enable Custom Claim Schemas',
    description:
      'Add the claims of the custom claim schemas to ID tokens, UserInfo and verifiable credentials',
    visibility: 'admin',
  },
  'feature.enable_custom_claim_schemas_introspection': {
    key: 'feature.enable_custom_claim_schemas_introspection',
    type: 'boolean',
    default: false,
    label: 'Custom Claim Schemas in Introspection',
    description: 'Also add the claims of the custom claim schemas to token introspection responses',
    visibility: 'admin',
    dependsOn: [{ key: 'feature.enable_custom_claim_schemas', value: true }],
  },

  'feature.enable_check_api': {
    key: 'feature.enable_check_api',
    // The Check API is turned on or off before the request's tenant is known: platform only.
    scopes: ['platform'],
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_CHECK_API',
    // As the Check API reads it: on only as 'true'.
    envBoolean: 'exactly-true',
    label: 'Enable Check API',
    description: 'Enable /api/check endpoint for permission checking, for the whole platform',
    visibility: 'admin',
  },

  // Cache Features
  'feature.introspection_cache_enabled': {
    key: 'feature.introspection_cache_enabled',
    type: 'boolean',
    default: true,
    envKey: 'ENABLE_INTROSPECTION_CACHE',
    envBoolean: 'exactly-true',
    label: 'Introspection Cache Enabled',
    description: 'Enable caching of token introspection results',
    visibility: 'admin',
  },

  // Conformance Testing
  'feature.conformance_enabled': {
    key: 'feature.conformance_enabled',
    // Conformance mode applies to the whole deployment; tenants cannot set it.
    scopes: ['platform'],
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_CONFORMANCE_MODE',
    envEmpty: 'false',
    label: 'Conformance Mode',
    description:
      'Enable conformance-test-only behaviour for OpenID Foundation certification runs (for example, certification-suite clients registered without a scope get the standard scopes). Sign-in still goes through the Login UI. Must be disabled in production environments.',
    visibility: 'admin',
  },

  // UI Contract / Flow Engine
  'feature.enable_flow_engine': {
    key: 'feature.enable_flow_engine',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_FLOW_ENGINE',
    label: 'Enable Flow Engine',
    description:
      'Enable server-driven UI flows (UI Contract). When disabled, standard OIDC flows will be used.',
    visibility: 'admin',
  },
  'feature.enable_rar': {
    key: 'feature.enable_rar',
    type: 'boolean',
    envKey: 'ENABLE_RAR',
    envBoolean: 'exactly-true',
    label: 'Rich Authorization Requests',
    description:
      'Accept authorization_details (RFC 9396) at authorize and PAR, and advertise the supported types',
    visibility: 'admin',
    default: false,
  },
  'feature.enable_ai_scopes': {
    key: 'feature.enable_ai_scopes',
    type: 'boolean',
    envKey: 'ENABLE_AI_SCOPES',
    envBoolean: 'exactly-true',
    label: 'AI Scopes',
    description: 'Advertise the ai:* scopes (ai:read, ai:write, ai:execute, ai:admin) in discovery',
    visibility: 'admin',
    default: false,
  },
  'feature.enable_ai_ephemeral_auth': {
    key: 'feature.enable_ai_ephemeral_auth',
    type: 'boolean',
    envKey: 'ENABLE_AI_EPHEMERAL_AUTH',
    envBoolean: 'exactly-true',
    label: 'AI Ephemeral Auth',
    description: "Allow tenants to use the 'ai_ephemeral' tenant profile",
    visibility: 'admin',
    default: false,
  },
  'feature.enable_id_jag': {
    key: 'feature.enable_id_jag',
    type: 'boolean',
    envKey: 'ENABLE_ID_JAG',
    envBoolean: 'exactly-true',
    label: 'ID-JAG',
    description: 'Issue Identity Assertion Authorization Grants (ID-JAG) through Token Exchange',
    visibility: 'admin',
    default: false,
  },
};

/**
 * Feature Flags Category Metadata
 */
export const FEATURE_FLAGS_CATEGORY_META: CategoryMeta = {
  category: 'feature-flags',
  label: 'Feature Flags',
  description: 'Feature toggles for enabling/disabling functionality',
  settings: FEATURE_FLAGS_SETTINGS_META,
};

/**
 * Default Feature Flags settings values
 */
export const FEATURE_FLAGS_DEFAULTS: FeatureFlagsSettings = {
  // Policy & Authorization
  'feature.enable_abac': false,
  'feature.enable_rebac': false,
  'feature.enable_policy_logging': false,
  'feature.enable_verified_attributes': false,
  'feature.enable_custom_rules': true,
  'feature.enable_policy_embedding': false,
  'feature.enable_id_level_permissions': false,

  // Token Features
  'feature.enable_sd_jwt': false,
  'feature.enable_client_credentials': false,
  'feature.enable_custom_claims': false,
  'feature.enable_custom_claim_schemas': false,
  'feature.enable_custom_claim_schemas_introspection': false,

  'feature.enable_check_api': false,

  // Cache Features
  'feature.introspection_cache_enabled': true,

  // Conformance Testing
  'feature.conformance_enabled': false,

  // UI Contract / Flow Engine
  'feature.enable_flow_engine': false,
  'feature.enable_rar': false,
  'feature.enable_ai_scopes': false,
  'feature.enable_ai_ephemeral_auth': false,
  'feature.enable_id_jag': false,
};
