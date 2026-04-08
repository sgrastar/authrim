import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { buildIssuerUrl, buildRequestIssuerUrl } from '@authrim/ar-lib-core';

export function getCanonicalTenantBaseUrl(env: Env, tenantId: string): string {
  return buildIssuerUrl(env, tenantId);
}

export function getRequestAwareIssuerUrl(c: Context<{ Bindings: Env }>, tenantId: string): string {
  return (
    buildRequestIssuerUrl(c.req.raw, c.env, tenantId) || getCanonicalTenantBaseUrl(c.env, tenantId)
  );
}
