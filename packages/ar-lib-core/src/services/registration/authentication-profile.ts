/**
 * An authentication method profile, as a Flow step names it (`authentication_profile_ref`): the
 * methods the step offers are the tenant's, narrowed by the profile. A method the tenant has
 * turned off is never offered, whatever the profile says; one the profile turns off is not
 * offered at that step. `default` names no profile: the tenant's methods as they are.
 *
 * Profiles are kept in the admin database (ar-management `authentication-method-profiles`), with
 * the same keys as the tenant's `authentication-methods` settings: the tenant's own, or the
 * platform's (services/platform-profiles.ts).
 */
import type { Env } from '../../types/env';
import { resolveNamedProfile } from '../platform-profiles';
import { createLogger } from '../../utils/logger';

const log = createLogger().module('AUTH-METHOD-PROFILE');

/** The profile a step names: none (the tenant's methods), one found, or one that is not there. */
export type AuthenticationProfileRead =
  | { kind: 'default' }
  | { kind: 'profile'; values: Record<string, unknown> }
  | { kind: 'missing' };

export async function readAuthenticationProfile(
  env: Env,
  tenantId: string,
  ref: string | null | undefined
): Promise<AuthenticationProfileRead> {
  if (!ref || ref === 'default') return { kind: 'default' };
  try {
    // The tenant's own profile, or the platform's (its copy where that applies).
    const profile = await resolveNamedProfile(env, tenantId, 'method', ref);
    return profile.kind === 'missing'
      ? { kind: 'missing' }
      : { kind: 'profile', values: profile.values };
  } catch (error) {
    log.error(
      'Failed to read an authentication method profile',
      { action: 'auth_method_profile_read' },
      error instanceof Error ? error : undefined
    );
    // Unread, it narrows nothing it can be trusted to: the step offers no method (below).
    return { kind: 'missing' };
  }
}

/** The method a step's output handle stands for (`mail_otp`, `passkey`… or a provider's id). */
const METHOD_OF_HANDLE: Record<string, string> = {
  mail_otp: 'email_otp',
  passkey: 'passkey',
  totp: 'totp',
};

/**
 * A method or provider name as a Flow step's handle: lower case, runs of other characters as one
 * `_`, none at either end. Linear in the length (no backtracking regular expression on it).
 */
export function normalizeMethodHandle(value: string): string {
  const joined = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_');
  let start = 0;
  let end = joined.length;
  while (start < end && joined[start] === '_') start++;
  while (end > start && joined[end - 1] === '_') end--;
  return joined.slice(start, end) || 'method';
}

function providerUsageOf(value: unknown): Array<Record<string, unknown>> {
  let list: unknown = value;
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(list)
    ? list.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === 'object' && !Array.isArray(item)
      )
    : [];
}

/**
 * Whether the profile lets a step offer a method for its use. A missing profile (deleted since
 * the Flow was published, or unread) offers none: a step never offers more than it was set to.
 */
export function profileAllowsHandle(
  profile: AuthenticationProfileRead,
  handle: string,
  usage: 'login' | 'signup' | 'reauth'
): boolean {
  if (profile.kind === 'default') return true;
  if (profile.kind === 'missing') return false;
  const values = profile.values;
  const off = (key: string) => values[key] === false;
  const method = METHOD_OF_HANDLE[handle];
  if (method) return !off(`authentication-methods.${method}.${usage}_enabled`);
  if (handle === 'directory_password')
    return !off('authentication-methods.directory_password.enabled');
  if (handle === 'guest') return !off('authentication-methods.guest.login_enabled');
  if (handle === 'did')
    return usage !== 'signup' && !off('authentication-methods.did.login_enabled');
  // An external provider: as the profile's own provider list has it, when it lists the provider.
  const providers = providerUsageOf(values['authentication-methods.external_provider_usage']);
  const listed = providers.find((provider) => {
    const id =
      typeof provider.id === 'string'
        ? provider.id
        : typeof provider.providerId === 'string'
          ? provider.providerId
          : '';
    return id && normalizeMethodHandle(id) === handle;
  });
  if (!listed) return true;
  const enabled = listed.enabled !== false;
  const usageKey = usage === 'reauth' ? 'loginEnabled' : `${usage}Enabled`;
  return enabled && listed[usageKey] !== false;
}

/** The handles a step offers, narrowed by its profile. */
export function narrowHandlesByProfile(
  handles: readonly string[],
  profile: AuthenticationProfileRead,
  usage: 'login' | 'signup' | 'reauth'
): string[] {
  return handles.filter((handle) => profileAllowsHandle(profile, handle, usage));
}
