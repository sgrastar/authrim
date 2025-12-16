/**
 * Region Shards Admin API
 *
 * Manages region sharding configuration for Durable Objects.
 * Supports dynamic shard count and region distribution changes via generation-based approach.
 *
 * Endpoints:
 * - GET /api/admin/settings/region-shards: Get current configuration
 * - PUT /api/admin/settings/region-shards: Update configuration (increments generation)
 * - DELETE /api/admin/settings/region-shards: Delete configuration (reset to default)
 */

import type { Context } from 'hono';
import {
  type RegionShardConfig,
  getRegionShardConfig,
  saveRegionShardConfig,
  deleteRegionShardConfig,
  validateRegionShardRequest,
  calculateRegionRanges,
  createNewRegionGeneration,
  DEFAULT_TENANT_ID,
  DEFAULT_TOTAL_SHARDS,
  DEFAULT_REGION_DISTRIBUTION,
} from '@authrim/shared';

/**
 * Request body for PUT /api/admin/settings/region-shards
 */
interface UpdateRegionShardsRequest {
  /** Total number of shards */
  totalShards: number;
  /** Region distribution percentages (must sum to 100) */
  regionDistribution: Record<string, number>;
}

/**
 * GET /api/admin/settings/region-shards
 *
 * Get current region sharding configuration.
 *
 * Response:
 * - currentGeneration: Current generation number
 * - currentTotalShards: Current total shard count
 * - currentRegions: Current region distribution with shard ranges
 * - previousGenerations: Array of previous generation configs
 * - updatedAt: Last update timestamp
 */
export async function getRegionShards(c: Context) {
  const config = await getRegionShardConfig(c.env, DEFAULT_TENANT_ID);

  return c.json({
    currentGeneration: config.currentGeneration,
    currentTotalShards: config.currentTotalShards,
    currentRegions: config.currentRegions,
    previousGenerations: config.previousGenerations,
    maxPreviousGenerations: config.maxPreviousGenerations,
    updatedAt: config.updatedAt,
    updatedBy: config.updatedBy,
  });
}

/**
 * PUT /api/admin/settings/region-shards
 *
 * Update region sharding configuration.
 *
 * If totalShards or regionDistribution changes from current config,
 * a new generation is created and the old config is preserved in previousGenerations.
 *
 * Request Body:
 * - totalShards: number (required, >= active region count)
 * - regionDistribution: Record<string, number> (required, must sum to 100)
 *
 * Validation Rules:
 * - regionDistribution must sum to 100
 * - totalShards must be >= number of active regions (percentage > 0)
 * - Each region with percentage > 0 must get at least 1 shard
 * - Regions with 0% are allowed (disabled regions)
 */
export async function updateRegionShards(c: Context) {
  let body: UpdateRegionShardsRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  // Basic field validation
  if (typeof body.totalShards !== 'number' || body.totalShards <= 0) {
    return c.json({ error: 'totalShards must be a positive number' }, 400);
  }

  if (!body.regionDistribution || typeof body.regionDistribution !== 'object') {
    return c.json({ error: 'regionDistribution is required and must be an object' }, 400);
  }

  // Validate region distribution
  const validation = validateRegionShardRequest(body);
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400);
  }

  // Get current config
  const currentConfig = await getRegionShardConfig(c.env, DEFAULT_TENANT_ID);

  // Calculate new region ranges
  const newRegions = calculateRegionRanges(body.totalShards, body.regionDistribution);

  // Check if config actually changed
  const configChanged =
    body.totalShards !== currentConfig.currentTotalShards ||
    JSON.stringify(newRegions) !== JSON.stringify(currentConfig.currentRegions);

  let newConfig: RegionShardConfig;

  if (configChanged) {
    // Create new generation
    newConfig = createNewRegionGeneration(currentConfig, body.totalShards, newRegions, 'admin-api');
  } else {
    // No change, just update timestamp
    newConfig = {
      ...currentConfig,
      updatedAt: Date.now(),
      updatedBy: 'admin-api',
    };
  }

  // Save to KV
  await saveRegionShardConfig(c.env, DEFAULT_TENANT_ID, newConfig);

  return c.json({
    success: true,
    generationIncremented: configChanged,
    currentGeneration: newConfig.currentGeneration,
    currentTotalShards: newConfig.currentTotalShards,
    currentRegions: newConfig.currentRegions,
    previousGenerationsCount: newConfig.previousGenerations.length,
    updatedAt: newConfig.updatedAt,
    note: configChanged
      ? 'New generation created. Existing resources will continue to use old config until they expire.'
      : 'Configuration unchanged, only timestamp updated.',
  });
}

/**
 * DELETE /api/admin/settings/region-shards
 *
 * Delete region sharding configuration (reset to default).
 *
 * This removes the KV entry, causing the system to use default values.
 * Note: This does NOT affect existing resources with embedded generation/region info.
 */
export async function deleteRegionShards(c: Context) {
  await deleteRegionShardConfig(c.env, DEFAULT_TENANT_ID);

  // Return default config info
  const defaultRegions = calculateRegionRanges(DEFAULT_TOTAL_SHARDS, DEFAULT_REGION_DISTRIBUTION);

  return c.json({
    success: true,
    message: 'Region shard configuration deleted. System will use defaults.',
    defaults: {
      totalShards: DEFAULT_TOTAL_SHARDS,
      regionDistribution: DEFAULT_REGION_DISTRIBUTION,
      regions: defaultRegions,
    },
    note: 'Existing resources with embedded generation/region info will continue to work.',
  });
}
