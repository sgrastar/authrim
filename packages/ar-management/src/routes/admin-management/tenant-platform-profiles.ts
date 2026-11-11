/**
 * The platform's profiles as a tenant's admin sees and changes them, shared by the tenant routes
 * for method profiles and session profiles.
 *
 * - Listed beside the tenant's own, each with what holds for the tenant: its copy where that
 *   applies, else the platform's values, and why a copy does not apply (locked, or the platform
 *   does not let tenants change its profiles).
 * - Saving one makes or changes the tenant's copy (a full copy of the values it is given), where
 *   the platform lets tenants change its profiles and the profile is not locked. The switch is
 *   read fresh for this: a decision to change is not taken on a cached value.
 * - Deleting one removes the tenant's copy ("back to the platform's"): always allowed.
 * - Creating a profile of the tenant's own needs the platform's leave
 *   (`profiles.<kind>.tenant_create_allowed`); one the tenant has stays usable and editable.
 */
import type { Context } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import {
  NamedProfileRepository,
  PlatformProfileRepository,
  getLogger,
  overrideSetAsideReason,
  readProfileSwitch,
  requireDedicatedAdminDatabaseAdapter,
  type PlatformProfile,
  type PlatformProfileKind,
  type ProfileOverride,
} from '@authrim/ar-lib-core';
import { writeAdminAuditLog } from '../../admin-shared';
import { checkProfileValues, profileValuesError } from './profile-input';

type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

const TENANT_TABLE: Readonly<
  Record<PlatformProfileKind, 'authentication_method_profiles' | 'session_profiles'>
> = {
  method: 'authentication_method_profiles',
  session: 'session_profiles',
};
const AUDIT: Readonly<Record<PlatformProfileKind, { action: string; resource: string }>> = {
  method: { action: 'authentication_method.profile', resource: 'authentication_method_profile' },
  session: { action: 'session.profile', resource: 'session_profile' },
};

const adminAdapter = (c: AdminContext) =>
  requireDedicatedAdminDatabaseAdapter(c.env, 'admin-management');

/** A platform profile as the tenant sees it. */
export function platformEntry(
  platform: PlatformProfile,
  override: ProfileOverride | null,
  changeAllowed: boolean
) {
  const setAside = overrideSetAsideReason(platform, changeAllowed);
  const applies = override !== null && setAside === null;
  return {
    id: platform.id,
    name: platform.name,
    is_system: false,
    scope: 'platform' as const,
    /** What holds for the tenant now. */
    values: applies && override ? override.values : platform.values,
    platform_values: platform.values,
    platform_version: platform.version,
    /** The tenant's copy's version (send it back to change the copy), or null with none. */
    version: override?.version ?? null,
    locked: platform.locked,
    overridden: applies,
    override_inactive: override !== null && !applies,
    override_inactive_reason: override !== null && !applies ? setAside : null,
    /** Whether this tenant may change it now. */
    editable: setAside === null && platform.state === 'active',
    /** The platform changed it since the tenant's copy was made. */
    platform_updated: override !== null && override.baseVersion < platform.version,
    created_by: override?.created_by ?? platform.created_by,
    created_at: override?.created_at ?? platform.created_at,
    updated_at: override?.updated_at ?? platform.updated_at,
  };
}

/** The platform's profiles for the tenant's list. */
export async function listPlatformEntries(
  c: AdminContext,
  kind: PlatformProfileKind,
  tenantId: string
) {
  const adapter = adminAdapter(c);
  const [platforms, overrides, changeAllowed] = await Promise.all([
    new PlatformProfileRepository(adapter, kind).list(),
    new NamedProfileRepository(adapter, TENANT_TABLE[kind]).listOverrides(tenantId),
    readProfileSwitch(c.env, kind, 'tenant_change_allowed'),
  ]);
  const byBase = new Map(overrides.map((override) => [override.baseProfileId, override]));
  return platforms.map((platform) =>
    platformEntry(platform, byBase.get(platform.id) ?? null, changeAllowed)
  );
}

/** One platform profile for the tenant, or null when it is not there. */
export async function getPlatformEntry(
  c: AdminContext,
  kind: PlatformProfileKind,
  tenantId: string,
  id: string
) {
  const adapter = adminAdapter(c);
  const platform = await new PlatformProfileRepository(adapter, kind).find(id);
  // A deleted profile is not shown (Flows that still name it keep reading it).
  if (!platform || platform.state === 'deleted') return null;
  const [override, changeAllowed] = await Promise.all([
    new NamedProfileRepository(adapter, TENANT_TABLE[kind]).findOverride(tenantId, id),
    readProfileSwitch(c.env, kind, 'tenant_change_allowed'),
  ]);
  return platformEntry(platform, override, changeAllowed);
}

/** Whether the tenant may create a profile of its own (read fresh). */
export async function tenantMayCreateProfile(
  c: AdminContext,
  kind: PlatformProfileKind
): Promise<boolean> {
  return readProfileSwitch(c.env, kind, 'tenant_create_allowed', { fresh: true });
}

/** The answer to a create the platform does not allow. */
export const creationNotAllowed = (c: AdminContext) =>
  c.json(
    {
      error: 'profile_creation_not_allowed',
      error_description: 'The platform does not let tenants add profiles of their own',
    },
    403
  );

/**
 * Saves the tenant's copy of a platform profile: `{ values, version }` (`version`: the copy's,
 * or null to make it).
 */
export async function saveTenantOverride(
  c: AdminContext,
  kind: PlatformProfileKind,
  tenantId: string,
  id: string,
  body: Record<string, unknown>
): Promise<Response> {
  const adapter = adminAdapter(c);
  const platform = await new PlatformProfileRepository(adapter, kind).find(id);
  if (!platform || platform.state === 'deleted') {
    return c.json({ error: 'not_found', error_description: 'Profile not found' }, 404);
  }
  const changeAllowed = await readProfileSwitch(c.env, kind, 'tenant_change_allowed', {
    fresh: true,
  });
  const setAside = overrideSetAsideReason(platform, changeAllowed);
  if (setAside !== null || platform.state !== 'active') {
    return c.json(
      {
        error: 'profile_not_editable',
        error_description:
          setAside === 'locked'
            ? 'The platform has locked this profile'
            : setAside === 'changes_not_allowed'
              ? 'The platform does not let tenants change its profiles'
              : 'The platform is deleting this profile',
        reason: setAside ?? 'deleting',
      },
      403
    );
  }
  // The tenant's copy is the tenant's: it may hold what the tenant's own profiles may.
  const check = checkProfileValues(kind, body.values, { platform: false });
  if (!check.ok) return profileValuesError(c, check);
  const version = body.version;
  if (version !== null && (typeof version !== 'number' || !Number.isSafeInteger(version))) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'version must be the copy’s version, or null to make one',
        field: 'version',
      },
      400
    );
  }
  const auth = c.get('adminAuth');
  const result = await new NamedProfileRepository(adapter, TENANT_TABLE[kind]).saveOverride(
    tenantId,
    { id: platform.id, name: platform.name, version: platform.version },
    check.values,
    version,
    auth?.userId ?? null
  );
  if (result.status === 'conflict') {
    return c.json(
      {
        error: 'conflict',
        error_description: 'The profile changed; reload and try again',
        current_version: result.currentVersion,
      },
      409
    );
  }
  await writeAdminAuditLog(c, {
    action: `${AUDIT[kind].action}.${version === null ? 'override_created' : 'override_updated'}`,
    resourceType: AUDIT[kind].resource,
    resourceId: platform.id,
    result: 'success',
    metadata: {
      scope: 'tenant_override',
      platform_profile_id: platform.id,
      platform_version: platform.version,
      base_version: result.override.baseVersion,
      version: result.override.version,
    },
    after: { values: result.override.values },
  });
  return c.json({ profile: platformEntry(platform, result.override, changeAllowed) });
}

/** Removes the tenant's copy of a platform profile (its values hold again). */
export async function deleteTenantOverride(
  c: AdminContext,
  kind: PlatformProfileKind,
  tenantId: string,
  id: string
): Promise<Response> {
  const adapter = adminAdapter(c);
  const platform = await new PlatformProfileRepository(adapter, kind).find(id);
  const repo = new NamedProfileRepository(adapter, TENANT_TABLE[kind]);
  const override = await repo.findOverride(tenantId, id);
  if (!override) {
    return c.json({ error: 'not_found', error_description: 'There is no change to remove' }, 404);
  }
  await repo.deleteOverride(tenantId, id);
  await writeAdminAuditLog(c, {
    action: `${AUDIT[kind].action}.override_removed`,
    resourceType: AUDIT[kind].resource,
    resourceId: id,
    result: 'success',
    metadata: {
      scope: 'tenant_override',
      platform_profile_id: id,
      platform_found: platform !== null,
      base_version: override.baseVersion,
      version: override.version,
    },
    before: { values: override.values },
  });
  if (!platform) return c.body(null, 204);
  const changeAllowed = await readProfileSwitch(c.env, kind, 'tenant_change_allowed').catch(
    (error: unknown) => {
      getLogger(c as unknown as Context<{ Bindings: Env }>)
        .module('PLATFORM-PROFILES')
        .warn('Profile switch unreadable after removing a copy', {
          errorType: error instanceof Error ? error.name : 'Unknown',
        });
      return true;
    }
  );
  return c.json({ profile: platformEntry(platform, null, changeAllowed) });
}
