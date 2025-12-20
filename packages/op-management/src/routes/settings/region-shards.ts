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
 * - POST /api/admin/settings/region-shards/migrate: Force generation increment
 * - GET /api/admin/settings/region-shards/validate: Validate colocation groups
 */

import type { Context } from 'hono';
import {
  type RegionShardConfig,
  type RegionShardConfigV2,
  type ColocationGroup,
  getRegionShardConfig,
  saveRegionShardConfig,
  deleteRegionShardConfig,
  validateRegionShardRequest,
  calculateRegionRanges,
  createNewRegionGeneration,
  validateColocationGroups,
  DEFAULT_TENANT_ID,
  DEFAULT_TOTAL_SHARDS,
  DEFAULT_REGION_DISTRIBUTION,
  DEFAULT_COLOCATION_GROUPS,
} from '@authrim/shared';

/**
 * Request body for PUT /api/admin/settings/region-shards
 */
interface UpdateRegionShardsRequest {
  /** Total number of shards */
  totalShards: number;
  /** Region distribution percentages (must sum to 100) */
  regionDistribution: Record<string, number>;
  /** Optional: Colocation group configurations */
  groups?: Record<string, ColocationGroupInput>;
}

/**
 * Input format for colocation group
 */
interface ColocationGroupInput {
  totalShards: number;
  members: string[];
  description?: string;
}

/**
 * Request body for POST /api/admin/settings/region-shards/migrate
 */
interface MigrateRequest {
  /** Optional: Reason for migration (for audit) */
  reason?: string;
  /** Optional: Force migration even if no changes detected */
  force?: boolean;
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
  const configV2 = config as RegionShardConfigV2;

  // Merge default groups with custom groups
  const effectiveGroups = { ...DEFAULT_COLOCATION_GROUPS, ...configV2.groups };

  return c.json({
    currentGeneration: config.currentGeneration,
    currentTotalShards: config.currentTotalShards,
    currentRegions: config.currentRegions,
    previousGenerations: config.previousGenerations,
    maxPreviousGenerations: config.maxPreviousGenerations,
    updatedAt: config.updatedAt,
    updatedBy: config.updatedBy,
    // V2: Include colocation groups
    version: configV2.version || 1,
    groups: effectiveGroups,
    // Validation status
    validation: validateColocationGroups(config),
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
  const requestValidation = validateRegionShardRequest(body);
  if (!requestValidation.valid) {
    return c.json({ error: requestValidation.error }, 400);
  }

  // Get current config
  const currentConfig = await getRegionShardConfig(c.env, DEFAULT_TENANT_ID);
  const currentConfigV2 = currentConfig as RegionShardConfigV2;

  // Calculate new region ranges
  const newRegions = calculateRegionRanges(body.totalShards, body.regionDistribution);

  // Build groups if provided
  let newGroups: Record<string, ColocationGroup> | undefined;
  if (body.groups) {
    newGroups = {};
    for (const [groupName, groupInput] of Object.entries(body.groups)) {
      newGroups[groupName] = {
        name: groupName,
        totalShards: groupInput.totalShards,
        members: groupInput.members as ColocationGroup['members'],
        description: groupInput.description,
      };
    }
  }

  // Check if config actually changed
  const configChanged =
    body.totalShards !== currentConfig.currentTotalShards ||
    JSON.stringify(newRegions) !== JSON.stringify(currentConfig.currentRegions) ||
    (body.groups && JSON.stringify(newGroups) !== JSON.stringify(currentConfigV2.groups));

  let newConfig: RegionShardConfigV2;

  if (configChanged) {
    // Create new generation
    const baseConfig = createNewRegionGeneration(
      currentConfig,
      body.totalShards,
      newRegions,
      'admin-api'
    );
    newConfig = {
      ...baseConfig,
      version: 2,
      groups: newGroups || currentConfigV2.groups,
    };
  } else {
    // No change, just update timestamp
    newConfig = {
      ...currentConfig,
      version: currentConfigV2.version || 1,
      groups: currentConfigV2.groups,
      updatedAt: Date.now(),
      updatedBy: 'admin-api',
    };
  }

  // Validate colocation groups before saving
  const colocationValidation = validateColocationGroups(newConfig);
  if (!colocationValidation.valid) {
    return c.json(
      {
        error: 'Colocation group validation failed',
        details: colocationValidation.errors,
        warnings: colocationValidation.warnings,
      },
      400
    );
  }

  // Save to KV
  await saveRegionShardConfig(c.env, DEFAULT_TENANT_ID, newConfig);

  // Merge with defaults for response
  const effectiveGroups = { ...DEFAULT_COLOCATION_GROUPS, ...newConfig.groups };

  return c.json({
    success: true,
    generationIncremented: configChanged,
    currentGeneration: newConfig.currentGeneration,
    currentTotalShards: newConfig.currentTotalShards,
    currentRegions: newConfig.currentRegions,
    previousGenerationsCount: newConfig.previousGenerations.length,
    updatedAt: newConfig.updatedAt,
    version: newConfig.version,
    groups: effectiveGroups,
    validation: colocationValidation,
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
      groups: DEFAULT_COLOCATION_GROUPS,
    },
    note: 'Existing resources with embedded generation/region info will continue to work.',
  });
}

/**
 * POST /api/admin/settings/region-shards/migrate
 *
 * Force a generation increment without changing shard configuration.
 *
 * Use cases:
 * - Prefix migration (e.g., 2-char to 3-char)
 * - Salt changes for re-sharding
 * - Force migration away from a problematic generation
 *
 * Request Body:
 * - reason: Optional migration reason (for audit logging)
 * - force: Force migration even if no changes (default: true)
 */
export async function migrateRegionShards(c: Context) {
  let body: MigrateRequest = {};
  try {
    body = await c.req.json();
  } catch {
    // Empty body is OK for migration
  }

  const reason = body.reason || 'manual-migration';

  // Get current config
  const currentConfig = await getRegionShardConfig(c.env, DEFAULT_TENANT_ID);
  const currentConfigV2 = currentConfig as RegionShardConfigV2;

  // Create new generation with same settings
  const baseConfig = createNewRegionGeneration(
    currentConfig,
    currentConfig.currentTotalShards,
    currentConfig.currentRegions,
    `admin-api:migrate:${reason}`
  );

  const newConfig: RegionShardConfigV2 = {
    ...baseConfig,
    version: 2,
    groups: currentConfigV2.groups,
  };

  // Save to KV
  await saveRegionShardConfig(c.env, DEFAULT_TENANT_ID, newConfig);

  return c.json({
    success: true,
    message: 'Generation incremented successfully.',
    previousGeneration: currentConfig.currentGeneration,
    currentGeneration: newConfig.currentGeneration,
    reason,
    note:
      'All new resources will use the new generation. ' +
      'Existing resources will continue to use their embedded generation until they expire.',
  });
}

/**
 * GET /api/admin/settings/region-shards/validate
 *
 * Validate current colocation group configuration.
 *
 * Returns validation results including:
 * - Whether configuration is valid
 * - Any critical errors (e.g., user-client group shard mismatch)
 * - Warnings for non-critical issues
 */
export async function validateRegionShardsConfig(c: Context) {
  const config = await getRegionShardConfig(c.env, DEFAULT_TENANT_ID);
  const configV2 = config as RegionShardConfigV2;

  const validation = validateColocationGroups(config);

  // Merge default groups with custom groups
  const effectiveGroups = { ...DEFAULT_COLOCATION_GROUPS, ...configV2.groups };

  return c.json({
    valid: validation.valid,
    errors: validation.errors,
    warnings: validation.warnings,
    currentGeneration: config.currentGeneration,
    currentTotalShards: config.currentTotalShards,
    groups: effectiveGroups,
    recommendation: validation.valid
      ? 'Configuration is valid.'
      : 'CRITICAL: Fix errors before deploying. Colocation group shard mismatch causes intermittent authentication failures.',
  });
}
