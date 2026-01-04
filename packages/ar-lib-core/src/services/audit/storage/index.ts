/**
 * Audit Storage Adapters
 *
 * Provides unified storage interface for audit logs with multiple backend support:
 * - D1: Hot data storage for recent logs (fast queries)
 * - R2: Archive storage for long-term retention (cost-efficient)
 * - Hyperdrive: External PostgreSQL for enterprise deployments
 */

// Adapter Interface
export type {
  IAuditStorageAdapter,
  AuditStorageBackendType,
  AuditLogType,
  AuditWriteResult,
  AuditQueryOptions,
  AuditQueryResult,
  AuditStorageHealth,
  AuditBackendConfig,
  AuditRetentionConfig,
  AuditStorageRoutingRule,
  AuditStorageConfig,
} from './adapter';

export { DEFAULT_AUDIT_STORAGE_CONFIG } from './adapter';

// D1 Adapter
export { D1AuditAdapter, createD1EventLogAdapter, createD1PIILogAdapter } from './d1-adapter';

export type { D1AuditAdapterConfig } from './d1-adapter';

// R2 Adapter
export { R2AuditAdapter, createR2AuditAdapter } from './r2-adapter';

export type { R2AuditAdapterConfig } from './r2-adapter';

// Hyperdrive Adapter
export { HyperdriveAuditAdapter, createHyperdriveAuditAdapter } from './hyperdrive-adapter';

export type { HyperdriveAuditAdapterConfig } from './hyperdrive-adapter';
