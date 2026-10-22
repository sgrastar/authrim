/**
 * What a change would affect in a tenant, beyond the setting itself: the preview of the bulk apply
 * asks the provider registered for a category. A provider answers with plain counts and codes (no
 * names, no values), or says why it cannot (`available: false`).
 */
import type { Context } from 'hono';
import {
  ensureAdminDatabaseAdapter,
  findImplicitOidcActivations,
  resolveAuthCorePersistenceAdapterFromEnv,
  type AdminAuthContext,
  type DatabaseAdapter,
  type Env,
  type TenantDatabaseRequestCache,
} from '@authrim/ar-lib-core';

export interface BulkApplyImpactInput {
  c: Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }, string>;
  tenantId: string;
  category: string;
  /** The keys of the category the change would set or clear in this tenant. */
  keys: readonly string[];
  /** Shared by the providers of one request, so a tenant's database is routed once. */
  requestCache: TenantDatabaseRequestCache;
}

export type BulkApplyImpact =
  | { available: true; [detail: string]: unknown }
  | { available: false; reason: string };

export type BulkApplyImpactProvider = (input: BulkApplyImpactInput) => Promise<BulkApplyImpact>;

const PARTITION = 'settings-bulk-apply-impact';
const OIDC_DEFAULT_SET_KEY = 'identity_mapping.oidc_default_set_id';

/**
 * The tenant's activations that the OIDC release used to apply to an app naming no Mapping Set and
 * no longer does (see `findImplicitOidcActivations`): IDs and names of this tenant's rows, from the
 * Admin database in one query. When that cannot be read the impact says so
 * (`warnings_unavailable`) and has no warnings.
 */
async function implicitActivationWarnings(
  c: BulkApplyImpactInput['c'],
  tenantId: string
): Promise<Record<string, unknown>> {
  try {
    const admin = ensureAdminDatabaseAdapter(c.env, 'settings-bulk-apply-impact');
    if (!admin) return { warnings: [], warnings_unavailable: true };
    const activations = await findImplicitOidcActivations(admin, { tenantId });
    return {
      warnings:
        activations.length === 0
          ? []
          : [{ code: 'implicit_activation_no_longer_applies', activations }],
    };
  } catch {
    return { warnings: [], warnings_unavailable: true };
  }
}

/**
 * Identity mapping: the apps of the tenant that have no Mapping Set of their own, which follow the
 * default (an app that names a set, or opts out, or whose choice is unreadable, does not). One
 * query on the tenant's Core database, counting with the same reading of `identity_mapping` as the
 * Mapping Set selection (`readClientIdentityMappingChoice`: unset is null, empty, `null`, or an
 * object with neither a set nor a mode).
 */
export const identityMappingImpact: BulkApplyImpactProvider = async ({
  c,
  tenantId,
  keys,
  requestCache,
}) => {
  // Only the default Mapping Set decides which Mapping Set an app without its own uses.
  if (!keys.includes(OIDC_DEFAULT_SET_KEY)) return { available: true, applies: false };
  let core: DatabaseAdapter;
  try {
    core = await resolveAuthCorePersistenceAdapterFromEnv(c.env, PARTITION, {
      tenantId,
      requestCache,
      // A preview leaves no trace: a tenant whose database cannot be routed is not reported
      // (no notification, no repair job) by looking at it.
      sideEffects: 'none',
    });
  } catch {
    return { available: false, reason: 'core_database_unavailable' };
  }
  try {
    const row = await core.queryOne<{
      total: number | null;
      following: number | null;
      legacy_profile_only: number | null;
    }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE
                    WHEN identity_mapping IS NULL OR trim(identity_mapping) = '' THEN 1
                    WHEN json_valid(identity_mapping)
                         AND (json_type(identity_mapping) = 'null'
                              OR (json_type(identity_mapping) = 'object'
                                  AND json_extract(identity_mapping, '$.mode') IS NULL
                                  AND json_extract(identity_mapping, '$.fieldMappingSetId') IS NULL
                                  AND json_extract(identity_mapping, '$.policySetId') IS NULL
                                  AND json_extract(identity_mapping, '$.destinationProfileId') IS NULL
                                  AND json_extract(identity_mapping, '$.destination_profile_id') IS NULL))
                      THEN 1
                    ELSE 0
                  END) AS following,
              SUM(CASE
                    WHEN json_valid(identity_mapping)
                         AND json_type(identity_mapping) = 'object'
                         AND json_extract(identity_mapping, '$.mode') IS NULL
                         AND json_extract(identity_mapping, '$.fieldMappingSetId') IS NULL
                         AND json_extract(identity_mapping, '$.policySetId') IS NULL
                         AND (json_extract(identity_mapping, '$.destinationProfileId') IS NOT NULL
                              OR json_extract(identity_mapping, '$.destination_profile_id') IS NOT NULL)
                      THEN 1
                    ELSE 0
                  END) AS legacy_profile_only
         FROM oauth_clients
        WHERE tenant_id = ?`,
      [tenantId]
    );
    return {
      available: true,
      applies: true,
      apps_total: Number(row?.total ?? 0),
      apps_following_default: Number(row?.following ?? 0),
      // Apps whose selector names only a Destination Profile: they fail rather than follow it.
      apps_with_unusable_choice: Number(row?.legacy_profile_only ?? 0),
      ...(await implicitActivationWarnings(c, tenantId)),
    };
  } catch {
    return { available: false, reason: 'query_failed' };
  }
};

/** The providers by category. Registering another is how a category adds what it affects. */
export const bulkApplyImpactProviders: Record<string, BulkApplyImpactProvider> = Object.create(
  null
) as Record<string, BulkApplyImpactProvider>;
bulkApplyImpactProviders['identity-mapping'] = identityMappingImpact;

export function registerBulkApplyImpactProvider(
  category: string,
  provider: BulkApplyImpactProvider
): void {
  bulkApplyImpactProviders[category] = provider;
}
