/**
 * The Check API's platform switches, shared by the check and subscribe routes.
 */

import {
  createLogger,
  resolvePlatformSettingsWithSources,
  type Env as SharedEnv,
} from '@authrim/ar-lib-core';

const log = createLogger().module('CHECK-API');

/** Default batch size limit (secure default: not too large to prevent DoS) */
export const DEFAULT_BATCH_SIZE_LIMIT = 100;

interface CheckSettingsEnv extends SharedEnv {
  /** Batch size limit for batch check API (1-1000, default: 100) */
  CHECK_API_BATCH_SIZE_LIMIT?: string;
}

/** A batch size limit as the Check API applies it: a whole number in 1..1000, else unset. */
function batchSizeLimitOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 1000
    ? value
    : undefined;
}

/** The batch size from env alone (CHECK_API_BATCH_SIZE_LIMIT), else the default. */
function envBatchSizeLimit(env: CheckSettingsEnv): number {
  const batch = env.CHECK_API_BATCH_SIZE_LIMIT
    ? batchSizeLimitOf(parseInt(env.CHECK_API_BATCH_SIZE_LIMIT, 10))
    : undefined;
  return batch ?? DEFAULT_BATCH_SIZE_LIMIT;
}

/**
 * Whether the Check API is on, and the most checks in one batch, for the whole platform: the
 * Settings API values (`feature.enable_check_api`, `limits.check_api_batch_size`), else env,
 * else off and 100. When the switch cannot be read the Check API is off (env does not turn on what
 * a saved value may have turned off); a batch size that cannot be read is env's, else 100.
 */
export async function readCheckApiSettings(
  env: CheckSettingsEnv
): Promise<{ enabled: boolean; batchSizeLimit: number }> {
  // Each read apart, as before: one that fails leaves the other's value in effect.
  const [flags, limits] = await Promise.allSettled([
    resolvePlatformSettingsWithSources(env, 'feature-flags', {}),
    resolvePlatformSettingsWithSources(env, 'limits', {}),
  ]);
  for (const result of [flags, limits]) {
    if (result.status === 'rejected') {
      log.error(
        'Failed to read Check API settings',
        { error: String(result.reason) },
        result.reason as Error
      );
    }
  }
  return {
    enabled:
      flags.status === 'fulfilled'
        ? flags.value.values['feature.enable_check_api'] === true
        : false,
    batchSizeLimit:
      limits.status === 'fulfilled'
        ? (batchSizeLimitOf(limits.value.values['limits.check_api_batch_size']) ??
          DEFAULT_BATCH_SIZE_LIMIT)
        : envBatchSizeLimit(env),
  };
}

/** Whether the Check API is on (see readCheckApiSettings). */
export async function isCheckApiEnabled(env: CheckSettingsEnv): Promise<boolean> {
  return (await readCheckApiSettings(env)).enabled;
}

/** The most checks in one batch request (see readCheckApiSettings). */
export async function getBatchSizeLimit(env: CheckSettingsEnv): Promise<number> {
  return (await readCheckApiSettings(env)).batchSizeLimit;
}
