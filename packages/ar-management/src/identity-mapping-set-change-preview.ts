/**
 * POST /api/admin/identity-mapping/sets/{id}/preview-change[?tenant_id=]
 *
 * What a change of a Mapping Set's content would do, before it is saved: the claims it adds,
 * removes, renames, or fills from other attributes, through other steps or with another type, and
 * for each app that uses the set (by its own choice, through the tenant's default or through the
 * platform's) the changes that app would see with the scopes it is registered for, and those its
 * scopes hold back. Nothing is written.
 *
 * The draft is checked as a save checks it (`validateContent`); one a save would refuse gets the
 * save's 400. Which apps use the set is decided by the runtime's selection
 * (`selectIdentityMapping` for the tenant, `readClientIdentityMappingChoice` for each app), and
 * whether a claim reaches an app by the release's own judgement of the Destination Profile's
 * scopes (`isOidcFieldApplicableToScopes`). `references` is counted as the PUT counts it, so the
 * count sent back as `confirm_impact` is the one the save expects.
 *
 * A tenant's set is the tenant's to look at. A set the platform owns reaches every tenant, so it
 * needs the platform's authority: without `tenant_id` the answer counts, tenant by tenant, the
 * apps that use it and those that would see a change (at most `TENANTS_SUMMARY_LIMIT` tenants);
 * with `tenant_id` it lists that tenant's apps.
 *
 * `sample` (a test user's values before and after) needs the draft compiled, which a preview does
 * not do yet: it is always null, with `sample_unavailable: "draft_not_compiled"` when asked for.
 */
import {
  ADMIN_PERMISSIONS,
  createAuthContextFromHono,
  ensureAdminDatabaseAdapter,
  ensureDatabaseAdapter,
  getTenantIdFromContext,
  hasGlobalAdminPermission,
  IdentityMappingSelectionError,
  isOidcFieldApplicableToScopes,
  loadDestinationProfileConsentDescriptor,
  PLATFORM_MAPPING_TENANT_ID,
  readClientIdentityMappingChoice,
  resolveAuthCorePersistenceAdapterFromEnv,
  resolveOidcFieldRequiredScopes,
  selectIdentityMapping,
  type AdminAuthContext,
  type DatabaseAdapter,
  type DestinationProfileConsentField,
  type IdentityMappingTier,
  type TenantDatabaseRequestCache,
} from '@authrim/ar-lib-core';
import {
  claimShapes,
  contentProfile,
  diffClaimShapes,
  readCatalogTypes,
  releasePoints,
  type ClaimChange,
  type ReleasePoint,
} from './identity-mapping-content-diff';
import {
  badRequest,
  controlPlaneErrorResponse,
  createRepository,
  forbidden,
  notFound,
  resolveFieldMappingSetOwner,
  type AdminContext,
} from './identity-mapping-control-plane';
import {
  readCurrentContent,
  readSaveBody,
  referenceCount,
  requestAuthorId,
  validateContent,
  validSetId,
} from './identity-mapping-set-facade';
import { parseMappingSetContent } from './identity-mapping-set-facade-content';
import {
  scanMappingSetReferences,
  summarizeForRequest,
} from './identity-mapping-set-reference-guard';
import { hasPlatformIdentityMappingRead } from './identity-mapping-tenants';
import { mapWithConcurrency } from './map-with-concurrency';
import { getSingleTenantId, isSingleTenantMode } from './single-tenant-guard';

const PARTITION = 'identity-mapping-set-change-preview';
/** The most apps listed for one tenant. */
export const APPS_LIMIT = 200;
/** The most apps of a tenant read to decide which use the set. */
const APP_ROWS_LIMIT = 2000;
/** The most tenants a platform set's summary looks at. */
export const TENANTS_SUMMARY_LIMIT = 100;
const TENANT_CONCURRENCY = 4;
const TENANT_ID_PATTERN = /^[a-z0-9-]{1,63}$/;
/** The namespace the runtime releases an app's claims from, unless its own choice names another. */
const RELEASE_NAMESPACE = 'oidc.claim';

interface AppLine {
  tenant_id: string;
  client_id: string;
  name: string;
  /** Why the app uses the set: its own choice, the tenant's default or the platform's. */
  tier: IdentityMappingTier;
  /** The changes the app would see, given the scopes it is registered for. */
  changes: ClaimChange[];
  /** The changes its scopes hold back, by the scope that would release each. */
  held_back: Array<{ claim: string; scope: string | null }>;
}

type TenantApps =
  | {
      ok: true;
      apps: AppLine[];
      truncated: boolean;
      /** The defaults could not be read: the apps that follow them are not among `apps`. */
      defaultsUnreadable: boolean;
    }
  | { ok: false; reason: 'core_database_unavailable' | 'query_failed' };

/** The scopes an app is registered for, with `openid`. */
function registeredScopes(raw: string | null): Set<string> {
  const scopes = new Set((raw ?? '').split(/\s+/).filter((scope) => scope.length > 0));
  scopes.add('openid');
  return scopes;
}

type ProfileFields = Map<string, Map<string, DestinationProfileConsentField[]>>;

/** The OIDC fields of each Destination Profile named, by claim. */
async function readProfileFields(
  admin: DatabaseAdapter,
  ownerTenantId: string,
  profileIds: ReadonlyArray<string | null | undefined>
): Promise<ProfileFields> {
  const profiles: ProfileFields = new Map();
  for (const profileId of new Set(
    profileIds.filter((id): id is string => typeof id === 'string')
  )) {
    const descriptor = await loadDestinationProfileConsentDescriptor(
      admin,
      ownerTenantId,
      profileId
    );
    const byClaim = new Map<string, DestinationProfileConsentField[]>();
    for (const field of descriptor?.destinationType === 'oidc' ? descriptor.fields : []) {
      byClaim.set(field.key, [...(byClaim.get(field.key) ?? []), field]);
    }
    profiles.set(profileId, byClaim);
  }
  return profiles;
}

/**
 * When the set's one profile is switched for another, the claims the profiles list differently:
 * a claim is released only if the profile lists it, the standard claims the scopes bring too, so
 * one the old profile let through and the new one does not (or the other way round, or with other
 * scopes, surfaces or accepted values) changes for an app even though no edge writes it. A claim
 * the mapping also changes keeps both: an app that does not release the mapping's namespace still
 * sees what the profile does to its standard claim.
 */
function profileFieldChanges(
  profiles: ProfileFields,
  before: string | null,
  after: string | null
): ClaimChange[] {
  if (!before || !after || before === after) return [];
  const was = profiles.get(before) ?? new Map();
  const now = profiles.get(after) ?? new Map();
  const describe = (fields: DestinationProfileConsentField[] | undefined) =>
    JSON.stringify(
      // Everything the release judges a field by: when it is in play, and what it accepts.
      (fields ?? []).map((field) => ({
        scopes: resolveOidcFieldRequiredScopes(field),
        surfaces: [...field.surfaces].sort(),
        required: field.required,
        nullable: field.nullable,
        valueType: field.valueType,
        valueMultiplicity: field.valueMultiplicity,
        allowedValues: [...field.allowedValues].sort(),
      }))
    );
  const fieldChanges: ClaimChange[] = [];
  for (const claim of [...new Set([...was.keys(), ...now.keys()])].sort()) {
    if (claim === 'sub') continue;
    const base = {
      claim,
      namespace: RELEASE_NAMESPACE,
      profile_id: after,
      previous_profile_id: before,
    };
    if (!was.has(claim)) fieldChanges.push({ kind: 'profile_field_added', ...base });
    else if (!now.has(claim)) fieldChanges.push({ kind: 'profile_field_removed', ...base });
    else if (describe(was.get(claim)) !== describe(now.get(claim))) {
      fieldChanges.push({ kind: 'profile_field_changed', ...base });
    }
  }
  return fieldChanges;
}

/** Splits the set's changes into what an app with these scopes sees and what they hold back. */
function changesFor(
  changes: readonly ClaimChange[],
  profiles: ProfileFields,
  scopes: ReadonlySet<string>,
  /** The namespace the app's claims are released from (the runtime releases only that one). */
  releaseNamespace: string
): Pick<AppLine, 'changes' | 'held_back'> {
  const seen: ClaimChange[] = [];
  const heldBack: AppLine['held_back'] = [];
  for (const change of changes) {
    // A change reaches the app when the claim reached it before, or reaches it after: a rename
    // into a claim its scopes do not release still takes away the claim it had.
    const points = releasePoints(change);
    // A profile's own field is in play whatever the mapping writes (the standard claims pass the
    // profile too); a claim the mapping writes is released only from the app's namespace.
    const anyNamespace = change.kind.startsWith('profile_field_');
    const fieldsAt = (point: ReleasePoint | null) =>
      point?.profileId && (anyNamespace || point.namespace === releaseNamespace)
        ? (profiles.get(point.profileId)?.get(point.claim) ?? [])
        : [];
    const reaches = (fields: DestinationProfileConsentField[]) =>
      fields.some((field) => isOidcFieldApplicableToScopes(field, scopes));
    const before = fieldsAt(points.before);
    const after = fieldsAt(points.after);
    if (reaches(before) || reaches(after)) {
      seen.push(change);
      continue;
    }
    // A claim the profile does not list is never released: no app sees it either way.
    const listed = after.length > 0 ? after : before;
    heldBack.push({
      claim: change.claim,
      scope: listed.length > 0 ? (resolveOidcFieldRequiredScopes(listed[0])[0] ?? null) : null,
    });
  }
  return { changes: seen, held_back: heldBack };
}

/** The apps of one tenant that use the set, and what each would see. */
async function tenantApps(
  c: AdminContext,
  tenantId: string,
  setId: string,
  changes: readonly ClaimChange[],
  profiles: ProfileFields,
  requestCache: TenantDatabaseRequestCache
): Promise<TenantApps> {
  // Which level gives an app that names no set this set, as the runtime selects it.
  let defaultTier: IdentityMappingTier | null = null;
  let defaultsUnreadable = false;
  try {
    const selection = await selectIdentityMapping({
      env: c.env,
      tenantId,
      protocol: 'oidc',
      clientSelector: null,
      fresh: true,
    });
    if (selection.kind === 'bound' && selection.setId === setId) defaultTier = selection.tier;
  } catch (error) {
    // A default that is not a choice binds no app to this set. Unreadable settings say nothing of
    // the apps that follow the defaults; an app's own choice is still its own.
    if (!(error instanceof IdentityMappingSelectionError)) throw error;
    if (error.code === 'settings_unreadable') defaultsUnreadable = true;
  }

  let core: DatabaseAdapter;
  try {
    core =
      tenantId === getTenantIdFromContext(c)
        ? createAuthContextFromHono(c, tenantId).coreAdapter
        : await resolveAuthCorePersistenceAdapterFromEnv(c.env, PARTITION, {
            tenantId,
            requestCache,
            sideEffects: 'none',
          });
  } catch {
    return { ok: false, reason: 'core_database_unavailable' };
  }
  let rows: Array<{
    client_id: string;
    client_name: string | null;
    scope: string | null;
    identity_mapping: string | null;
  }>;
  try {
    rows = await core.query(
      `SELECT client_id, client_name, scope, identity_mapping
         FROM oauth_clients
        WHERE tenant_id = ?
        ORDER BY client_id
        LIMIT ?`,
      [tenantId, APP_ROWS_LIMIT + 1]
    );
  } catch {
    return { ok: false, reason: 'query_failed' };
  }
  const apps: AppLine[] = [];
  for (const row of rows.slice(0, APP_ROWS_LIMIT)) {
    const choice = readClientIdentityMappingChoice(row.identity_mapping);
    const tier: IdentityMappingTier | null =
      choice.kind === 'set' ? (choice.setId === setId ? 'client' : null) : null;
    const used = tier ?? (choice.kind === 'unset' ? defaultTier : null);
    if (!used) continue;
    // An app's own choice may name the namespace its claims come from.
    const releaseNamespace =
      (choice.kind === 'set' ? choice.selector.destinationNamespace : undefined) ??
      RELEASE_NAMESPACE;
    apps.push({
      tenant_id: tenantId,
      client_id: row.client_id,
      name: row.client_name ?? row.client_id,
      tier: used,
      ...changesFor(changes, profiles, registeredScopes(row.scope), releaseNamespace),
    });
  }
  return { ok: true, apps, truncated: rows.length > APP_ROWS_LIMIT, defaultsUnreadable };
}

async function listTenantIds(c: AdminContext, limit: number): Promise<string[]> {
  const directory = ensureDatabaseAdapter(c.env.DB, PARTITION);
  if (!directory) throw new Error('tenant_directory_unavailable');
  if (isSingleTenantMode(c.env)) return [getSingleTenantId(c.env)];
  const rows = await directory.query<{ id: string }>(
    "SELECT id FROM tenants WHERE lifecycle_state <> 'deleted' ORDER BY id LIMIT ?",
    [limit]
  );
  return rows.map((row) => row.id);
}

async function tenantExists(c: AdminContext, tenantId: string): Promise<boolean> {
  if (isSingleTenantMode(c.env)) return tenantId === getSingleTenantId(c.env);
  const directory = ensureDatabaseAdapter(c.env.DB, PARTITION);
  if (!directory) throw new Error('tenant_directory_unavailable');
  const row = await directory.queryOne<{ id: string }>(
    "SELECT id FROM tenants WHERE id = ? AND lifecycle_state <> 'deleted'",
    [tenantId]
  );
  return row !== null;
}

export async function adminIdentityMappingSetChangePreviewHandler(c: AdminContext) {
  try {
    const setId = validSetId(c);
    const repository = createRepository(c);
    const contextTenantId = getTenantIdFromContext(c);
    const ownerTenantId = await resolveFieldMappingSetOwner(
      c,
      repository,
      contextTenantId,
      setId,
      'read'
    );
    const platformSet = ownerTenantId === PLATFORM_MAPPING_TENANT_ID;
    // A platform set reaches every tenant: what it would do is for the platform's authority.
    const adminAuth = (c as unknown as { get(key: string): AdminAuthContext | undefined }).get(
      'adminAuth'
    );
    // It lists other tenants' apps, so the apps' read for every tenant too.
    if (
      platformSet &&
      !(
        hasPlatformIdentityMappingRead(adminAuth) &&
        hasGlobalAdminPermission(adminAuth, ADMIN_PERMISSIONS.CLIENTS_READ)
      )
    ) {
      throw forbidden('A change of a platform set is previewed with the platform authority');
    }
    const tenantParam = c.req.query('tenant_id');
    if (tenantParam !== undefined && (!platformSet || !TENANT_ID_PATTERN.test(tenantParam))) {
      throw badRequest('tenant_id is for a platform set, and must be a tenant ID');
    }

    const state = await repository.findFieldMappingSetState(ownerTenantId, setId);
    if (!state) throw notFound('field mapping set not found');
    const body = await readSaveBody(c);
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== 'content' && key !== 'sample')
    ) {
      throw badRequest('The body is { content, sample? }');
    }
    const { content: rawContent, sample: rawSample } = body as Record<string, unknown>;
    if (
      rawSample !== undefined &&
      (typeof rawSample !== 'object' ||
        rawSample === null ||
        typeof (rawSample as Record<string, unknown>).test_user_id !== 'string')
    ) {
      throw badRequest('sample must be { test_user_id }');
    }
    const draft = parseMappingSetContent(rawContent);
    // The save's own checks: a draft a save would refuse is refused the same way.
    await validateContent(repository, ownerTenantId, draft, requestAuthorId(c));

    const admin = ensureAdminDatabaseAdapter(c.env, PARTITION);
    if (!admin) throw new Error('admin_database_unavailable');
    const current = await readCurrentContent(repository, ownerTenantId, state);
    const [typesBefore, typesAfter] = await Promise.all([
      readCatalogTypes(admin, ownerTenantId, current?.catalogVersionId ?? null),
      readCatalogTypes(admin, ownerTenantId, draft.catalogVersionId),
    ]);
    const shapesBefore = current ? claimShapes(current, typesBefore) : new Map();
    const shapesAfter = claimShapes(draft, typesAfter);
    const claimChanges = diffClaimShapes(shapesBefore, shapesAfter);
    const profileBefore = contentProfile(shapesBefore);
    const profileAfter = contentProfile(shapesAfter);
    const profiles = await readProfileFields(admin, ownerTenantId, [
      profileBefore,
      profileAfter,
      ...claimChanges.flatMap((change) => [change.profile_id, change.previous_profile_id]),
    ]);
    const changes = [
      ...claimChanges,
      ...profileFieldChanges(profiles, profileBefore, profileAfter),
    ].sort((a, b) => a.claim.localeCompare(b.claim) || a.kind.localeCompare(b.kind));

    // Counted as the save counts it (other tenants too, for a platform set: the count a save
    // asks to confirm is the whole one, so it is counted even for one tenant's apps), and without
    // a trace: a preview reports a tenant it cannot route, it does not repair it.
    const summary = summarizeForRequest(
      c,
      await scanMappingSetReferences(c, {
        setId,
        ownerTenantId,
        purpose: 'change',
        sideEffects: 'none',
      })
    );

    const requestCache: TenantDatabaseRequestCache = new Map();
    const sampleUnavailable =
      rawSample !== undefined ? { sample_unavailable: 'draft_not_compiled' as const } : {};
    const base = {
      setId,
      owner: platformSet ? ('platform' as const) : ('tenant' as const),
      changes,
      references: referenceCount(summary),
      usage_complete: summary.scanComplete,
    };

    if (platformSet && tenantParam === undefined) {
      const tenantIds = await listTenantIds(c, TENANTS_SUMMARY_LIMIT + 1);
      const page = tenantIds.slice(0, TENANTS_SUMMARY_LIMIT);
      const tenants = await mapWithConcurrency(page, TENANT_CONCURRENCY, async (tenantId) => {
        const result = await tenantApps(c, tenantId, setId, changes, profiles, requestCache);
        return result.ok
          ? {
              tenant_id: tenantId,
              apps_using: result.apps.length,
              apps_changed: result.apps.filter((app) => app.changes.length > 0).length,
              ...(result.truncated || result.defaultsUnreadable
                ? { apps_count_is_lower_bound: true }
                : {}),
              ...(result.defaultsUnreadable ? { unavailable: 'settings_unreadable' as const } : {}),
            }
          : {
              tenant_id: tenantId,
              apps_using: null,
              apps_changed: null,
              unavailable: result.reason,
            };
      });
      return c.json({
        ...base,
        // A tenant none of whose apps use the set is left out; one whose apps were not all read
        // is kept, as its count is only a lower bound.
        tenants: tenants.filter(
          (row) => row.apps_using !== 0 || 'apps_count_is_lower_bound' in row
        ),
        tenants_truncated: tenantIds.length > TENANTS_SUMMARY_LIMIT,
        apps: [],
        apps_truncated: false,
        sample: null,
        ...sampleUnavailable,
      });
    }

    const tenantId = tenantParam ?? ownerTenantId;
    if (tenantParam !== undefined && !(await tenantExists(c, tenantParam))) {
      throw notFound('tenant not found');
    }
    const result = await tenantApps(c, tenantId, setId, changes, profiles, requestCache);
    if (!result.ok) {
      return c.json(
        {
          error: 'temporarily_unavailable',
          error_description: 'The apps of the tenant cannot be read right now',
          reason: result.reason,
        },
        503
      );
    }
    return c.json({
      ...base,
      apps: result.apps.slice(0, APPS_LIMIT),
      apps_truncated: result.truncated || result.apps.length > APPS_LIMIT,
      // The apps that follow the defaults are not listed when the defaults cannot be read.
      ...(result.defaultsUnreadable
        ? { defaults_unavailable: 'settings_unreadable' as const }
        : {}),
      sample: null,
      ...sampleUnavailable,
    });
  } catch (error) {
    return controlPlaneErrorResponse(c, error);
  }
}
