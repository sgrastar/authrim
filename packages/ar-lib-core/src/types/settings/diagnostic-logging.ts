/**
 * Diagnostic Logging Settings Category
 *
 * Configuration for diagnostic logging to support debugging, troubleshooting,
 * OIDF RP Conformance testing, and compliance audits.
 *
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/diagnostic-logging
 * Config Level: tenant (Phase 1), tenant with client-level storage overrides
 *
 * Security-first design:
 * - Semantic HTTP Log: Meaningful data extraction, not raw HTTP dumps
 * - Allowlist approach: Only safe headers are logged (Authorization, Cookie excluded)
 * - Schema-aware extraction: Body data is extracted based on schema knowledge
 * - Token hashing: Token values are irreversibly hashed (SHA-256)
 * - Default disabled: Logging is off unless explicitly enabled
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

/**
 * Log output format
 */
export type DiagnosticLogFormat = 'json' | 'jsonl' | 'text';

/**
 * Buffering strategy
 */
export type DiagnosticLogBufferStrategy = 'realtime' | 'batch' | 'queue';

/**
 * Log level (settings type)
 */
export type DiagnosticLoggingLogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Diagnostic log storage privacy mode
 */
export type DiagnosticLoggingStorageMode = 'full' | 'masked' | 'minimal';

/**
 * Diagnostic Logging Settings Interface
 */
export interface DiagnosticLoggingSettings {
  // Global ON/OFF
  /** Enable diagnostic logging */
  'diagnostic-logging.enabled': boolean;

  /** Log level (debug, info, warn, error) */
  'diagnostic-logging.log_level': DiagnosticLoggingLogLevel;

  // Category-specific ON/OFF
  /** Enable HTTP request logging */
  'diagnostic-logging.http_request_enabled': boolean;
  /** Enable HTTP response logging */
  'diagnostic-logging.http_response_enabled': boolean;
  /** Enable token validation logging */
  'diagnostic-logging.token_validation_enabled': boolean;
  /** Enable authentication decision logging */
  'diagnostic-logging.auth_decision_enabled': boolean;

  // R2 output settings
  /** Enable R2 output */
  'diagnostic-logging.r2_output_enabled': boolean;
  /** R2 bucket binding name (environment binding) */
  'diagnostic-logging.r2_bucket_binding': string;
  /** R2 path prefix */
  'diagnostic-logging.r2_path_prefix': string;

  // Format settings
  /** Output format (json, jsonl, text) */
  'diagnostic-logging.output_format': DiagnosticLogFormat;

  // Buffering settings
  /** Buffer strategy (realtime, batch, queue) */
  'diagnostic-logging.buffer_strategy': DiagnosticLogBufferStrategy;
  /** Batch size for batch strategy */
  'diagnostic-logging.batch_size': number;
  /** Batch interval in milliseconds */
  'diagnostic-logging.batch_interval_ms': number;

  // Filter settings
  /** Filter PII (Personally Identifiable Information) */
  'diagnostic-logging.filter_pii': boolean;
  /** Hash token values using SHA-256 */
  'diagnostic-logging.filter_tokens': boolean;
  /** Token hash prefix length (default 12 characters) */
  'diagnostic-logging.token_hash_prefix_length': number;

  // HTTP log settings
  /** Safe headers allowlist (comma-separated) */
  'diagnostic-logging.http_safe_headers': string;
  /** Schema-aware body extraction */
  'diagnostic-logging.http_body_schema_aware': boolean;

  // Retention settings
  /** Retention period for diagnostic logs in days */
  'diagnostic-logging.retention_days': number;

  // Privacy mode settings
  /** Default storage mode for diagnostic logs */
  'diagnostic-logging.storage_mode.default': DiagnosticLoggingStorageMode;
  /** Per-client storage mode overrides (JSON map: { client_id: mode }) */
  'diagnostic-logging.storage_mode.by_client': string;

  // SDK integration settings
  /** Enable SDK log ingestion from client SDKs */
  'diagnostic-logging.sdk_ingest_enabled': boolean;
  /** Enable merged output (server + SDK logs) */
  'diagnostic-logging.merged_output_enabled': boolean;
}

/**
 * Diagnostic Logging Settings Metadata
 */
export const DIAGNOSTIC_LOGGING_SETTINGS_META: Record<
  keyof DiagnosticLoggingSettings,
  SettingMeta
> = {
  'diagnostic-logging.enabled': {
    key: 'diagnostic-logging.enabled',
    type: 'boolean',
    default: false,
    envKey: 'DIAGNOSTIC_LOGGING_ENABLED',
    label: 'Enable Diagnostic Logging',
    description: 'Enable diagnostic logging for debugging, troubleshooting, and compliance testing',
    visibility: 'admin',
  },
  'diagnostic-logging.log_level': {
    key: 'diagnostic-logging.log_level',
    type: 'enum',
    default: 'debug',
    envKey: 'DIAGNOSTIC_LOGGING_LOG_LEVEL',
    label: 'Log Level',
    description: 'Minimum log level to record (debug, info, warn, error)',
    visibility: 'admin',
    enum: ['debug', 'info', 'warn', 'error'],
  },
  'diagnostic-logging.http_request_enabled': {
    key: 'diagnostic-logging.http_request_enabled',
    type: 'boolean',
    default: true,
    envKey: 'DIAGNOSTIC_LOGGING_HTTP_REQUEST_ENABLED',
    label: 'Enable HTTP Request Logging',
    description: 'Log HTTP request details (method, path, safe headers, body summary)',
    visibility: 'admin',
  },
  'diagnostic-logging.http_response_enabled': {
    key: 'diagnostic-logging.http_response_enabled',
    type: 'boolean',
    default: true,
    envKey: 'DIAGNOSTIC_LOGGING_HTTP_RESPONSE_ENABLED',
    label: 'Enable HTTP Response Logging',
    description: 'Log HTTP response details (status, safe headers, body summary)',
    visibility: 'admin',
  },
  'diagnostic-logging.token_validation_enabled': {
    key: 'diagnostic-logging.token_validation_enabled',
    type: 'boolean',
    default: true,
    envKey: 'DIAGNOSTIC_LOGGING_TOKEN_VALIDATION_ENABLED',
    label: 'Enable Token Validation Logging',
    description: 'Log ID Token validation steps (issuer, aud, exp, nonce, hash)',
    visibility: 'admin',
  },
  'diagnostic-logging.auth_decision_enabled': {
    key: 'diagnostic-logging.auth_decision_enabled',
    type: 'boolean',
    default: true,
    envKey: 'DIAGNOSTIC_LOGGING_AUTH_DECISION_ENABLED',
    label: 'Enable Auth Decision Logging',
    description: 'Log final authentication decision and reason',
    visibility: 'admin',
  },
  'diagnostic-logging.r2_output_enabled': {
    key: 'diagnostic-logging.r2_output_enabled',
    type: 'boolean',
    default: false,
    envKey: 'DIAGNOSTIC_LOGGING_R2_OUTPUT_ENABLED',
    label: 'Enable R2 Output',
    description: 'Persist diagnostic logs to R2 bucket (in addition to console.log)',
    visibility: 'admin',
  },
  'diagnostic-logging.r2_bucket_binding': {
    key: 'diagnostic-logging.r2_bucket_binding',
    type: 'string',
    default: 'DIAGNOSTIC_LOGS',
    envKey: 'DIAGNOSTIC_LOGGING_R2_BUCKET_BINDING',
    label: 'R2 Bucket Binding',
    description: 'R2 bucket binding name (must match wrangler.toml)',
    visibility: 'admin',
  },
  'diagnostic-logging.r2_path_prefix': {
    key: 'diagnostic-logging.r2_path_prefix',
    type: 'string',
    default: 'diagnostic-logs',
    envKey: 'DIAGNOSTIC_LOGGING_R2_PATH_PREFIX',
    label: 'R2 Path Prefix',
    description: 'Path prefix for R2 objects (e.g., diagnostic-logs)',
    visibility: 'admin',
  },
  'diagnostic-logging.output_format': {
    key: 'diagnostic-logging.output_format',
    type: 'enum',
    default: 'jsonl',
    envKey: 'DIAGNOSTIC_LOGGING_OUTPUT_FORMAT',
    label: 'Output Format',
    description: 'Log output format (json, jsonl, text)',
    visibility: 'admin',
    enum: ['json', 'jsonl', 'text'],
  },
  'diagnostic-logging.buffer_strategy': {
    key: 'diagnostic-logging.buffer_strategy',
    type: 'enum',
    default: 'queue',
    envKey: 'DIAGNOSTIC_LOGGING_BUFFER_STRATEGY',
    label: 'Buffer Strategy',
    description:
      'Buffering strategy: realtime (immediate), batch (buffered), queue (async via Queue)',
    visibility: 'admin',
    enum: ['realtime', 'batch', 'queue'],
  },
  'diagnostic-logging.batch_size': {
    key: 'diagnostic-logging.batch_size',
    type: 'number',
    default: 100,
    envKey: 'DIAGNOSTIC_LOGGING_BATCH_SIZE',
    label: 'Batch Size',
    description: 'Maximum number of log entries per batch',
    visibility: 'admin',
    min: 1,
    max: 1000,
  },
  'diagnostic-logging.batch_interval_ms': {
    key: 'diagnostic-logging.batch_interval_ms',
    type: 'number',
    default: 5000,
    envKey: 'DIAGNOSTIC_LOGGING_BATCH_INTERVAL_MS',
    label: 'Batch Interval (ms)',
    description: 'Batch flush interval in milliseconds',
    visibility: 'admin',
    min: 100,
    max: 60000,
  },
  'diagnostic-logging.filter_pii': {
    key: 'diagnostic-logging.filter_pii',
    type: 'boolean',
    default: true,
    envKey: 'DIAGNOSTIC_LOGGING_FILTER_PII',
    label: 'Filter PII',
    description: 'Exclude Personally Identifiable Information from logs',
    visibility: 'admin',
    status: 'in_development',
  },
  'diagnostic-logging.filter_tokens': {
    key: 'diagnostic-logging.filter_tokens',
    type: 'boolean',
    default: true,
    envKey: 'DIAGNOSTIC_LOGGING_FILTER_TOKENS',
    label: 'Hash Tokens',
    description: 'Hash token values using SHA-256 (irreversible)',
    visibility: 'admin',
    status: 'in_development',
  },
  'diagnostic-logging.token_hash_prefix_length': {
    key: 'diagnostic-logging.token_hash_prefix_length',
    type: 'number',
    default: 12,
    envKey: 'DIAGNOSTIC_LOGGING_TOKEN_HASH_PREFIX_LENGTH',
    label: 'Token Hash Prefix Length',
    description: 'Number of characters to show from hashed token (default 12)',
    visibility: 'admin',
    min: 8,
    max: 64,
  },
  'diagnostic-logging.http_safe_headers': {
    key: 'diagnostic-logging.http_safe_headers',
    type: 'string',
    default: 'content-type,accept,user-agent,x-correlation-id,x-diagnostic-session-id',
    envKey: 'DIAGNOSTIC_LOGGING_HTTP_SAFE_HEADERS',
    label: 'Safe Headers Allowlist',
    description: 'Comma-separated list of safe headers to include (Authorization, Cookie excluded)',
    visibility: 'admin',
  },
  'diagnostic-logging.http_body_schema_aware': {
    key: 'diagnostic-logging.http_body_schema_aware',
    type: 'boolean',
    default: true,
    envKey: 'DIAGNOSTIC_LOGGING_HTTP_BODY_SCHEMA_AWARE',
    label: 'Schema-Aware Body Extraction',
    description: 'Extract body data based on schema knowledge (recommended)',
    visibility: 'admin',
  },
  'diagnostic-logging.retention_days': {
    key: 'diagnostic-logging.retention_days',
    type: 'number',
    default: 30,
    envKey: 'DIAGNOSTIC_LOGGING_RETENTION_DAYS',
    label: 'Retention Days',
    description: 'Number of days to retain diagnostic logs (default: 30)',
    visibility: 'admin',
    min: 1,
    max: 365,
  },
  'diagnostic-logging.storage_mode.default': {
    key: 'diagnostic-logging.storage_mode.default',
    type: 'enum',
    default: 'masked',
    label: 'Default Storage Mode',
    description: 'Default privacy mode for diagnostic logs (full, masked, minimal)',
    visibility: 'admin',
    enum: ['full', 'masked', 'minimal'],
  },
  'diagnostic-logging.storage_mode.by_client': {
    key: 'diagnostic-logging.storage_mode.by_client',
    type: 'string',
    default: '{}',
    label: 'Client Storage Mode Overrides',
    description: 'JSON map of client_id to storage mode overrides',
    visibility: 'admin',
  },
  'diagnostic-logging.sdk_ingest_enabled': {
    key: 'diagnostic-logging.sdk_ingest_enabled',
    type: 'boolean',
    default: true,
    envKey: 'SDK_INGEST_ENABLED',
    label: 'Enable SDK Log Ingestion',
    description: 'Accept diagnostic logs from client SDKs via the public ingest API',
    visibility: 'admin',
  },
  'diagnostic-logging.merged_output_enabled': {
    key: 'diagnostic-logging.merged_output_enabled',
    type: 'boolean',
    default: false,
    envKey: 'MERGED_OUTPUT_ENABLED',
    label: 'Enable Merged Log Output',
    description:
      'Export server and SDK logs in a single merged timeline using diagnosticSessionId correlation',
    visibility: 'admin',
    status: 'in_development',
  },
};

/**
 * Diagnostic Logging Category Metadata
 */
export const DIAGNOSTIC_LOGGING_CATEGORY_META: CategoryMeta = {
  category: 'diagnostic-logging',
  label: 'Diagnostic Logging',
  description:
    'Diagnostic logging for debugging, troubleshooting, OIDF conformance testing, and compliance',
  settings: DIAGNOSTIC_LOGGING_SETTINGS_META,
};

/**
 * Default Diagnostic Logging settings values
 */
export const DIAGNOSTIC_LOGGING_DEFAULTS: DiagnosticLoggingSettings = {
  'diagnostic-logging.enabled': false,
  'diagnostic-logging.log_level': 'debug',
  'diagnostic-logging.http_request_enabled': true,
  'diagnostic-logging.http_response_enabled': true,
  'diagnostic-logging.token_validation_enabled': true,
  'diagnostic-logging.auth_decision_enabled': true,
  'diagnostic-logging.r2_output_enabled': false,
  'diagnostic-logging.r2_bucket_binding': 'DIAGNOSTIC_LOGS',
  'diagnostic-logging.r2_path_prefix': 'diagnostic-logs',
  'diagnostic-logging.output_format': 'jsonl',
  'diagnostic-logging.buffer_strategy': 'queue',
  'diagnostic-logging.batch_size': 100,
  'diagnostic-logging.batch_interval_ms': 5000,
  'diagnostic-logging.filter_pii': true,
  'diagnostic-logging.filter_tokens': true,
  'diagnostic-logging.token_hash_prefix_length': 12,
  'diagnostic-logging.http_safe_headers':
    'content-type,accept,user-agent,x-correlation-id,x-diagnostic-session-id',
  'diagnostic-logging.http_body_schema_aware': true,
  'diagnostic-logging.retention_days': 30,
  'diagnostic-logging.storage_mode.default': 'masked',
  'diagnostic-logging.storage_mode.by_client': '{}',
  'diagnostic-logging.sdk_ingest_enabled': true,
  'diagnostic-logging.merged_output_enabled': false,
};
