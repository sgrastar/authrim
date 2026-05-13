import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { buildRequestIssuerUrl } from '@authrim/ar-lib-core';

export function getRequestIssuer(c: Context<{ Bindings: Env }>, tenantId: string): string {
  return buildRequestIssuerUrl(c.req.raw, c.env, tenantId);
}
