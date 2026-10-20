/**
 * Who uses a Mapping Set.
 *
 * Settings v2 has no foreign keys, so a Mapping Set that is named as the platform's or a tenant's
 * default, chosen by an app, or used by a credential profile can be deleted or switched off with
 * nothing stopping it, and the places that name it break one by one. `findMappingSetReferences`
 * finds those places; the operations that remove or disable a set (and the usage API) ask it
 * first and refuse when it finds any, or when it could not look everywhere.
 *
 * What is looked at (the places that hold a Mapping Set ID):
 * - the platform's and the tenants' `identity-mapping` settings documents (Admin database),
 * - OIDC clients' `identity_mapping` (the tenant's Core database),
 * - SAML SP / IdP configurations' `identityMapping` (the tenant's Core database),
 * - credential profile versions (Admin database),
 * - a tenant's enabled SCIM inbound provisioning (the settings store), for a set the tenant owns.
 *   The platform's sets cannot be used by SCIM: its lookup only reads the tenant's own sets.
 *
 * Nothing found is only worth anything if everything was looked at: every place that could not
 * be (a tenant whose Core database could not be reached, a failed query, a store that is not
 * bound) is returned in `unscanned`, never left out, and the callers refuse on it.
 *
 * Nothing here decides what a caller may see of another tenant's references. That is
 * `summarizeMappingSetReferences`.
 */
import type { DatabaseAdapter } from '../db/adapter';
import { identityMappingResolutionReasonCode } from './identity-mapping-set-binding';
import { PLATFORM_MAPPING_TENANT_ID } from './identity-mapping-owner';

/** The setting that names the default Mapping Set, and the category it lives in. */
const DEFAULT_SET_SETTING_PATH = '$."identity_mapping.oidc_default_set_id"';
const IDENTITY_MAPPING_SETTINGS_CATEGORY = 'identity-mapping';

/** Rows read for one place before it is cut off (the answer then says the count is a lower bound). */
export const MAPPING_SET_REFERENCE_ROW_LIMIT = 500;
/** Other tenants looked at for a platform set, before the rest are reported as not looked at. */
export const MAPPING_SET_REFERENCE_TENANT_LIMIT = 200;
/** Tenants whose Core databases are read at the same time. */
const TENANT_SCAN_CONCURRENCY = 8;

export type MappingSetReferenceKind =
  | 'platform_default'
  | 'tenant_default'
  | 'client'
  | 'saml_provider'
  | 'credential_profile'
  | 'federation_trust_source'
  | 'scim';

export interface MappingSetReferenceSwapInputs {
  /** The fields the provider's release policy names. */
  policyKeys: string[];
  attributeDescriptors?: Record<string, { name?: string; friendlyName?: string }>;
  destinationNamespace?: string;
}

export interface MappingSetReference {
  kind: MappingSetReferenceKind;
  /** The tenant the reference is in. Absent for the platform's own default. */
  tenantId?: string;
  /** `client`: the OIDC client. */
  clientId?: string;
  /** `saml_provider`: the identity provider row, its type and the entity ID of its partner. */
  providerId?: string;
  providerType?: string;
  entityId?: string;
  /** `credential_profile`: the profile and version that name the set, and in which role. */
  profileId?: string;
  versionId?: string;
  versionLifecycleState?: string;
  credentialConfigurationId?: string;
  role?: 'issuance' | 'verification';
  /** `federation_trust_source`: the source, and the role of the entities it resolves. */
  trustSourceId?: string;
  federationRole?: 'saml_idp' | 'saml_sp';
  /** A Mapping Set version the reference pins (an app's own choice may). */
  pinnedVersionId?: string;
  /** A credential profile version also pins the compiled snapshot it was published with. */
  pinnedSnapshotHash?: string;
  /**
   * What a SAML provider saved about the Destination Profile it releases into, which the profile
   * of another version must keep true. Not part of what is shown (see `summarizeMappingSetReferences`).
   */
  swapInputs?: MappingSetReferenceSwapInputs;
  /** When asked about something that sets use (a Destination Profile): the set the reference is through. */
  viaMappingSetId?: string;
}

/** The places that could not be looked at. Fixed codes: nothing here carries a row or an error. */
export interface UnscannedMappingSetScope {
  area:
    | 'platform_settings'
    | 'tenant_settings'
    | 'credential_profiles'
    | 'federation_trust_sources'
    | 'tenant_clients'
    | 'tenant_saml'
    | 'scim_settings'
    | 'tenant_directory'
    | 'tenant_limit'
    | 'other_tenants';
  tenantId?: string;
  reason: string;
}

export interface MappingSetReferenceScan {
  references: MappingSetReference[];
  /** True when a place held more than the row limit: `references` is then not all of them. */
  truncated: boolean;
  unscanned: UnscannedMappingSetScope[];
}

/** What a reference is asked for: removing the set also counts the versions it cannot outlive. */
export type MappingSetReferencePurpose = 'delete' | 'change';

export interface FindMappingSetReferencesInput {
  /** The Admin database. */
  adminAdapter: DatabaseAdapter;
  setId: string;
  /** The tenant ID that owns the set, or the platform's. */
  ownerTenantId: string;
  /** The tenant the call is made for. */
  contextTenantId: string;
  /** The context tenant's Core database. */
  contextCoreAdapter?: DatabaseAdapter | null;
  /**
   * The Core database of another tenant, through tenant routing. Returns null or throws when it
   * cannot be had: that tenant is then reported as not looked at. Without it no other tenant is.
   */
  resolveCoreAdapter?: (tenantId: string) => Promise<DatabaseAdapter | null>;
  /**
   * The tenant IDs that can still be looked at (not those whose deletion is complete), at most
   * `limit` of them, for a set the platform owns (any tenant may use it). Without it only the
   * context tenant is looked at.
   */
  listTenantIds?: (limit: number) => Promise<readonly string[]>;
  /**
   * For a set the platform owns: whether the other tenants' Core databases are read. Off, only
   * the context tenant's are, and the rest is reported as not looked at (`other_tenants`). Each
   * tenant is a database read, so this is for the callers that may run the search many times.
   * Default on.
   */
  scanOtherTenants?: boolean;
  /** The store the SCIM settings are in (`settings:tenant:<id>:scim`). */
  settingsStore?: { get(key: string): Promise<string | null> } | null;
  /** Default `delete`. `change` leaves out what cannot be broken by switching a version off. */
  purpose?: MappingSetReferencePurpose;
  maxTenants?: number;
}

function parseJsonObject(json: string | null): Record<string, unknown> {
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

function scimSettingsKey(tenantId: string): string {
  return `settings:tenant:${tenantId}:scim`;
}

function failureScope(
  area: UnscannedMappingSetScope['area'],
  error: unknown,
  tenantId?: string
): UnscannedMappingSetScope {
  return {
    area,
    ...(tenantId ? { tenantId } : {}),
    reason: identityMappingResolutionReasonCode(error),
  };
}

/** Finds every place that names the Mapping Set, and every place it could not look. */
export async function findMappingSetReferences(
  input: FindMappingSetReferencesInput
): Promise<MappingSetReferenceScan> {
  const { adminAdapter: admin, setId, ownerTenantId } = input;
  const platformOwned = ownerTenantId === PLATFORM_MAPPING_TENANT_ID;
  const purpose = input.purpose ?? 'delete';
  const references: MappingSetReference[] = [];
  const unscanned: UnscannedMappingSetScope[] = [];
  let truncated = false;
  const limit = MAPPING_SET_REFERENCE_ROW_LIMIT;
  const keep = (found: MappingSetReference[]) => {
    if (found.length > limit) truncated = true;
    references.push(...found.slice(0, limit));
  };

  // The platform's default (a single document): cheap, so asked for every set.
  try {
    const hit = await admin.queryOne<{ hit: number }>(
      `SELECT 1 AS hit FROM platform_settings_documents
        WHERE category = ? AND json_extract(document_json, '${DEFAULT_SET_SETTING_PATH}') = ?
        LIMIT 1`,
      [IDENTITY_MAPPING_SETTINGS_CATEGORY, setId]
    );
    if (hit) references.push({ kind: 'platform_default' });
  } catch (error) {
    unscanned.push(failureScope('platform_settings', error));
  }

  // The tenants' defaults. A set a tenant owns is only ever named by that tenant.
  try {
    const rows = await admin.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM tenant_settings_documents
        WHERE scope_type = 'tenant' AND category = ?
          AND json_extract(document_json, '${DEFAULT_SET_SETTING_PATH}') = ?
          ${platformOwned ? '' : 'AND tenant_id = ?'}
        ORDER BY tenant_id LIMIT ${limit + 1}`,
      platformOwned
        ? [IDENTITY_MAPPING_SETTINGS_CATEGORY, setId]
        : [IDENTITY_MAPPING_SETTINGS_CATEGORY, setId, ownerTenantId]
    );
    keep(rows.map((row) => ({ kind: 'tenant_default' as const, tenantId: row.tenant_id })));
  } catch (error) {
    unscanned.push(failureScope('tenant_settings', error));
  }

  // Credential profile versions. Removing the set is stopped by their foreign keys whatever state
  // the version is in; switching it off only matters to a version that can still be used. The
  // state is part of the query: cutting the rows off first could leave only versions that are not.
  try {
    const rows = await admin.query<{
      tenant_id: string;
      credential_profile_id: string;
      id: string;
      lifecycle_state: string;
      credential_configuration_id: string;
      issuance_mapping_set_id: string;
      issuance_mapping_version_id: string | null;
      issuance_mapping_snapshot_hash: string | null;
      verification_mapping_set_id: string | null;
      verification_mapping_version_id: string | null;
      verification_mapping_snapshot_hash: string | null;
    }>(
      `SELECT tenant_id, credential_profile_id, id, lifecycle_state, credential_configuration_id,
              issuance_mapping_set_id, issuance_mapping_version_id, issuance_mapping_snapshot_hash,
              verification_mapping_set_id, verification_mapping_version_id,
              verification_mapping_snapshot_hash
         FROM credential_profile_versions
        WHERE (issuance_mapping_set_id = ? OR verification_mapping_set_id = ?)
          ${platformOwned ? '' : 'AND tenant_id = ?'}
          ${purpose === 'change' ? "AND lifecycle_state = 'published'" : ''}
        ORDER BY tenant_id, credential_profile_id, id LIMIT ${limit + 1}`,
      platformOwned ? [setId, setId] : [setId, setId, ownerTenantId]
    );
    const found: MappingSetReference[] = [];
    for (const row of rows) {
      const base = {
        kind: 'credential_profile' as const,
        tenantId: row.tenant_id,
        profileId: row.credential_profile_id,
        versionId: row.id,
        versionLifecycleState: row.lifecycle_state,
        credentialConfigurationId: row.credential_configuration_id,
      };
      if (row.issuance_mapping_set_id === setId) {
        found.push({
          ...base,
          role: 'issuance',
          ...(row.issuance_mapping_version_id
            ? { pinnedVersionId: row.issuance_mapping_version_id }
            : {}),
          ...(row.issuance_mapping_snapshot_hash
            ? { pinnedSnapshotHash: row.issuance_mapping_snapshot_hash }
            : {}),
        });
      }
      if (row.verification_mapping_set_id === setId) {
        found.push({
          ...base,
          role: 'verification',
          ...(row.verification_mapping_version_id
            ? { pinnedVersionId: row.verification_mapping_version_id }
            : {}),
          ...(row.verification_mapping_snapshot_hash
            ? { pinnedSnapshotHash: row.verification_mapping_snapshot_hash }
            : {}),
        });
      }
    }
    keep(found);
  } catch (error) {
    unscanned.push(failureScope('credential_profiles', error));
  }

  // Federation trust sources that resolve entities of an aggregate with a set (automatic runtime
  // resolution): `runtimeResolution.idpFieldMappingSetId` for the entities that are identity
  // providers, `spFieldMappingSetId` for service providers. Any source that names the set counts,
  // whatever its mode or state: switching it to automatic is not checked against the set.
  try {
    const field = (name: string) =>
      `CASE WHEN json_valid(protocol_payload_json)
            THEN json_extract(protocol_payload_json, '$.runtimeResolution.${name}') END`;
    const rows = await admin.query<{
      id: string;
      tenant_id: string;
      idp_set: string | null;
      sp_set: string | null;
    }>(
      `SELECT id, tenant_id, ${field('idpFieldMappingSetId')} AS idp_set,
              ${field('spFieldMappingSetId')} AS sp_set
         FROM federation_trust_sources
        WHERE (${field('idpFieldMappingSetId')} = ? OR ${field('spFieldMappingSetId')} = ?)
          ${platformOwned ? '' : 'AND tenant_id = ?'}
        ORDER BY tenant_id, id LIMIT ${limit + 1}`,
      platformOwned ? [setId, setId] : [setId, setId, ownerTenantId]
    );
    const found: MappingSetReference[] = [];
    for (const row of rows) {
      const base = {
        kind: 'federation_trust_source' as const,
        tenantId: row.tenant_id,
        trustSourceId: row.id,
      };
      if (row.idp_set === setId) found.push({ ...base, federationRole: 'saml_idp' });
      if (row.sp_set === setId) found.push({ ...base, federationRole: 'saml_sp' });
    }
    keep(found);
  } catch (error) {
    unscanned.push(failureScope('federation_trust_sources', error));
  }

  // The apps, per tenant, in the tenant's Core database.
  const tenantIds = await tenantsToScan(input, unscanned);
  for (let start = 0; start < tenantIds.length; start += TENANT_SCAN_CONCURRENCY) {
    const chunk = tenantIds.slice(start, start + TENANT_SCAN_CONCURRENCY);
    const scans = await Promise.all(chunk.map((tenantId) => scanTenant(input, tenantId)));
    for (const scan of scans) {
      keep(scan.references);
      if (scan.truncated) truncated = true;
      unscanned.push(...scan.unscanned);
    }
  }

  return { references, truncated, unscanned };
}

/** The tenants whose apps are looked at: the owner of a tenant's set, every tenant for the platform's. */
async function tenantsToScan(
  input: FindMappingSetReferencesInput,
  unscanned: UnscannedMappingSetScope[]
): Promise<string[]> {
  if (input.ownerTenantId !== PLATFORM_MAPPING_TENANT_ID) return [input.ownerTenantId];
  const ids = new Set<string>([input.contextTenantId]);
  if (input.scanOtherTenants === false) {
    unscanned.push({ area: 'other_tenants', reason: 'not_scanned' });
    return [...ids];
  }
  if (!input.listTenantIds) {
    unscanned.push({ area: 'tenant_directory', reason: 'tenant_directory_unavailable' });
    return [...ids];
  }
  const max = input.maxTenants ?? MAPPING_SET_REFERENCE_TENANT_LIMIT;
  try {
    // One more than can be looked at, to tell whether there are more.
    for (const id of await input.listTenantIds(max + 1)) {
      if (id !== PLATFORM_MAPPING_TENANT_ID) ids.add(id);
    }
  } catch (error) {
    unscanned.push(failureScope('tenant_directory', error));
    return [...ids];
  }
  const all = [...ids].sort();
  if (all.length <= max) return all;
  // The context tenant is always among those looked at.
  const kept = [input.contextTenantId, ...all.filter((id) => id !== input.contextTenantId)].slice(
    0,
    max
  );
  unscanned.push({ area: 'tenant_limit', reason: 'tenant_limit_exceeded' });
  return kept;
}

async function scanTenant(
  input: FindMappingSetReferencesInput,
  tenantId: string
): Promise<{
  references: MappingSetReference[];
  truncated: boolean;
  unscanned: UnscannedMappingSetScope[];
}> {
  const references: MappingSetReference[] = [];
  const unscanned: UnscannedMappingSetScope[] = [];
  const limit = MAPPING_SET_REFERENCE_ROW_LIMIT;
  let truncated = false;

  let core: DatabaseAdapter | null = null;
  try {
    core =
      tenantId === input.contextTenantId && input.contextCoreAdapter
        ? input.contextCoreAdapter
        : ((await input.resolveCoreAdapter?.(tenantId)) ?? null);
  } catch {
    core = null;
  }
  if (!core) {
    unscanned.push({ area: 'tenant_clients', tenantId, reason: 'core_database_unavailable' });
    unscanned.push({ area: 'tenant_saml', tenantId, reason: 'core_database_unavailable' });
  } else {
    // json_extract fails the whole query on a value that is not JSON: only a value that is can
    // name a set (the runtime ignores the others), so the rest are not asked.
    try {
      const rows = await core.query<{ client_id: string; pinned: string | null }>(
        `SELECT client_id,
                CASE WHEN json_valid(identity_mapping)
                     THEN json_extract(identity_mapping, '$.fieldMappingVersionId') END AS pinned
           FROM oauth_clients
          WHERE tenant_id = ?
            AND CASE WHEN json_valid(identity_mapping)
                     THEN COALESCE(json_extract(identity_mapping, '$.fieldMappingSetId'),
                                   json_extract(identity_mapping, '$.policySetId')) END = ?
          ORDER BY client_id LIMIT ${limit + 1}`,
        [tenantId, input.setId]
      );
      truncated ||= rows.length > limit;
      for (const row of rows.slice(0, limit)) {
        references.push({
          kind: 'client',
          tenantId,
          clientId: row.client_id,
          ...(typeof row.pinned === 'string' && row.pinned ? { pinnedVersionId: row.pinned } : {}),
        });
      }
    } catch (error) {
      unscanned.push(failureScope('tenant_clients', error, tenantId));
    }
    try {
      const rows = await core.query<{
        id: string;
        provider_type: string;
        pinned: string | null;
        entity_id: string | null;
        policies: string | null;
        descriptors: string | null;
        destination_namespace: string | null;
      }>(
        `SELECT id, provider_type,
                CASE WHEN json_valid(config_json)
                     THEN json_extract(config_json, '$.identityMapping.fieldMappingVersionId') END AS pinned,
                CASE WHEN json_valid(config_json)
                     THEN json_extract(config_json, '$.entityId') END AS entity_id,
                CASE WHEN json_valid(config_json)
                     THEN json_extract(config_json, '$.identityMapping.destinationFieldPolicies') END AS policies,
                CASE WHEN json_valid(config_json)
                     THEN json_extract(config_json, '$.identityMapping.attributeDescriptors') END AS descriptors,
                CASE WHEN json_valid(config_json)
                     THEN json_extract(config_json, '$.identityMapping.destinationNamespace') END AS destination_namespace
           FROM identity_providers
          WHERE tenant_id = ?
            AND CASE WHEN json_valid(config_json)
                     THEN json_extract(config_json, '$.identityMapping.fieldMappingSetId') END = ?
          ORDER BY id LIMIT ${limit + 1}`,
        [tenantId, input.setId]
      );
      truncated ||= rows.length > limit;
      for (const row of rows.slice(0, limit)) {
        const policyKeys = Object.keys(parseJsonObject(row.policies));
        const descriptors = parseJsonObject(row.descriptors);
        references.push({
          kind: 'saml_provider',
          tenantId,
          providerId: row.id,
          providerType: row.provider_type,
          ...(typeof row.entity_id === 'string' && row.entity_id
            ? { entityId: row.entity_id }
            : {}),
          ...(typeof row.pinned === 'string' && row.pinned ? { pinnedVersionId: row.pinned } : {}),
          ...(policyKeys.length > 0 || Object.keys(descriptors).length > 0
            ? {
                swapInputs: {
                  policyKeys,
                  ...(Object.keys(descriptors).length > 0
                    ? {
                        attributeDescriptors: descriptors as NonNullable<
                          MappingSetReferenceSwapInputs['attributeDescriptors']
                        >,
                      }
                    : {}),
                  ...(typeof row.destination_namespace === 'string' && row.destination_namespace
                    ? { destinationNamespace: row.destination_namespace }
                    : {}),
                },
              }
            : {}),
        });
      }
    } catch (error) {
      unscanned.push(failureScope('tenant_saml', error, tenantId));
    }
  }

  // SCIM reads only the tenant's own sets, so only the owner's settings can name this one.
  if (tenantId === input.ownerTenantId && input.ownerTenantId !== PLATFORM_MAPPING_TENANT_ID) {
    if (!input.settingsStore) {
      unscanned.push({ area: 'scim_settings', tenantId, reason: 'settings_store_unavailable' });
    } else {
      try {
        const raw = await input.settingsStore.get(scimSettingsKey(tenantId));
        if (raw) {
          const parsed: unknown = JSON.parse(raw);
          const settings =
            parsed && typeof parsed === 'object' && !Array.isArray(parsed)
              ? (parsed as Record<string, unknown>)
              : {};
          const named =
            typeof settings.mappingSetId === 'string' ? settings.mappingSetId.trim() : '';
          // Settings that are switched off are not read at runtime; switching them on is judged
          // again against the set then.
          if (settings.enabled === true && named === input.setId) {
            references.push({ kind: 'scim', tenantId });
          }
        }
      } catch (error) {
        // A value that is not JSON reads as the defaults (nothing named); anything else is a failure.
        if (!(error instanceof SyntaxError)) {
          unscanned.push(failureScope('scim_settings', error, tenantId));
        }
      }
    }
  }
  return { references, truncated, unscanned };
}

// ---------------------------------------------------------------------------------------------
// What a caller may see
// ---------------------------------------------------------------------------------------------

export interface MappingSetReferenceSummary {
  /** Everything found, other tenants' included. */
  count: number;
  /** True when the count is at least this (a place held more rows than were read). */
  countIsLowerBound: boolean;
  /** The first references the viewer may see in full. */
  items: MappingSetReference[];
  /** True when the viewer may see more references than `items` holds. */
  itemsTruncated: boolean;
  /**
   * The references in other tenants, when the viewer may not see them: how many, in how many
   * tenants. Never their IDs. `scanned` is false when those tenants' Core databases were not read
   * (the viewer has no global authority), so the count holds only what the Admin database knows.
   */
  otherTenants?: { referenceCount: number; tenantCount: number; scanned: boolean };
  /** False when a place could not be looked at (see `unscanned`). */
  scanComplete: boolean;
  unscanned: { count: number; items: UnscannedMappingSetScope[] };
}

export interface SummarizeMappingSetReferencesOptions {
  /** The tenant the viewer is in. Its references, and the platform's, are shown in full. */
  viewerTenantId: string;
  /** Whether the viewer may see other tenants' references (global authority). */
  includeOtherTenants: boolean;
  /** Default 20. */
  itemLimit?: number;
}

const DEFAULT_ITEM_LIMIT = 20;

/**
 * The references as a viewer may see them: their own tenant's (and the platform's own default) in
 * full, up to a limit; other tenants' only as a count unless the viewer has global authority.
 * The places that could not be looked at follow the same rule, so a tenant ID is not given away
 * by being unreachable.
 */
export function summarizeMappingSetReferences(
  scan: MappingSetReferenceScan,
  options: SummarizeMappingSetReferencesOptions
): MappingSetReferenceSummary {
  const itemLimit = options.itemLimit ?? DEFAULT_ITEM_LIMIT;
  const visibleTo = (tenantId: string | undefined) =>
    options.includeOtherTenants || tenantId === undefined || tenantId === options.viewerTenantId;
  // What a provider saved about its profile is for the check of a change, not for showing.
  const visible = scan.references
    .filter((reference) => visibleTo(reference.tenantId))
    .map(({ swapInputs: _swapInputs, ...shown }) => shown);
  const hidden = scan.references.filter((reference) => !visibleTo(reference.tenantId));
  const visibleUnscanned = scan.unscanned.filter((entry) => visibleTo(entry.tenantId));
  const hiddenUnscanned = scan.unscanned.filter((entry) => !visibleTo(entry.tenantId));
  // What is not shown by tenant is shown by kind of place and reason, once each.
  const anonymous = new Map<string, UnscannedMappingSetScope>();
  for (const entry of hiddenUnscanned) {
    anonymous.set(`${entry.area}:${entry.reason}`, { area: entry.area, reason: entry.reason });
  }
  const unscannedItems = [...visibleUnscanned, ...anonymous.values()];
  const otherTenantsNotScanned = scan.unscanned.some((entry) => entry.area === 'other_tenants');
  return {
    count: scan.references.length,
    countIsLowerBound: scan.truncated,
    items: visible.slice(0, itemLimit),
    itemsTruncated: visible.length > itemLimit,
    ...(hidden.length > 0 || otherTenantsNotScanned
      ? {
          otherTenants: {
            referenceCount: hidden.length,
            tenantCount: new Set(hidden.map((reference) => reference.tenantId)).size,
            scanned: !otherTenantsNotScanned,
          },
        }
      : {}),
    // A place cut off at the row limit has not been looked at in full either.
    scanComplete: scan.unscanned.length === 0 && !scan.truncated,
    unscanned: { count: scan.unscanned.length, items: unscannedItems },
  };
}

/**
 * Why the set may not be removed or switched off, or null: it is named somewhere (`referenced`), or
 * it could not be looked for everywhere, which is as bad (`scan_incomplete`).
 */
export function mappingSetReferenceBlock(
  scan: MappingSetReferenceScan
): 'referenced' | 'scan_incomplete' | null {
  if (scan.references.length > 0) return 'referenced';
  return scan.unscanned.length > 0 ? 'scan_incomplete' : null;
}
