/**
 * Durable Object Retry Utility
 *
 * Provides retry logic for Durable Object RPC calls with:
 * - Overloaded error detection and exponential backoff
 * - Retryable error handling
 * - OIDC-compliant error responses
 *
 * Usage:
 * ```typescript
 * const session = await callDOWithRetry(
 *   () => sessionStore.getSessionRpc(sessionId),
 *   { operationName: 'SessionStore.getSession' }
 * );
 * ```
 */

/**
 * Options for DO retry operation
 */
export interface DORetryOptions {
  /** Maximum number of retries (default: 3) */
  maxRetries?: number;
  /** Initial delay in milliseconds (default: 50) */
  initialDelayMs?: number;
  /** Maximum delay in milliseconds (default: 500) */
  maxDelayMs?: number;
  /** Operation name for logging */
  operationName: string;
}

/**
 * Custom error class for DO overloaded errors
 * Can be caught and handled by callers for OIDC error responses
 */
export class DOOverloadedError extends Error {
  public readonly retryable = false;
  public readonly cause: Error | null;

  constructor(message: string, cause?: Error | null) {
    super(message);
    this.name = 'DOOverloadedError';
    this.cause = cause ?? null;
  }
}

/**
 * Check if an error is an overloaded error
 */
function isOverloadedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes('overloaded') ||
    message.includes('too many requests') ||
    message.includes('rate limit')
  );
}

/**
 * Check if an error is retryable
 */
function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  // Check for retryable property (Cloudflare DO errors)
  if ('retryable' in error && (error as { retryable?: boolean }).retryable === true) {
    return true;
  }

  // Check for transient errors
  const message = error.message.toLowerCase();
  return (
    message.includes('network') || message.includes('timeout') || message.includes('temporary')
  );
}

/**
 * Call a Durable Object method with retry logic
 *
 * Automatically retries on:
 * - Overloaded errors (with exponential backoff)
 * - Retryable errors (with exponential backoff)
 *
 * Throws immediately on:
 * - Non-retryable errors (e.g., invalid_grant, invalid_request)
 *
 * @param operation - Async function that calls the DO method
 * @param options - Retry configuration
 * @returns The result of the operation
 * @throws DOOverloadedError if all retries are exhausted due to overloaded state
 * @throws Original error if it's not retryable
 */
export async function callDOWithRetry<T>(
  operation: () => Promise<T>,
  options: DORetryOptions
): Promise<T> {
  const { maxRetries = 3, initialDelayMs = 50, maxDelayMs = 500, operationName } = options;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      const isOverloaded = isOverloadedError(error);
      const isRetryable = isRetryableError(error);

      // If not retryable, throw immediately
      if (!isOverloaded && !isRetryable) {
        throw lastError;
      }

      // If we've exhausted retries, throw
      if (attempt === maxRetries) {
        break;
      }

      // Calculate delay with exponential backoff and jitter
      const baseDelay = initialDelayMs * Math.pow(2, attempt);
      const jitter = Math.random() * baseDelay * 0.1; // 10% jitter
      const delay = Math.min(baseDelay + jitter, maxDelayMs);

      console.warn(
        `${operationName}: ${isOverloaded ? 'DO Overloaded' : 'Retryable error'} ` +
          `(attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${Math.round(delay)}ms`
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // All retries exhausted
  console.error(`${operationName}: All ${maxRetries + 1} attempts failed`);

  // Wrap in DOOverloadedError for OIDC-compliant handling
  throw new DOOverloadedError(`Service temporarily unavailable: ${operationName}`, lastError);
}

/**
 * Helper to determine OIDC error response for DO errors
 *
 * Returns appropriate OAuth 2.0 error code based on the error type:
 * - DOOverloadedError -> 'temporarily_unavailable'
 * - Other errors -> 'server_error'
 */
export function getOIDCErrorForDOError(error: unknown): {
  error: string;
  errorDescription: string;
  httpStatus: number;
} {
  if (error instanceof DOOverloadedError) {
    return {
      error: 'temporarily_unavailable',
      errorDescription: 'The authorization server is currently unable to handle the request',
      httpStatus: 503,
    };
  }

  return {
    error: 'server_error',
    errorDescription: error instanceof Error ? error.message : 'Internal server error',
    httpStatus: 500,
  };
}
