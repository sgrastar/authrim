import {
  ensureDatabaseAdapter,
  IdentityMappingSelectionError,
  selectIdentityMapping,
  type Env,
  type IdentityMappingChainEntry,
} from '@authrim/ar-lib-core';
import { mapWithConcurrency } from './map-with-concurrency';
import { getSingleTenantId, isSingleTenantMode } from './single-tenant-guard';

export const PLATFORM_MAPPING_TENANT_LIMIT = 100;
export type PlatformIdentityMappingRelation = 'following' | 'own_default' | 'opted_out';
export interface PlatformIdentityMappingTenantRelation {
  tenant_id: string;
  relation: PlatformIdentityMappingRelation;
}

/** Complete fresh relationships only. Save guards need no tenant app database or routing write. */
export async function readPlatformIdentityMappingRelations(
  env: Env
): Promise<PlatformIdentityMappingTenantRelation[]> {
  if (!env.DB) throw new Error('platform_mapping_inventory_unavailable');
  const directory = ensureDatabaseAdapter(env.DB, 'identity-mapping-platform-followers');
  const single = isSingleTenantMode(env);
  const rows = await directory.query<{ id: string }>(
    `SELECT id FROM tenants WHERE lifecycle_state <> 'deleted'${single ? ' AND id=?' : ''}
     ORDER BY id LIMIT ?`,
    [...(single ? [getSingleTenantId(env)] : []), PLATFORM_MAPPING_TENANT_LIMIT + 1]
  );
  if (rows.length > PLATFORM_MAPPING_TENANT_LIMIT)
    throw new Error('platform_mapping_inventory_limit');
  return mapWithConcurrency(rows, 4, async ({ id }) => {
    let tenant: IdentityMappingChainEntry | undefined;
    try {
      const selection = await selectIdentityMapping({
        env,
        tenantId: id,
        protocol: 'oidc',
        clientSelector: null,
        fresh: true,
      });
      tenant = selection.chain[1];
    } catch (error) {
      // A broken platform default does not make a known tenant relationship unknowable.
      if (
        !(error instanceof IdentityMappingSelectionError) ||
        error.code !== 'default_setting_invalid' ||
        error.tier !== 'platform_default'
      )
        throw error;
      tenant = error.chain?.[1];
    }
    if (tenant?.tier !== 'tenant_default') throw new Error('platform_mapping_relation_unavailable');
    const relation =
      tenant.state === 'unset'
        ? 'following'
        : tenant.state === 'set'
          ? 'own_default'
          : tenant.state === 'none'
            ? 'opted_out'
            : null;
    if (!relation) throw new Error('platform_mapping_relation_unavailable');
    return { tenant_id: id, relation };
  });
}
