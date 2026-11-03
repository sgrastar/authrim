import type { Env } from '../types';
import {
  getRegionShardConfig,
  isConfiguredRegionShard,
  type RegionShardConfigV2,
  type ShardResolution,
} from '@authrim/ar-lib-core';

/** The tenant's shard configuration could not be read: the ID can be neither accepted nor refused. */
export class ShardConfigUnavailableError extends Error {
  constructor(cause: unknown) {
    super('region_shard_config_unavailable', { cause });
    this.name = 'ShardConfigUnavailableError';
  }
}

/** How often an ID of a newer generation may make an isolate re-read a tenant's configuration. */
const GENERATION_REFRESH_INTERVAL_MS = 5_000;
const lastGenerationRefreshAt = new Map<string, number>();
/** A re-read in flight, shared by the checks of newer-generation IDs only. */
const refreshesInFlight = new Map<string, Promise<RegionShardConfigV2>>();

async function loadConfig(
  env: Env,
  tenantId: string,
  bypassCache = false
): Promise<RegionShardConfigV2> {
  try {
    return await getRegionShardConfig(
      { AUTHRIM_CONFIG: env.AUTHRIM_CONFIG } as Parameters<typeof getRegionShardConfig>[0],
      tenantId,
      { bypassCache }
    );
  } catch (error) {
    throw new ShardConfigUnavailableError(error);
  }
}

/**
 * Whether the shard named by an ID from a request is one the tenant's config places resources
 * in. Checked before the store is called: a forged ID must not create Durable Objects.
 *
 * An ID of a generation newer than this isolate's cached configuration re-reads it (at most every
 * few seconds per tenant); while it cannot be confirmed the check throws
 * `ShardConfigUnavailableError` rather than refusing an ID another isolate just issued. The re-read
 * replaces the cached configuration without emptying it, and only newer-generation IDs wait for
 * it, so an unverified ID cannot slow down or fail the checks of other IDs.
 */
export async function isConfiguredShard(
  env: Env,
  tenantId: string,
  resolution: ShardResolution
): Promise<boolean> {
  const config = await loadConfig(env, tenantId);
  if (isConfiguredRegionShard(config, resolution)) return true;
  if (resolution.generation <= config.currentGeneration) return false;

  let refresh = refreshesInFlight.get(tenantId);
  if (!refresh) {
    const now = Date.now();
    if (now - (lastGenerationRefreshAt.get(tenantId) ?? 0) < GENERATION_REFRESH_INTERVAL_MS) {
      throw new ShardConfigUnavailableError('region_shard_generation_unconfirmed');
    }
    lastGenerationRefreshAt.set(tenantId, now);
    refresh = loadConfig(env, tenantId, true).finally(() => refreshesInFlight.delete(tenantId));
    refreshesInFlight.set(tenantId, refresh);
  }
  const refreshed = await refresh;
  if (isConfiguredRegionShard(refreshed, resolution)) return true;
  if (resolution.generation <= refreshed.currentGeneration) return false;
  // Still ahead of the stored configuration: forged, or a write not yet visible here.
  throw new ShardConfigUnavailableError('region_shard_generation_unconfirmed');
}

/** For tests: forget the refresh times. */
export function resetConfiguredShardRefreshes(): void {
  lastGenerationRefreshAt.clear();
  refreshesInFlight.clear();
}
