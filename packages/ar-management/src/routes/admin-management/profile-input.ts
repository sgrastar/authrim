/**
 * What a method or session profile may hold, and the check of a profile's name and values: one
 * rule for a tenant's own profiles, its copies of the platform's, and the platform's own.
 *
 * The platform's profiles hold only settings that mean the same in every tenant (which methods,
 * how long sessions last, single sign-on). A setting that names something of one tenant (an
 * external provider, the Human Verification provider and its use) is left out: handed to every
 * tenant, it would name what most of them do not have.
 */
import type { Context } from 'hono';
import {
  ALL_CATEGORY_META,
  AUTHENTICATION_METHODS_SETTINGS_META,
  SESSION_PROFILE_KEYS,
  validateSettingValue,
  type PlatformProfileKind,
} from '@authrim/ar-lib-core';
import { AUTHENTICATION_METHOD_PROFILE_KEYS } from './authentication-method-profiles';

const NAME_MAX = 80;
const VALUES_MAX_BYTES = 64 * 1024;

/** Method profile settings that name something of one tenant (left out of the platform's). */
export const TENANT_SPECIFIC_METHOD_PROFILE_KEYS: ReadonlySet<string> = new Set([
  'authentication-methods.human_verification.provider',
  'authentication-methods.human_verification.signup_enabled',
  'authentication-methods.human_verification.login_enabled',
  'authentication-methods.human_verification.reauth_enabled',
  'authentication-methods.external_provider_usage',
]);

/** The settings a profile of the kind may hold (`platform`: one of the platform's own). */
export function profileKeys(kind: PlatformProfileKind, platform: boolean): ReadonlySet<string> {
  if (kind === 'session') return new Set<string>(SESSION_PROFILE_KEYS);
  return new Set(
    AUTHENTICATION_METHOD_PROFILE_KEYS.filter(
      (key) => !platform || !TENANT_SPECIFIC_METHOD_PROFILE_KEYS.has(key)
    )
  );
}

type SettingMetaArg = Parameters<typeof validateSettingValue>[2];

function metaOf(kind: PlatformProfileKind, key: string): SettingMetaArg {
  if (kind === 'method') {
    return AUTHENTICATION_METHODS_SETTINGS_META[
      key as keyof typeof AUTHENTICATION_METHODS_SETTINGS_META
    ];
  }
  const category = key.startsWith('oauth.') ? 'oauth' : 'session';
  return (ALL_CATEGORY_META[category].settings as Record<string, unknown>)[key] as SettingMetaArg;
}

export type ProfileValuesCheck =
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; field: string; reason: string; rejected?: Record<string, string> };

/** Checks a profile's values: known settings of the kind, each a valid value, not too large. */
export function checkProfileValues(
  kind: PlatformProfileKind,
  values: unknown,
  options: { platform: boolean }
): ProfileValuesCheck {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    return { ok: false, field: 'values', reason: 'values must be an object' };
  }
  const allowed = profileKeys(kind, options.platform);
  const rejected: Record<string, string> = {};
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    if (!allowed.has(key)) {
      rejected[key] =
        options.platform && TENANT_SPECIFIC_METHOD_PROFILE_KEYS.has(key)
          ? 'A platform profile cannot hold a setting that names something of one tenant'
          : 'Not a setting of this profile';
      continue;
    }
    const validation = validateSettingValue(key, value, metaOf(kind, key));
    if (!validation.valid) rejected[key] = validation.errors[0]?.reason ?? 'Invalid value';
  }
  if (Object.keys(rejected).length) {
    return {
      ok: false,
      field: 'values',
      reason: 'Some profile values are invalid',
      rejected,
    };
  }
  if (new TextEncoder().encode(JSON.stringify(values)).length > VALUES_MAX_BYTES) {
    return { ok: false, field: 'values', reason: 'values are too large' };
  }
  return { ok: true, values: values as Record<string, unknown> };
}

/** A profile's name: 1 to 80 characters once trimmed, else null. */
export function profileName(value: unknown): string | null {
  const name = typeof value === 'string' ? value.trim() : '';
  return name && name.length <= NAME_MAX ? name : null;
}

/** The 400 answer of a failed check. */
export function profileValuesError(c: Context, check: Extract<ProfileValuesCheck, { ok: false }>) {
  return c.json(
    {
      error: 'invalid_request',
      error_description: check.reason,
      field: check.field,
      ...(check.rejected ? { rejected: check.rejected } : {}),
    },
    400
  );
}
