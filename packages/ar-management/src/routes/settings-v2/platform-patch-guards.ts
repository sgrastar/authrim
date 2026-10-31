import type { CategoryName, SettingsPatchRequest } from '@authrim/ar-lib-core';
import { parsePatchRequest } from './settings-support';

const DEFAULT_SET_KEY = 'identity_mapping.oidc_default_set_id';

type PlatformPatchParseResult =
  | { ok: true; body: SettingsPatchRequest; expectedFollowing?: number }
  | { ok: false; message: string };

/** Inspect guard presence and types before the general PATCH parser drops unknown fields. */
export function parsePlatformSettingsPatch(
  rawBody: unknown,
  category: CategoryName
): PlatformPatchParseResult {
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    return { ok: false, message: 'PATCH body must be an object' };
  }
  const raw = rawBody as Record<string, unknown>;
  const hasVersion = Object.hasOwn(raw, 'expected_version');
  const hasFollowing = Object.hasOwn(raw, 'expected_following');
  if ((hasVersion || hasFollowing) && category !== 'identity-mapping') {
    return { ok: false, message: 'Preview guards are only supported for identity-mapping' };
  }
  if (
    hasVersion &&
    (typeof raw.expected_version !== 'string' || raw.expected_version.trim().length === 0)
  ) {
    return { ok: false, message: 'expected_version must be a non-empty string' };
  }
  if (
    hasVersion &&
    Object.hasOwn(raw, 'ifMatch') &&
    (typeof raw.ifMatch !== 'string' || raw.ifMatch !== raw.expected_version)
  ) {
    return { ok: false, message: 'ifMatch and expected_version must be the same string' };
  }
  if (
    hasFollowing &&
    (typeof raw.expected_following !== 'number' ||
      !Number.isSafeInteger(raw.expected_following) ||
      raw.expected_following < 0)
  ) {
    return { ok: false, message: 'expected_following must be a non-negative safe integer' };
  }
  if (hasFollowing) {
    const setsDefault =
      raw.set !== null &&
      typeof raw.set === 'object' &&
      !Array.isArray(raw.set) &&
      Object.hasOwn(raw.set, DEFAULT_SET_KEY);
    const clearsDefault = Array.isArray(raw.clear) && raw.clear.includes(DEFAULT_SET_KEY);
    if (!setsDefault && !clearsDefault) {
      return {
        ok: false,
        message: 'Preview guards require setting or clearing the default Mapping Set',
      };
    }
  }

  const body = parsePatchRequest(raw);
  if (hasVersion) body.ifMatch = raw.expected_version as string;
  return {
    ok: true,
    body,
    ...(hasFollowing ? { expectedFollowing: raw.expected_following as number } : {}),
  };
}
