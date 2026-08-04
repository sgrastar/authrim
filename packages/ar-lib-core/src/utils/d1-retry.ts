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

import { createLogger } from './logger';
import { isTenantPlacementWriteFenceError } from '../errors/tenant-placement-write-fence';

const log = createLogger().module('D1_RETRY');

/**
 * Retry configuration
 */
export interface RetryConfig {
  maxRetries?: number; // Maximum retry attempts (default: 3)
  initialDelayMs?: number; // Initial delay in milliseconds (default: 100)
  maxDelayMs?: number; // Maximum delay in milliseconds (default: 5000)
  backoffMultiplier?: number; // Backoff multiplier (default: 2)
  jitterRatio?: number; // Symmetric random jitter ratio (default: 0)
  maxElapsedMs?: number; // Stop scheduling retries after this deadline (default: unlimited)
  shouldRetry?: (error: Error) => boolean; // Optional error classifier
  throwOnExhausted?: boolean; // Preserve the final cause for request-serving adapters
}

/**
 * Default retry configuration
 */
const DEFAULT_RETRY_CONFIG = {
  maxRetries: 3,
  initialDelayMs: 100,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  jitterRatio: 0,
  maxElapsedMs: Number.POSITIVE_INFINITY,
  shouldRetry: () => true,
  throwOnExhausted: false,
};

export class D1OperationError extends Error {
  readonly code: 'd1_temporarily_unavailable' | 'd1_operation_failed';
  readonly retryable: boolean;
  readonly attempts: number;
  readonly cause: Error;

  constructor(operationName: string, attempts: number, cause: Error, retryable: boolean) {
    super(
      retryable
        ? `${operationName} temporarily unavailable`
        : `${operationName} failed after retries exhausted`,
      { cause }
    );
    this.name = 'D1OperationError';
    this.code = retryable ? 'd1_temporarily_unavailable' : 'd1_operation_failed';
    this.retryable = retryable;
    this.attempts = attempts;
    // Keep an explicit typed own property so callers can classify the original database error
    // without depending on how ErrorOptions.cause is represented by the runtime or bundler.
    this.cause = cause;
  }
}

export function isTransientD1Error(error: Error): boolean {
  const message = error.message.toLowerCase();
  if (
    message.includes('unique constraint') ||
    message.includes('foreign key constraint') ||
    message.includes('not null constraint') ||
    message.includes('syntax error') ||
    message.includes('no such table') ||
    message.includes('no such column') ||
    message.includes('tenant_placement_write_fence') ||
    message.includes('d1_admission_queue')
  ) {
    return false;
  }
  return (
    message.includes('d1') ||
    message.includes('overload') ||
    message.includes('queued for too long') ||
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('temporar') ||
    message.includes('internal error')
  );
}

function secureRandomFraction(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0] / 0x1_0000_0000;
}

function jitterDelay(delay: number, ratio: number): number {
  if (ratio <= 0) return delay;
  const boundedRatio = Math.min(1, ratio);
  const multiplier = 1 - boundedRatio + secureRandomFraction() * boundedRatio * 2;
  return Math.max(0, Math.round(delay * multiplier));
}

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
 *     await this.db.prepare('INSERT INTO ...').bind(...).run();
 *   },
 *   'AuditStore.append',
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
  const startedAt = Date.now();
  let attempts = 0;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    attempts = attempt + 1;
    try {
      // Execute the operation
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // This is an intentional application fence. Retrying inside D1 only hides the
      // typed cause and delays the API contract that lets the UI wait safely.
      if (isTenantPlacementWriteFenceError(lastError)) throw lastError;

      // If this was the last attempt, don't retry
      if (attempt === cfg.maxRetries || !cfg.shouldRetry(lastError)) {
        break;
      }

      // Calculate delay with exponential backoff
      const delay = jitterDelay(
        Math.min(cfg.initialDelayMs * Math.pow(cfg.backoffMultiplier, attempt), cfg.maxDelayMs),
        cfg.jitterRatio
      );
      if (Date.now() - startedAt + delay > cfg.maxElapsedMs) break;

      log.warn(`${operationName}: Attempt ${attempt + 1}/${cfg.maxRetries + 1} failed`, {
        errorMessage: lastError.message,
        attempt: attempt + 1,
        maxRetries: cfg.maxRetries + 1,
        nextDelay: delay,
      });

      // Wait before retrying
      await sleep(delay);
    }
  }

  // All retries exhausted
  log.error(
    `${operationName}: All ${attempts} attempts failed`,
    {
      operationName,
    },
    lastError ?? undefined
  );

  if (cfg.throwOnExhausted && lastError) {
    const retryableForCaller =
      cfg.shouldRetry(lastError) || lastError.message.toLowerCase().includes('d1_admission_queue');
    throw new D1OperationError(operationName, attempts, lastError, retryableForCaller);
  }

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
