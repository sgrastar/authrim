/**
 * Database Adapter Interface
 *
 * Provides an abstraction layer for database operations, enabling:
 * - Multiple backend support (D1, Postgres via Hyperdrive, DynamoDB, etc.)
 * - Mock adapters for testing
 * - Partition-specific adapters (different backends per partition)
 *
 * Design decisions:
 * - Generic methods for type-safe queries
 * - Transaction support with context passing
 * - Batch operations for performance
 * - Health check for monitoring
 */

/**
 * Result of an execute operation (INSERT, UPDATE, DELETE)
 */
export interface ExecuteResult {
  /** Number of rows affected by the operation */
  rowsAffected: number;
  /** Last inserted row ID (if applicable) */
  lastInsertRowid?: number | bigint;
  /** Whether the operation was successful */
  success: boolean;
  /** Duration of the operation in milliseconds */
  durationMs?: number;
}

/**
 * Prepared statement for batch operations
 */
export interface PreparedStatement {
  /** SQL query string */
  sql: string;
  /** Query parameters */
  params?: unknown[];
}

/**
 * Transaction context passed to transaction callbacks
 */
export interface TransactionContext {
  /**
   * Execute a query within the transaction
   * @param sql - SQL query string
   * @param params - Query parameters
   */
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;

  /**
   * Execute a query and return the first result
   * @param sql - SQL query string
   * @param params - Query parameters
   */
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>;

  /**
   * Execute a statement (INSERT, UPDATE, DELETE) within the transaction
   * @param sql - SQL statement
   * @param params - Statement parameters
   */
  execute(sql: string, params?: unknown[]): Promise<ExecuteResult>;
}

/**
 * Database health status
 */
export interface HealthStatus {
  /** Whether the database is healthy */
  healthy: boolean;
  /** Latency in milliseconds */
  latencyMs: number;
  /** Error message if unhealthy */
  error?: string;
  /** Database type (d1, postgres, etc.) */
  type: string;
  /** Partition identifier */
  partition?: string;
}

/**
 * Query options for advanced queries
 */
export interface QueryOptions {
  /** Query timeout in milliseconds */
  timeoutMs?: number;
  /** Whether to use read replica (if available) */
  useReadReplica?: boolean;
}

/**
 * Database Adapter Interface
 *
 * All database implementations must implement this interface.
 * This enables:
 * - D1 adapter for Cloudflare Workers
 * - Postgres adapter via Hyperdrive
 * - Mock adapter for testing
 * - Future: DynamoDB, MySQL adapters
 */
export interface DatabaseAdapter {
  /**
   * Execute a SELECT query and return all results
   *
   * @param sql - SQL query string with ? placeholders
   * @param params - Query parameters (ordered)
   * @returns Array of results
   *
   * @example
   * ```typescript
   * const users = await adapter.query<User>(
   *   'SELECT * FROM users WHERE tenant_id = ?',
   *   [tenantId]
   * );
   * ```
   */
  query<T>(sql: string, params?: unknown[], options?: QueryOptions): Promise<T[]>;

  /**
   * Execute a SELECT query and return the first result
   *
   * @param sql - SQL query string with ? placeholders
   * @param params - Query parameters (ordered)
   * @returns First result or null if not found
   *
   * @example
   * ```typescript
   * const user = await adapter.queryOne<User>(
   *   'SELECT * FROM users WHERE id = ?',
   *   [userId]
   * );
   * ```
   */
  queryOne<T>(sql: string, params?: unknown[], options?: QueryOptions): Promise<T | null>;

  /**
   * Execute a statement (INSERT, UPDATE, DELETE)
   *
   * @param sql - SQL statement with ? placeholders
   * @param params - Statement parameters (ordered)
   * @returns Execution result with affected rows
   *
   * @example
   * ```typescript
   * const result = await adapter.execute(
   *   'INSERT INTO users (id, email) VALUES (?, ?)',
   *   [userId, email]
   * );
   * console.log(`Inserted ${result.rowsAffected} rows`);
   * ```
   */
  execute(sql: string, params?: unknown[]): Promise<ExecuteResult>;

  /**
   * Execute multiple statements in a transaction
   *
   * If any statement fails, all changes are rolled back.
   * Note: D1 uses batch for transactions (all-or-nothing semantics)
   *
   * @param fn - Async function receiving transaction context
   * @returns Result of the transaction function
   *
   * @example
   * ```typescript
   * const result = await adapter.transaction(async (tx) => {
   *   await tx.execute('INSERT INTO users (id) VALUES (?)', [userId]);
   *   await tx.execute('INSERT INTO profiles (user_id) VALUES (?)', [userId]);
   *   return { userId };
   * });
   * ```
   */
  transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T>;

  /**
   * Execute multiple statements in a batch (all-or-nothing)
   *
   * More efficient than individual statements for bulk operations.
   * In D1, this uses the batch API for atomic execution.
   *
   * @param statements - Array of prepared statements
   * @returns Array of execution results
   *
   * @example
   * ```typescript
   * const results = await adapter.batch([
   *   { sql: 'INSERT INTO users (id) VALUES (?)', params: [userId1] },
   *   { sql: 'INSERT INTO users (id) VALUES (?)', params: [userId2] },
   * ]);
   * ```
   */
  batch(statements: PreparedStatement[]): Promise<ExecuteResult[]>;

  /**
   * Check if the database is healthy and responsive
   *
   * Used for health checks and monitoring.
   *
   * @returns Health status with latency information
   *
   * @example
   * ```typescript
   * const health = await adapter.isHealthy();
   * if (!health.healthy) {
   *   console.error(`Database unhealthy: ${health.error}`);
   * }
   * ```
   */
  isHealthy(): Promise<HealthStatus>;

  /**
   * Get the database type identifier
   *
   * @returns Database type string (e.g., 'd1', 'postgres', 'mock')
   */
  getType(): string;

  /**
   * Close the database connection (if applicable)
   *
   * For pooled connections, this may return the connection to the pool.
   * For D1, this is a no-op.
   */
  close(): Promise<void>;
}

/**
 * Factory function type for creating database adapters
 */
export type DatabaseAdapterFactory = (config: unknown) => DatabaseAdapter;

/**
 * PII Status values for tracking PII write state
 *
 * State machine:
 * - none: No PII (M2M clients, etc.)
 * - pending: Core created, PII not yet written
 * - active: Core and PII both created successfully
 * - failed: PII write failed (can retry via Admin API)
 * - deleted: GDPR deletion completed (tombstone created)
 */
export type PIIStatus = 'none' | 'pending' | 'active' | 'failed' | 'deleted';

/**
 * PII Sensitivity Class for categorizing PII data
 *
 * Classes:
 * - IDENTITY_CORE: email, phone (required for auth)
 * - PROFILE: name, picture (OIDC standard claims)
 * - DEMOGRAPHIC: gender, birthdate (GDPR Art.9 special categories)
 * - LOCATION: address claims
 * - HIGH_RISK: gov-id, biometrics (future)
 */
export type PIIClass = 'IDENTITY_CORE' | 'PROFILE' | 'DEMOGRAPHIC' | 'LOCATION' | 'HIGH_RISK';
