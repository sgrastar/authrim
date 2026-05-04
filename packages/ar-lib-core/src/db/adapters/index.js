/**
 * Database Adapters
 *
 * Export all database adapter implementations.
 * Currently supported:
 * - D1Adapter: Cloudflare D1 database
 * - PostgresAdapter: PostgreSQL via Hyperdrive
 * - MysqlAdapter: MySQL via Hyperdrive
 *
 * Future adapters:
 * - PostgresAdapter: PostgreSQL via Hyperdrive
 * - MockAdapter: For testing
 */
export { D1Adapter, createD1Adapter } from './d1-adapter';
export { PostgresAdapter, createPostgresAdapter } from './postgres-adapter';
export { MysqlAdapter, createMysqlAdapter } from './mysql-adapter';
