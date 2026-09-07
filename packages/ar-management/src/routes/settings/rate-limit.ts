import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  RateLimitProfiles,
  clearRateLimitConfigCache,
  getProfileOverrideKVKey,
} from '@authrim/ar-lib-core';

/**
 * Rate Limit Settings API
 *
 * Allows dynamic configuration of rate limiting profiles via KV
 * without requiring redeployment.
 *
 * KV Keys:
 * - rate_limit_{profile}_max_requests - Maximum requests per window
 * - rate_limit_{profile}_window_seconds - Time window in seconds
 *
 * Profiles: strict, moderate, lenient, publicRead, loginStart, sendChallenge, loadTest
 */

const VALID_PROFILES = [
  'strict',
  'moderate',
  'lenient',
  'publicRead',
  'loginStart',
  'sendChallenge',
  'loadTest',
] as const;
type ProfileName = (typeof VALID_PROFILES)[number];
const RATE_LIMIT_REFRESH_NOTE =
  'Changes refresh asynchronously and may take up to a few minutes to apply across active isolates.';
const RATE_LIMIT_PROFILE_KV_NAMES: Record<ProfileName, string> = {
  strict: 'strict',
  moderate: 'moderate',
  lenient: 'lenient',
  publicRead: 'public_read',
  loginStart: 'login_start',
  sendChallenge: 'send_challenge',
  loadTest: 'loadtest',
};

/**
 * Get KV keys for a rate limit profile
 */
function getRateLimitKVKeys(profileName: string): {
  maxRequestsKey: string;
  windowSecondsKey: string;
} {
  const normalizedName =
    RATE_LIMIT_PROFILE_KV_NAMES[profileName as ProfileName] ??
    profileName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return {
    maxRequestsKey: `rate_limit_${normalizedName}_max_requests`,
    windowSecondsKey: `rate_limit_${normalizedName}_window_seconds`,
  };
}

/**
 * GET /api/admin/settings/rate-limit
 * Get all rate limit profile configurations
 */
export async function getRateLimitSettings(c: Context<{ Bindings: Env }>) {
  const profiles: Record<
    string,
    {
      current: { maxRequests: number; windowSeconds: number };
      source: { maxRequests: string; windowSeconds: string };
      default: { maxRequests: number; windowSeconds: number };
      kv_values: { maxRequests: string | null; windowSeconds: string | null };
    }
  > = {};

  for (const profileName of VALID_PROFILES) {
    const defaultConfig = RateLimitProfiles[profileName];
    const { maxRequestsKey, windowSecondsKey } = getRateLimitKVKeys(profileName);

    let kvMaxRequests: string | null = null;
    let kvWindowSeconds: string | null = null;

    if (c.env.AUTHRIM_CONFIG) {
      try {
        [kvMaxRequests, kvWindowSeconds] = await Promise.all([
          c.env.AUTHRIM_CONFIG.get(maxRequestsKey),
          c.env.AUTHRIM_CONFIG.get(windowSecondsKey),
        ]);
      } catch {
        // KV read error - use defaults
      }
    }

    const currentMaxRequests = kvMaxRequests
      ? parseInt(kvMaxRequests, 10)
      : defaultConfig.maxRequests;
    const currentWindowSeconds = kvWindowSeconds
      ? parseInt(kvWindowSeconds, 10)
      : defaultConfig.windowSeconds;

    profiles[profileName] = {
      current: {
        maxRequests: currentMaxRequests,
        windowSeconds: currentWindowSeconds,
      },
      source: {
        maxRequests: kvMaxRequests ? 'kv' : 'default',
        windowSeconds: kvWindowSeconds ? 'kv' : 'default',
      },
      default: {
        maxRequests: defaultConfig.maxRequests,
        windowSeconds: defaultConfig.windowSeconds,
      },
      kv_values: {
        maxRequests: kvMaxRequests,
        windowSeconds: kvWindowSeconds,
      },
    };
  }

  // Get current RATE_LIMIT_PROFILE env setting
  const envProfile = c.env.RATE_LIMIT_PROFILE || null;

  return c.json({
    profiles,
    env_rate_limit_profile: envProfile,
    cache_ttl_seconds: 300,
    note: RATE_LIMIT_REFRESH_NOTE,
  });
}

/**
 * GET /api/admin/settings/rate-limit/:profile
 * Get specific profile configuration
 */
export async function getRateLimitProfile(c: Context<{ Bindings: Env }>) {
  const profileName = c.req.param('profile')! as string;

  if (!VALID_PROFILES.includes(profileName as ProfileName)) {
    return c.json(
      {
        error: 'invalid_profile',
        error_description: `Invalid profile name. Valid profiles: ${VALID_PROFILES.join(', ')}`,
      },
      400
    );
  }

  const defaultConfig = RateLimitProfiles[profileName as ProfileName];
  const { maxRequestsKey, windowSecondsKey } = getRateLimitKVKeys(profileName);

  let kvMaxRequests: string | null = null;
  let kvWindowSeconds: string | null = null;

  if (c.env.AUTHRIM_CONFIG) {
    try {
      [kvMaxRequests, kvWindowSeconds] = await Promise.all([
        c.env.AUTHRIM_CONFIG.get(maxRequestsKey),
        c.env.AUTHRIM_CONFIG.get(windowSecondsKey),
      ]);
    } catch {
      // KV read error - use defaults
    }
  }

  return c.json({
    profile: profileName,
    current: {
      maxRequests: kvMaxRequests ? parseInt(kvMaxRequests, 10) : defaultConfig.maxRequests,
      windowSeconds: kvWindowSeconds ? parseInt(kvWindowSeconds, 10) : defaultConfig.windowSeconds,
    },
    source: {
      maxRequests: kvMaxRequests ? 'kv' : 'default',
      windowSeconds: kvWindowSeconds ? 'kv' : 'default',
    },
    default: {
      maxRequests: defaultConfig.maxRequests,
      windowSeconds: defaultConfig.windowSeconds,
    },
    kv_keys: {
      maxRequests: maxRequestsKey,
      windowSeconds: windowSecondsKey,
    },
  });
}

/**
 * PUT /api/admin/settings/rate-limit/:profile
 * Update rate limit profile configuration
 */
export async function updateRateLimitProfile(c: Context<{ Bindings: Env }>) {
  const profileName = c.req.param('profile')! as string;

  if (!VALID_PROFILES.includes(profileName as ProfileName)) {
    return c.json(
      {
        error: 'invalid_profile',
        error_description: `Invalid profile name. Valid profiles: ${VALID_PROFILES.join(', ')}`,
      },
      400
    );
  }

  if (!c.env.AUTHRIM_CONFIG) {
    return c.json(
      {
        error: 'kv_not_configured',
        error_description: 'AUTHRIM_CONFIG KV namespace is not configured',
      },
      500
    );
  }

  const body = await c.req.json<{
    maxRequests?: number;
    windowSeconds?: number;
  }>();

  const { maxRequests, windowSeconds } = body;

  // Validation
  if (maxRequests !== undefined) {
    if (typeof maxRequests !== 'number' || maxRequests <= 0 || maxRequests > 1000000) {
      return c.json(
        {
          error: 'invalid_max_requests',
          error_description: 'maxRequests must be a number between 1 and 1,000,000',
        },
        400
      );
    }
  }

  if (windowSeconds !== undefined) {
    if (typeof windowSeconds !== 'number' || windowSeconds <= 0 || windowSeconds > 86400) {
      return c.json(
        {
          error: 'invalid_window_seconds',
          error_description: 'windowSeconds must be a number between 1 and 86400 (24 hours)',
        },
        400
      );
    }
  }

  if (maxRequests === undefined && windowSeconds === undefined) {
    return c.json(
      {
        error: 'no_changes',
        error_description: 'At least one of maxRequests or windowSeconds must be provided',
      },
      400
    );
  }

  const { maxRequestsKey, windowSecondsKey } = getRateLimitKVKeys(profileName);

  // Store in KV
  const updates: string[] = [];

  if (maxRequests !== undefined) {
    await c.env.AUTHRIM_CONFIG.put(maxRequestsKey, maxRequests.toString());
    updates.push(`maxRequests: ${maxRequests}`);
  }

  if (windowSeconds !== undefined) {
    await c.env.AUTHRIM_CONFIG.put(windowSecondsKey, windowSeconds.toString());
    updates.push(`windowSeconds: ${windowSeconds}`);
  }

  // Clear cache to apply immediately (within next request)
  clearRateLimitConfigCache();

  return c.json({
    success: true,
    profile: profileName,
    updated: {
      maxRequests: maxRequests ?? null,
      windowSeconds: windowSeconds ?? null,
    },
    kv_keys: {
      maxRequests: maxRequestsKey,
      windowSeconds: windowSecondsKey,
    },
    note: RATE_LIMIT_REFRESH_NOTE,
  });
}

/**
 * DELETE /api/admin/settings/rate-limit/:profile
 * Reset profile to default values (remove KV overrides)
 */
export async function resetRateLimitProfile(c: Context<{ Bindings: Env }>) {
  const profileName = c.req.param('profile')! as string;

  if (!VALID_PROFILES.includes(profileName as ProfileName)) {
    return c.json(
      {
        error: 'invalid_profile',
        error_description: `Invalid profile name. Valid profiles: ${VALID_PROFILES.join(', ')}`,
      },
      400
    );
  }

  if (!c.env.AUTHRIM_CONFIG) {
    return c.json(
      {
        error: 'kv_not_configured',
        error_description: 'AUTHRIM_CONFIG KV namespace is not configured',
      },
      500
    );
  }

  const { maxRequestsKey, windowSecondsKey } = getRateLimitKVKeys(profileName);

  // Delete KV keys
  await Promise.all([
    c.env.AUTHRIM_CONFIG.delete(maxRequestsKey),
    c.env.AUTHRIM_CONFIG.delete(windowSecondsKey),
  ]);

  // Clear cache
  clearRateLimitConfigCache();

  const defaultConfig = RateLimitProfiles[profileName as ProfileName];

  return c.json({
    success: true,
    profile: profileName,
    reset_to_default: {
      maxRequests: defaultConfig.maxRequests,
      windowSeconds: defaultConfig.windowSeconds,
    },
    note: `Profile reset to default values. ${RATE_LIMIT_REFRESH_NOTE}`,
  });
}

/**
 * GET /api/admin/settings/rate-limit/profile-override
 * Get current global profile override setting
 */
export async function getProfileOverride(c: Context<{ Bindings: Env }>) {
  const kvKey = getProfileOverrideKVKey();
  let currentOverride: string | null = null;

  if (c.env.AUTHRIM_CONFIG) {
    try {
      currentOverride = await c.env.AUTHRIM_CONFIG.get(kvKey);
    } catch {
      // KV read error
    }
  }

  return c.json({
    profile_override: currentOverride,
    kv_key: kvKey,
    valid_profiles: VALID_PROFILES,
    note: currentOverride
      ? `All endpoints currently using "${currentOverride}" profile instead of their defaults`
      : 'No profile override set. Endpoints use their default profiles.',
  });
}

/**
 * PUT /api/admin/settings/rate-limit/profile-override
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
  await c.env.AUTHRIM_CONFIG.put(
    kvKey,
    profile,
    loadTestExpiresIn === null ? undefined : { expirationTtl: loadTestExpiresIn }
  );

  // Clear cache to apply immediately
  clearRateLimitConfigCache();

  const profileConfig = RateLimitProfiles[profile as ProfileName];

  return c.json({
    success: true,
    profile_override: profile,
    expires_in: loadTestExpiresIn,
    effective_config: {
      maxRequests: profileConfig.maxRequests,
      windowSeconds: profileConfig.windowSeconds,
    },
    kv_key: kvKey,
    note: `All rate-limited endpoints will use "${profile}" after their runtime caches refresh. ${RATE_LIMIT_REFRESH_NOTE}`,
    warning:
      profile === 'loadTest'
        ? 'Load test profile is active. Remember to clear override after testing!'
        : undefined,
  });
}

/**
 * DELETE /api/admin/settings/rate-limit/profile-override
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

  return c.json({
    success: true,
    profile_override: null,
    note: `Profile override cleared. Endpoints now use their default profiles. ${RATE_LIMIT_REFRESH_NOTE}`,
  });
}
