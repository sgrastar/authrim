import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  RATE_LIMIT_PROFILE_SETTING_NAMES,
  clearRateLimitConfigCache,
  formatRateLimitProfileOverride,
  getProfileOverrideKVKey,
  parseRateLimitProfileOverride,
  readRateLimitProfileConfig,
  type RateLimitConfig,
} from '@authrim/ar-lib-core';

/**
 * Rate limit profile override (formerly under /api/admin/settings/rate-limits)
 *
 * Switches every rate-limited endpoint to one profile for the whole platform, for example
 * loadTest during a load test. It is an operation rather than a setting: a loadTest override
 * always expires (15 minutes unless set, at most an hour), so a run that cannot clean up does not
 * leave the platform's limits raised. The profiles' own limits are Settings API values
 * (`rate_limit.*`, platform).
 *
 * AUTHRIM_CONFIG key: rate_limit_profile_override, with the time the override stops applying (the
 * rate limiter honours it even while the key cannot be read). RATE_LIMIT_PROFILE env applies when
 * no override is set.
 */

const VALID_PROFILES = Object.keys(RATE_LIMIT_PROFILE_SETTING_NAMES) as Array<
  keyof typeof RATE_LIMIT_PROFILE_SETTING_NAMES
>;
type ProfileName = (typeof VALID_PROFILES)[number];
/** RATE_LIMIT_PROFILE, when it names a profile: the override that applies when none is set. */
function envProfileOverride(env: Env): ProfileName | null {
  const value = (env as { RATE_LIMIT_PROFILE?: string }).RATE_LIMIT_PROFILE;
  return value && VALID_PROFILES.includes(value as ProfileName) ? (value as ProfileName) : null;
}

/** A time in milliseconds as Unix seconds (null stays null). */
function unixSeconds(ms: number | null): number | null {
  return ms === null ? null : Math.ceil(ms / 1000);
}

const RATE_LIMIT_REFRESH_NOTE =
  'Changes refresh asynchronously and may take up to a few minutes to apply across active isolates.';

/**
 * GET /api/admin/rate-limits/profile-override
 * Get current global profile override setting
 */
export async function getProfileOverride(c: Context<{ Bindings: Env }>) {
  const kvKey = getProfileOverrideKVKey();
  let stored: ReturnType<typeof parseRateLimitProfileOverride> = null;

  if (c.env.AUTHRIM_CONFIG) {
    try {
      stored = parseRateLimitProfileOverride(await c.env.AUTHRIM_CONFIG.get(kvKey));
    } catch {
      // An override that may be set is never shown as unset.
      return c.json(
        {
          error: 'temporarily_unavailable',
          error_description: 'The rate limit profile override could not be read',
        },
        503
      );
    }
  }

  const envProfile = envProfileOverride(c.env);
  const effective = stored?.profile ?? envProfile;
  return c.json({
    profile_override: stored?.profile ?? null,
    expires_at: unixSeconds(stored?.expiresAt ?? null),
    env_profile_override: envProfile,
    effective_profile_override: effective,
    kv_key: kvKey,
    valid_profiles: VALID_PROFILES,
    note: stored
      ? `All endpoints currently using "${stored.profile}" profile instead of their defaults`
      : envProfile
        ? `No profile override set; RATE_LIMIT_PROFILE makes all endpoints use "${envProfile}".`
        : 'No profile override set. Endpoints use their default profiles.',
  });
}

/**
 * PUT /api/admin/rate-limits/profile-override
 * Set global profile override (switches ALL endpoints to specified profile)
 *
 * This is useful for load testing - set to "loadTest" to bypass strict rate limits
 */
export async function setProfileOverride(c: Context<{ Bindings: Env }>) {
  if (!c.env.AUTHRIM_CONFIG) {
    return c.json(
      {
        error: 'kv_not_configured',
        error_description: 'AUTHRIM_CONFIG KV namespace is not configured',
      },
      500
    );
  }

  const body = await c.req.json<{ profile: string; expires_in?: number }>();
  const { profile } = body;

  if (!profile) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'profile is required',
      },
      400
    );
  }

  if (!VALID_PROFILES.includes(profile as ProfileName)) {
    return c.json(
      {
        error: 'invalid_profile',
        error_description: `Invalid profile name. Valid profiles: ${VALID_PROFILES.join(', ')}`,
      },
      400
    );
  }

  const loadTestExpiresIn =
    profile === 'loadTest' ? (body.expires_in === undefined ? 15 * 60 : body.expires_in) : null;
  if (
    loadTestExpiresIn !== null &&
    (!Number.isSafeInteger(loadTestExpiresIn) || loadTestExpiresIn < 60 || loadTestExpiresIn > 3600)
  ) {
    return c.json(
      {
        error: 'invalid_expiration',
        error_description: 'loadTest expires_in must be an integer between 60 and 3600 seconds',
      },
      400
    );
  }
  if (profile !== 'loadTest' && body.expires_in !== undefined) {
    return c.json(
      {
        error: 'invalid_expiration',
        error_description: 'expires_in is supported only for the loadTest profile',
      },
      400
    );
  }

  const kvKey = getProfileOverrideKVKey();
  // The expiry is stored with the override too, so the rate limiter stops applying it on time
  // even while the key cannot be read.
  const expiresAt = loadTestExpiresIn === null ? null : Date.now() + loadTestExpiresIn * 1000;
  await c.env.AUTHRIM_CONFIG.put(
    kvKey,
    formatRateLimitProfileOverride(profile as ProfileName, expiresAt),
    loadTestExpiresIn === null ? undefined : { expirationTtl: loadTestExpiresIn }
  );

  // Clear cache to apply immediately
  clearRateLimitConfigCache();

  // The profile's limits as the rate limiter resolves them (null when they cannot be read).
  let effectiveConfig: RateLimitConfig | null = null;
  try {
    effectiveConfig = await readRateLimitProfileConfig(c.env, profile as ProfileName);
  } catch {
    effectiveConfig = null;
  }

  return c.json({
    success: true,
    profile_override: profile,
    expires_in: loadTestExpiresIn,
    expires_at: unixSeconds(expiresAt),
    effective_config: effectiveConfig,
    kv_key: kvKey,
    note: `All rate-limited endpoints will use "${profile}" after their runtime caches refresh. ${RATE_LIMIT_REFRESH_NOTE}`,
    warning:
      profile === 'loadTest'
        ? 'Load test profile is active. Remember to clear override after testing!'
        : undefined,
  });
}

/**
 * DELETE /api/admin/rate-limits/profile-override
 * Clear global profile override (endpoints return to their default profiles)
 */
export async function clearProfileOverride(c: Context<{ Bindings: Env }>) {
  if (!c.env.AUTHRIM_CONFIG) {
    return c.json(
      {
        error: 'kv_not_configured',
        error_description: 'AUTHRIM_CONFIG KV namespace is not configured',
      },
      500
    );
  }

  const kvKey = getProfileOverrideKVKey();
  await c.env.AUTHRIM_CONFIG.delete(kvKey);

  // Clear cache
  clearRateLimitConfigCache();

  const envProfile = envProfileOverride(c.env);
  return c.json({
    success: true,
    profile_override: null,
    env_profile_override: envProfile,
    note: envProfile
      ? `Profile override cleared. RATE_LIMIT_PROFILE still makes all endpoints use "${envProfile}". ${RATE_LIMIT_REFRESH_NOTE}`
      : `Profile override cleared. Endpoints now use their default profiles. ${RATE_LIMIT_REFRESH_NOTE}`,
  });
}
