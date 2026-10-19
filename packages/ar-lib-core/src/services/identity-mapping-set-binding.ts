import type { DatabaseAdapter } from '../db/adapter';
import {
  PLATFORM_MAPPING_TENANT_ID,
  RuntimeIdentityMappingOwnerError,
} from './identity-mapping-owner';
import { swallowedIdentityMappingFailureReasonCode } from './identity-mapping-swallowed-failure';
import {
  resolveRuntimeIdentityMappingBinding,
  type RuntimeIdentityMappingBinding,
  type RuntimeIdentityMappingRole,
} from './identity-mapping-runtime-resolver';

/**
 * Which tier of the field-mapping order a Mapping Set is asked for. The tier decides who may own
 * the set: the platform's default is the platform's alone, and the tenant's default and an app's
 * own mapping may be the tenant's or one the platform shares.
 */
export type IdentityMappingTier = 'client' | 'tenant_default' | 'platform_default';

export type IdentityMappingResolutionErrorCode =
  /** No such set for this tenant (also: a set another tenant owns, or one the tier cannot use). */
  | 'set_missing'
  /** The set exists and is usable here, but nothing active applies (not active, or no activation). */
  | 'set_inactive'
  /** The mapping does not point at exactly one Destination Profile. */
  | 'destination_profile_invalid'
  /** The Admin database is not bound or failed the lookup. */
  | 'admin_database_unavailable';

/**
 * A Mapping Set that was named could not be turned into a binding. The message and fields name
 * the tier and the set ID the caller gave, never a row, a value or another tenant's ID.
 */
export class IdentityMappingResolutionError extends Error {
  constructor(
    readonly code: IdentityMappingResolutionErrorCode,
    readonly tier: IdentityMappingTier,
    readonly setId: string,
    /**
     * One of a fixed set of codes for what failed underneath (see
     * identityMappingResolutionReasonCode), set for database failures. The underlying error is deliberately not kept: its message and
     * fields can name other tenants and row values.
     */
    readonly reasonCode?: string
  ) {
    super(`Identity mapping set could not be resolved (${code}) for ${tier}`);
    this.name = 'IdentityMappingResolutionError';
  }
}

export interface LoadMappingBindingBySetIdInput {
  /**
   * The Admin database. There is no fallback to the Core database when it is missing: the Core
   * database holds no mappings, so reading it would only look like an empty answer.
   */
  adapter: DatabaseAdapter | null | undefined;
  /** The tenant the call is made for. */
  tenantId: string;
  setId: string;
  tier: IdentityMappingTier;
  protocol: 'oidc';
  role: RuntimeIdentityMappingRole;
  versionId?: string;
  /** The app the call is for, so an activation scoped to it can be told from the others. */
  clientId?: string;
}

interface MappingSetOwnerRow {
  tenant_id: string;
  lifecycle_state: string;
}

const RESOLUTION_REASON_CODES: ReadonlySet<string> = new Set([
  'no_such_table',
  'no_such_column',
  'd1_error',
  'database_timeout',
  'database_unavailable',
  'admin_database_not_configured',
]);

/**
 * Why a database failure happened, as one of a fixed set of codes. The error's own `code` and
 * `name` are not passed on unless they are one of those codes: they are free text to us, and can
 * carry a tenant ID or a value. Anything else is classified from the message (which is not kept)
 * and otherwise reported as `unknown`.
 */
export function identityMappingResolutionReasonCode(error: unknown): string {
  const direct = swallowedIdentityMappingFailureReasonCode(error);
  if (RESOLUTION_REASON_CODES.has(direct)) return direct;
  if (error instanceof Error) {
    const byMessage = swallowedIdentityMappingFailureReasonCode(new Error(error.message));
    if (RESOLUTION_REASON_CODES.has(byMessage)) return byMessage;
  }
  return 'unknown';
}

/**
 * Whether `tier` may use a set owned by `ownerTenantId` for a call made for `tenantId`.
 * The platform tier is the platform's alone; the other tiers take their own tenant's sets and the
 * platform's. Nothing else is ever readable.
 */
function tierAllowsOwner(tier: IdentityMappingTier, tenantId: string, ownerTenantId: string) {
  if (ownerTenantId === PLATFORM_MAPPING_TENANT_ID) return true;
  return tier !== 'platform_default' && ownerTenantId === tenantId;
}

/**
 * The binding of the Mapping Set the caller names. The set is found by its ID alone, which fixes
 * the tenant ID that owns it (the calling tenant's, or the platform's); the binding is then read
 * under that owner. The calling tenant is still what the activation's scope is matched against.
 *
 * A set that does not exist and one that another tenant owns fail the same way (`set_missing`),
 * so the answer does not tell a tenant what exists elsewhere.
 */
export async function loadMappingBindingBySetId(
  input: LoadMappingBindingBySetIdInput
): Promise<RuntimeIdentityMappingBinding> {
  const { adapter, tenantId, setId, tier } = input;
  const fail = (code: IdentityMappingResolutionErrorCode, reasonCode?: string) =>
    new IdentityMappingResolutionError(code, tier, setId, reasonCode);
  if (!adapter) throw fail('admin_database_unavailable', 'admin_database_not_configured');

  let setRow: MappingSetOwnerRow | null;
  try {
    setRow = await adapter.queryOne<MappingSetOwnerRow>(
      'SELECT tenant_id, lifecycle_state FROM field_mapping_sets WHERE id = ?',
      [setId]
    );
  } catch (error) {
    throw fail('admin_database_unavailable', identityMappingResolutionReasonCode(error));
  }
  if (!setRow || !tierAllowsOwner(tier, tenantId, setRow.tenant_id)) throw fail('set_missing');
  if (setRow.lifecycle_state !== 'active') throw fail('set_inactive');

  let binding: RuntimeIdentityMappingBinding | null;
  try {
    binding = await resolveRuntimeIdentityMappingBinding(adapter, {
      tenantId,
      ownerTenantId: setRow.tenant_id,
      protocol: input.protocol,
      role: input.role,
      fieldMappingSetId: setId,
      fieldMappingVersionId: input.versionId,
      partnerEntityId: input.clientId,
      clientId: input.clientId,
    });
  } catch (error) {
    if (error instanceof RuntimeIdentityMappingOwnerError) throw error;
    throw fail('admin_database_unavailable', identityMappingResolutionReasonCode(error));
  }
  if (!binding) throw fail('set_inactive');
  if (binding.destinationProfileIds.length !== 1 || !binding.destinationProfileId) {
    throw fail('destination_profile_invalid');
  }
  return binding;
}
