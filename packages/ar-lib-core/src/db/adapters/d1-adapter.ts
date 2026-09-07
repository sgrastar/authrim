/**
 * D1 Database Adapter
 *
 * Implementation of DatabaseAdapter for Cloudflare D1.
 * Provides:
 * - Type-safe query methods
 * - Explicit atomic batches and non-atomic callback compatibility
 * - Retry logic with exponential backoff
 * - Health check functionality
 *
 * D1 Characteristics:
 * - Serverless SQLite database
 * - Batch API provides all-or-nothing semantics
 * - Callback transactions execute immediately and cannot roll back
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
import { isTransientD1Error, retryD1Operation, type RetryConfig } from '../../utils/d1-retry';
import { createLogger } from '../../utils/logger';

const log = createLogger().module('D1');

/**
 * D1 Database type (from @cloudflare/workers-types)
 */
interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
  withSession?(constraintOrBookmark?: string): D1DatabaseSession;
}

interface D1DatabaseSession {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  getBookmark(): string | null;
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
  /** Maximum concurrent operations within this adapter/request context. */
  maxConcurrentOperations?: number;
  /** Maximum queued operations within this adapter instance (request-scoped in Worker paths). */
  maxQueuedOperations?: number;
  /** Maximum time to wait for local admission. */
  admissionWaitMs?: number;
}

interface D1AdmissionWaiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface D1AdmissionState {
  active: number;
  waiters: D1AdmissionWaiter[];
}

/**
 * D1 Database Adapter Implementation
 */
export class D1Adapter implements DatabaseAdapter {
  private readonly db: D1Database;
  private readonly partition: string;
  private readonly retryConfig: RetryConfig;
  private readonly debug: boolean;
  private readonly maxConcurrentOperations: number;
  private readonly maxQueuedOperations: number;
  private readonly admissionWaitMs: number;
  // Deliberately adapter-local. Sharing pending promises across Worker requests causes
  // cross-request I/O violations; callers create adapters inside one request/actor context.
  private readonly admissionState: D1AdmissionState = { active: 0, waiters: [] };

  constructor(config: D1AdapterConfig) {
    this.db = config.db;
    this.partition = config.partition ?? 'default';
    this.retryConfig = {
      maxRetries: 1,
      initialDelayMs: 40,
      maxDelayMs: 250,
      backoffMultiplier: 2,
      jitterRatio: 0.35,
      maxElapsedMs: 1200,
      shouldRetry: isTransientD1Error,
      throwOnExhausted: true,
      ...(config.retryConfig ?? {}),
    };
    this.debug = config.debug ?? false;
    this.maxConcurrentOperations = Math.max(1, config.maxConcurrentOperations ?? 8);
    this.maxQueuedOperations = Math.max(0, config.maxQueuedOperations ?? 64);
    this.admissionWaitMs = Math.max(1, config.admissionWaitMs ?? 500);
  }

  private async withAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireAdmission();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private acquireAdmission(): Promise<() => void> {
    const state = this.admissionState;
    if (state.active < this.maxConcurrentOperations) {
      state.active += 1;
      return Promise.resolve(this.releaseAdmission(state));
    }
    if (state.waiters.length >= this.maxQueuedOperations) {
      return Promise.reject(new Error('d1_admission_queue_full'));
    }
    return new Promise((resolve, reject) => {
      const waiter: D1AdmissionWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = state.waiters.indexOf(waiter);
          if (index >= 0) state.waiters.splice(index, 1);
          reject(new Error('d1_admission_queue_timeout'));
        }, this.admissionWaitMs),
      };
      state.waiters.push(waiter);
    });
  }

  private releaseAdmission(state: D1AdmissionState): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = state.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(this.releaseAdmission(state));
        return;
      }
      state.active = Math.max(0, state.active - 1);
    };
  }

  /**
   * Execute a SELECT query and return all results
   */
  async query<T>(sql: string, params?: unknown[], options?: QueryOptions): Promise<T[]> {
    const startTime = Date.now();
    const sessionConstraint = this.readSessionConstraint(options);

    try {
      const result = await retryD1Operation(
        async () => {
          const session = this.readSession(sessionConstraint);
          const stmt = params ? session.prepare(sql).bind(...params) : session.prepare(sql);
          return this.withAdmission(() => stmt.all<T>());
        },
        `D1Adapter.query[${this.partition}]`,
        this.retryConfig
      );

      if (!result) {
        // Retry exhausted - throw error instead of returning empty array
        // Returning [] would make it impossible to distinguish "no data" from "query failed"
        log.error('D1Adapter.query failed after retries exhausted', {
          partition: this.partition,
          sql: this.truncateSql(sql),
        });
        throw new Error('D1Adapter.query failed after retries exhausted');
      }

      if (this.debug) {
        log.debug('D1Adapter.query completed', {
          partition: this.partition,
          durationMs: Date.now() - startTime,
          rowCount: result.results?.length ?? 0,
        });
      }

      return result.results ?? [];
    } catch (error) {
      log.error(
        'D1Adapter.query error',
        {
          partition: this.partition,
          sql: this.truncateSql(sql),
        },
        error as Error
      );
      throw error;
    }
  }

  /**
   * Execute a SELECT query and return the first result
   */
  async queryOne<T>(sql: string, params?: unknown[], options?: QueryOptions): Promise<T | null> {
    const startTime = Date.now();
    const sessionConstraint = this.readSessionConstraint(options);

    try {
      const result = await retryD1Operation(
        async () => {
          const session = this.readSession(sessionConstraint);
          const stmt = params ? session.prepare(sql).bind(...params) : session.prepare(sql);
          return { value: await this.withAdmission(() => stmt.first<T>()) };
        },
        `D1Adapter.queryOne[${this.partition}]`,
        this.retryConfig
      );

      if (!result) {
        log.error('D1Adapter.queryOne failed after retries exhausted', {
          partition: this.partition,
          sql: this.truncateSql(sql),
        });
        throw new Error('D1Adapter.queryOne failed after retries exhausted');
      }

      if (this.debug) {
        log.debug('D1Adapter.queryOne completed', {
          partition: this.partition,
          durationMs: Date.now() - startTime,
          found: result.value !== null,
        });
      }

      return result.value;
    } catch (error) {
      log.error(
        'D1Adapter.queryOne error',
        {
          partition: this.partition,
          sql: this.truncateSql(sql),
        },
        error as Error
      );
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
          return this.withAdmission(() => stmt.run());
        },
        `D1Adapter.execute[${this.partition}]`,
        this.retryConfig
      );

      if (!result) {
        // Retry exhausted - throw error instead of returning success: false
        // Returning { success: false } could be silently ignored by callers
        log.error('D1Adapter.execute failed after retries exhausted', {
          partition: this.partition,
          sql: this.truncateSql(sql),
        });
        throw new Error('D1Adapter.execute failed after retries exhausted');
      }

      const executeResult: ExecuteResult = {
        rowsAffected: result.meta?.changes ?? 0,
        lastInsertRowid: result.meta?.last_row_id,
        success: result.success,
        durationMs: result.meta?.duration ?? Date.now() - startTime,
      };

      if (this.debug) {
        log.debug('D1Adapter.execute completed', {
          partition: this.partition,
          durationMs: executeResult.durationMs,
          rowsAffected: executeResult.rowsAffected,
        });
      }

      return executeResult;
    } catch (error) {
      log.error(
        'D1Adapter.execute error',
        {
          partition: this.partition,
          sql: this.truncateSql(sql),
        },
        error as Error
      );
      throw error;
    }
  }

  /**
   * Execute multiple statements in a transaction
   *
   * D1's batch API is only suitable when the full statement list is known up
   * front. Transaction callbacks in this adapter contract await each
   * tx.query/tx.execute call and may branch on query results, so deferring
   * execution until after the callback returns deadlocks the callback. Execute
   * statements immediately to preserve the callback semantics shared with the
   * Postgres and MySQL adapters.
   */
  async transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const startTime = Date.now();
    let statementCount = 0;

    const txContext: TransactionContext = {
      query: async <T>(sql: string, params?: unknown[], options?: QueryOptions): Promise<T[]> => {
        statementCount++;
        return this.query<T>(sql, params, options);
      },
      queryOne: async <T>(
        sql: string,
        params?: unknown[],
        options?: QueryOptions
      ): Promise<T | null> => {
        statementCount++;
        return this.queryOne<T>(sql, params, options);
      },
      execute: async (sql: string, params?: unknown[]): Promise<ExecuteResult> => {
        statementCount++;
        return this.execute(sql, params);
      },
    };

    try {
      const result = await fn(txContext);
      if (this.debug) {
        log.debug('D1Adapter.transaction completed', {
          partition: this.partition,
          durationMs: Date.now() - startTime,
          statementCount,
        });
      }

      return result;
    } catch (error) {
      log.error(
        'D1Adapter.transaction error',
        {
          partition: this.partition,
          statementCount,
        },
        error as Error
      );
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
        async () => this.withAdmission(() => this.db.batch(preparedStatements)),
        `D1Adapter.batch[${this.partition}]`,
        this.retryConfig
      );

      if (!results) {
        // Retry exhausted - throw error for consistent behavior
        log.error('D1Adapter.batch failed after retries exhausted', {
          partition: this.partition,
          statementCount: statements.length,
        });
        throw new Error('D1Adapter.batch failed after retries exhausted');
      }

      const executeResults: ExecuteResult[] = results.map((result) => ({
        rowsAffected: result.meta?.changes ?? 0,
        lastInsertRowid: result.meta?.last_row_id,
        success: result.success,
        durationMs: result.meta?.duration,
      }));

      if (this.debug) {
        log.debug('D1Adapter.batch completed', {
          partition: this.partition,
          durationMs: Date.now() - startTime,
          statementCount: statements.length,
        });
      }

      return executeResults;
    } catch (error) {
      log.error(
        'D1Adapter.batch error',
        {
          partition: this.partition,
          statementCount: statements.length,
        },
        error as Error
      );
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
      const result = await this.readSession('first-primary').prepare('SELECT 1').first();
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

  private readSessionConstraint(options?: QueryOptions): string {
    const consistencyClass =
      options?.consistencyClass ??
      (options?.useReadReplica === true ? 'replica_eligible' : 'primary_required');
    const bookmark = options?.bookmark?.trim() || null;
    if (consistencyClass === 'read_after_write') {
      if (!bookmark) throw new Error('d1_read_after_write_bookmark_required');
      if (typeof this.db.withSession !== 'function') throw new Error('d1_sessions_api_required');
      return bookmark;
    }
    if (bookmark) throw new Error(`d1_bookmark_not_allowed_for:${consistencyClass}`);
    const constraint =
      consistencyClass === 'replica_eligible' ? 'first-unconstrained' : 'first-primary';
    if (constraint !== 'first-primary' && typeof this.db.withSession !== 'function') {
      throw new Error('d1_sessions_api_required');
    }
    return constraint;
  }

  private readSession(constraint: string): D1DatabaseSession {
    if (typeof this.db.withSession === 'function') return this.db.withSession(constraint);
    if (constraint !== 'first-primary') throw new Error('d1_sessions_api_required');
    return this.db as unknown as D1DatabaseSession;
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
