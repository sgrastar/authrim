import type { Context } from 'hono';
import {
  createAuthContextFromHono,
  getTenantIdFromContext,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';

export function resolveSettingsTenantId(c: Context): string {
  const contextTenantId = getTenantIdFromContext(c as Context<{ Bindings: Env }>);
  if (contextTenantId) {
    return contextTenantId;
  }

  throw new Error('Settings routes require tenant context');
}

export function resolveSettingsCoreAdapter(c: Context): DatabaseAdapter {
  const tenantId = resolveSettingsTenantId(c);
  return createAuthContextFromHono(c as Context<{ Bindings: Env }>, tenantId).coreAdapter;
}
