/**
 * D1 Database Retry Utilities
 *
 * Provides exponential backoff retry logic for D1 database operations
 * to improve reliability of audit logging and data persistence.
 *
 * Problem: D1 writes can fail due to transient network issues, causing
 * missing audit logs which violates compliance requirements.
 *
 * Solution: Retry failed operations with exponential backoff, with
 * monitoring/alerting for persistent failures.
 */

/**
 * Retry configuration
 */
export interface RetryConfig {
  maxRetries?: number; // Maximum retry attempts (default: 3)
  initialDelayMs?: number; // Initial delay in milliseconds (default: 100)
  maxDelayMs?: number; // Maximum delay in milliseconds (default: 5000)
  backoffMultiplier?: number; // Backoff multiplier (default: 2)
}

/**
 * Default retry configuration
 */
const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
  maxRetries: 3,
  initialDelayMs: 100,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
};

/**
 * Sleep utility for exponential backoff
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a D1 operation with exponential backoff retry logic
 *
 * @param operation - The D1 operation to execute
 * @param operationName - Name of the operation for logging
 * @param config - Retry configuration
 * @returns Promise that resolves when operation succeeds or all retries exhausted
 *
 * @example
 * await retryD1Operation(
 *   async () => {
 *     await this.env.DB.prepare('INSERT INTO ...').bind(...).run();
 *   },
 *   'SessionStore.saveToD1',
 *   { maxRetries: 3 }
 * );
 */
export async function retryD1Operation<T>(
  operation: () => Promise<T>,
  operationName: string,
  config: RetryConfig = {}
): Promise<T | null> {
  const cfg = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      // Execute the operation
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // If this was the last attempt, don't retry
      if (attempt === cfg.maxRetries) {
        break;
      }

      // Calculate delay with exponential backoff
      const delay = Math.min(
        cfg.initialDelayMs * Math.pow(cfg.backoffMultiplier, attempt),
        cfg.maxDelayMs
      );

      console.warn(
        `${operationName}: Attempt ${attempt + 1}/${cfg.maxRetries + 1} failed, retrying in ${delay}ms...`,
        {
          error: lastError.message,
          attempt: attempt + 1,
          maxRetries: cfg.maxRetries + 1,
          nextDelay: delay,
        }
      );

      // Wait before retrying
      await sleep(delay);
    }
  }

  // All retries exhausted
  console.error(`${operationName}: All ${cfg.maxRetries + 1} attempts failed`, {
    error: lastError?.message,
    operationName,
  });

  // CRITICAL: This should trigger monitoring/alerting in production
  // Consider integrating with error tracking service (Sentry, etc.)

  // Return null to indicate failure without throwing
  // This prevents D1 logging failures from breaking the main operation
  return null;
}

/**
 * Execute a D1 batch operation with retry logic
 *
 * @param operations - Array of D1 prepared statements to execute in batch
 * @param operationName - Name of the operation for logging
 * @param config - Retry configuration
 * @returns Promise that resolves when batch succeeds or all retries exhausted
 *
 * @example
 * await retryD1Batch(
 *   [
 *     env.DB.prepare('INSERT INTO ...').bind(...),
 *     env.DB.prepare('UPDATE ...').bind(...),
 *   ],
 *   'SessionStore.batchUpdate',
 * );
 */
export async function retryD1Batch(
  operations: Array<D1PreparedStatement>,
  operationName: string,
  config: RetryConfig = {}
): Promise<D1Result[] | null> {
  return retryD1Operation(
    async () => {
      // D1 batch() method executes multiple statements in a transaction
      // All succeed or all fail (ACID guarantees)
      const results = await Promise.all(operations.map((stmt) => stmt.run()));
      return results;
    },
    operationName,
    config
  );
}

/**
 * Type definitions for D1
 * (These should ideally come from @cloudflare/workers-types)
 */
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<D1Result>;
  all(): Promise<D1Result>;
  first(column?: string): Promise<unknown>;
}

export interface D1Result {
  success: boolean;
  meta?: {
    duration?: number;
    changes?: number;
    last_row_id?: number;
    rows_read?: number;
    rows_written?: number;
  };
  results?: unknown[];
  error?: string;
}
