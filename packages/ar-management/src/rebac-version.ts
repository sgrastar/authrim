import type { Context } from 'hono';
import { bumpReBACTenantVersion, getLogger, type Env } from '@authrim/ar-lib-core';

/**
 * Bumps the tenant's ReBAC version (REBAC_CACHE) after a relationship tuple or relation
 * definition write or delete: the policy service's cached check results of the tenant are
 * retired. A failure is logged: those results then live out their TTL (60 s).
 */
export async function bumpTenantReBACVersion(
  c: Context<{ Bindings: Env }>,
  tenantId: string
): Promise<void> {
  const kv = (c.env as Env | undefined)?.REBAC_CACHE;
  if (!kv) return;
  try {
    await bumpReBACTenantVersion(kv, tenantId);
  } catch (error) {
    getLogger(c)
      .module('ADMIN-REBAC')
      .warn('ReBAC version bump failed', {
        error: error instanceof Error ? error.message : 'unknown',
      });
  }
}
