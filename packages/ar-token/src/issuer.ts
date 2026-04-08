import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { buildRequestIssuerUrl, getDefaultTenantId, getTenantIdFromContext } from '@authrim/ar-lib-core';

export function getRequestIssuer(c: Context<{ Bindings: Env }>): string {
  const tenantId =
    typeof (c as { get?: unknown }).get === 'function'
      ? getTenantIdFromContext(c)
      : getDefaultTenantId(c.env);
  return buildRequestIssuerUrl(c.req.raw, c.env, tenantId);
}
