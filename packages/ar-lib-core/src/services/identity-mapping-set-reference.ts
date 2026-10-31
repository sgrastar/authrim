/**
 * Naming a Mapping Set as the OIDC default of the platform or a tenant (the setting
 * `identity_mapping.oidc_default_set_id`), or as an app's own choice.
 *
 * Two things live here, both shared by every place that saves such a name or later reads it:
 * - the value: what a saved name may look like, and how a saved or inherited value reads back
 *   (`readOidcDefaultSetSelection`);
 * - the reference: whether the set it names can be used (`validateOidcMappingSetReference`).
 *
 * The release of claims reads the same names through the selection (identity-mapping-selection.ts).
 */
import type { DatabaseAdapter } from '../db/adapter';
import {
  IDENTITY_MAPPING_NONE,
  IDENTITY_MAPPING_SET_ID_MAX_LENGTH,
} from '../types/settings/identity-mapping';
import { DISABLED_MARKER } from '../utils/settings-manager';
import { loadDestinationProfileConsentDescriptor } from './destination-profile-consent';
import {
  findPlatformMappingCompileViolation,
  platformDestinationProfileRefs,
  type PlatformCatalogEntry,
} from './identity-mapping-platform-checks';
import {
  PLATFORM_MAPPING_TENANT_ID,
  RuntimeIdentityMappingOwnerError,
} from './identity-mapping-owner';
import {
  IdentityMappingResolutionError,
  identityMappingResolutionReasonCode,
  loadMappingBindingBySetId,
  type IdentityMappingResolutionErrorCode,
  type IdentityMappingTier,
} from './identity-mapping-set-binding';

// ---------------------------------------------------------------------------------------------
// The value
// ---------------------------------------------------------------------------------------------

/** What a Mapping Set ID looks like: the IDs the control plane makes, and the plain ones before it. */
const SET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

/** Where a default is saved. The platform has no level above it, so its value cannot be `none`. */
export type IdentityMappingDefaultScope = 'platform' | 'tenant';

/**
 * Why a value cannot be saved as the default Mapping Set at `scope`, or null. Only the form of the
 * value is judged here; whether the set exists is `validateOidcMappingSetReference`.
 */
export function oidcDefaultSetValueProblem(
  value: unknown,
  scope: IdentityMappingDefaultScope
): string | null {
  const key = 'identity_mapping.oidc_default_set_id';
  if (typeof value !== 'string') {
    return `${key} must be a Mapping Set ID (a string)`;
  }
  // The settings reader turns the disabled marker into `false` for every key, which for a string
  // setting would read as "no value". "Do not use a default" is `none`.
  if (value === DISABLED_MARKER) {
    return `${key} cannot be disabled; use ${IDENTITY_MAPPING_NONE} to use no default`;
  }
  if (value.length === 0 || value !== value.trim()) {
    return `${key} must not be empty or have surrounding whitespace`;
  }
  if (value.length > IDENTITY_MAPPING_SET_ID_MAX_LENGTH) {
    return `${key} must be at most ${IDENTITY_MAPPING_SET_ID_MAX_LENGTH} characters`;
  }
  if (value === IDENTITY_MAPPING_NONE) {
    return scope === 'platform'
      ? `${key} cannot be ${IDENTITY_MAPPING_NONE} for the platform; clear it to use no default`
      : null;
  }
  // Spellings of the reserved value that are not it would read as the ID of a set that cannot exist.
  if (value.toLowerCase() === IDENTITY_MAPPING_NONE) {
    return `${key} must be exactly ${IDENTITY_MAPPING_NONE} (lowercase) or a Mapping Set ID`;
  }
  if (!SET_ID_PATTERN.test(value)) {
    return `${key} is not a valid Mapping Set ID`;
  }
  return null;
}

/** What a default Mapping Set value in effect (saved, inherited or the code default) says. */
export type OidcDefaultSetSelection =
  /** Nothing is set at this level: the next level up decides. */
  | { kind: 'unset' }
  /** Explicitly no mapping from here, and the levels above are not asked. */
  | { kind: 'none' }
  | { kind: 'set'; setId: string }
  /**
   * A value that is neither: a stored value that is not a string (the disabled marker reads back as
   * `false`), an empty or over-long string, or an ID of no valid form. The caller must fail, not
   * fall through to the next level: a default that is set but unusable must not become another one.
   */
  | { kind: 'invalid' };

/**
 * Reads a default Mapping Set value in effect. `undefined` and `null` are unset; `none` is the
 * explicit opt-out; a string that could have been saved is a set ID; anything else is invalid.
 */
export function readOidcDefaultSetSelection(value: unknown): OidcDefaultSetSelection {
  if (value === undefined || value === null) return { kind: 'unset' };
  if (typeof value !== 'string') return { kind: 'invalid' };
  if (value === IDENTITY_MAPPING_NONE) return { kind: 'none' };
  // Judged as a tenant value (the one that allows `none`), which `none` has already been.
  return oidcDefaultSetValueProblem(value, 'tenant') === null
    ? { kind: 'set', setId: value }
    : { kind: 'invalid' };
}

// ---------------------------------------------------------------------------------------------
// The reference
// ---------------------------------------------------------------------------------------------

export type OidcMappingSetReferenceFailureCode =
  | IdentityMappingResolutionErrorCode
  /** A Mapping Set of the platform that holds something a platform set may not. */
  | 'platform_set_unsafe';

export type OidcMappingSetReferenceResult =
  | {
      ok: true;
      /** The tenant ID that owns the set: the context tenant's, or the platform's. */
      ownerTenantId: string;
      setId: string;
      versionId: string;
      destinationProfileId: string;
      snapshotHash: string;
    }
  | {
      ok: false;
      code: OidcMappingSetReferenceFailureCode;
      /** Fit to show to the admin who named the set; never a row or another tenant's ID. */
      message: string;
      /** One of a fixed set of codes for a database failure. */
      reasonCode?: string;
    };

export interface ValidateOidcMappingSetReferenceInput {
  /** The Admin database; missing is a failure (`admin_database_unavailable`), never an empty answer. */
  adminAdapter: DatabaseAdapter | null | undefined;
  /** The tenant the name is saved for (for the platform's own default: the platform ID). */
  contextTenantId: string;
  /**
   * Where the name is saved. `platform`: only a set the platform owns. `tenant`: the tenant's own
   * set or the platform's. `client` (an app's own choice): the tenant's own set only for now (a
   * platform-owned set answers `set_missing`; see the backup dependency note below).
   */
  scope: IdentityMappingDefaultScope | 'client';
  setId: string;
  /** A version the name pins (an app's own choice may); default: the active one. */
  versionId?: string;
}

const TIER_OF_SCOPE: Record<ValidateOidcMappingSetReferenceInput['scope'], IdentityMappingTier> = {
  platform: 'platform_default',
  tenant: 'tenant_default',
  client: 'client',
};

const FAILURE_MESSAGES: Record<IdentityMappingResolutionErrorCode, string> = {
  set_missing: 'The Mapping Set does not exist or is not available here',
  set_inactive: 'The Mapping Set must be active, with an active compiled version',
  destination_profile_invalid:
    'The active Mapping Set must reference exactly one active OIDC Destination Profile',
  admin_database_unavailable: 'The Mapping Set cannot be checked right now',
};

function failure(
  code: OidcMappingSetReferenceFailureCode,
  message?: string,
  reasonCode?: string
): OidcMappingSetReferenceResult {
  return {
    ok: false,
    code,
    message: message ?? FAILURE_MESSAGES[code as IdentityMappingResolutionErrorCode],
    ...(reasonCode ? { reasonCode } : {}),
  };
}

function parseRef(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * What a Mapping Set of the platform may hold, judged on the version's stored rows and the catalog
 * it is compiled against: the same judgement the control plane makes when the version is compiled
 * and again when it is activated (a platform set is shared by every tenant, so it can only read the
 * platform catalog's standard fields). Returns the first violation, or null.
 */
export async function platformSetViolation(
  adapter: DatabaseAdapter,
  versionId: string,
  catalogVersionId: string
): Promise<string | null> {
  const params = [PLATFORM_MAPPING_TENANT_ID, versionId];
  const [edgeRows, validationRows, transformRows, catalogRows] = await Promise.all([
    adapter.query<{ source_ref_json: string; target_ref_json: string }>(
      `SELECT e.source_ref_json, e.target_ref_json
         FROM mapping_rules r
         JOIN mapping_rule_edges e ON e.tenant_id = r.tenant_id AND e.rule_id = r.id
        WHERE r.tenant_id = ? AND r.field_mapping_version_id = ?`,
      params
    ),
    adapter.query<{ target_ref_json: string }>(
      `SELECT v.target_ref_json
         FROM mapping_rules r
         JOIN mapping_validation_rules v ON v.tenant_id = r.tenant_id AND v.rule_id = r.id
        WHERE r.tenant_id = ? AND r.field_mapping_version_id = ?`,
      params
    ),
    adapter.query<{ operation: string; parameters_json: string | null }>(
      `SELECT t.operation, t.parameters_json
         FROM mapping_rules r
         JOIN mapping_transform_steps t ON t.tenant_id = r.tenant_id AND t.rule_id = r.id
        WHERE r.tenant_id = ? AND r.field_mapping_version_id = ?`,
      params
    ),
    adapter.query<{
      id: string;
      stable_field_id: string;
      namespace: string;
      path: string;
      classification: string;
      target_taxonomy: string;
    }>(
      `SELECT id, stable_field_id, namespace, path, classification, target_taxonomy
         FROM field_catalog_entries
        WHERE tenant_id = ? AND catalog_version_id = ?`,
      [PLATFORM_MAPPING_TENANT_ID, catalogVersionId]
    ),
  ]);
  const entries: PlatformCatalogEntry[] = catalogRows.map((row) => ({
    ids: [row.id, row.stable_field_id],
    namespace: row.namespace,
    path: row.path,
    classification: row.classification,
    targetType: row.target_taxonomy,
    targetTaxonomy: row.target_taxonomy,
  }));
  const edges = edgeRows.map((row) => ({
    sourceRef: parseRef(row.source_ref_json),
    targetRef: parseRef(row.target_ref_json),
  }));
  const violation = findPlatformMappingCompileViolation(
    {
      edges,
      validationRules: validationRows.map((row) => ({ targetRef: parseRef(row.target_ref_json) })),
      transforms: transformRows.map((row) => ({
        operation: row.operation,
        parameters: parseRef(row.parameters_json),
      })),
    },
    entries
  );
  if (violation) return violation;
  const refs = platformDestinationProfileRefs(edges.map((edge) => edge.targetRef));
  return 'violation' in refs ? refs.violation : null;
}

/**
 * Whether a Mapping Set can be named as an OIDC default (or an app's own choice) at `scope`:
 * - it exists and its owner is allowed at that scope (the platform's default: the platform's set
 *   only; a tenant's: its own or the platform's; any other owner is the same as "missing");
 * - it is active, with an active activation that applies and an active compiled snapshot;
 * - it releases into exactly one Destination Profile, and that is an active OIDC one;
 * - when the platform owns it, it also holds what a platform set may hold.
 */
export async function validateOidcMappingSetReference(
  input: ValidateOidcMappingSetReferenceInput
): Promise<OidcMappingSetReferenceResult> {
  const adapter = input.adminAdapter;

  // TODO(backup dependency): lift this when the tenant backup's dependency rules can carry a
  // reference to a platform-owned set. A tenant backup holds the tenant's own rows only, so an app
  // that names a platform set would make that set a required dependency the bundle cannot hold,
  // and restoring it, even into the same environment, would fail with
  // `backup_reference_target_missing` (phase3-sqlite-references.ts). The runtime already reads such
  // a set under its owner (the tenant's default and the platform's default may name one), so only
  // saving the choice on an app is refused here. It answers as a set that does not exist, decided
  // from the owner alone before the set's state is judged, so a platform set that is a draft, has
  // no activation or the wrong number of profiles answers exactly as a set that does not exist.
  // See "What the backup side has to do" in docs/operations/platform-mapping-sets.md.
  if (input.scope === 'client' && adapter) {
    try {
      const owner = await adapter.queryOne<{ tenant_id: string }>(
        'SELECT tenant_id FROM field_mapping_sets WHERE id = ?',
        [input.setId]
      );
      if (owner?.tenant_id === PLATFORM_MAPPING_TENANT_ID) return failure('set_missing');
    } catch (error) {
      return failure(
        'admin_database_unavailable',
        undefined,
        identityMappingResolutionReasonCode(error)
      );
    }
  }

  let binding;
  try {
    binding = await loadMappingBindingBySetId({
      adapter,
      tenantId: input.contextTenantId,
      setId: input.setId,
      tier: TIER_OF_SCOPE[input.scope],
      protocol: 'oidc',
      role: 'op',
      versionId: input.versionId,
    });
  } catch (error) {
    if (error instanceof IdentityMappingResolutionError) {
      return failure(error.code, undefined, error.reasonCode);
    }
    // The owner rule failed inside the resolver: the set is not one this scope may name.
    if (error instanceof RuntimeIdentityMappingOwnerError) {
      return failure('set_missing');
    }
    return failure(
      'admin_database_unavailable',
      undefined,
      identityMappingResolutionReasonCode(error)
    );
  }
  const ownerTenantId = binding.tenantId;
  const profileId = binding.destinationProfileId as string;
  // The adapter is known to be set: the lookup above would have failed without it.
  const db = adapter as DatabaseAdapter;

  try {
    // Looked up under the owner: a platform set's profile must be the platform's, since a profile
    // a tenant owns is invisible to the other tenants this set would apply to.
    const descriptor = await loadDestinationProfileConsentDescriptor(db, ownerTenantId, profileId);
    if (!descriptor || descriptor.destinationType !== 'oidc') {
      return failure('destination_profile_invalid');
    }
    if (ownerTenantId === PLATFORM_MAPPING_TENANT_ID) {
      const violation = await platformSetViolation(
        db,
        binding.fieldMappingVersionId,
        binding.catalog.identity.id
      );
      if (violation) return failure('platform_set_unsafe', violation);
    }
  } catch (error) {
    return failure(
      'admin_database_unavailable',
      undefined,
      identityMappingResolutionReasonCode(error)
    );
  }

  return {
    ok: true,
    ownerTenantId,
    setId: binding.fieldMappingSetId,
    versionId: binding.fieldMappingVersionId,
    destinationProfileId: profileId,
    snapshotHash: binding.mappingSnapshotHash,
  };
}
