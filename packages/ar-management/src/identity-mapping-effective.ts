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
 */
import type { Context } from 'hono';
import {
  createAuthContextFromHono,
  ensureAdminDatabaseAdapter,
  getTenantIdFromContext,
  IdentityMappingSelectionError,
  PLATFORM_MAPPING_TENANT_ID,
  selectIdentityMapping,
  type Env,
  type IdentityMappingChainEntry,
  type IdentityMappingSelection,
} from '@authrim/ar-lib-core';

const CLIENT_ID_MAX_LENGTH = 256;

interface SetFacts {
  /** The set exists and the calling tenant may name it (its own or the platform's). */
  found: boolean;
  name?: string;
  owner?: 'tenant' | 'platform';
  lifecycleState?: string;
}

/**
 * What the Admin database says of the sets the selection names, in one query. A set another
 * tenant owns reads as one that does not exist. Null when the database cannot be read.
 */
async function readSetFacts(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  setIds: string[]
): Promise<Map<string, SetFacts> | null> {
  if (setIds.length === 0) return new Map();
  try {
    const admin = ensureAdminDatabaseAdapter(c.env, 'identity-mapping-effective');
    if (!admin) return null;
    const rows = await admin.query<{
      id: string;
      tenant_id: string;
      display_name: string | null;
      lifecycle_state: string;
    }>(
      `SELECT id, tenant_id, display_name, lifecycle_state
         FROM field_mapping_sets
        WHERE id IN (${setIds.map(() => '?').join(', ')}) AND tenant_id IN (?, ?)`,
      [...setIds, tenantId, PLATFORM_MAPPING_TENANT_ID]
    );
    const facts = new Map<string, SetFacts>(setIds.map((id) => [id, { found: false }]));
    for (const row of rows) {
      facts.set(row.id, {
        found: true,
        ...(row.display_name ? { name: row.display_name } : {}),
        owner: row.tenant_id === PLATFORM_MAPPING_TENANT_ID ? 'platform' : 'tenant',
        lifecycleState: row.lifecycle_state,
      });
    }
    return facts;
  } catch {
    return null;
  }
}

function describeSet(setId: string | undefined, facts: Map<string, SetFacts> | null) {
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

function describeChain(chain: IdentityMappingChainEntry[], facts: Map<string, SetFacts> | null) {
  return chain.map((entry) => ({
    tier: entry.tier,
    state: entry.state,
    ...(entry.setId ? { setId: entry.setId, ...describeSet(entry.setId, facts) } : {}),
    ...(entry.source ? { source: entry.source } : {}),
  }));
}

function describeSelection(
  selection: IdentityMappingSelection,
  facts: Map<string, SetFacts> | null
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

    let selection: IdentityMappingSelection | null = null;
    let failure: IdentityMappingSelectionError | null = null;
    try {
      selection = await selectIdentityMapping({
        env: c.env,
        tenantId,
        protocol: 'oidc',
        clientSelector,
        // Every level, so the chain shows what each says; and past the cache, so a default just
        // saved is shown.
        inspectDefaults: true,
        fresh: true,
      });
    } catch (error) {
      if (!(error instanceof IdentityMappingSelectionError)) throw error;
      if (error.code === 'settings_unreadable' || !error.chain) {
        return c.json(
          {
            error: 'temporarily_unavailable',
            error_description: 'The settings that decide the Mapping Set cannot be read right now',
          },
          503
        );
      }
      failure = error;
    }

    const chain = selection?.chain ?? failure?.chain ?? [];
    const setIds = [...new Set(chain.flatMap((entry) => (entry.setId ? [entry.setId] : [])))];
    const facts = await readSetFacts(c, tenantId, setIds);

    return c.json({
      tenantId,
      clientId: clientId ?? null,
      selection: selection
        ? describeSelection(selection, facts)
        : // The level that failed is named, never its value: the selection fails rather than
          // fall to another level.
          { kind: 'failed' as const, code: failure!.code, tier: failure!.tier },
      chain: describeChain(chain, facts),
    });
  } catch {
    return c.json(
      { error: 'internal_error', error_description: 'The Mapping Set selection could not be read' },
      500
    );
  }
}
