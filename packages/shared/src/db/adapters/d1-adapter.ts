/**
 * D1 Database Adapter
 *
 * Implementation of DatabaseAdapter for Cloudflare D1.
 * Provides:
 * - Type-safe query methods
 * - Transaction support via batch API
 * - Retry logic with exponential backoff
 * - Health check functionality
 *
 * D1 Characteristics:
 * - Serverless SQLite database
 * - Batch API provides transaction-like semantics (all-or-nothing)
 * - No persistent connections (stateless)
 */

import type {
  DatabaseAdapter,
  ExecuteResult,
  PreparedStatement,
  TransactionContext,
  HealthStatus,
  QueryOptions,
} from '../adapter';
import { retryD1Operation, type RetryConfig } from '../../utils/d1-retry';

/**
 * D1 Database type (from @cloudflare/workers-types)
 */
interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run(): Promise<D1Result>;
  all<T = unknown>(): Promise<D1Result<T>>;
  raw<T = unknown>(): Promise<T[]>;
}

interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
  meta?: D1Meta;
  error?: string;
}

interface D1Meta {
  duration?: number;
  changes?: number;
  last_row_id?: number;
  rows_read?: number;
  rows_written?: number;
}

interface D1ExecResult {
  count: number;
  duration: number;
}

/**
 * D1 Adapter Configuration
 */
export interface D1AdapterConfig {
  /** D1 database binding */
  db: D1Database;
  /** Partition identifier for logging/monitoring */
  partition?: string;
  /** Retry configuration */
  retryConfig?: RetryConfig;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * D1 Database Adapter Implementation
 */
export class D1Adapter implements DatabaseAdapter {
  private readonly db: D1Database;
  private readonly partition: string;
  private readonly retryConfig: RetryConfig;
  private readonly debug: boolean;

  constructor(config: D1AdapterConfig) {
    this.db = config.db;
    this.partition = config.partition ?? 'default';
    this.retryConfig = config.retryConfig ?? {};
    this.debug = config.debug ?? false;
  }

  /**
   * Execute a SELECT query and return all results
   */
  async query<T>(sql: string, params?: unknown[], options?: QueryOptions): Promise<T[]> {
    const startTime = Date.now();

    try {
      const result = await retryD1Operation(
        async () => {
          const stmt = params ? this.db.prepare(sql).bind(...params) : this.db.prepare(sql);
          return stmt.all<T>();
        },
        `D1Adapter.query[${this.partition}]`,
        this.retryConfig
      );

      if (!result) {
        // Retry exhausted - throw error instead of returning empty array
        // Returning [] would make it impossible to distinguish "no data" from "query failed"
        const errorMsg = `D1Adapter.query failed after retries exhausted`;
        console.error(errorMsg, {
          partition: this.partition,
          sql: this.truncateSql(sql),
        });
        throw new Error(errorMsg);
      }

      if (this.debug) {
        console.log(`D1Adapter.query completed`, {
          partition: this.partition,
          durationMs: Date.now() - startTime,
          rowCount: result.results?.length ?? 0,
        });
      }

      return result.results ?? [];
    } catch (error) {
      console.error(`D1Adapter.query error`, {
        partition: this.partition,
        sql: this.truncateSql(sql),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Execute a SELECT query and return the first result
   */
  async queryOne<T>(sql: string, params?: unknown[], options?: QueryOptions): Promise<T | null> {
    const startTime = Date.now();

    try {
      const result = await retryD1Operation(
        async () => {
          const stmt = params ? this.db.prepare(sql).bind(...params) : this.db.prepare(sql);
          return stmt.first<T>();
        },
        `D1Adapter.queryOne[${this.partition}]`,
        this.retryConfig
      );

      if (this.debug) {
        console.log(`D1Adapter.queryOne completed`, {
          partition: this.partition,
          durationMs: Date.now() - startTime,
          found: result !== null,
        });
      }

      return result;
    } catch (error) {
      console.error(`D1Adapter.queryOne error`, {
        partition: this.partition,
        sql: this.truncateSql(sql),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Execute a statement (INSERT, UPDATE, DELETE)
   */
  async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
    const startTime = Date.now();

    try {
      const result = await retryD1Operation(
        async () => {
          const stmt = params ? this.db.prepare(sql).bind(...params) : this.db.prepare(sql);
          return stmt.run();
        },
        `D1Adapter.execute[${this.partition}]`,
        this.retryConfig
      );

      if (!result) {
        // Retry exhausted - throw error instead of returning success: false
        // Returning { success: false } could be silently ignored by callers
        const errorMsg = `D1Adapter.execute failed after retries exhausted`;
        console.error(errorMsg, {
          partition: this.partition,
          sql: this.truncateSql(sql),
        });
        throw new Error(errorMsg);
      }

      const executeResult: ExecuteResult = {
        rowsAffected: result.meta?.changes ?? 0,
        lastInsertRowid: result.meta?.last_row_id,
        success: result.success,
        durationMs: result.meta?.duration ?? Date.now() - startTime,
      };

      if (this.debug) {
        console.log(`D1Adapter.execute completed`, {
          partition: this.partition,
          durationMs: executeResult.durationMs,
          rowsAffected: executeResult.rowsAffected,
        });
      }

      return executeResult;
    } catch (error) {
      console.error(`D1Adapter.execute error`, {
        partition: this.partition,
        sql: this.truncateSql(sql),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Execute multiple statements in a transaction
   *
   * D1 doesn't have traditional transactions, but batch() provides
   * all-or-nothing semantics. We collect statements and execute them
   * in a batch at the end.
   */
  async transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const startTime = Date.now();
    const collectedStatements: Array<{ sql: string; params?: unknown[] }> = [];
    const pendingResults: Array<{
      resolve: (value: unknown) => void;
      reject: (reason: unknown) => void;
      type: 'query' | 'queryOne' | 'execute';
    }> = [];

    // Create a transaction context that collects statements
    const txContext: TransactionContext = {
      query: <T>(sql: string, params?: unknown[]): Promise<T[]> => {
        return new Promise((resolve, reject) => {
          collectedStatements.push({ sql, params });
          pendingResults.push({
            resolve: resolve as (value: unknown) => void,
            reject,
            type: 'query',
          });
        });
      },
      queryOne: <T>(sql: string, params?: unknown[]): Promise<T | null> => {
        return new Promise((resolve, reject) => {
          collectedStatements.push({ sql, params });
          pendingResults.push({
            resolve: resolve as (value: unknown) => void,
            reject,
            type: 'queryOne',
          });
        });
      },
      execute: (sql: string, params?: unknown[]): Promise<ExecuteResult> => {
        return new Promise((resolve, reject) => {
          collectedStatements.push({ sql, params });
          pendingResults.push({
            resolve: resolve as (value: unknown) => void,
            reject,
            type: 'execute',
          });
        });
      },
    };

    // Note: D1 batch doesn't support mixing reads and writes in the same way
    // For now, we execute all statements in batch
    // This is a simplified implementation - for complex transactions,
    // consider using a proper transaction-supporting database

    try {
      // Execute the transaction function (collects statements)
      const result = await fn(txContext);

      // If no statements collected, just return the result
      if (collectedStatements.length === 0) {
        return result;
      }

      // Execute all statements in batch
      const preparedStatements = collectedStatements.map((stmt) =>
        stmt.params ? this.db.prepare(stmt.sql).bind(...stmt.params) : this.db.prepare(stmt.sql)
      );

      const batchResults = await retryD1Operation(
        async () => this.db.batch(preparedStatements),
        `D1Adapter.transaction[${this.partition}]`,
        this.retryConfig
      );

      if (!batchResults) {
        throw new Error('Transaction failed: batch execution failed after retries');
      }

      // Resolve pending promises with results
      for (let i = 0; i < pendingResults.length; i++) {
        const pending = pendingResults[i];
        const batchResult = batchResults[i];

        if (!batchResult.success) {
          pending.reject(new Error(batchResult.error ?? 'Statement failed'));
          continue;
        }

        switch (pending.type) {
          case 'query':
            pending.resolve(batchResult.results ?? []);
            break;
          case 'queryOne':
            pending.resolve(batchResult.results?.[0] ?? null);
            break;
          case 'execute':
            pending.resolve({
              rowsAffected: batchResult.meta?.changes ?? 0,
              lastInsertRowid: batchResult.meta?.last_row_id,
              success: batchResult.success,
              durationMs: batchResult.meta?.duration,
            } as ExecuteResult);
            break;
        }
      }

      if (this.debug) {
        console.log(`D1Adapter.transaction completed`, {
          partition: this.partition,
          durationMs: Date.now() - startTime,
          statementCount: collectedStatements.length,
        });
      }

      return result;
    } catch (error) {
      // Reject all pending promises
      for (const pending of pendingResults) {
        pending.reject(error);
      }

      console.error(`D1Adapter.transaction error`, {
        partition: this.partition,
        error: error instanceof Error ? error.message : String(error),
        statementCount: collectedStatements.length,
      });
      throw error;
    }
  }

  /**
   * Execute multiple statements in a batch
   */
  async batch(statements: PreparedStatement[]): Promise<ExecuteResult[]> {
    const startTime = Date.now();

    if (statements.length === 0) {
      return [];
    }

    try {
      const preparedStatements = statements.map((stmt) =>
        stmt.params ? this.db.prepare(stmt.sql).bind(...stmt.params) : this.db.prepare(stmt.sql)
      );

      const results = await retryD1Operation(
        async () => this.db.batch(preparedStatements),
        `D1Adapter.batch[${this.partition}]`,
        this.retryConfig
      );

      if (!results) {
        // Retry exhausted - throw error for consistent behavior
        const errorMsg = `D1Adapter.batch failed after retries exhausted`;
        console.error(errorMsg, {
          partition: this.partition,
          statementCount: statements.length,
        });
        throw new Error(errorMsg);
      }

      const executeResults: ExecuteResult[] = results.map((result) => ({
        rowsAffected: result.meta?.changes ?? 0,
        lastInsertRowid: result.meta?.last_row_id,
        success: result.success,
        durationMs: result.meta?.duration,
      }));

      if (this.debug) {
        console.log(`D1Adapter.batch completed`, {
          partition: this.partition,
          durationMs: Date.now() - startTime,
          statementCount: statements.length,
        });
      }

      return executeResults;
    } catch (error) {
      console.error(`D1Adapter.batch error`, {
        partition: this.partition,
        error: error instanceof Error ? error.message : String(error),
        statementCount: statements.length,
      });
      throw error;
    }
  }

  /**
   * Check if the database is healthy
   */
  async isHealthy(): Promise<HealthStatus> {
    const startTime = Date.now();

    try {
      // Simple health check query
      const result = await this.db.prepare('SELECT 1').first();
      const latencyMs = Date.now() - startTime;

      return {
        healthy: result !== null,
        latencyMs,
        type: 'd1',
        partition: this.partition,
      };
    } catch (error) {
      return {
        healthy: false,
        latencyMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
        type: 'd1',
        partition: this.partition,
      };
    }
  }

  /**
   * Get the database type
   */
  getType(): string {
    return 'd1';
  }

  /**
   * Close the connection (no-op for D1)
   */
  async close(): Promise<void> {
    // D1 is stateless, no connection to close
  }

  /**
   * Truncate SQL for logging (avoid logging sensitive data)
   */
  private truncateSql(sql: string, maxLength: number = 100): string {
    if (sql.length <= maxLength) {
      return sql;
    }
    return sql.substring(0, maxLength) + '...';
  }
}

/**
 * Create a D1 adapter from environment binding
 *
 * @param db - D1 database binding from Cloudflare Worker environment
 * @param partition - Partition identifier (default: 'default')
 * @returns D1Adapter instance
 *
 * @example
 * ```typescript
 * const adapter = createD1Adapter(env.DB, 'core');
 * const users = await adapter.query<User>('SELECT * FROM users');
 * ```
 */
export function createD1Adapter(
  db: D1Database,
  partition: string = 'default',
  options?: { retryConfig?: RetryConfig; debug?: boolean }
): D1Adapter {
  return new D1Adapter({
    db,
    partition,
    retryConfig: options?.retryConfig,
    debug: options?.debug,
  });
}
