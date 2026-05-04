/**
 * Audit Storage Adapters
 *
 * Provides unified storage interface for audit logs with multiple backend support:
 * - D1: Hot data storage for recent logs (fast queries)
 * - R2: Archive storage for long-term retention (cost-efficient)
 * - Hyperdrive: External PostgreSQL/MySQL for enterprise deployments
 */
export { DEFAULT_AUDIT_STORAGE_CONFIG, hasAuditStorageRoutingTargets, normalizeAuditStorageRoutingTargets, } from './adapter';
export { auditRoutingRuleMatches, resolveAuditRoutingTargets } from './routing';
// D1 Adapter
export { D1AuditAdapter, createD1EventLogAdapter, createD1PIILogAdapter } from './d1-adapter';
// R2 Adapter
export { R2AuditAdapter, createR2AuditAdapter } from './r2-adapter';
// Hyperdrive Adapter
export { HyperdriveAuditAdapter, createHyperdriveAuditAdapter } from './hyperdrive-adapter';
export { MysqlAuditAdapter, createMysqlAuditAdapter } from './mysql-audit-adapter';
export { resolveHyperdriveBindingForAuditTarget } from '../hyperdrive-binding';
