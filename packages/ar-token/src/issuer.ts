import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { buildRequestIssuerUrl } from '@authrim/ar-lib-core';

function requireRequestTenantId(c: Context<{ Bindings: Env }>): string {
  const getContextValue = (c as { get?: (key: string) => unknown }).get;
  const tenantId =
    typeof getContextValue === 'function' ? String(getContextValue.call(c, 'tenantId') ?? '') : '';
  if (!tenantId.trim()) {
    throw new Error('Request issuer requires tenant context');
  }
  return tenantId.trim();
}

export function getRequestIssuer(c: Context<{ Bindings: Env }>): string {
  const tenantId = requireRequestTenantId(c);
  return buildRequestIssuerUrl(c.req.raw, c.env, tenantId);
}
