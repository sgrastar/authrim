/**
 * The authentication method and session profiles a tenant can name: its own, and the platform's
 * (admin migration 015). One place decides what a named profile holds for a tenant, for every
 * reader (the runtime, publishing checks, the Admin API).
 *
 * A platform profile is named by its own id (`pmp_…`, `psp_…`), never by the id of a tenant's
 * copy of it. What it holds for the tenant:
 * - the tenant's copy (`base_profile_id` = the platform id) while the platform lets tenants change
 *   its profiles (`profiles.<kind>.tenant_change_allowed`) and the profile is not locked;
 * - the platform's own values otherwise (a copy set aside this way is kept, not deleted, and
 *   applies again once allowed);
 * - nothing (missing) when the platform profile is not there, whatever copy is left (a copy
 *   carried into an environment without its platform profile does not outlive it).
 * A tenant's own profile (no base) holds its own values.
 */
import type { Env } from '../types/env';
import { NamedProfileRepository } from '../repositories/admin/authentication-method-profile';
import {
  PlatformProfileRepository,
  isPlatformProfileId,
  type PlatformProfile,
  type PlatformProfileKind,
} from '../repositories/admin/platform-profile';
import type { ProfileOverride } from '../repositories/admin/authentication-method-profile';
import { requireDedicatedAdminDatabaseAdapter } from './admin-database-adapter';
import { resolvePlatformSettingsWithSources } from './effective-settings';
import { PROFILES_DEFAULTS } from '../types/settings/profiles';

const TENANT_TABLE: Readonly<
  Record<PlatformProfileKind, 'authentication_method_profiles' | 'session_profiles'>
> = {
  method: 'authentication_method_profiles',
  session: 'session_profiles',
};

export type ProfileSwitchName = 'tenant_change_allowed' | 'tenant_create_allowed';

/**
 * A platform switch for a kind of profile (KV, else the environment, else allowed). A read that
 * fails is thrown: what a profile holds is not guessed at.
 */
export async function readProfileSwitch(
  env: Env,
  kind: PlatformProfileKind,
  name: ProfileSwitchName,
  options: { fresh?: boolean } = {}
): Promise<boolean> {
  const key = `profiles.${kind}.${name}` as keyof typeof PROFILES_DEFAULTS;
  const { values } = await resolvePlatformSettingsWithSources(env, 'profiles', {
    fresh: options.fresh === true,
  });
  const value = values[key];
  return typeof value === 'boolean' ? value : PROFILES_DEFAULTS[key];
}

/** What a profile a tenant names holds for it (see the file comment). */
export type NamedProfileResolution =
  | {
      kind: 'tenant';
      id: string;
      values: Record<string, unknown>;
    }
  | {
      kind: 'platform';
      id: string;
      values: Record<string, unknown>;
      platform: PlatformProfile;
      /** The tenant's copy, whether or not it applies. */
      override: ProfileOverride | null;
      /** Whether the copy is what applies (it is there, changes are allowed, not locked). */
      overrideApplies: boolean;
    }
  | { kind: 'missing'; id: string };

/** Why a tenant's copy of a platform profile does not apply now (null: it applies, or none). */
export function overrideSetAsideReason(
  platform: PlatformProfile,
  changeAllowed: boolean
): 'locked' | 'changes_not_allowed' | null {
  if (platform.locked) return 'locked';
  if (!changeAllowed) return 'changes_not_allowed';
  return null;
}

export async function resolveNamedProfile(
  env: Env,
  tenantId: string,
  kind: PlatformProfileKind,
  ref: string,
  options: { fresh?: boolean } = {}
): Promise<NamedProfileResolution> {
  const adapter = requireDedicatedAdminDatabaseAdapter(env, `${kind}-profile`);
  const tenantRepo = new NamedProfileRepository(adapter, TENANT_TABLE[kind]);
  if (!isPlatformProfileId(kind, ref)) {
    const own = await tenantRepo.find(tenantId, ref);
    return own ? { kind: 'tenant', id: ref, values: own.values } : { kind: 'missing', id: ref };
  }
  const platform = await new PlatformProfileRepository(adapter, kind).find(ref);
  if (!platform) return { kind: 'missing', id: ref };
  const override = await tenantRepo.findOverride(tenantId, ref);
  // The switch is read only when there is a copy it could set aside.
  const overrideApplies =
    override !== null &&
    overrideSetAsideReason(
      platform,
      await readProfileSwitch(env, kind, 'tenant_change_allowed', options)
    ) === null;
  return {
    kind: 'platform',
    id: ref,
    values: overrideApplies ? override.values : platform.values,
    platform,
    override,
    overrideApplies,
  };
}
