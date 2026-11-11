/**
 * A session profile, as a Flow step names it (`session_profile_ref`): how long a session made by
 * that Flow lasts, whether it can be extended, and whether single sign-on is on. `default` names
 * no profile: the tenant's session settings (and `oauth.sso_enabled`) as they are.
 *
 * A profile holds some of those settings; one it leaves out is the tenant's. Profiles are kept in
 * the admin database (ar-management `session-profiles`).
 */
import type { Env } from '../types/env';
import { resolveNamedProfile } from './platform-profiles';
import { createLogger } from '../utils/logger';
import { readSettingsFlag } from '../utils/tenant-settings';
import {
  readTenantSessionSettings,
  sessionExtensionPolicyFromSettings,
  sessionTtlFromSettings,
  type SessionExtensionPolicy,
  type SessionTtlContext,
  type SessionTtlResolution,
} from './session-ttl';

const log = createLogger().module('SESSION-PROFILE');

/** The session settings a profile may hold. */
export const SESSION_PROFILE_SESSION_KEYS = [
  'session.default_ttl',
  'session.max_ttl',
  'session.ttl.email_code',
  'session.ttl.directory_password',
  'session.ttl.direct_auth',
  'session.ttl.passkey',
  'session.ttl.passkey_registration',
  'session.ttl.guest',
  'session.ttl.did',
  'session.refresh_default',
] as const;
/** Every setting a profile may hold: the session ones, and single sign-on. */
export const SESSION_PROFILE_KEYS = [...SESSION_PROFILE_SESSION_KEYS, 'oauth.sso_enabled'] as const;

/** The profile a step names: none (the tenant's), one found, or one that is not there. */
export type SessionProfileRead =
  | { kind: 'default' }
  | { kind: 'profile'; id: string; values: Record<string, unknown> }
  | { kind: 'missing'; id: string };

export async function readSessionProfile(
  env: Env,
  tenantId: string,
  ref: string | null | undefined
): Promise<SessionProfileRead> {
  if (!ref || ref === 'default') return { kind: 'default' };
  try {
    // The tenant's own profile, or the platform's (its copy where that applies).
    const profile = await resolveNamedProfile(env, tenantId, 'session', ref);
    return profile.kind === 'missing'
      ? { kind: 'missing', id: ref }
      : { kind: 'profile', id: ref, values: profile.values };
  } catch (error) {
    log.error(
      'Failed to read a session profile',
      { action: 'session_profile_read' },
      error instanceof Error ? error : undefined
    );
    return { kind: 'missing', id: ref };
  }
}

/** A profile that cannot be used: no session is made by a Flow whose profile is not there. */
export class SessionProfileUnavailableError extends Error {
  constructor(readonly profileId: string) {
    super('session_profile_unavailable');
    this.name = 'SessionProfileUnavailableError';
  }
}

/**
 * The session settings a session is made with: the tenant's, with the profile's on top. A missing
 * profile is thrown (`SessionProfileUnavailableError`): a Flow set to a shorter session never
 * quietly gives the tenant's longer one.
 */
export function sessionSettingsWithProfile(
  tenantSettings: Record<string, unknown>,
  profile: SessionProfileRead
): Record<string, unknown> {
  if (profile.kind === 'default') return tenantSettings;
  if (profile.kind === 'missing') throw new SessionProfileUnavailableError(profile.id);
  const settings = { ...tenantSettings };
  for (const key of SESSION_PROFILE_SESSION_KEYS) {
    if (profile.values[key] !== undefined) settings[key] = profile.values[key];
  }
  return settings;
}

/**
 * Single sign-on as the profile sets it: true or false, or null where it leaves it to the tenant
 * (Default, or a profile without the setting). A missing profile turns it off.
 */
export function sessionProfileSso(profile: SessionProfileRead): boolean | null {
  if (profile.kind === 'default') return null;
  if (profile.kind === 'missing') return false;
  return readSettingsFlag(profile.values, 'oauth.sso_enabled');
}

/** What a session keeps of its profile, so extending it later follows the same rules. */
export interface SessionProfileSnapshot {
  /** The profile it was made with (absent: Default). */
  session_profile_id?: string;
  session_extension: { enabled: boolean; max_lifetime_ms: number };
}

export interface ProfiledSessionTtl {
  ttl: SessionTtlResolution;
  /** To keep in the session's data (spread into it). */
  snapshot: SessionProfileSnapshot;
}

/**
 * A new session's lifetime and what it keeps of the profile, from the tenant's settings and the
 * profile the Flow names. Throws `SessionProfileUnavailableError` for a missing profile.
 */
export async function resolveProfiledSessionTtl(
  env: Env,
  tenantId: string,
  context: SessionTtlContext,
  profileRef: string | null | undefined
): Promise<ProfiledSessionTtl> {
  const profile = await readSessionProfile(env, tenantId, profileRef);
  const settings = sessionSettingsWithProfile(
    await readTenantSessionSettings(env, tenantId),
    profile
  );
  const extension = sessionExtensionPolicyFromSettings(env, settings);
  return {
    ttl: sessionTtlFromSettings(env, settings, context),
    snapshot: {
      ...(profile.kind === 'profile' ? { session_profile_id: profile.id } : {}),
      session_extension: {
        enabled: extension.enabled,
        max_lifetime_ms: extension.maxLifetimeMs,
      },
    },
  };
}

/**
 * The extension rules a session was made with (kept in its data), or null for a session made
 * before profiles (then the tenant's rules hold).
 */
export function sessionExtensionPolicyOfData(
  data: Record<string, unknown> | undefined
): SessionExtensionPolicy | null {
  const kept = data?.session_extension;
  if (!kept || typeof kept !== 'object' || Array.isArray(kept)) return null;
  const { enabled, max_lifetime_ms: max } = kept as Record<string, unknown>;
  if (typeof enabled !== 'boolean') return null;
  if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0) return null;
  return { enabled, maxLifetimeMs: max };
}
