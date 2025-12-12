import type { Context } from 'hono';
import type { Env } from '@authrim/shared';
import { RateLimitProfiles, clearRateLimitConfigCache } from '@authrim/shared';

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
 * Profiles: strict, moderate, lenient, loadTest
 */

const VALID_PROFILES = ['strict', 'moderate', 'lenient', 'loadTest'] as const;
type ProfileName = (typeof VALID_PROFILES)[number];

/**
 * Get KV keys for a rate limit profile
 */
function getRateLimitKVKeys(profileName: string): {
  maxRequestsKey: string;
  windowSecondsKey: string;
} {
  const normalizedName = profileName
    .toLowerCase()
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase();
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
    cache_ttl_seconds: 10,
    note: 'Changes take effect within 10 seconds (cache TTL)',
  });
}

/**
 * GET /api/admin/settings/rate-limit/:profile
 * Get specific profile configuration
 */
export async function getRateLimitProfile(c: Context<{ Bindings: Env }>) {
  const profileName = c.req.param('profile') as string;

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
  const profileName = c.req.param('profile') as string;

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
    note: 'Changes will take effect within 10 seconds (cache TTL)',
  });
}

/**
 * DELETE /api/admin/settings/rate-limit/:profile
 * Reset profile to default values (remove KV overrides)
 */
export async function resetRateLimitProfile(c: Context<{ Bindings: Env }>) {
  const profileName = c.req.param('profile') as string;

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
    note: 'Profile reset to default values. Changes will take effect within 10 seconds.',
  });
}
