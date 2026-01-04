/**
 * Audit Log Types
 *
 * This module defines the core types for the audit logging system.
 * The system separates Event Logs (non-PII) from PII Logs for GDPR compliance.
 *
 * Architecture:
 * - EventLog: What happened, results, errors (D1_CORE - no PII)
 * - PIILog: User data changes (D1_PII - encrypted)
 * - Both linked via anonymized_user_id (random UUID + mapping table)
 */

// =============================================================================
// Log Levels and Categories
// =============================================================================

/**
 * Event severity levels for alerting and filtering.
 */
export type EventSeverity = 'debug' | 'info' | 'warn' | 'error' | 'critical';

/**
 * Event categories for grouping and filtering.
 */
export type EventCategory =
  | 'auth' // Authentication events (login, logout, MFA)
  | 'token' // Token events (issue, refresh, revoke, introspect)
  | 'consent' // User consent events
  | 'user' // User management events
  | 'client' // Client/application events
  | 'admin' // Admin operations
  | 'security' // Security events (rate limit, suspicious activity)
  | 'system' // System events (startup, shutdown, migration)
  | 'audit'; // Audit log management events

/**
 * Event result status.
 */
export type EventResult = 'success' | 'failure' | 'partial';

// =============================================================================
// Event Log (D1_CORE - Non-PII)
// =============================================================================

/**
 * Event log entry stored in D1_CORE.
 * Contains only search axes; detailed data is stored in R2 if > 2KB.
 *
 * Time units: epoch milliseconds
 */
export interface EventLogEntry {
  /** Unique event ID (UUID v4) */
  id: string;

  /** Tenant identifier */
  tenantId: string;

  // -- Search axes (indexed) --
  /** Event type (e.g., 'auth.login', 'token.issued', 'user.pii_purge_started') */
  eventType: string;

  /** Event category for grouping */
  eventCategory: EventCategory;

  /** Event result status */
  result: EventResult;

  /** Error code if result is 'failure' (e.g., 'invalid_grant', 'rate_limited') */
  errorCode?: string;

  /** Error message (sanitized, max 1024 chars) */
  errorMessage?: string;

  /** Event severity level */
  severity: EventSeverity;

  // -- Correlation IDs --
  /** Anonymized user ID (random UUID from mapping table, not real user ID) */
  anonymizedUserId?: string;

  /** OAuth client ID */
  clientId?: string;

  /** Session ID for correlation */
  sessionId?: string;

  /** Request ID for correlation */
  requestId?: string;

  // -- Performance --
  /** Operation duration in milliseconds */
  durationMs?: number;

  // -- Details (R2 or inline) --
  /**
   * R2 key for detailed data (if > 2KB).
   * Path format: event-details/{tenantId}/{YYYY-MM-DD}/{entryId}.json
   */
  detailsR2Key?: string;

  /**
   * Inline details JSON (if <= 2KB).
   * Contains request_path, response_status, feature_flags, etc.
   */
  detailsJson?: string;

  // -- Retention --
  /** Retention expiry (epoch milliseconds) */
  retentionUntil?: number;

  /** Creation timestamp (epoch milliseconds) */
  createdAt: number;
}

/**
 * Detailed event data stored in R2 or inline.
 * Note: This interface uses index signature to allow flexible metadata.
 */
export interface EventDetails {
  /** Request path (without query string for privacy) */
  requestPath?: string;

  /** HTTP method */
  requestMethod?: string;

  /** Response HTTP status code */
  responseStatus?: number;

  /** Feature flags active during this event */
  featureFlags?: Record<string, boolean>;

  /** Performance metrics */
  performanceMetrics?: {
    dbTimeMs?: number;
    kvTimeMs?: number;
    externalApiTimeMs?: number;
  };

  /** Additional metadata (sanitized - no PII or secrets) */
  [key: string]: unknown;
}

// =============================================================================
// PII Log (D1_PII - Encrypted Personal Data)
// =============================================================================

/**
 * PII change type.
 */
export type PIIChangeType =
  | 'create' // New user created
  | 'update' // User data updated
  | 'delete' // User data deleted
  | 'view' // PII data accessed (for audit trail)
  | 'export'; // PII data exported (GDPR data portability)

/**
 * Actor type who performed the action.
 */
export type ActorType = 'user' | 'admin' | 'system' | 'api';

/**
 * Legal basis for processing (GDPR Article 6).
 */
export type LegalBasis =
  | 'consent' // User gave explicit consent
  | 'contract' // Necessary for contract performance
  | 'legal_obligation' // Required by law
  | 'vital_interests' // Protect vital interests
  | 'public_task' // Public interest
  | 'legitimate_interests'; // Legitimate business interests

/**
 * PII log entry stored in D1_PII.
 * Contains encrypted user data changes.
 *
 * Time units: epoch milliseconds
 */
export interface PIILogEntry {
  /** Unique entry ID (UUID v4) */
  id: string;

  /** Tenant identifier */
  tenantId: string;

  /** Real user ID (stored in PII DB only) */
  userId: string;

  /** Anonymized user ID (for linking with EventLog) */
  anonymizedUserId: string;

  /** Type of change */
  changeType: PIIChangeType;

  /** JSON array of affected field names: ["email", "name"] */
  affectedFields: string;

  // -- Encrypted data --
  /**
   * R2 key for encrypted values (if > 4KB).
   * Path format: pii-values/{tenantId}/{YYYY-MM-DD}/{entryId}.json
   */
  valuesR2Key?: string;

  /** Inline encrypted values JSON (if <= 4KB) */
  valuesEncrypted?: string;

  // -- Encryption metadata --
  /** Encryption key ID (for key rotation) */
  encryptionKeyId: string;

  /** GCM nonce/IV (Base64 encoded, 12 bytes) */
  encryptionIv: string;

  // -- Actor information --
  /** Actor user ID (who performed the action) */
  actorUserId?: string;

  /** Actor type */
  actorType: ActorType;

  /** Request ID for correlation */
  requestId?: string;

  // -- Legal basis --
  /** Legal basis for processing (GDPR) */
  legalBasis?: LegalBasis;

  /** Consent reference ID if applicable */
  consentReference?: string;

  // -- Retention --
  /** Retention expiry (epoch milliseconds) */
  retentionUntil: number;

  /** Creation timestamp (epoch milliseconds) */
  createdAt: number;
}

// =============================================================================
// Encrypted Value Structure
// =============================================================================

/**
 * AES-256-GCM encrypted value structure.
 */
export interface EncryptedValue {
  /** Base64-encoded ciphertext */
  ciphertext: string;

  /** Base64-encoded 12-byte IV/nonce */
  iv: string;

  /** Key ID used for encryption (for rotation support) */
  keyId: string;

  // Note: AAD (Additional Authenticated Data) is not stored here.
  // It is regenerated from: `${tenantId}:${sortedAffectedFields.join(',')}`
}

// =============================================================================
// User Anonymization Mapping
// =============================================================================

/**
 * Mapping between real user ID and anonymized ID.
 * Stored in D1_PII. Deleted when user exercises "right to be forgotten".
 */
export interface UserAnonymizationMap {
  /** Unique entry ID */
  id: string;

  /** Tenant identifier */
  tenantId: string;

  /** Real user ID */
  userId: string;

  /** Anonymized user ID (random UUID) */
  anonymizedUserId: string;

  /** Creation timestamp (epoch milliseconds) */
  createdAt: number;
}

// =============================================================================
// Tenant PII Configuration
// =============================================================================

/**
 * Per-tenant PII configuration.
 * Defines which fields are considered PII and retention policies.
 */
export interface TenantPIIConfig {
  /** Fields to treat as PII (true = is PII) */
  piiFields: {
    email: boolean; // Default: true
    name: boolean; // Default: true
    phone: boolean; // Default: true
    ipAddress: boolean; // Default: false (GDPR: true)
    userAgent: boolean; // Default: false
    deviceFingerprint: boolean; // Default: true
    address: boolean; // Default: true
    birthdate: boolean; // Default: true
    governmentId: boolean; // Default: true
  };

  /** Event log detail level */
  eventLogDetailLevel: 'minimal' | 'standard' | 'detailed';

  /** Event log retention in days (default: 90) */
  eventLogRetentionDays: number;

  /** PII log retention in days (default: 365) */
  piiLogRetentionDays: number;

  /**
   * Operational log retention in days (default: 90)
   * Applies to reason_detail storage in operational_logs table
   */
  operationalLogRetentionDays?: number;
}

/**
 * Default PII configuration.
 */
export const DEFAULT_PII_CONFIG: TenantPIIConfig = {
  piiFields: {
    email: true,
    name: true,
    phone: true,
    ipAddress: false,
    userAgent: false,
    deviceFingerprint: true,
    address: true,
    birthdate: true,
    governmentId: true,
  },
  eventLogDetailLevel: 'standard',
  eventLogRetentionDays: 90,
  piiLogRetentionDays: 365,
  operationalLogRetentionDays: 90, // reason_detail retention (90 days default)
};

// =============================================================================
// Audit Service Types
// =============================================================================

/**
 * Parameters for logging an event.
 */
export interface EventLogParams {
  /** Event type (e.g., 'auth.login', 'token.issued') */
  eventType: string;

  /** Event category */
  eventCategory: EventCategory;

  /** Event result */
  result: EventResult;

  /** Event severity (default: 'info') */
  severity?: EventSeverity;

  /** Error code if failure */
  errorCode?: string;

  /** Error message (will be sanitized) */
  errorMessage?: string;

  /** Anonymized user ID */
  anonymizedUserId?: string;

  /** OAuth client ID */
  clientId?: string;

  /** Session ID */
  sessionId?: string;

  /** Request ID */
  requestId?: string;

  /** Operation duration in milliseconds */
  durationMs?: number;

  /** Additional details (will be sanitized for PII) */
  details?: EventDetails;
}

/**
 * Parameters for logging a PII change.
 */
export interface PIILogParams {
  /** Real user ID */
  userId: string;

  /** Anonymized user ID (will be fetched if not provided) */
  anonymizedUserId?: string;

  /** Type of change */
  changeType: PIIChangeType;

  /** List of affected field names */
  affectedFields: string[];

  /** Old values (for update/delete) */
  oldValues?: Record<string, unknown>;

  /** New values (for create/update) */
  newValues?: Record<string, unknown>;

  /** Actor user ID */
  actorUserId?: string;

  /** Actor type */
  actorType: ActorType;

  /** Request ID */
  requestId?: string;

  /** Legal basis for processing */
  legalBasis?: LegalBasis;

  /** Consent reference ID */
  consentReference?: string;
}

/**
 * Parameters for combined event + PII log.
 */
export interface CombinedLogParams extends EventLogParams {
  /** PII change parameters */
  pii: Omit<PIILogParams, 'anonymizedUserId' | 'requestId'>;
}

/**
 * Context for PII purge operations (GDPR "right to be forgotten").
 */
export interface PurgeContext {
  /** Actor who initiated the purge */
  actorUserId: string;

  /** Actor type */
  actorType: ActorType;

  /** Reason for deletion */
  deletionReason: 'user_request' | 'admin_action' | 'inactivity' | 'account_abuse';

  /** Legal basis for the deletion */
  legalBasis?: string;

  /** Request ID for tracking */
  requestId: string;
}

/**
 * Result of a PII purge operation.
 */
export interface PurgeResult {
  /** Whether the purge succeeded */
  success: boolean;

  /** Number of PII log entries deleted */
  piiLogsDeleted: number;

  /** Purge job ID for tracking */
  purgeJobId: string;

  /** Error message if failed */
  errorMessage?: string;
}

// =============================================================================
// Audit Service Interface
// =============================================================================

/**
 * Audit service for logging events and PII changes.
 */
export interface IAuditService {
  /**
   * Log an event (non-PII).
   * Uses Queue for async processing with D1 fallback.
   */
  logEvent(tenantId: string, params: EventLogParams): Promise<void>;

  /**
   * Log a PII change.
   * Encrypts sensitive data before storage.
   */
  logPIIChange(tenantId: string, params: PIILogParams): Promise<void>;

  /**
   * Log an event with associated PII change.
   * Atomic operation linking both logs.
   */
  logEventWithPII(tenantId: string, params: CombinedLogParams): Promise<void>;

  /**
   * Get or create anonymized user ID.
   * Uses random UUID + mapping table (not HMAC).
   */
  getAnonymizedUserId(tenantId: string, userId: string): Promise<string>;

  /**
   * Purge all PII for a user (GDPR "right to be forgotten").
   * Uses 2-stage logging (started/completed/failed).
   */
  purgeUserPII(tenantId: string, userId: string, context: PurgeContext): Promise<PurgeResult>;
}

// =============================================================================
// Queue Message Types
// =============================================================================

/**
 * Audit queue message types.
 */
export type AuditQueueMessageType = 'event_log' | 'pii_log';

/**
 * Audit queue message structure.
 */
export interface AuditQueueMessage {
  /** Message type */
  type: AuditQueueMessageType;

  /** Log entries to write */
  entries: (EventLogEntry | PIILogEntry)[];

  /** Tenant ID for routing */
  tenantId: string;

  /** Message timestamp (epoch milliseconds) */
  timestamp: number;
}

// =============================================================================
// Write Configuration
// =============================================================================

/**
 * Audit write mode.
 */
export type AuditWriteMode = 'sync' | 'buffered' | 'queued';

/**
 * Audit write configuration.
 */
export interface AuditWriteConfig {
  /** Write mode (default: 'queued') */
  mode: AuditWriteMode;

  /** Buffer configuration for 'buffered' mode */
  bufferConfig?: {
    /** Max entries before flush (default: 100) */
    maxSize: number;
    /** Flush interval in ms (default: 5000) */
    flushIntervalMs: number;
  };

  /** Queue configuration for 'queued' mode */
  queueConfig: {
    /** Queue binding name (default: 'AUDIT_QUEUE') */
    binding: string;
    /** Max batch size (default: 100) */
    maxBatchSize: number;
    /** Max retries before DLQ (default: 5) */
    retryLimit: number;
  };
}

/**
 * Default audit write configuration.
 */
export const DEFAULT_AUDIT_WRITE_CONFIG: AuditWriteConfig = {
  mode: 'queued',
  queueConfig: {
    binding: 'AUDIT_QUEUE',
    maxBatchSize: 100,
    retryLimit: 5,
  },
};
