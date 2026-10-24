/**
 * GET /api/admin/platform/identity-mapping/tenants?cursor=&limit=
 *
 * For the operator: every tenant, with which Mapping Set an app of it that names none gets and
 * where that was decided (the tenant's default, the platform's, or none), and how its apps choose
 * (follow the default, name their own set, opt out, or hold a value that is not a choice). The
 * view before and after a bulk apply of the default (MAP-01), of a change of the platform default
 * (MAP-07), and of a new tenant (MAP-09).
 *
 * Each row runs `selectIdentityMapping` for the tenant with no app, as the effective endpoint does
 * for the tenant's view, so the source shown is the one the runtime uses. The app counts read each
 * stored choice the way the selection does (`countClientIdentityMappingChoices`). A tenant whose
 * apps cannot be counted keeps its row, with `apps: null` and the reason; one whose settings
 * cannot be read keeps its row too, with a failed selection.
 *
 * Platform authority only: the answer names every tenant and counts their apps. Counts, IDs and
 * names of tenants and sets; nothing of an app or a user.
 */
import type { Context } from 'hono';
import {
  ADMIN_PERMISSIONS,
  ensureDatabaseAdapter,
  hasGlobalAdminPermission,
  IdentityMappingSelectionError,
  readPlatformIdentityMappingDefault,
  resolveAuthCorePersistenceAdapterFromEnv,
  selectIdentityMapping,
  type AdminAuthContext,
  type DatabaseAdapter,
  type Env,
  type IdentityMappingChainEntry,
  type IdentityMappingSelection,
  type TenantDatabaseRequestCache,
} from '@authrim/ar-lib-core';
import {
  countClientIdentityMappingChoices,
  type ClientIdentityMappingChoiceCounts,
} from './identity-mapping-app-choices';
import {
  describeChain,
  describeSelection,
  describeSelectionFailure,
  readSetFactsForTenants,
} from './identity-mapping-effective';
import { mapWithConcurrency } from './map-with-concurrency';
import { getSingleTenantId, isSingleTenantMode } from './single-tenant-guard';

type TenantsContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

const PARTITION = 'identity-mapping-tenants';
export const TENANTS_PAGE_DEFAULT = 50;
export const TENANTS_PAGE_MAX = 100;
/** Each tenant is a settings read and a Core database query. */
const TENANT_CONCURRENCY = 4;
const TENANT_ID_PATTERN = /^[a-z0-9-]{1,63}$/;

/**
 * Whether the caller may see every tenant's mapping: the settings read permission held for every
 * tenant (a global assignment with a global tenant scope, or a machine token for every tenant).
 * An Agent never does: it acts within one tenant.
 */
export function hasPlatformIdentityMappingRead(adminAuth: AdminAuthContext | undefined): boolean {
  if (!adminAuth || adminAuth.actorType === 'agent') return false;
  return hasGlobalAdminPermission(adminAuth, ADMIN_PERMISSIONS.SETTINGS_READ);
}

function encodeCursor(tenantId: string): string {
  return btoa(tenantId).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodeCursor(cursor: string): string | null {
  try {
    const id = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
    return TENANT_ID_PATTERN.test(id) ? id : null;
  } catch {
    return null;
  }
}

function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined) return TENANTS_PAGE_DEFAULT;
  if (!/^[0-9]{1,3}$/.test(raw)) return null;
  const limit = Number(raw);
  return limit >= 1 && limit <= TENANTS_PAGE_MAX ? limit : null;
}

function invalid(c: TenantsContext, description: string) {
  return c.json({ error: 'invalid_request', error_description: description }, 400);
}

type TenantSelection =
  | { ok: true; selection: IdentityMappingSelection }
  | { ok: false; failure: IdentityMappingSelectionError };

interface TenantRead {
  tenant: { id: string; name: string; lifecycleState: string };
  selection: TenantSelection;
  apps: ClientIdentityMappingChoiceCounts | { unavailable: string };
}

async function countApps(
  c: TenantsContext,
  tenantId: string,
  requestCache: TenantDatabaseRequestCache
): Promise<TenantRead['apps']> {
  let core: DatabaseAdapter;
  try {
    core = await resolveAuthCorePersistenceAdapterFromEnv(c.env, PARTITION, {
      tenantId,
      requestCache,
      // A read leaves no trace: a tenant whose database cannot be routed is not reported (no
      // notification, no repair job) by looking at it.
      sideEffects: 'none',
    });
  } catch {
    return { unavailable: 'core_database_unavailable' };
  }
  try {
    return await countClientIdentityMappingChoices(core, tenantId);
  } catch {
    return { unavailable: 'query_failed' };
  }
}

async function readTenant(
  c: TenantsContext,
  tenant: TenantRead['tenant'],
  requestCache: TenantDatabaseRequestCache
): Promise<TenantRead> {
  let selection: TenantSelection;
  try {
    selection = {
      ok: true,
      selection: await selectIdentityMapping({
        env: c.env,
        tenantId: tenant.id,
        protocol: 'oidc',
        clientSelector: null,
        // No app, so the selection reads the defaults anyway. The platform's level is read once
        // for the page (`platform_default`), not again for a tenant whose own default decides.
        fresh: true,
      }),
    };
  } catch (error) {
    if (!(error instanceof IdentityMappingSelectionError)) throw error;
    selection = { ok: false, failure: error };
  }

  return { tenant, selection, apps: await countApps(c, tenant.id, requestCache) };
}

function chainOf(selection: TenantSelection): readonly IdentityMappingChainEntry[] | null {
  return selection.ok ? selection.selection.chain : (selection.failure.chain ?? null);
}

export async function adminPlatformIdentityMappingTenantsHandler(c: TenantsContext) {
  if (!hasPlatformIdentityMappingRead(c.get('adminAuth'))) {
    return c.json(
      {
        error: 'forbidden',
        error_description: 'Every tenant’s mapping needs the platform settings read authority',
      },
      403
    );
  }
  const limit = parseLimit(c.req.query('limit'));
  if (limit === null) {
    return invalid(c, `limit must be a whole number from 1 to ${TENANTS_PAGE_MAX}`);
  }
  const rawCursor = c.req.query('cursor');
  const after = rawCursor === undefined ? null : decodeCursor(rawCursor);
  if (rawCursor !== undefined && after === null) {
    return invalid(c, 'cursor must be a next_cursor this endpoint returned');
  }

  let platformDefault: IdentityMappingChainEntry;
  let tenants: Array<TenantRead['tenant']>;
  try {
    platformDefault = await readPlatformIdentityMappingDefault(c.env, { fresh: true });
    const directory = ensureDatabaseAdapter(c.env.DB, PARTITION);
    if (!directory) throw new Error('tenant_directory_unavailable');
    const filters = ["lifecycle_state <> 'deleted'"];
    const params: unknown[] = [];
    if (isSingleTenantMode(c.env)) {
      filters.push('id = ?');
      params.push(getSingleTenantId(c.env));
    }
    if (after !== null) {
      filters.push('id > ?');
      params.push(after);
    }
    const rows = await directory.query<{ id: string; name: string; lifecycle_state: string }>(
      `SELECT id, name, lifecycle_state FROM tenants
        WHERE ${filters.join(' AND ')}
        ORDER BY id ASC
        LIMIT ?`,
      [...params, limit + 1]
    );
    tenants = rows.map((row) => ({
      id: row.id,
      name: row.name,
      lifecycleState: row.lifecycle_state,
    }));
  } catch {
    return c.json(
      {
        error: 'temporarily_unavailable',
        error_description: 'The tenants or the platform settings cannot be read right now',
      },
      503
    );
  }
  const hasMore = tenants.length > limit;
  const page = hasMore ? tenants.slice(0, limit) : tenants;

  try {
    const requestCache: TenantDatabaseRequestCache = new Map();
    const reads = await mapWithConcurrency(page, TENANT_CONCURRENCY, (tenant) =>
      readTenant(c, tenant, requestCache)
    );

    // The names, owners and states of every set the page names, in one Admin database query.
    const wanted = new Map<string, string[]>(
      reads.map((read) => [
        read.tenant.id,
        (chainOf(read.selection) ?? []).flatMap((entry) => (entry.setId ? [entry.setId] : [])),
      ])
    );
    // The platform's own default under a key no tenant ID can be: only a platform set is found.
    wanted.set('', platformDefault.setId ? [platformDefault.setId] : []);
    const facts = await readSetFactsForTenants(c.env, PARTITION, wanted);

    return c.json({
      platform_default: describeChain([platformDefault], facts?.get('') ?? null)[0],
      tenants: reads.map((read) => {
        const tenantFacts = facts?.get(read.tenant.id) ?? null;
        const chain = chainOf(read.selection);
        return {
          tenant_id: read.tenant.id,
          display_name: read.tenant.name,
          lifecycle_state: read.tenant.lifecycleState,
          // The tenant's level of the chain; null when the settings could not be read for it.
          tenant_default: chain ? describeChain([chain[1]], tenantFacts)[0] : null,
          effective: read.selection.ok
            ? describeSelection(read.selection.selection, tenantFacts)
            : describeSelectionFailure(read.selection.failure),
          ...('unavailable' in read.apps
            ? { apps: null, apps_unavailable: read.apps.unavailable }
            : {
                apps: {
                  total: read.apps.total,
                  following_default: read.apps.followingDefault,
                  own_set: read.apps.ownSet,
                  opted_out: read.apps.optedOut,
                  unusable: read.apps.unusable,
                },
              }),
        };
      }),
      next_cursor: hasMore ? encodeCursor(page[page.length - 1].id) : null,
      generated_at: new Date().toISOString(),
    });
  } catch {
    return c.json(
      {
        error: 'internal_error',
        error_description: 'The tenants’ Mapping Set selection could not be read',
      },
      500
    );
  }
}
