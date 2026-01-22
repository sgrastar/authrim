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
  'feature.enable_token_exchange': boolean;
  'feature.enable_client_credentials': boolean;
  'feature.enable_custom_claims': boolean;

  // Development & Testing
  'feature.enable_test_endpoints': boolean;
  'feature.enable_check_api': boolean;
  'feature.enable_mock_auth': boolean;

  // Cache Features
  'feature.introspection_cache_enabled': boolean;

  // Conformance Testing
  'feature.conformance_enabled': boolean;
  'feature.conformance_use_builtin_forms': boolean;

  // UI Contract / Flow Engine
  'feature.enable_flow_engine': boolean;
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
    description: 'Enable Attribute-Based Access Control',
    visibility: 'page', // Managed on Attributes page
  },
  'feature.enable_rebac': {
    key: 'feature.enable_rebac',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_REBAC',
    label: 'Enable ReBAC',
    description: 'Enable Relationship-Based Access Control',
    visibility: 'page', // Managed on ReBAC page
  },
  'feature.enable_policy_logging': {
    key: 'feature.enable_policy_logging',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_POLICY_LOGGING',
    label: 'Enable Policy Logging',
    description: 'Log policy evaluation decisions for debugging',
    visibility: 'admin',
  },
  'feature.enable_verified_attributes': {
    key: 'feature.enable_verified_attributes',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_VERIFIED_ATTRIBUTES',
    label: 'Enable Verified Attributes',
    description: 'Enable verified attribute claims in tokens',
    visibility: 'admin',
  },
  'feature.enable_custom_rules': {
    key: 'feature.enable_custom_rules',
    type: 'boolean',
    default: true,
    envKey: 'ENABLE_CUSTOM_RULES',
    label: 'Enable Custom Rules',
    description: 'Allow custom policy rules',
    visibility: 'page', // Managed on Policies page
  },
  'feature.enable_policy_embedding': {
    key: 'feature.enable_policy_embedding',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_POLICY_EMBEDDING',
    label: 'Enable Policy Embedding',
    description: 'Enable embedding policy decisions in tokens',
    visibility: 'admin',
  },
  'feature.enable_id_level_permissions': {
    key: 'feature.enable_id_level_permissions',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_ID_LEVEL_PERMISSIONS',
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
    label: 'Enable SD-JWT',
    description: 'Enable Selective Disclosure JWT support',
    visibility: 'admin',
  },
  'feature.enable_token_exchange': {
    key: 'feature.enable_token_exchange',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_TOKEN_EXCHANGE',
    label: 'Enable Token Exchange',
    description: 'Enable OAuth 2.0 Token Exchange (RFC 8693)',
    visibility: 'admin',
  },
  'feature.enable_client_credentials': {
    key: 'feature.enable_client_credentials',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_CLIENT_CREDENTIALS',
    label: 'Enable Client Credentials',
    description: 'Enable Client Credentials grant type',
    visibility: 'admin',
  },
  'feature.enable_custom_claims': {
    key: 'feature.enable_custom_claims',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_CUSTOM_CLAIMS',
    label: 'Enable Custom Claims',
    description: 'Allow custom claims in ID tokens and UserInfo',
    visibility: 'admin',
  },

  // Development & Testing
  'feature.enable_test_endpoints': {
    key: 'feature.enable_test_endpoints',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_TEST_ENDPOINTS',
    label: 'Enable Test Endpoints',
    description: 'Enable test/debug API endpoints (development only)',
    visibility: 'internal',
  },
  'feature.enable_check_api': {
    key: 'feature.enable_check_api',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_CHECK_API',
    label: 'Enable Check API',
    description: 'Enable /api/check endpoint for permission checking',
    visibility: 'admin',
  },
  'feature.enable_mock_auth': {
    key: 'feature.enable_mock_auth',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_MOCK_AUTH',
    label: 'Enable Mock Auth',
    description: 'Enable mock authentication for testing (development only)',
    visibility: 'internal',
  },

  // Cache Features
  'feature.introspection_cache_enabled': {
    key: 'feature.introspection_cache_enabled',
    type: 'boolean',
    default: true,
    envKey: 'INTROSPECTION_CACHE_ENABLED',
    label: 'Introspection Cache Enabled',
    description: 'Enable caching of token introspection results',
    visibility: 'admin',
  },

  // Conformance Testing
  'feature.conformance_enabled': {
    key: 'feature.conformance_enabled',
    type: 'boolean',
    default: false,
    envKey: 'CONFORMANCE_ENABLED',
    label: 'Conformance Mode',
    description: 'Enable OIDC conformance testing mode',
    visibility: 'admin',
  },
  'feature.conformance_use_builtin_forms': {
    key: 'feature.conformance_use_builtin_forms',
    type: 'boolean',
    default: true,
    envKey: 'CONFORMANCE_USE_BUILTIN_FORMS',
    label: 'Use Built-in Forms',
    description: 'Use built-in login/consent forms in conformance mode',
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
  'feature.enable_token_exchange': false,
  'feature.enable_client_credentials': false,
  'feature.enable_custom_claims': false,

  // Development & Testing
  'feature.enable_test_endpoints': false,
  'feature.enable_check_api': false,
  'feature.enable_mock_auth': false,

  // Cache Features
  'feature.introspection_cache_enabled': true,

  // Conformance Testing
  'feature.conformance_enabled': false,
  'feature.conformance_use_builtin_forms': true,

  // UI Contract / Flow Engine
  'feature.enable_flow_engine': false,
};
