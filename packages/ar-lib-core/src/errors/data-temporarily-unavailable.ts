import type { Context } from 'hono';
import { D1OperationError, isTransientD1Error } from '../utils/d1-retry';

export const DATA_TEMPORARILY_UNAVAILABLE_RETRY_AFTER_MS = 1_000;

export function isDataTemporarilyUnavailableError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current instanceof D1OperationError) return current.retryable;
    if (current instanceof Error && isTransientD1Error(current)) return true;
    if (!current || typeof current !== 'object') return false;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function createDataTemporarilyUnavailableResponse(
  c: Context,
  error: unknown
): Response | null {
  if (!isDataTemporarilyUnavailableError(error)) return null;
  return c.json(
    {
      error: 'temporarily_unavailable',
      error_description: 'Data service is temporarily unavailable. Retry shortly.',
      extensions: {
        reason: 'data_store_overloaded',
        retryable: true,
        retry_after_ms: DATA_TEMPORARILY_UNAVAILABLE_RETRY_AFTER_MS,
      },
    },
    503,
    {
      'Retry-After': '1',
    }
  );
}
