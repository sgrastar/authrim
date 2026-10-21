/**
 * The activations a tenant has that the OIDC release used to apply to an app naming no Mapping
 * Set, and no longer does (the app's own choice, the tenant's default and the platform's default
 * decide now).
 *
 * This is the condition of Statement 1 of docs/operations/identity-mapping-implicit-application.md:
 * an active activation of the tenant whose version exists, that has an active compiled snapshot (one
 * without finds no mapping), and whose scope fits an OIDC call (protocol `oidc`, role `op`; a scope
 * that names a client fits only that client, so it is counted only for a call that names it). The
 * runtime does not look for them: it is for the views that tell an admin that something stopped
 * applying (the effective-selection API and the bulk apply's impact).
 *
 * It reads the Admin database once, for one tenant, and returns IDs and names only: no scope, claim
 * or value.
 */
import type { DatabaseAdapter } from '../db/adapter';
import { activationScopeApplies } from './identity-mapping-runtime-resolver';

export interface ImplicitOidcActivation {
  activationId: string;
  setId: string;
  /** The Mapping Set's display name, when it has one. */
  setName?: string;
}

export interface FindImplicitOidcActivationsInput {
  tenantId: string;
  /** The app the view is for. Without one, only an activation that names no app counts. */
  clientId?: string;
  /** At most this many are returned (default 20), most recently activated first. */
  limit?: number;
}

interface ActivationRow {
  activation_id: string;
  field_mapping_set_id: string;
  activation_scope_json: string | null;
  display_name: string | null;
}

const ROW_LIMIT = 200;

function parseScope(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // A scope that is not JSON counts as having none, as the runtime reads it.
    return {};
  }
}

/** Throws when the Admin database cannot be read; the caller says the check could not be made. */
export async function findImplicitOidcActivations(
  adapter: DatabaseAdapter,
  input: FindImplicitOidcActivationsInput
): Promise<ImplicitOidcActivation[]> {
  const rows = await adapter.query<ActivationRow>(
    `SELECT a.id AS activation_id, a.field_mapping_set_id, a.activation_scope_json, s.display_name
       FROM field_mapping_activations a
       JOIN field_mapping_versions v
         ON v.tenant_id = a.tenant_id
        AND v.field_mapping_set_id = a.field_mapping_set_id
        AND v.id = a.field_mapping_version_id
       LEFT JOIN field_mapping_sets s
         ON s.id = a.field_mapping_set_id AND s.tenant_id = a.tenant_id
      WHERE a.tenant_id = ?
        AND a.lifecycle_state = 'active'
        AND EXISTS (
          SELECT 1 FROM compiled_mapping_snapshots c
           WHERE c.tenant_id = a.tenant_id
             AND c.field_mapping_version_id = a.field_mapping_version_id
             AND c.lifecycle_state = 'active'
             AND c.catalog_version_id IS NOT NULL
        )
      ORDER BY a.activated_at DESC, a.created_at DESC
      LIMIT ${ROW_LIMIT}`,
    [input.tenantId]
  );
  const limit = input.limit ?? 20;
  const found: ImplicitOidcActivation[] = [];
  for (const row of rows) {
    const applies = activationScopeApplies(parseScope(row.activation_scope_json), {
      tenantId: input.tenantId,
      protocol: 'oidc',
      role: 'op',
      ...(input.clientId ? { clientId: input.clientId, partnerEntityId: input.clientId } : {}),
    });
    if (!applies) continue;
    found.push({
      activationId: row.activation_id,
      setId: row.field_mapping_set_id,
      ...(row.display_name ? { setName: row.display_name } : {}),
    });
    if (found.length >= limit) break;
  }
  return found;
}
