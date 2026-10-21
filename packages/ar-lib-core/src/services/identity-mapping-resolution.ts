/**
 * Selecting and reading the Mapping Set of an OIDC app in one step: the selection
 * (identity-mapping-selection.ts) decides which set, and only a selection that names one reads
 * the Admin database (`loadMappingBindingBySetId`).
 *
 * - A selection of none succeeds without a database, so a Worker without DB_ADMIN answers as one
 *   with it.
 * - A selection that names a set fails with `admin_database_unavailable` when DB_ADMIN is not
 *   bound or cannot be read. There is no fallback to the Core database, which holds no mappings.
 *
 * `applyOIDCIdentityMapping` (the release of claims) and the consent screen call this;
 * `toOidcIdentityMappingRuntimeError` (oidc-identity-mapping.ts) turns its failures into the
 * errors the release answers with.
 */
import type { DatabaseAdapter } from '../db/adapter';
import type { Env } from '../types/env';
import { ensureAdminDatabaseAdapter } from './admin-database-adapter';
import type { EffectiveSettingsEnv } from './effective-settings';
import type { RuntimeIdentityMappingBinding } from './identity-mapping-runtime-resolver';
import { loadMappingBindingBySetId } from './identity-mapping-set-binding';
import { selectIdentityMapping, type IdentityMappingSelection } from './identity-mapping-selection';

export interface ResolveOidcIdentityMappingBindingInput {
  env: EffectiveSettingsEnv & Partial<Pick<Env, 'DB_ADMIN'>>;
  tenantId: string;
  /** The app the call is for, so an activation scoped to it can be told from the others. */
  clientId?: string;
  /** The app's `identity_mapping` (see `readClientIdentityMappingChoice`). */
  clientSelector: unknown;
  /** Read the settings documents past the cache. */
  fresh?: boolean;
  /**
   * The Admin database to read through, instead of DB_ADMIN of `env` (a caller that already holds
   * the adapter, and tests). Never the Core database.
   */
  adminAdapter?: DatabaseAdapter | null;
}

export interface OidcIdentityMappingResolution {
  selection: IdentityMappingSelection;
  /** The set's binding, or null when the selection is none. */
  binding: RuntimeIdentityMappingBinding | null;
}

/**
 * The selection and, when it names a set, that set's binding. Throws
 * `IdentityMappingSelectionError` (the selection could not be made) or
 * `IdentityMappingResolutionError` (the chosen set could not be used); a wrong owner stays a
 * `RuntimeIdentityMappingOwnerError`.
 */
export async function resolveOidcIdentityMappingBinding(
  input: ResolveOidcIdentityMappingBindingInput
): Promise<OidcIdentityMappingResolution> {
  const selection = await selectIdentityMapping({
    env: input.env,
    tenantId: input.tenantId,
    protocol: 'oidc',
    clientSelector: input.clientSelector,
    fresh: input.fresh,
  });
  if (selection.kind === 'none') return { selection, binding: null };

  const adapter =
    input.adminAdapter ?? ensureAdminDatabaseAdapter(input.env, 'oidc-identity-mapping');
  const binding = await loadMappingBindingBySetId({
    adapter,
    tenantId: input.tenantId,
    setId: selection.setId,
    tier: selection.tier,
    protocol: 'oidc',
    role: 'op',
    versionId: selection.selector?.fieldMappingVersionId,
    clientId: input.clientId,
  });
  return { selection, binding };
}
