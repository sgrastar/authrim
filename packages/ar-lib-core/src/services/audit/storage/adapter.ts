/**
 * Audit Storage Adapter Interface
 *
 * Provides a unified interface for different audit log storage backends:
 * - D1: Hot data storage for recent logs
 * - R2: Archive storage for long-term retention
 * - Hyperdrive: External PostgreSQL for enterprise deployments
 * - Logpush / Firehose: Forwarding sinks for external delivery
 */

import type { EventLogEntry, PIILogEntry } from '../types';

// =============================================================================
// Storage Backend Types
// =============================================================================

/**
 * Supported storage backend types.
 */
export type AuditStorageBackendType = 'D1' | 'R2' | 'HYPERDRIVE' | 'LOGPUSH' | 'FIREHOSE' | 'HTTP';

/**
 * Log type for routing.
 */
export type AuditLogType = 'event' | 'pii';

// =============================================================================
// Write Result Types
// =============================================================================

/**
 * Result of a write operation.
 */
export interface AuditWriteResult {
  /** Whether the write was successful */
  success: boolean;

  /** Number of entries written */
  entriesWritten: number;

  /** Backend identifier */
  backend: string;

  /** Write duration in milliseconds */
  durationMs: number;

  /** Error message if failed */
  errorMessage?: string;
}

// =============================================================================
// Query Types
// =============================================================================

/**
 * Query options for retrieving audit logs.
 */
export interface AuditQueryOptions {
  /** Tenant ID (required) */
  tenantId: string;

  /** Log type to query */
  logType: AuditLogType;

  /** Start time (epoch milliseconds, inclusive) */
  startTime?: number;

  /** End time (epoch milliseconds, exclusive) */
  endTime?: number;

  /** Event type filter (for event logs) */
  eventType?: string;

  /** Event category filter (for event logs) */
  eventCategory?: string;

  /** Result filter (for event logs) */
  result?: 'success' | 'failure' | 'partial';

  /** Anonymized user ID filter */
  anonymizedUserId?: string;

  /** Client ID filter */
  clientId?: string;

  /** Request ID filter */
  requestId?: string;

  /** User ID filter (for PII logs only) */
  userId?: string;

  /** Change type filter (for PII logs) */
  changeType?: string;

  /** Maximum number of results */
  limit?: number;

  /** Offset for pagination */
  offset?: number;

  /** Sort order */
  sortOrder?: 'asc' | 'desc';
}

/**
 * Query result containing audit log entries.
 */
export interface AuditQueryResult {
  /** Event log entries (if querying event logs) */
  eventEntries?: EventLogEntry[];

  /** PII log entries (if querying PII logs) */
  piiEntries?: PIILogEntry[];

  /** Total count of matching entries (for pagination) */
  totalCount: number;

  /** Whether there are more results */
  hasMore: boolean;

  /** Query duration in milliseconds */
  durationMs: number;

  /** Backend that served the query */
  backend: string;
}

// =============================================================================
// Health Check Types
// =============================================================================

/**
 * Storage health status.
 */
export interface AuditStorageHealth {
  /** Whether the storage is healthy */
  healthy: boolean;

  /** Backend identifier */
  backend: string;

  /** Backend type */
  backendType: AuditStorageBackendType;

  /** Latency of health check in milliseconds */
  latencyMs: number;

  /** Error message if unhealthy */
  errorMessage?: string;

  /** Additional details */
  details?: Record<string, unknown>;
}

// =============================================================================
// Adapter Interface
// =============================================================================

/**
 * Audit storage adapter interface.
 *
 * Implementations must be idempotent for write operations.
 * All timestamps are in epoch milliseconds.
 */
export interface IAuditStorageAdapter {
  /**
   * Get the backend type.
   */
  getBackendType(): AuditStorageBackendType;

  /**
   * Get the backend identifier (e.g., "d1-core", "r2-archive").
   */
  getIdentifier(): string;

  // ---------------------------------------------------------------------------
  // Write Operations
  // ---------------------------------------------------------------------------

  /**
   * Write a single event log entry.
   * Must be idempotent.
   */
  writeEventLog(entry: EventLogEntry): Promise<AuditWriteResult>;

  /**
   * Write multiple event log entries in a batch.
   * Must be idempotent.
   */
  writeEventLogBatch(entries: EventLogEntry[]): Promise<AuditWriteResult>;

  /**
   * Write a single PII log entry.
   * Must be idempotent.
   */
  writePIILog(entry: PIILogEntry): Promise<AuditWriteResult>;

  /**
   * Write multiple PII log entries in a batch.
   * Must be idempotent.
   */
  writePIILogBatch(entries: PIILogEntry[]): Promise<AuditWriteResult>;

  // ---------------------------------------------------------------------------
  // Query Operations
  // ---------------------------------------------------------------------------

  /**
   * Query audit logs based on options.
   */
  query(options: AuditQueryOptions): Promise<AuditQueryResult>;

  /**
   * Count matching entries without retrieving them.
   */
  count(options: Omit<AuditQueryOptions, 'limit' | 'offset'>): Promise<number>;

  // ---------------------------------------------------------------------------
  // Maintenance Operations
  // ---------------------------------------------------------------------------

  /**
   * Delete entries that have exceeded their retention period.
   *
   * @param logType - Type of log to clean up
   * @param beforeTime - Delete entries with retention_until < beforeTime (epoch ms)
   * @param tenantId - Optional tenant ID to scope the cleanup
   * @param batchSize - Maximum entries to delete in one call
   * @returns Number of entries deleted
   */
  deleteByRetention(
    logType: AuditLogType,
    beforeTime: number,
    tenantId?: string,
    batchSize?: number
  ): Promise<number>;

  // ---------------------------------------------------------------------------
  // Health Check
  // ---------------------------------------------------------------------------

  /**
   * Check if the storage backend is healthy.
   */
  isHealthy(): Promise<AuditStorageHealth>;

  /**
   * Close any connections (for cleanup).
   */
  close(): Promise<void>;
}

// =============================================================================
// Backend Configuration
// =============================================================================

/**
 * Configuration for a storage backend.
 */
export interface AuditBackendConfig {
  /** Unique identifier for this backend */
  id: string;

  /** Backend type */
  type: AuditStorageBackendType;

  /** Whether this backend is enabled */
  enabled: boolean;

  /** Priority for routing (lower = higher priority) */
  priority: number;

  /** D1-specific configuration */
  d1Config?: {
    /** Database binding name */
    binding: string;
    /** Whether this is the PII database */
    isPiiDb: boolean;
  };

  /** R2-specific configuration */
  r2Config?: {
    /** Bucket binding name */
    binding: string;
    /** Path prefix for log files */
    pathPrefix: string;
    /** File format */
    format: 'json' | 'jsonl';
  };

  /** Hyperdrive-specific configuration */
  hyperdriveConfig?: {
    /** Hyperdrive binding name */
    binding: string;
    /** External database engine */
    driver?: 'postgres' | 'mysql';
    /** Schema name */
    schema: string;
    /** Connection pool size */
    poolSize?: number;
  };

  /** Logpush-specific configuration */
  logpushConfig?: {
    /** Destination reference or binding */
    destinationRef: string;
    /** Optional dataset/category name */
    dataset?: string;
  };

  /** Firehose-specific configuration */
  firehoseConfig?: {
    /** Stream reference or binding */
    streamRef: string;
    /** Optional delivery region hint */
    region?: string;
  };

  /** Generic HTTP sink configuration */
  httpConfig?: {
    /** Direct URL (non-secret) */
    url?: string;
    /** Environment variable / binding reference for the URL */
    urlRef?: string;
    /** Optional secret/env reference for bearer token */
    authTokenRef?: string;
    /** Additional static headers */
    headers?: Record<string, string>;
    /** HTTP method */
    method?: 'POST';
    /** Payload format */
    format?: 'json';
  };
}

/**
 * Retention configuration.
 */
export interface AuditRetentionConfig {
  /** Event log retention in days */
  eventLogRetentionDays: number;

  /** PII log retention in days */
  piiLogRetentionDays: number;

  /** Archive to R2 before deletion */
  archiveBeforeDelete: boolean;

  /** Minimum retention required by regulations */
  minimumRetentionDays?: number;
}

/**
 * Fan-out targets for a routing rule.
 *
 * A single matching rule may:
 * - write hot data to one primary store
 * - mirror or archive into one or more archive stores
 * - forward to one or more sinks such as Logpush or Firehose
 */
export interface AuditStorageRoutingTargets {
  /** Primary queryable store for matched logs */
  primaryStore?: string;

  /** Archive stores that should receive a copy */
  archiveStores?: string[];

  /** Forwarding sinks that should receive a copy */
  forwardingSinks?: string[];
}

/**
 * Routing rule for directing logs to specific backends.
 */
export interface AuditStorageRoutingRule {
  /** Rule name */
  name: string;

  /** Priority (lower = higher priority) */
  priority: number;

  /** Whether this rule is enabled */
  enabled: boolean;

  /** Conditions to match */
  conditions: {
    tenantId?: string | string[];
    clientId?: string | string[];
    logType?: AuditLogType | '*';
    eventCategory?: string | string[];
    region?: string | string[];
  };

  /** Canonical fan-out targets for this rule */
  targets: AuditStorageRoutingTargets;

  /**
   * Deprecated single-backend alias.
   *
   * Pre-Phase 4 configs may still persist `backend`; runtime/admin code should
   * normalize it into `targets.primaryStore` on read and write.
   */
  backend?: string;

  /** Override retention for matching logs */
  retention?: Partial<AuditRetentionConfig>;
}

/**
 * Complete storage configuration.
 */
export interface AuditStorageConfig {
  /** List of backend configurations */
  backends: AuditBackendConfig[];

  /** Default backend ID for event logs */
  defaultEventBackend: string;

  /** Default backend ID for PII logs */
  defaultPiiBackend: string;

  /** Default retention configuration */
  defaultRetention: AuditRetentionConfig;

  /** Routing rules */
  routingRules: AuditStorageRoutingRule[];

  /** Batch configuration */
  batchConfig: {
    /** Maximum buffer size before flush */
    maxBufferSize: number;
    /** Flush interval in milliseconds */
    flushIntervalMs: number;
    /** Maximum batch size for writes */
    maxBatchSize: number;
  };
}

function normalizeTargetList(values: string[] | undefined): string[] | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }

  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Normalize legacy and partial routing targets into the Phase 4 canonical shape.
 */
export function normalizeAuditStorageRoutingTargets(
  targets: AuditStorageRoutingTargets | undefined,
  backend?: string | null
): AuditStorageRoutingTargets {
  const primaryStore = targets?.primaryStore?.trim() || backend?.trim() || undefined;
  const archiveStores = normalizeTargetList(targets?.archiveStores);
  const forwardingSinks = normalizeTargetList(targets?.forwardingSinks);

  return {
    ...(primaryStore ? { primaryStore } : {}),
    ...(archiveStores ? { archiveStores } : {}),
    ...(forwardingSinks ? { forwardingSinks } : {}),
  };
}

/**
 * Returns true when the routing rule has at least one effective target.
 */
export function hasAuditStorageRoutingTargets(targets: AuditStorageRoutingTargets): boolean {
  return Boolean(
    targets.primaryStore ||
      (targets.archiveStores && targets.archiveStores.length > 0) ||
      (targets.forwardingSinks && targets.forwardingSinks.length > 0)
  );
}

/**
 * Default storage configuration.
 */
export const DEFAULT_AUDIT_STORAGE_CONFIG: AuditStorageConfig = {
  backends: [
    {
      id: 'd1-core',
      type: 'D1',
      enabled: true,
      priority: 1,
      d1Config: {
        binding: 'DB',
        isPiiDb: false,
      },
    },
    {
      id: 'd1-pii',
      type: 'D1',
      enabled: true,
      priority: 1,
      d1Config: {
        binding: 'DB_PII',
        isPiiDb: true,
      },
    },
  ],
  defaultEventBackend: 'd1-core',
  defaultPiiBackend: 'd1-pii',
  defaultRetention: {
    eventLogRetentionDays: 90,
    piiLogRetentionDays: 365,
    archiveBeforeDelete: false,
  },
  routingRules: [],
  batchConfig: {
    maxBufferSize: 100,
    flushIntervalMs: 5000,
    maxBatchSize: 100,
  },
};
