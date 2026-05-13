import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { getDefaultTenantId, isMultiTenantEnabled, isValidTenantIdentifier } from '@authrim/ar-lib-core';

export type InternalTokenRefreshTenantResolution =
  | { ok: true; tenantId: string }
  | { ok: false; error: string };

export function resolveInternalTokenRefreshTenantId(
  c: Context<{ Bindings: Env }>
): InternalTokenRefreshTenantResolution {
  const requestedTenantId = c.req.header('X-Tenant-Id')?.trim();
  if (requestedTenantId) {
    if (!isValidTenantIdentifier(requestedTenantId)) {
      return { ok: false, error: 'X-Tenant-Id header has an invalid format' };
    }
    return { ok: true, tenantId: requestedTenantId };
  }

  if (!isMultiTenantEnabled(c.env)) {
    return { ok: true, tenantId: getDefaultTenantId(c.env) };
  }

  return {
    ok: false,
    error: 'X-Tenant-Id header is required for internal token refresh in multi-tenant mode',
  };
}
