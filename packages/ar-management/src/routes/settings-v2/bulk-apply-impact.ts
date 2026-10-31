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
import { countClientIdentityMappingChoices } from '../../identity-mapping-app-choices';

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
 * default, and those a change of the default leaves alone (an app that names a set, or opts out);
 * an app whose choice is unreadable follows nothing. One query on the tenant's Core database,
 * each stored `identity_mapping` read the way the Mapping Set selection reads it
 * (`countClientIdentityMappingChoices`).
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
    const counts = await countClientIdentityMappingChoices(core, tenantId);
    return {
      available: true,
      applies: true,
      apps_total: counts.total,
      apps_following_default: counts.followingDefault,
      // Apps whose selector names only a Destination Profile: they fail rather than follow it.
      apps_with_unusable_choice: counts.legacyProfileOnly,
      // Not changed by the default: the app names its own set, or opts out.
      apps_with_own_set: counts.ownSet,
      apps_opted_out: counts.optedOut,
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
