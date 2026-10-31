/**
 * GET /api/admin/identity-mapping/effective?client_id=...
 *
 * Which Mapping Set an OIDC app of the calling tenant is bound to, and why: the app's own choice,
 * the tenant's default, the platform's default, or none. It runs `selectIdentityMapping`, the
 * selection the ID token, UserInfo and the consent screen run, so what an admin sees is what
 * decides at runtime.
 *
 * Without `client_id` it shows the tenant's view: the defaults, with no app level. With one, the
 * app must be the calling tenant's; another tenant's app and one that does not exist are both 404.
 *
 * The selection itself reads no database. The name and owner of each set it names are read from
 * the Admin database in one query; if that cannot be read, the answer is the same without them.
 *
 * `warnings`: when the selection is none because nothing is named (`no_default`) and the tenant has
 * an active activation that the OIDC release used to apply to an app naming no Mapping Set, the
 * answer says it no longer does (`implicit_activation_no_longer_applies`), with the IDs and names of
 * those activations and their sets, and nothing else. That is one more query on the Admin database,
 * made only for that answer; if it cannot be made the answer is the same with
 * `warnings_unavailable: true`.
 */
import type { Context } from 'hono';
import {
  createAuthContextFromHono,
  ensureAdminDatabaseAdapter,
  findImplicitOidcActivations,
  getTenantIdFromContext,
  IdentityMappingSelectionError,
  PLATFORM_MAPPING_TENANT_ID,
  selectIdentityMapping,
  type Env,
  type IdentityMappingChainEntry,
  type IdentityMappingSelection,
} from '@authrim/ar-lib-core';

const CLIENT_ID_MAX_LENGTH = 256;
/** How many set IDs one query binds (D1 binds at most 100 parameters). */
const SET_FACTS_CHUNK = 90;

export interface SetFacts {
  /** The set exists and the calling tenant may name it (its own or the platform's). */
  found: boolean;
  name?: string;
  owner?: 'tenant' | 'platform';
  lifecycleState?: string;
}

/**
 * What the Admin database says of the sets each tenant's selection names, in one query for all of
 * them. For each tenant, a set another tenant owns reads as one that does not exist. Null when the
 * database cannot be read.
 */
export async function readSetFactsForTenants(
  env: Env,
  partition: string,
  wanted: ReadonlyMap<string, readonly string[]>
): Promise<Map<string, Map<string, SetFacts>> | null> {
  const setIds = [...new Set([...wanted.values()].flat())];
  const byTenant = new Map<string, Map<string, SetFacts>>();
  for (const [tenantId, ids] of wanted) {
    byTenant.set(tenantId, new Map(ids.map((id) => [id, { found: false }])));
  }
  if (setIds.length === 0) return byTenant;
  try {
    const admin = ensureAdminDatabaseAdapter(env, partition);
    if (!admin) return null;
    // D1 binds at most 100 parameters to a statement: a page of tenants names up to one set each,
    // and the platform's, so the IDs are read a chunk at a time.
    const rows: Array<{
      id: string;
      tenant_id: string;
      display_name: string | null;
      lifecycle_state: string;
    }> = [];
    for (let start = 0; start < setIds.length; start += SET_FACTS_CHUNK) {
      const chunk = setIds.slice(start, start + SET_FACTS_CHUNK);
      rows.push(
        ...(await admin.query<(typeof rows)[number]>(
          `SELECT id, tenant_id, display_name, lifecycle_state
             FROM field_mapping_sets
            WHERE id IN (${chunk.map(() => '?').join(', ')})`,
          chunk
        ))
      );
    }
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    for (const [tenantId, facts] of byTenant) {
      for (const id of facts.keys()) {
        const row = rowsById.get(id);
        if (!row || (row.tenant_id !== tenantId && row.tenant_id !== PLATFORM_MAPPING_TENANT_ID)) {
          continue;
        }
        facts.set(id, {
          found: true,
          ...(row.display_name ? { name: row.display_name } : {}),
          owner: row.tenant_id === PLATFORM_MAPPING_TENANT_ID ? 'platform' : 'tenant',
          lifecycleState: row.lifecycle_state,
        });
      }
    }
    return byTenant;
  } catch {
    return null;
  }
}

function describeSet(setId: string | undefined, facts: ReadonlyMap<string, SetFacts> | null) {
  if (!setId || !facts) return {};
  const fact = facts.get(setId);
  if (!fact) return {};
  return {
    setFound: fact.found,
    ...(fact.name ? { setName: fact.name } : {}),
    ...(fact.owner ? { setOwner: fact.owner } : {}),
    ...(fact.lifecycleState ? { setLifecycleState: fact.lifecycleState } : {}),
  };
}

export function describeChain(
  chain: readonly IdentityMappingChainEntry[],
  facts: ReadonlyMap<string, SetFacts> | null
) {
  return chain.map((entry) => ({
    tier: entry.tier,
    state: entry.state,
    ...(entry.setId ? { setId: entry.setId, ...describeSet(entry.setId, facts) } : {}),
    ...(entry.source ? { source: entry.source } : {}),
  }));
}

export function describeSelection(
  selection: IdentityMappingSelection,
  facts: ReadonlyMap<string, SetFacts> | null
) {
  if (selection.kind === 'none') return { kind: 'none' as const, reason: selection.reason };
  return {
    kind: 'bound' as const,
    tier: selection.tier,
    setId: selection.setId,
    ...describeSet(selection.setId, facts),
    ...(selection.selector?.fieldMappingVersionId
      ? { pinnedVersionId: selection.selector.fieldMappingVersionId }
      : {}),
  };
}

/**
 * A selection that failed: the level that failed is named, never its value (the selection fails
 * rather than fall to another level).
 */
export function describeSelectionFailure(failure: IdentityMappingSelectionError) {
  return {
    kind: 'failed' as const,
    code: failure.code,
    tier: failure.tier,
    ...(failure.reasonCode ? { reason: failure.reasonCode } : {}),
  };
}

/**
 * The activations of the calling tenant that stopped applying (see `findImplicitOidcActivations`),
 * as the warnings of the answer. Only this tenant's rows are read; what is returned is IDs and
 * names.
 */
export async function readImplicitActivationWarnings(
  env: Env,
  tenantId: string,
  clientId: string | undefined
): Promise<{
  warnings: Array<{
    code: 'implicit_activation_no_longer_applies';
    activations: Array<{ activationId: string; setId: string; setName?: string }>;
  }>;
  warnings_unavailable?: true;
}> {
  try {
    const admin = ensureAdminDatabaseAdapter(env, 'identity-mapping-effective');
    if (!admin) return { warnings: [], warnings_unavailable: true };
    const activations = await findImplicitOidcActivations(admin, { tenantId, clientId });
    return activations.length === 0
      ? { warnings: [] }
      : {
          warnings: [{ code: 'implicit_activation_no_longer_applies', activations }],
        };
  } catch {
    return { warnings: [], warnings_unavailable: true };
  }
}

/**
 * The answer of the effective endpoint for an app's choice (`clientSelector`, null for the
 * tenant's view), or for a choice that is not saved: the tenant's level as `tenantDefaultProposal`
 * says (see `selectIdentityMapping`). Null when the settings cannot be read.
 */
export async function effectiveMappingView(
  env: Env,
  tenantId: string,
  input: {
    clientId: string | null;
    clientSelector: unknown;
    tenantDefaultProposal?: { value: unknown };
  }
) {
  let selection: IdentityMappingSelection | null = null;
  let failure: IdentityMappingSelectionError | null = null;
  try {
    selection = await selectIdentityMapping({
      env,
      tenantId,
      protocol: 'oidc',
      clientSelector: input.clientSelector,
      // Every level, so the chain shows what each says; and past the cache, so a default just
      // saved is shown.
      inspectDefaults: true,
      fresh: true,
      ...(input.tenantDefaultProposal
        ? { tenantDefaultProposal: input.tenantDefaultProposal }
        : {}),
    });
  } catch (error) {
    if (!(error instanceof IdentityMappingSelectionError)) throw error;
    if (error.code === 'settings_unreadable' || !error.chain) return null;
    failure = error;
  }

  const chain = selection?.chain ?? failure?.chain ?? [];
  const setIds = [...new Set(chain.flatMap((entry) => (entry.setId ? [entry.setId] : [])))];
  const facts =
    (
      await readSetFactsForTenants(env, 'identity-mapping-effective', new Map([[tenantId, setIds]]))
    )?.get(tenantId) ?? null;

  const implicit =
    selection?.kind === 'none' && selection.reason === 'no_default'
      ? await readImplicitActivationWarnings(env, tenantId, input.clientId ?? undefined)
      : { warnings: [] };

  return {
    tenantId,
    clientId: input.clientId,
    selection: failure
      ? describeSelectionFailure(failure)
      : describeSelection(selection as IdentityMappingSelection, facts),
    chain: describeChain(chain, facts),
    ...implicit,
  };
}

export async function adminIdentityMappingEffectiveHandler(c: Context<{ Bindings: Env }>) {
  const clientId = c.req.query('client_id');
  if (
    clientId !== undefined &&
    (clientId.length === 0 ||
      clientId.length > CLIENT_ID_MAX_LENGTH ||
      clientId !== clientId.trim())
  ) {
    return c.json(
      { error: 'invalid_request', error_description: 'client_id must be an app (client) ID' },
      400
    );
  }

  try {
    const tenantId = getTenantIdFromContext(c);

    // The app's own choice, from the tenant's app row alone: an app of another tenant is not found.
    let clientSelector: unknown = null;
    if (clientId !== undefined) {
      const { coreAdapter } = createAuthContextFromHono(c, tenantId);
      const row = await coreAdapter.queryOne<{ identity_mapping: string | null }>(
        'SELECT identity_mapping FROM oauth_clients WHERE tenant_id = ? AND client_id = ?',
        [tenantId, clientId]
      );
      if (!row) {
        return c.json({ error: 'not_found', error_description: 'client not found' }, 404);
      }
      clientSelector = row.identity_mapping;
    }

    const view = await effectiveMappingView(c.env, tenantId, {
      clientId: clientId ?? null,
      clientSelector,
    });
    if (!view) {
      return c.json(
        {
          error: 'temporarily_unavailable',
          error_description: 'The settings that decide the Mapping Set cannot be read right now',
        },
        503
      );
    }
    return c.json(view);
  } catch {
    return c.json(
      { error: 'internal_error', error_description: 'The Mapping Set selection could not be read' },
      500
    );
  }
}
