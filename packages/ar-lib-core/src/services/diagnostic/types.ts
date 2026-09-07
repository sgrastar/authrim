/**
 * Diagnostic Logging Types
 *
 * Type definitions for diagnostic logs used in debugging, troubleshooting,
 * OIDF RP Conformance testing, and compliance audits.
 */

/**
 * Diagnostic log category
 */
export type DiagnosticLogCategory =
  | 'http-request'
  | 'http-response'
  | 'token-validation'
  | 'auth-decision';

/**
 * Diagnostic log privacy mode
 */
export type DiagnosticLogPrivacyMode = 'full' | 'masked' | 'minimal';

/**
 * Log level
 */
export type DiagnosticLogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Base diagnostic log entry
 */
export interface BaseDiagnosticLogEntry {
  /** Unique log entry ID */
  id: string;

  /** Diagnostic session ID (for correlation across SDK and server) */
  diagnosticSessionId?: string;

  /** Flow ID for cross-category correlation */
  flowId?: string;

  /** Tenant ID */
  tenantId: string;

  /** Client ID (optional, for future client-scoped logging) */
  clientId?: string;

  /** Log category */
  category: DiagnosticLogCategory;

  /** Log level */
  level: DiagnosticLogLevel;

  /** Timestamp (Unix epoch in milliseconds) */
  timestamp: number;

  /** Request ID for correlation */
  requestId?: string;

  /** Storage privacy mode applied at ingestion */
  storageMode?: DiagnosticLogPrivacyMode;

  /** User ID (anonymized if PII filtering enabled) */
  anonymizedUserId?: string;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * HTTP Request Log Entry (Semantic HTTP Log)
 */
export interface HttpRequestLogEntry extends BaseDiagnosticLogEntry {
  category: 'http-request';

  /** HTTP method */
  method: string;

  /** Request path */
  path: string;

  /** Query parameters (sanitized) */
  query?: Record<string, string>;

  /** Safe headers (allowlist only) */
  headers: Record<string, string>;

  /** Body summary (schema-aware extraction) */
  bodySummary?: Record<string, unknown>;

  /** Remote address */
  remoteAddress?: string;
}

/**
 * HTTP Response Log Entry (Semantic HTTP Log)
 */
export interface HttpResponseLogEntry extends BaseDiagnosticLogEntry {
  category: 'http-response';

  /** HTTP status code */
  status: number;

  /** Safe response headers (allowlist only) */
  headers: Record<string, string>;

  /** Body summary (schema-aware extraction) */
  bodySummary?: Record<string, unknown>;

  /** Response duration in milliseconds */
  durationMs?: number;
}

/**
 * Token Validation Step
 */
export type TokenValidationStep =
  | 'issuer-check'
  | 'audience-check'
  | 'expiry-check'
  | 'nonce-check'
  | 'signature-check'
  | 'hash-check' // s_hash, c_hash, at_hash
  | 'token-request'
  | 'token-response'
  | 'id-token-validation'
  | 'userinfo-request'
  | 'userinfo-response'
  | 'userinfo-mismatch'
  | 'logout-token-validation'
  | 'fapi2-provider-metadata-validation'
  | 'fapi2-authorization-response-validation'
  | 'fapi2-token-response-validation'
  | 'fapi2-id-token-validation'
  | 'fapi2-resource-response-validation';

/**
 * Token Validation Log Entry
 */
export interface TokenValidationLogEntry extends BaseDiagnosticLogEntry {
  category: 'token-validation';

  /** Validation step */
  step: TokenValidationStep;

  /** Token type (id_token, access_token, refresh_token) */
  tokenType?: string;

  /** Token hash (SHA-256, prefix only) */
  tokenHash?: string;

  /** Validation result */
  result: 'pass' | 'fail';

  /** Expected value (for validation) */
  expected?: unknown;

  /** Actual value (for validation) */
  actual?: unknown;

  /** Error message (if failed) */
  errorMessage?: string;

  /** Additional validation details */
  details?: Record<string, unknown>;
}

/**
 * Authentication Decision Log Entry
 */
export interface AuthDecisionLogEntry extends BaseDiagnosticLogEntry {
  category: 'auth-decision';

  /** Final authentication decision */
  decision: 'allow' | 'deny';

  /** Reason for the decision */
  reason: string;

  /** Authentication flow (authorization_code, implicit, etc.) */
  flow?: string;

  /** Grant type (for token endpoint) */
  grantType?: string;

  /** Additional decision context */
  context?: Record<string, unknown>;
}

/**
 * Union type of all diagnostic log entries
 */
export type DiagnosticLogEntry =
  | HttpRequestLogEntry
  | HttpResponseLogEntry
  | TokenValidationLogEntry
  | AuthDecisionLogEntry;

/**
 * Diagnostic log write result
 */
export interface DiagnosticLogWriteResult {
  /** Write success status */
  success: boolean;

  /** Number of entries written */
  entriesWritten: number;

  /** Backend identifier (console, r2, etc.) */
  backend: string;

  /** Write duration in milliseconds */
  durationMs: number;

  /** Error message (if failed) */
  errorMessage?: string;
}

/**
 * Diagnostic log query options
 */
export interface DiagnosticLogQueryOptions {
  /** Tenant ID */
  tenantId: string;

  /** Client ID (optional) */
  clientId?: string;

  /** Diagnostic session ID (for correlation) */
  diagnosticSessionId?: string;

  /** Log category filter */
  category?: DiagnosticLogCategory;

  /** Start time (Unix epoch in milliseconds) */
  startTime?: number;

  /** End time (Unix epoch in milliseconds) */
  endTime?: number;

  /** Request ID filter */
  requestId?: string;

  /** Pagination: limit */
  limit?: number;

  /** Pagination: offset */
  offset?: number;
}

/**
 * Diagnostic log query result
 */
export interface DiagnosticLogQueryResult {
  /** Log entries */
  entries: DiagnosticLogEntry[];

  /** Total count (before pagination) */
  totalCount: number;

  /** Has more results */
  hasMore: boolean;

  /** Query duration in milliseconds */
  durationMs: number;

  /** Backend identifier */
  backend: string;
}
