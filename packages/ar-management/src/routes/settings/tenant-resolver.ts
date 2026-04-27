import type { Context } from 'hono';
import {
  createAuthContextFromHono,
  getDefaultTenantId,
  getTenantIdFromContext,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';

export function resolveSettingsTenantId(c: Context, explicitTenantId?: string | null): string {
  const trimmedExplicit = explicitTenantId?.trim();
  if (trimmedExplicit) {
    return trimmedExplicit;
  }

  const contextTenantId = getTenantIdFromContext(c as Context<{ Bindings: Env }>);
  if (contextTenantId) {
    return contextTenantId;
  }

  return getDefaultTenantId((c as Context<{ Bindings: Env }>).env);
}

export function resolveSettingsCoreAdapter(
  c: Context,
  explicitTenantId?: string | null
): DatabaseAdapter {
  const tenantId = resolveSettingsTenantId(c, explicitTenantId);
  return createAuthContextFromHono(c as Context<{ Bindings: Env }>, tenantId).coreAdapter;
}
