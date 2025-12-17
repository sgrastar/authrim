/**
 * Database Adapters
 *
 * Export all database adapter implementations.
 * Currently supported:
 * - D1Adapter: Cloudflare D1 database
 *
 * Future adapters:
 * - PostgresAdapter: PostgreSQL via Hyperdrive
 * - MockAdapter: For testing
 */

export { D1Adapter, createD1Adapter, type D1AdapterConfig } from './d1-adapter';
