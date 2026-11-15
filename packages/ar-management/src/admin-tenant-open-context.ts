import type { Context, Next } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  TenantDatabaseResolverError,
  getLogger,
  isTenantAdminOpenInventoryPath,
  extractTenantAdminOpenPathTenantId,
  resolveTenantMetadataContext,
  validateTenantExistsAsync,
} from '@authrim/ar-lib-core';
import { requireTenantResourceAccess } from './admin-tenant-access';
import { ensureSupportedTenantId } from './single-tenant-guard';

const INVITATIONS_PATH = /^\/api\/admin\/tenants\/[^/]+\/invitations(?:\/[^/]+)?\/?$/;

/**
 * The tenant data context of the PATH tenant for the tenant-admin-open routes that the request
 * context does not give one (they are tenant inventory routes): the invitation handlers and the
 * idempotency middleware in front of them read the tenant's own core database from it. `info`
 * and `runtime-profiles` read the deployment bindings and need none, so they get none.
 *
 * It runs after authentication and the declared route access, and before any route-level
 * middleware. The caller's own access to the path tenant is decided first, so nothing is
 * resolved for a tenant the caller may not reach; for one who may reach it, a tenant that is
 * missing or not yet provisioned is a plain 404 / 409 / 503, never an exception.
 */
export async function tenantAdminOpenDataContext(
  c: Context<{ Bindings: Env }>,
  next: Next
): Promise<Response | void> {
  const path = c.req.path;
  if (!isTenantAdminOpenInventoryPath(path) || !INVITATIONS_PATH.test(path)) {
    return next();
  }
  const ctx = c as unknown as { get(key: string): unknown; set(key: string, value: unknown): void };
  if (ctx.get('tenantMetadataContext')) return next();

  const tenantId = extractTenantAdminOpenPathTenantId(path);
  if (!tenantId) return next();

  const unsupported = await ensureSupportedTenantId(c, tenantId);
  if (unsupported) return unsupported;
  const refusal = await requireTenantResourceAccess(c, tenantId);
  if (refusal) return refusal;

  try {
    const context = await resolveTenantMetadataContext(c.env, tenantId);
    const exists = await validateTenantExistsAsync(context.coreDb, c.env.AUTHRIM_CONFIG, tenantId);
    if (!exists) {
      return c.json({ error: 'not_found', error_description: 'Tenant not found' }, 404);
    }
    ctx.set('tenantMetadataContext', context);
  } catch (error) {
    if (error instanceof TenantDatabaseResolverError) {
      // The registry knows no such tenant.
      if (error.code === 'missing_registry_row') {
        return c.json({ error: 'not_found', error_description: 'Tenant not found' }, 404);
      }
      const propagating = error.code === 'snapshot_generation_propagating';
      if (propagating) c.header('Retry-After', '1');
      return c.json(
        { error: error.code, route: c.req.path, tenant_id: tenantId },
        propagating ? 503 : 409
      );
    }
    getLogger(c)
      .module('ADMIN-TENANT-OPEN-CONTEXT')
      .warn('Tenant metadata source resolution failed', {
        tenant_id: tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
    return c.json(
      { error: 'temporarily_unavailable', error_description: 'Tenant unavailable' },
      503
    );
  }
  return next();
}
