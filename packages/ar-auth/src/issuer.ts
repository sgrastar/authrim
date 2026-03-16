import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { buildIssuerUrl, getTenantIdFromContext } from '@authrim/ar-lib-core';

export function getRequestIssuer(c: Context<{ Bindings: Env }>): string {
  return buildIssuerUrl(c.env, getTenantIdFromContext(c));
}
