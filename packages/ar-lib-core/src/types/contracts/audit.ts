/**
 * Contract Audit Log Types
 *
 * Types for auditing contract operations for compliance and security.
 * Provides structured audit trail for all contract-related activities.
 */

import type { FieldChange } from './change-log';

// =============================================================================
// Audit Event Types
// =============================================================================

/**
 * Types of contract-related audit events.
 */
export type ContractAuditEventType =
  // Contract lifecycle events
  | 'contract.created'
  | 'contract.updated'
  | 'contract.status_changed'
  | 'contract.rolled_back'
  | 'contract.deleted'
  | 'contract.archived'
  // Policy resolution events
  | 'policy.resolved'
  | 'policy.validated'
  | 'policy.violation_detected'
  // Cache events
  | 'cache.invalidated'
  | 'cache.warmed'
  // Access events
  | 'access.granted'
  | 'access.denied'
  | 'access.viewed';

// =============================================================================
// Audit Log Entry
// =============================================================================

/**
 * Audit log entry for contract operations.
 */
export interface ContractAuditLog {
  /** Unique audit log ID */
  id: string;
  /** Event type */
  eventType: ContractAuditEventType;
  /** Subject of the audit event */
  subject: AuditSubject;
  /** Actor who performed the action */
  actor: AuditActor;
  /** Action performed */
  action: string;
  /** Result of the action */
  result: 'success' | 'failure';
  /** Changes made (if applicable) */
  changes?: FieldChange[];
  /** Error information (if failed) */
  error?: AuditError;
  /** When the event occurred (ISO 8601) */
  timestamp: string;
  /** Request ID for correlation */
  requestId?: string;
  /** Trace ID for distributed tracing */
  traceId?: string;
  /** Session ID */
  sessionId?: string;
  /** When this log entry should be deleted (ISO 8601) */
  retentionUntil: string;
  /** Additional context */
  context?: AuditContext;
}

/**
 * Subject of an audit event.
 */
export interface AuditSubject {
  /** Subject type */
  type: 'tenant' | 'client' | 'policy' | 'cache' | 'flow';
  /** Subject ID */
  id: string;
  /** Subject name (for display) */
  name?: string;
  /** Version (if applicable) */
  version?: number;
}

/**
 * Actor who performed the action.
 */
export interface AuditActor {
  /** Actor type */
  type: 'user' | 'service' | 'system';
  /** User ID (for user actors) */
  userId?: string;
  /** Service name (for service actors) */
  serviceName?: string;
  /** Email (for user actors) */
  email?: string;
  /** IP address */
  ipAddress?: string;
  /** User agent */
  userAgent?: string;
  /** Geographic location (if available) */
  location?: AuditLocation;
}

/**
 * Geographic location for audit.
 */
export interface AuditLocation {
  /** Country code (ISO 3166-1 alpha-2) */
  country?: string;
  /** Region/State */
  region?: string;
  /** City */
  city?: string;
}

/**
 * Error information in audit log.
 */
export interface AuditError {
  /** Error code */
  code: string;
  /** Error message */
  message: string;
  /** Stack trace (development only) */
  stack?: string;
}

/**
 * Additional context for audit events.
 */
export interface AuditContext {
  /** Previous state (for updates) */
  previousState?: Record<string, unknown>;
  /** New state (for updates) */
  newState?: Record<string, unknown>;
  /** Affected resources */
  affectedResources?: AuditAffectedResource[];
  /** Custom metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Resource affected by an audit event.
 */
export interface AuditAffectedResource {
  /** Resource type */
  type: string;
  /** Resource ID */
  id: string;
  /** How it was affected */
  impact: 'created' | 'updated' | 'deleted' | 'invalidated';
}

// =============================================================================
// Audit Log Query
// =============================================================================

/**
 * Query parameters for retrieving audit logs.
 */
export interface AuditLogQuery {
  /** Filter by event types */
  eventTypes?: ContractAuditEventType[];
  /** Filter by subject ID */
  subjectId?: string;
  /** Filter by subject type */
  subjectType?: AuditSubject['type'];
  /** Filter by actor user ID */
  actorId?: string;
  /** Filter by result */
  result?: 'success' | 'failure';
  /** Filter by date range (from) */
  fromDate: string;
  /** Filter by date range (to) */
  toDate: string;
  /** Filter by request ID */
  requestId?: string;
  /** Filter by IP address */
  ipAddress?: string;
  /** Maximum number of results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Sort order */
  sortOrder?: 'asc' | 'desc';
}

/**
 * Result of an audit log query.
 */
export interface AuditLogQueryResult {
  /** Audit log entries */
  entries: ContractAuditLog[];
  /** Total count (for pagination) */
  totalCount: number;
  /** Whether there are more results */
  hasMore: boolean;
  /** Query execution time (ms) */
  queryTimeMs?: number;
}

// =============================================================================
// Audit Summary
// =============================================================================

/**
 * Summary of audit events for a time period.
 */
export interface AuditSummary {
  /** Time period start (ISO 8601) */
  periodStart: string;
  /** Time period end (ISO 8601) */
  periodEnd: string;
  /** Total event count */
  totalEvents: number;
  /** Events by type */
  eventsByType: Record<ContractAuditEventType, number>;
  /** Events by result */
  eventsByResult: {
    success: number;
    failure: number;
  };
  /** Top actors */
  topActors: {
    userId: string;
    eventCount: number;
  }[];
  /** Top subjects */
  topSubjects: {
    type: AuditSubject['type'];
    id: string;
    eventCount: number;
  }[];
}

// =============================================================================
// Audit Configuration
// =============================================================================

/**
 * Audit logging configuration.
 */
export interface AuditConfig {
  /** Whether audit logging is enabled */
  enabled: boolean;
  /** Event types to log */
  logEventTypes: ContractAuditEventType[];
  /** Retention period in days */
  retentionDays: number;
  /** Include request/response bodies */
  includeRequestBody: boolean;
  /** Include response bodies */
  includeResponseBody: boolean;
  /** Mask sensitive fields */
  maskSensitiveFields: boolean;
  /** Sensitive field paths to mask */
  sensitiveFields: string[];
  /** Export configuration */
  export?: AuditExportConfig;
}

/**
 * Audit export configuration.
 */
export interface AuditExportConfig {
  /** Enable automatic export */
  enabled: boolean;
  /** Export destination */
  destination: 'r2' | 's3' | 'gcs';
  /** Export format */
  format: 'json' | 'csv' | 'parquet';
  /** Export frequency */
  frequency: 'hourly' | 'daily' | 'weekly';
  /** Bucket/container name */
  bucket: string;
  /** Path prefix */
  prefix?: string;
}

/**
 * Default audit configuration.
 */
export const DEFAULT_AUDIT_CONFIG: AuditConfig = {
  enabled: true,
  logEventTypes: [
    'contract.created',
    'contract.updated',
    'contract.status_changed',
    'contract.rolled_back',
    'contract.deleted',
    'access.denied',
  ],
  retentionDays: 90,
  includeRequestBody: false,
  includeResponseBody: false,
  maskSensitiveFields: true,
  sensitiveFields: ['password', 'secret', 'token', 'credential'],
};

// =============================================================================
// Audit Report
// =============================================================================

/**
 * Audit compliance report.
 */
export interface AuditComplianceReport {
  /** Report ID */
  id: string;
  /** Report generation time (ISO 8601) */
  generatedAt: string;
  /** Reporting period */
  period: {
    start: string;
    end: string;
  };
  /** Tenant ID */
  tenantId: string;
  /** Summary statistics */
  summary: AuditSummary;
  /** Compliance status */
  complianceStatus: 'compliant' | 'non_compliant' | 'needs_review';
  /** Issues found */
  issues: ComplianceIssue[];
  /** Recommendations */
  recommendations: string[];
}

/**
 * Compliance issue found in audit.
 */
export interface ComplianceIssue {
  /** Issue type */
  type: 'missing_logs' | 'unauthorized_access' | 'policy_violation' | 'retention_issue';
  /** Issue severity */
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** Issue description */
  description: string;
  /** Affected resources */
  affectedResources?: string[];
  /** Remediation steps */
  remediation?: string;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Create an audit log entry.
 */
export function createAuditLogEntry(
  eventType: ContractAuditEventType,
  subject: AuditSubject,
  actor: AuditActor,
  action: string,
  result: 'success' | 'failure',
  retentionDays: number = 90
): Omit<ContractAuditLog, 'id'> {
  const now = new Date();
  const retentionUntil = new Date(now);
  retentionUntil.setDate(retentionUntil.getDate() + retentionDays);

  return {
    eventType,
    subject,
    actor,
    action,
    result,
    timestamp: now.toISOString(),
    retentionUntil: retentionUntil.toISOString(),
  };
}
