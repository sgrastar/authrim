/**
 * Database Module
 *
 * Provides database abstraction layer for PII/Non-PII separation.
 *
 * Architecture:
 * - DatabaseAdapter: Interface for database operations
 * - D1Adapter: Cloudflare D1 implementation
 * - PIIPartitionRouter: Routes PII access to correct database (Phase 3)
 *
 * Usage:
 * ```typescript
 * import { createD1Adapter, type DatabaseAdapter } from '@authrim/shared/db';
 *
 * // Create adapter for Core DB
 * const coreAdapter = createD1Adapter(env.DB, 'core');
 *
 * // Create adapter for PII DB
 * const piiAdapter = createD1Adapter(env.DB_PII, 'pii');
 * ```
 */

// Types and interfaces
export type {
  DatabaseAdapter,
  ExecuteResult,
  PreparedStatement,
  TransactionContext,
  HealthStatus,
  QueryOptions,
  DatabaseAdapterFactory,
  PIIStatus,
  PIIClass,
} from './adapter';

// Adapters
export { D1Adapter, createD1Adapter, type D1AdapterConfig } from './adapters';

// Partition Router
export {
  PIIPartitionRouter,
  createPIIPartitionRouter,
  buildPartitionSettingsKvKey,
  getDefaultPartitionSettings,
  validatePartitionSettings,
  clearPartitionSettingsCache,
  DEFAULT_PARTITION,
  PARTITION_SETTINGS_KV_PREFIX,
  PARTITION_SETTINGS_CACHE_TTL_MS,
  COUNTRY_TO_PARTITION,
  type PartitionKey,
  type PartitionRuleOperator,
  type PartitionRuleCondition,
  type PartitionRule,
  type PartitionSettings,
  type CfGeoProperties,
  type UserPartitionAttributes,
  type PartitionResolution,
  type PartitionResolutionMethod,
} from './partition-router';
