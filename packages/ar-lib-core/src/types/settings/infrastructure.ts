/**
 * Infrastructure Settings Category (Platform)
 *
 * Platform-level infrastructure settings (read-only via API).
 * API: GET /api/admin/platform/settings/infrastructure
 * Config Level: platform (read-only)
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

/**
 * Infrastructure Settings Interface
 */
export interface InfrastructureSettings {
  // Sharding Configuration
  'infra.code_shards': number;
  'infra.session_shards': number;
  'infra.challenge_shards': number;
  'infra.revocation_shards': number;

  // Region Sharding
  'infra.region_total_shards': number;
  'infra.region_enam_percent': number;
  'infra.region_weur_percent': number;
  'infra.region_apac_percent': number;
  'infra.region_generation': number;

  // Cache Configuration
  'infra.config_cache_ttl': number;
  'infra.tenant_context_cache_ttl': number;
  'infra.key_cache_ttl': number;
  'infra.jwks_cache_ttl': number;
  'infra.feature_flags_cache_ttl': number;

  // Retry Configuration
  'infra.retry_max': number;
  'infra.retry_initial_delay': number;
  'infra.retry_max_delay': number;
  'infra.backoff_multiplier': number;

  // Timeout Configuration
  'infra.default_fetch_timeout_ms': number;

  // Supported Algorithms (platform-level, read-only)
  'infra.supported_signing_algs': string;
  'infra.dpop_signing_alg_values_supported': string;

  // Durable Objects Configuration
  'infra.do_cleanup_interval': number;
  'infra.do_audit_flush_delay': number;
  'infra.do_saml_request_expiry': number;
  'infra.do_saml_artifact_expiry': number;
}

/**
 * Infrastructure Settings Metadata
 */
export const INFRASTRUCTURE_SETTINGS_META: Record<keyof InfrastructureSettings, SettingMeta> = {
  // Sharding Configuration
  'infra.code_shards': {
    key: 'infra.code_shards',
    type: 'number',
    default: 64,
    envKey: 'AUTHRIM_CODE_SHARDS',
    label: 'Auth Code Shards',
    description: 'Number of Durable Object shards for authorization codes',
    min: 1,
    max: 256,
    visibility: 'admin',
  },
  'infra.session_shards': {
    key: 'infra.session_shards',
    type: 'number',
    default: 64,
    envKey: 'AUTHRIM_SESSION_SHARDS',
    label: 'Session Shards',
    description: 'Number of Durable Object shards for sessions',
    min: 1,
    max: 256,
    visibility: 'admin',
  },
  'infra.challenge_shards': {
    key: 'infra.challenge_shards',
    type: 'number',
    default: 64,
    envKey: 'AUTHRIM_CHALLENGE_SHARDS',
    label: 'Challenge Shards',
    description: 'Number of Durable Object shards for challenges',
    min: 1,
    max: 256,
    visibility: 'admin',
  },
  'infra.revocation_shards': {
    key: 'infra.revocation_shards',
    type: 'number',
    default: 64,
    envKey: 'AUTHRIM_REVOCATION_SHARDS',
    label: 'Revocation Shards',
    description: 'Number of Durable Object shards for token revocation',
    min: 1,
    max: 256,
    visibility: 'admin',
  },

  // Region Sharding
  'infra.region_total_shards': {
    key: 'infra.region_total_shards',
    type: 'number',
    default: 100,
    envKey: 'REGION_SHARD_TOTAL_SHARDS',
    label: 'Total Region Shards',
    description: 'Total number of shards for region-based distribution',
    min: 10,
    max: 1000,
    visibility: 'admin',
  },
  'infra.region_enam_percent': {
    key: 'infra.region_enam_percent',
    type: 'number',
    default: 40,
    envKey: 'REGION_SHARD_ENAM_PERCENT',
    label: 'ENAM Region Percent',
    description: 'Percentage of shards for Eastern North America',
    min: 0,
    max: 100,
    visibility: 'admin',
  },
  'infra.region_weur_percent': {
    key: 'infra.region_weur_percent',
    type: 'number',
    default: 35,
    envKey: 'REGION_SHARD_WEUR_PERCENT',
    label: 'WEUR Region Percent',
    description: 'Percentage of shards for Western Europe',
    min: 0,
    max: 100,
    visibility: 'admin',
  },
  'infra.region_apac_percent': {
    key: 'infra.region_apac_percent',
    type: 'number',
    default: 25,
    envKey: 'REGION_SHARD_APAC_PERCENT',
    label: 'APAC Region Percent',
    description: 'Percentage of shards for Asia Pacific',
    min: 0,
    max: 100,
    visibility: 'admin',
  },
  'infra.region_generation': {
    key: 'infra.region_generation',
    type: 'number',
    default: 1,
    envKey: 'REGION_SHARD_GENERATION',
    label: 'Shard Generation',
    description: 'Generation number for shard migration',
    min: 1,
    max: 100,
    visibility: 'admin',
  },

  // Cache Configuration
  'infra.config_cache_ttl': {
    key: 'infra.config_cache_ttl',
    type: 'duration',
    default: 180,
    envKey: 'CONFIG_CACHE_TTL',
    label: 'Config Cache TTL',
    description: 'In-memory cache TTL for config values in seconds',
    min: 10,
    max: 3600,
    unit: 'seconds',
    visibility: 'admin',
  },
  'infra.tenant_context_cache_ttl': {
    key: 'infra.tenant_context_cache_ttl',
    type: 'duration',
    default: 300,
    envKey: 'TENANT_CONTEXT_CACHE_TTL',
    label: 'Tenant Context Cache TTL',
    description: 'Cache TTL for tenant context in seconds',
    min: 60,
    max: 3600,
    unit: 'seconds',
    visibility: 'admin',
  },
  'infra.key_cache_ttl': {
    key: 'infra.key_cache_ttl',
    type: 'duration',
    default: 3600,
    envKey: 'KEY_CACHE_TTL',
    label: 'Key Cache TTL',
    description: 'Cache TTL for cryptographic keys in seconds',
    min: 300,
    max: 86400,
    unit: 'seconds',
    visibility: 'admin',
  },
  'infra.jwks_cache_ttl': {
    key: 'infra.jwks_cache_ttl',
    type: 'duration',
    default: 86400,
    envKey: 'PLATFORM_JWKS_CACHE_TTL',
    label: 'Platform JWKS Cache TTL',
    description:
      'Cache TTL for platform signing keys JWKS endpoint in seconds (see external-idp.jwks_cache_ttl for external IdP keys)',
    min: 300,
    max: 604800,
    unit: 'seconds',
    visibility: 'admin',
  },
  'infra.feature_flags_cache_ttl': {
    key: 'infra.feature_flags_cache_ttl',
    type: 'duration',
    default: 60,
    envKey: 'FEATURE_FLAGS_CACHE_TTL',
    label: 'Feature Flags Cache TTL',
    description: 'Cache TTL for feature flags in seconds',
    min: 10,
    max: 600,
    unit: 'seconds',
    visibility: 'admin',
  },

  // Retry Configuration
  'infra.retry_max': {
    key: 'infra.retry_max',
    type: 'number',
    default: 3,
    envKey: 'DEFAULT_RETRY_MAX',
    label: 'Max Retries',
    description: 'Maximum retry attempts for failed operations',
    min: 0,
    max: 10,
    visibility: 'admin',
  },
  'infra.retry_initial_delay': {
    key: 'infra.retry_initial_delay',
    type: 'duration',
    default: 100,
    envKey: 'DEFAULT_RETRY_INITIAL_DELAY',
    label: 'Retry Initial Delay',
    description: 'Initial delay before first retry in milliseconds',
    min: 10,
    max: 10000,
    unit: 'ms',
    visibility: 'admin',
  },
  'infra.retry_max_delay': {
    key: 'infra.retry_max_delay',
    type: 'duration',
    default: 5000,
    envKey: 'DEFAULT_RETRY_MAX_DELAY',
    label: 'Retry Max Delay',
    description: 'Maximum delay between retries in milliseconds',
    min: 100,
    max: 60000,
    unit: 'ms',
    visibility: 'admin',
  },
  'infra.backoff_multiplier': {
    key: 'infra.backoff_multiplier',
    type: 'number',
    default: 2,
    envKey: 'BACKOFF_MULTIPLIER',
    label: 'Backoff Multiplier',
    description: 'Exponential backoff multiplier for retries',
    min: 1,
    max: 5,
    visibility: 'admin',
  },

  // Timeout Configuration
  'infra.default_fetch_timeout_ms': {
    key: 'infra.default_fetch_timeout_ms',
    type: 'duration',
    default: 5000,
    envKey: 'DEFAULT_FETCH_TIMEOUT_MS',
    label: 'Default Fetch Timeout',
    description: 'Default timeout for external fetch requests',
    min: 1000,
    max: 60000,
    unit: 'ms',
    visibility: 'admin',
  },

  // Supported Algorithms (platform-level, read-only)
  'infra.supported_signing_algs': {
    key: 'infra.supported_signing_algs',
    type: 'string',
    default: 'RS256,RS384,RS512,ES256,ES384,ES512,PS256,PS384,PS512,EdDSA',
    envKey: 'SUPPORTED_SIGNING_ALGS',
    label: 'Supported Signing Algorithms',
    description: 'Platform-supported JWS signing algorithms (comma-separated)',
    visibility: 'internal',
  },
  'infra.dpop_signing_alg_values_supported': {
    key: 'infra.dpop_signing_alg_values_supported',
    type: 'string',
    default: 'RS256,ES256,ES384,EdDSA',
    envKey: 'DPOP_SIGNING_ALG_VALUES_SUPPORTED',
    label: 'DPoP Signing Algorithms',
    description: 'Supported algorithms for DPoP proofs (comma-separated)',
    visibility: 'internal',
  },

  // Durable Objects Configuration
  'infra.do_cleanup_interval': {
    key: 'infra.do_cleanup_interval',
    type: 'duration',
    default: 60000,
    envKey: 'DO_CLEANUP_INTERVAL',
    label: 'DO Cleanup Interval',
    description: 'Durable Objects cleanup interval in milliseconds',
    min: 10000,
    max: 600000,
    unit: 'ms',
    visibility: 'admin',
  },
  'infra.do_audit_flush_delay': {
    key: 'infra.do_audit_flush_delay',
    type: 'duration',
    default: 5000,
    envKey: 'DO_AUDIT_FLUSH_DELAY',
    label: 'DO Audit Flush Delay',
    description: 'Delay before flushing audit logs in Durable Objects',
    min: 1000,
    max: 60000,
    unit: 'ms',
    visibility: 'admin',
  },
  'infra.do_saml_request_expiry': {
    key: 'infra.do_saml_request_expiry',
    type: 'duration',
    default: 300,
    envKey: 'DO_SAML_REQUEST_EXPIRY',
    label: 'SAML Request Expiry',
    description: 'SAML authentication request expiry in seconds',
    min: 60,
    max: 600,
    unit: 'seconds',
    visibility: 'admin',
  },
  'infra.do_saml_artifact_expiry': {
    key: 'infra.do_saml_artifact_expiry',
    type: 'duration',
    default: 120,
    envKey: 'DO_SAML_ARTIFACT_EXPIRY',
    label: 'SAML Artifact Expiry',
    description: 'SAML artifact expiry in seconds',
    min: 30,
    max: 300,
    unit: 'seconds',
    visibility: 'admin',
  },
};

/**
 * Infrastructure Category Metadata
 */
export const INFRASTRUCTURE_CATEGORY_META: CategoryMeta = {
  category: 'infrastructure',
  label: 'Infrastructure',
  description: 'Platform-level infrastructure settings (read-only)',
  settings: INFRASTRUCTURE_SETTINGS_META,
};

/**
 * Default Infrastructure settings values
 */
export const INFRASTRUCTURE_DEFAULTS: InfrastructureSettings = {
  'infra.code_shards': 64,
  'infra.session_shards': 64,
  'infra.challenge_shards': 64,
  'infra.revocation_shards': 64,
  'infra.region_total_shards': 100,
  'infra.region_enam_percent': 40,
  'infra.region_weur_percent': 35,
  'infra.region_apac_percent': 25,
  'infra.region_generation': 1,
  'infra.config_cache_ttl': 180,
  'infra.tenant_context_cache_ttl': 300,
  'infra.key_cache_ttl': 3600,
  'infra.jwks_cache_ttl': 86400,
  'infra.feature_flags_cache_ttl': 60,
  'infra.retry_max': 3,
  'infra.retry_initial_delay': 100,
  'infra.retry_max_delay': 5000,
  'infra.backoff_multiplier': 2,
  'infra.default_fetch_timeout_ms': 5000,
  'infra.supported_signing_algs': 'RS256,RS384,RS512,ES256,ES384,ES512,PS256,PS384,PS512,EdDSA',
  'infra.dpop_signing_alg_values_supported': 'RS256,ES256,ES384,EdDSA',
  'infra.do_cleanup_interval': 60000,
  'infra.do_audit_flush_delay': 5000,
  'infra.do_saml_request_expiry': 300,
  'infra.do_saml_artifact_expiry': 120,
};
