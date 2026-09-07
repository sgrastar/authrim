import type { Context } from 'hono';

const WRITE_FENCE_ERROR_CODE = 'tenant_placement_migration_write_fenced';
export const TENANT_PLACEMENT_WRITE_FENCE_RETRY_AFTER_MS = 500;

export function isTenantPlacementWriteFenceError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current === 'string') return current.includes(WRITE_FENCE_ERROR_CODE);
    if (!current || typeof current !== 'object') return false;
    const candidate = current as { message?: unknown; cause?: unknown };
    if (
      typeof candidate.message === 'string' &&
      candidate.message.includes(WRITE_FENCE_ERROR_CODE)
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

export function createTenantPlacementWriteFenceResponse(
  c: Context,
  error: unknown
): Response | null {
  if (!isTenantPlacementWriteFenceError(error)) return null;
  return c.json(
    {
      error: 'temporarily_unavailable',
      error_description: 'Tenant data is temporarily unavailable. Retry shortly.',
      extensions: {
        reason: 'tenant_placement_write_fence',
        retryable: true,
        retry_after_ms: TENANT_PLACEMENT_WRITE_FENCE_RETRY_AFTER_MS,
      },
    },
    503,
    {
      'Retry-After': '1',
    }
  );
}
