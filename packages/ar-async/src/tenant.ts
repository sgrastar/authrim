import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { getDefaultTenantId, isMultiTenantEnabled } from '@authrim/ar-lib-core';

export function resolveAsyncTenantId(c: Context<{ Bindings: Env }>): string | null {
  const getter = (c as unknown as { get?: (key: string) => unknown }).get;
  const contextTenantId =
    typeof getter === 'function'
      ? ((getter.call(c, 'tenantId') as string | undefined) ?? '').trim()
      : '';

  if (contextTenantId) {
    return contextTenantId;
  }

  if (!isMultiTenantEnabled(c.env)) {
    return getDefaultTenantId(c.env);
  }

  return null;
}
