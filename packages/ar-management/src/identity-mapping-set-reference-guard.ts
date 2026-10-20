/**
 * The check the Mapping Set operations make before they remove or switch off something that other
 * settings name (a default, an app, a credential profile): the shared reference search
 * (`findMappingSetReferences`) wired to this request's databases, and the refusal it produces.
 *
 * The refusal is a 409 `conflict` carrying `references`, in the form of the persistent identifier
 * profiles' (persistent-identifier-profiles.ts) with the count and the first few references. What
 * of another tenant's references the caller sees is decided here, once: only a caller with global
 * authority is given their tenant and app IDs; the others are given how many.
 */
import type { Context } from 'hono';
import {
  createAuthContextFromHono,
  ensureDatabaseAdapter,
  findMappingSetReferences,
  findMappingVersionSwapViolation,
  getTenantIdFromContext,
  hasGlobalAdminPermission,
  mappingSetReferenceBlock,
  PLATFORM_MAPPING_TENANT_ID,
  requireDedicatedAdminDatabaseAdapter,
  resolveAuthCorePersistenceAdapterFromEnv,
  summarizeMappingSetReferences,
  type AdminAuthContext,
  type DatabaseAdapter,
  type Env,
  type MappingSetReference,
  type MappingSetReferencePurpose,
  type MappingSetReferenceScan,
  type MappingSetReferenceSummary,
} from '@authrim/ar-lib-core';

type AdminContext = Context<{ Bindings: Env }>;

const PARTITION = 'identity-mapping-set-references';

/** A refusal: the message, and the fields to add to the 409 body. */
export interface MappingSetConflict {
  message: string;
  extra: {
    reason: 'referenced' | 'scan_incomplete' | 'would_break_references';
    references: MappingSetReferenceSummary & { violation?: { code: string; message: string } };
  };
}

/**
 * Whether the caller may see other tenants' references in full: a global tenant scope and the
 * wildcard held through a global assignment. (`roles` and `permissions` add up what is held for
 * one tenant only, so they say nothing about other tenants.)
 */
export function canSeeOtherTenantReferences(c: AdminContext): boolean {
  const auth = (c as unknown as { get(key: string): unknown }).get('adminAuth') as
    | AdminAuthContext
    | undefined;
  return hasGlobalAdminPermission(auth, '*');
}

/** The search, wired to this request: its Core database, tenant routing and the settings store. */
export async function scanMappingSetReferences(
  c: AdminContext,
  input: {
    setId: string;
    ownerTenantId: string;
    purpose: MappingSetReferencePurpose;
    /** For a platform set: read the other tenants' Core databases too (default yes). */
    scanOtherTenants?: boolean;
  }
): Promise<MappingSetReferenceScan> {
  const contextTenantId = getTenantIdFromContext(c);
  let contextCoreAdapter: DatabaseAdapter | null = null;
  try {
    contextCoreAdapter = createAuthContextFromHono(c, contextTenantId).coreAdapter;
  } catch {
    // Left null: the search reports the tenant's apps as not looked at.
  }
  const requestCache = new Map();
  return findMappingSetReferences({
    adminAdapter: requireDedicatedAdminDatabaseAdapter(c.env, PARTITION),
    setId: input.setId,
    ownerTenantId: input.ownerTenantId,
    contextTenantId,
    contextCoreAdapter,
    resolveCoreAdapter: (tenantId) =>
      resolveAuthCorePersistenceAdapterFromEnv(c.env, PARTITION, { tenantId, requestCache }),
    listTenantIds: async (limit) => {
      if (!c.env.DB) throw new Error('database_not_configured');
      // A tenant whose deletion is complete has no database left to read. One that is being
      // deleted or only suspended still has, so it stays.
      const rows = await ensureDatabaseAdapter(c.env.DB, PARTITION).query<{ id: string }>(
        "SELECT id FROM tenants WHERE lifecycle_state <> 'deleted' ORDER BY id LIMIT ?",
        [limit]
      );
      return rows.map((row) => row.id);
    },
    scanOtherTenants: input.scanOtherTenants,
    settingsStore: c.env.SETTINGS ?? null,
    purpose: input.purpose,
  });
}

/** The search result as the caller of this request may see it. */
export function summarizeForRequest(
  c: AdminContext,
  scan: MappingSetReferenceScan
): MappingSetReferenceSummary {
  return summarizeMappingSetReferences(scan, {
    viewerTenantId: getTenantIdFromContext(c),
    includeOtherTenants: canSeeOtherTenantReferences(c),
  });
}

function conflictFor(
  c: AdminContext,
  scan: MappingSetReferenceScan,
  subject: string,
  action: string
): MappingSetConflict | null {
  const block = mappingSetReferenceBlock(scan);
  if (!block) return null;
  return {
    message:
      block === 'referenced'
        ? `${subject} is in use and cannot be ${action}; remove the references first`
        : `${subject} cannot be ${action}: where it is used could not be checked everywhere`,
    extra: { reason: block, references: summarizeForRequest(c, scan) },
  };
}

/** Removing or switching off a set (or its active version): refused while anything names it. */
export async function checkMappingSetUnreferenced(
  c: AdminContext,
  input: {
    setId: string;
    ownerTenantId: string;
    action: 'deleted' | 'deactivated';
  }
): Promise<MappingSetConflict | null> {
  const scan = await scanMappingSetReferences(c, {
    setId: input.setId,
    ownerTenantId: input.ownerTenantId,
    purpose: input.action === 'deleted' ? 'delete' : 'change',
  });
  return conflictFor(c, scan, 'Mapping Set', input.action);
}

/** Deactivating a version only matters when it is the one in use. */
export async function checkMappingVersionDeactivation(
  c: AdminContext,
  input: { setId: string; ownerTenantId: string; versionId: string }
): Promise<MappingSetConflict | null> {
  const admin = requireDedicatedAdminDatabaseAdapter(c.env, PARTITION);
  const active = await admin.queryOne<{ id: string }>(
    `SELECT id FROM field_mapping_activations
      WHERE tenant_id = ? AND field_mapping_set_id = ? AND field_mapping_version_id = ?
        AND lifecycle_state = 'active' LIMIT 1`,
    [input.ownerTenantId, input.setId, input.versionId]
  );
  if (!active) return null;
  return checkMappingSetUnreferenced(c, {
    setId: input.setId,
    ownerTenantId: input.ownerTenantId,
    action: 'deactivated',
  });
}

interface SnapshotRow {
  catalog_version_id: string | null;
  snapshot_hash: string | null;
  lifecycle_state: string;
}

/**
 * Putting another version or another activation in use (activating one while the set has an active
 * one, or rolling back): refused when something names the set and what would be in use does not
 * meet what that needs (see `findMappingVersionSwapViolation`). With nothing naming the set, or
 * nothing in use to replace, it is allowed.
 */
export async function checkMappingVersionSwap(
  c: AdminContext,
  input:
    | {
        mode: 'activate';
        setId: string;
        ownerTenantId: string;
        versionId: string;
        snapshotId: string;
        activationScope: unknown;
      }
    | { mode: 'rollback'; setId: string; ownerTenantId: string }
): Promise<MappingSetConflict | null> {
  const admin = requireDedicatedAdminDatabaseAdapter(c.env, PARTITION);
  const { setId, ownerTenantId } = input;
  const inUse = await admin.queryOne<{ field_mapping_version_id: string }>(
    `SELECT field_mapping_version_id FROM field_mapping_activations
      WHERE tenant_id = ? AND field_mapping_set_id = ? AND lifecycle_state = 'active' LIMIT 1`,
    [ownerTenantId, setId]
  );
  // Nothing in use: whatever names the set is already failing, and this is what repairs it.
  if (!inUse) return null;

  let versionId: string;
  let activationScope: unknown;
  let snapshot: {
    catalogVersionId: string | null;
    willBeActive: boolean;
    snapshotHash: string | null;
  };
  if (input.mode === 'activate') {
    versionId = input.versionId;
    const row = await admin.queryOne<SnapshotRow>(
      `SELECT catalog_version_id, snapshot_hash, lifecycle_state FROM compiled_mapping_snapshots
        WHERE tenant_id = ? AND field_mapping_version_id = ? AND id = ?`,
      [ownerTenantId, versionId, input.snapshotId]
    );
    // The operation answers a missing snapshot itself.
    if (!row) return null;
    // The version and snapshot already in use: nothing changes.
    if (inUse.field_mapping_version_id === versionId && row.lifecycle_state === 'active') {
      return null;
    }
    snapshot = {
      catalogVersionId: row.catalog_version_id,
      willBeActive: true,
      snapshotHash: row.snapshot_hash,
    };
    // A platform set is always written with an empty scope; a tenant's is what the caller sends.
    activationScope =
      ownerTenantId === PLATFORM_MAPPING_TENANT_ID ? undefined : (input.activationScope ?? {});
  } else {
    const previous = await admin.queryOne<{
      field_mapping_version_id: string;
      activation_scope_json: string | null;
    }>(
      `SELECT field_mapping_version_id, activation_scope_json FROM field_mapping_activations
        WHERE tenant_id = ? AND field_mapping_set_id = ? AND lifecycle_state = 'retired'
        ORDER BY active_from DESC, activated_at DESC LIMIT 1`,
      [ownerTenantId, setId]
    );
    // The operation answers that there is nothing to roll back to.
    if (!previous) return null;
    versionId = previous.field_mapping_version_id;
    // A rollback re-activates the earlier activation, with the scope it had, and leaves the
    // snapshots as they are.
    activationScope =
      ownerTenantId === PLATFORM_MAPPING_TENANT_ID
        ? undefined
        : (previous.activation_scope_json ?? '{}');
    const row = await admin.queryOne<SnapshotRow>(
      `SELECT catalog_version_id, snapshot_hash, lifecycle_state FROM compiled_mapping_snapshots
        WHERE tenant_id = ? AND field_mapping_version_id = ?
        ORDER BY (lifecycle_state = 'active') DESC, compiled_at DESC LIMIT 1`,
      [ownerTenantId, versionId]
    );
    snapshot = {
      catalogVersionId: row?.catalog_version_id ?? null,
      willBeActive: row?.lifecycle_state === 'active',
      snapshotHash: row?.snapshot_hash ?? null,
    };
  }

  const scan = await scanMappingSetReferences(c, { setId, ownerTenantId, purpose: 'change' });
  if (!mappingSetReferenceBlock(scan)) return null;

  const violation = await findMappingVersionSwapViolation({
    adapter: admin,
    ownerTenantId,
    contextTenantId: getTenantIdFromContext(c),
    versionId,
    snapshot,
    activationScope,
    references: scan.references,
  });
  if (!violation) {
    // The version is fine for what was found; what could not be looked at may need more. A place
    // cut off at the row limit has references that were not checked either: every one of them has
    // to be, so that is as incomplete as a place that could not be read.
    if (scan.unscanned.length === 0 && !scan.truncated) return null;
    return {
      message:
        'The Mapping Set cannot be changed: where it is used could not be checked everywhere',
      extra: { reason: 'scan_incomplete', references: summarizeForRequest(c, scan) },
    };
  }
  return {
    message: `The Mapping Set is in use and this version would break it: ${violation.message}`,
    extra: {
      reason: 'would_break_references',
      references: { ...summarizeForRequest(c, scan), violation },
    },
  };
}

/**
 * Deleting a Destination Profile: refused while a Mapping Set that releases into it (in its active
 * version) is in use. Returns the sets the references are through, with the references.
 */
export async function checkDestinationProfileUnreferenced(
  c: AdminContext,
  input: { profileId: string; allowPlatformScope: boolean }
): Promise<MappingSetConflict | null> {
  const contextTenantId = getTenantIdFromContext(c);
  const admin = requireDedicatedAdminDatabaseAdapter(c.env, PARTITION);
  const profile = await admin.queryOne<{ tenant_id: string }>(
    `SELECT tenant_id FROM destination_profiles
      WHERE id = ? AND (tenant_id = ? OR (? = 1 AND tenant_id = ?))`,
    [input.profileId, contextTenantId, input.allowPlatformScope ? 1 : 0, PLATFORM_MAPPING_TENANT_ID]
  );
  // The operation answers a profile that is not there.
  if (!profile) return null;

  // The sets whose active version releases into the profile, under either spelling of its ID. A
  // tenant's profile is only used by that tenant's sets; the platform's by any tenant's.
  const platformOwned = profile.tenant_id === PLATFORM_MAPPING_TENANT_ID;
  const spellings = [input.profileId, `destination-profile-${input.profileId}`];
  const ref = (column: string) =>
    `CASE WHEN json_valid(e.target_ref_json) THEN json_extract(e.target_ref_json, '${column}') END`;
  const setLimit = 100;
  // In use means an active activation with an active compiled snapshot: the version row's own
  // state can say `published` while its activation is live (publishing an active version).
  const sets = await admin.query<{ set_id: string; owner: string }>(
    `SELECT DISTINCT s.id AS set_id, s.tenant_id AS owner
       FROM field_mapping_activations a
       JOIN field_mapping_sets s ON s.tenant_id = a.tenant_id AND s.id = a.field_mapping_set_id
       JOIN mapping_rules r
         ON r.tenant_id = a.tenant_id AND r.field_mapping_version_id = a.field_mapping_version_id
       JOIN mapping_rule_edges e ON e.tenant_id = r.tenant_id AND e.rule_id = r.id
      WHERE a.lifecycle_state = 'active'
        AND EXISTS (
          SELECT 1 FROM compiled_mapping_snapshots n
           WHERE n.tenant_id = a.tenant_id
             AND n.field_mapping_version_id = a.field_mapping_version_id
             AND n.lifecycle_state = 'active'
        )
        ${platformOwned ? '' : 'AND a.tenant_id = ?'}
        AND (${ref('$.profileId')} IN (?, ?) OR ${ref('$.profile_id')} IN (?, ?))
      ORDER BY s.id LIMIT ${setLimit + 1}`,
    platformOwned ? [...spellings, ...spellings] : [profile.tenant_id, ...spellings, ...spellings]
  );

  const references: MappingSetReference[] = [];
  const unscanned: MappingSetReferenceScan['unscanned'] = [];
  let truncated = sets.length > setLimit;
  if (truncated) unscanned.push({ area: 'tenant_limit', reason: 'set_limit_exceeded' });
  for (const set of sets.slice(0, setLimit)) {
    const scan = await scanMappingSetReferences(c, {
      setId: set.set_id,
      ownerTenantId: set.owner,
      purpose: 'change',
    });
    truncated ||= scan.truncated;
    references.push(...scan.references.map((r) => ({ ...r, viaMappingSetId: set.set_id })));
    unscanned.push(...scan.unscanned);
  }
  return conflictFor(c, { references, truncated, unscanned }, 'Destination Profile', 'deleted');
}
