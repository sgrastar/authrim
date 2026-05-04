/**
 * Database Module
 *
 * Provides database abstraction layer for PII/Non-PII separation.
 *
 * Architecture:
 * - DatabaseAdapter: Interface for database operations
 * - D1Adapter: Cloudflare D1 implementation
 * - PostgresAdapter: PostgreSQL via Hyperdrive
 * - MysqlAdapter: MySQL via Hyperdrive
 * - PIIPartitionRouter: Routes PII access to correct database (Phase 3)
 *
 * Usage:
 * ```typescript
 * import { createD1Adapter, createPostgresAdapter, type DatabaseAdapter } from '@authrim/ar-lib-core/db';
 *
 * // Create adapter for Core DB
 * const coreAdapter = createD1Adapter(env.DB, 'core');
 *
 * // Create adapter for PII DB
 * const piiAdapter = createD1Adapter(env.DB_PII, 'pii');
 * ```
 */
// Utilities
export { escapeLikePattern } from './adapter';
export { ensureDatabaseAdapter, ensureOptionalDatabaseAdapter, isDatabaseAdapter, isD1DatabaseLike, isDatabaseSource, } from './adapter-source';
// Adapters
export { D1Adapter, createD1Adapter, PostgresAdapter, createPostgresAdapter, MysqlAdapter, createMysqlAdapter, } from './adapters';
// Partition Router
export { PIIPartitionRouter, createPIIPartitionRouter, buildPartitionSettingsKvKey, getDefaultPartitionSettings, validatePartitionSettings, clearPartitionSettingsCache, DEFAULT_PARTITION, PARTITION_SETTINGS_KV_PREFIX, PARTITION_SETTINGS_CACHE_TTL_MS, COUNTRY_TO_PARTITION, } from './partition-router';
