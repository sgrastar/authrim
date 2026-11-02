/**
 * Placement policy for cross-tenant administrators (admin credential design D9).
 *
 * A global assignment reaches every tenant, so it may only be granted to an admin whose home
 * tenant (`admin_users.tenant_id`, never rewritten) is the deployment default tenant. The check
 * compares a stored value with a deployment setting, so it has no cross-database race.
 */

import type { Context } from 'hono';
import { getDefaultTenantId, type Env } from '@authrim/ar-lib-core';

export function crossTenantPlacementAllowed(env: Env, homeTenantId: string): boolean {
  return homeTenantId === getDefaultTenantId(env);
}

export function crossTenantPlacementResponse(c: Context): Response {
  return c.json(
    {
      error: 'cross_tenant_admin_requires_default_home',
      error_description:
        'A global role can only be granted to an administrator whose home tenant is the deployment default tenant.',
    },
    409
  );
}

/** Returns the 409 answer when `scopeType` is global and the admin is not homed in the default tenant. */
export function ensureCrossTenantPlacement(
  c: Context,
  env: Env,
  input: { scopeType: string; homeTenantId: string }
): Response | null {
  if (input.scopeType !== 'global') return null;
  return crossTenantPlacementAllowed(env, input.homeTenantId)
    ? null
    : crossTenantPlacementResponse(c);
}
