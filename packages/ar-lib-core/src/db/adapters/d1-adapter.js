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
import { retryD1Operation } from '../../utils/d1-retry';
import { createLogger } from '../../utils/logger';
const log = createLogger().module('D1');
/**
 * D1 Database Adapter Implementation
 */
export class D1Adapter {
    db;
    partition;
    retryConfig;
    debug;
    constructor(config) {
        this.db = config.db;
        this.partition = config.partition ?? 'default';
        this.retryConfig = config.retryConfig ?? {};
        this.debug = config.debug ?? false;
    }
    /**
     * Execute a SELECT query and return all results
     */
    async query(sql, params, options) {
        const startTime = Date.now();
        try {
            const result = await retryD1Operation(async () => {
                const stmt = params ? this.db.prepare(sql).bind(...params) : this.db.prepare(sql);
                return stmt.all();
            }, `D1Adapter.query[${this.partition}]`, this.retryConfig);
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
        }
        catch (error) {
            log.error('D1Adapter.query error', {
                partition: this.partition,
                sql: this.truncateSql(sql),
            }, error);
            throw error;
        }
    }
    /**
     * Execute a SELECT query and return the first result
     */
    async queryOne(sql, params, options) {
        const startTime = Date.now();
        try {
            const result = await retryD1Operation(async () => {
                const stmt = params ? this.db.prepare(sql).bind(...params) : this.db.prepare(sql);
                return stmt.first();
            }, `D1Adapter.queryOne[${this.partition}]`, this.retryConfig);
            if (this.debug) {
                log.debug('D1Adapter.queryOne completed', {
                    partition: this.partition,
                    durationMs: Date.now() - startTime,
                    found: result !== null,
                });
            }
            return result;
        }
        catch (error) {
            log.error('D1Adapter.queryOne error', {
                partition: this.partition,
                sql: this.truncateSql(sql),
            }, error);
            throw error;
        }
    }
    /**
     * Execute a statement (INSERT, UPDATE, DELETE)
     */
    async execute(sql, params) {
        const startTime = Date.now();
        try {
            const result = await retryD1Operation(async () => {
                const stmt = params ? this.db.prepare(sql).bind(...params) : this.db.prepare(sql);
                return stmt.run();
            }, `D1Adapter.execute[${this.partition}]`, this.retryConfig);
            if (!result) {
                // Retry exhausted - throw error instead of returning success: false
                // Returning { success: false } could be silently ignored by callers
                log.error('D1Adapter.execute failed after retries exhausted', {
                    partition: this.partition,
                    sql: this.truncateSql(sql),
                });
                throw new Error('D1Adapter.execute failed after retries exhausted');
            }
            const executeResult = {
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
        }
        catch (error) {
            log.error('D1Adapter.execute error', {
                partition: this.partition,
                sql: this.truncateSql(sql),
            }, error);
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
    async transaction(fn) {
        const startTime = Date.now();
        const collectedStatements = [];
        const pendingResults = [];
        // Create a transaction context that collects statements
        const txContext = {
            query: (sql, params) => {
                return new Promise((resolve, reject) => {
                    collectedStatements.push({ sql, params });
                    pendingResults.push({
                        resolve: resolve,
                        reject,
                        type: 'query',
                    });
                });
            },
            queryOne: (sql, params) => {
                return new Promise((resolve, reject) => {
                    collectedStatements.push({ sql, params });
                    pendingResults.push({
                        resolve: resolve,
                        reject,
                        type: 'queryOne',
                    });
                });
            },
            execute: (sql, params) => {
                return new Promise((resolve, reject) => {
                    collectedStatements.push({ sql, params });
                    pendingResults.push({
                        resolve: resolve,
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
            const preparedStatements = collectedStatements.map((stmt) => stmt.params ? this.db.prepare(stmt.sql).bind(...stmt.params) : this.db.prepare(stmt.sql));
            const batchResults = await retryD1Operation(async () => this.db.batch(preparedStatements), `D1Adapter.transaction[${this.partition}]`, this.retryConfig);
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
                        });
                        break;
                }
            }
            if (this.debug) {
                log.debug('D1Adapter.transaction completed', {
                    partition: this.partition,
                    durationMs: Date.now() - startTime,
                    statementCount: collectedStatements.length,
                });
            }
            return result;
        }
        catch (error) {
            // Reject all pending promises
            for (const pending of pendingResults) {
                pending.reject(error);
            }
            log.error('D1Adapter.transaction error', {
                partition: this.partition,
                statementCount: collectedStatements.length,
            }, error);
            throw error;
        }
    }
    /**
     * Execute multiple statements in a batch
     */
    async batch(statements) {
        const startTime = Date.now();
        if (statements.length === 0) {
            return [];
        }
        try {
            const preparedStatements = statements.map((stmt) => stmt.params ? this.db.prepare(stmt.sql).bind(...stmt.params) : this.db.prepare(stmt.sql));
            const results = await retryD1Operation(async () => this.db.batch(preparedStatements), `D1Adapter.batch[${this.partition}]`, this.retryConfig);
            if (!results) {
                // Retry exhausted - throw error for consistent behavior
                log.error('D1Adapter.batch failed after retries exhausted', {
                    partition: this.partition,
                    statementCount: statements.length,
                });
                throw new Error('D1Adapter.batch failed after retries exhausted');
            }
            const executeResults = results.map((result) => ({
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
        }
        catch (error) {
            log.error('D1Adapter.batch error', {
                partition: this.partition,
                statementCount: statements.length,
            }, error);
            throw error;
        }
    }
    /**
     * Check if the database is healthy
     */
    async isHealthy() {
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
        }
        catch (error) {
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
    getType() {
        return 'd1';
    }
    /**
     * Close the connection (no-op for D1)
     */
    async close() {
        // D1 is stateless, no connection to close
    }
    /**
     * Truncate SQL for logging (avoid logging sensitive data)
     */
    truncateSql(sql, maxLength = 100) {
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
export function createD1Adapter(db, partition = 'default', options) {
    return new D1Adapter({
        db,
        partition,
        retryConfig: options?.retryConfig,
        debug: options?.debug,
    });
}
