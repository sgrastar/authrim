/**
 * Region Sharding Utilities
 *
 * Generation-based region sharding for Durable Objects.
 * Enables dynamic shard count and region distribution changes without breaking existing resources.
 *
 * Key Features:
 * - Generation-based routing (each generation has fixed shard count and region distribution)
 * - ID embedding (generation, region, shard info embedded in resource IDs)
 * - Dynamic configuration via KV with caching
 * - locationHint support for DO placement
 *
 * Supported DOs:
 * - SessionStore
 * - AuthCodeStore (AuthorizationCodeStore)
 * - ChallengeStore
 *
 * @see docs/architecture/region-sharding.md
 */

import type { Env } from '../types/env';
import { fnv1a32, DEFAULT_TENANT_ID } from './tenant-context';

// =============================================================================
// Types
// =============================================================================

/**
 * Valid region keys for Cloudflare locationHint.
 */
export type RegionKey = 'apac' | 'weur' | 'enam' | 'wnam' | 'oc' | 'afr' | 'me';

/**
 * Resource types supported by region sharding.
 */
export type RegionShardResourceType =
  | 'session'
  | 'authcode'
  | 'challenge'
  | 'refresh'
  | 'revocation';

/**
 * Type abbreviations for DO instance names.
 */
export const TYPE_ABBREV: Record<RegionShardResourceType, string> = {
  session: 's',
  authcode: 'ac',
  challenge: 'ch',
  refresh: 'rt',
  revocation: 'rv',
};

/**
 * Reverse mapping from abbreviation to resource type.
 */
export const ABBREV_TO_TYPE: Record<string, RegionShardResourceType> = {
  s: 'session',
  ac: 'authcode',
  ch: 'challenge',
  rt: 'refresh',
  rv: 'revocation',
};

/**
 * Region range configuration.
 */
export interface RegionRange {
  /** Start shard index (inclusive) */
  startShard: number;
  /** End shard index (inclusive) */
  endShard: number;
  /** Number of shards in this region */
  shardCount: number;
}

/**
 * Single generation configuration.
 */
export interface RegionGenerationConfig {
  /** Generation number */
  generation: number;
  /** Total shard count for this generation */
  totalShards: number;
  /** Region distribution */
  regions: Record<string, RegionRange>;
  /** When this generation was deprecated (undefined if current) */
  deprecatedAt?: number;
}

/**
 * Full region shard configuration from KV.
 */
export interface RegionShardConfig {
  /** Current generation number */
  currentGeneration: number;
  /** Current total shard count */
  currentTotalShards: number;
  /** Current region distribution */
  currentRegions: Record<string, RegionRange>;
  /** Previous generation configs (for routing existing resources) */
  previousGenerations: RegionGenerationConfig[];
  /** Maximum number of previous generations to keep */
  maxPreviousGenerations: number;
  /** Last update timestamp (ms) */
  updatedAt: number;
  /** Who updated the config */
  updatedBy?: string;
}

/**
 * Parsed region ID.
 */
export interface ParsedRegionId {
  /** Generation number */
  generation: number;
  /** Region key */
  regionKey: string;
  /** Shard index */
  shardIndex: number;
  /** Random part (resource-specific ID) */
  randomPart: string;
}

/**
 * Shard resolution result.
 */
export interface ShardResolution {
  /** Generation number */
  generation: number;
  /** Region key */
  regionKey: string;
  /** Shard index */
  shardIndex: number;
}

// =============================================================================
// Constants
// =============================================================================

// Note: DEFAULT_TENANT_ID is imported from tenant-context.ts
// Re-export for convenience
export { DEFAULT_TENANT_ID } from './tenant-context';

/** Default total shard count */
export const DEFAULT_TOTAL_SHARDS = 20;

/** Default region distribution (APAC 20%, US 40%, EU 40%) */
export const DEFAULT_REGION_DISTRIBUTION: Record<string, number> = {
  apac: 20,
  enam: 40,
  weur: 40,
};

/** Cache TTL for shard configuration (10 seconds) */
export const REGION_SHARD_CONFIG_CACHE_TTL_MS = 10_000;

/** Maximum number of previous generations to keep (region sharding specific) */
export const REGION_MAX_PREVIOUS_GENERATIONS = 5;

/** KV key prefix for region shard configuration */
export const REGION_SHARD_CONFIG_KV_PREFIX = 'region_shard_config';

/** Valid region keys (frozen for runtime checks) */
export const VALID_REGION_KEYS = Object.freeze([
  'apac',
  'weur',
  'enam',
  'wnam',
  'oc',
  'afr',
  'me',
] as const);

// =============================================================================
// In-Memory Caching
// =============================================================================

/**
 * Cached region shard config by tenant.
 */
const regionShardConfigCache = new Map<string, { config: RegionShardConfig; expiresAt: number }>();

/**
 * Clear region shard config cache.
 * Useful for testing or after configuration changes.
 */
export function clearRegionShardConfigCache(): void {
  regionShardConfigCache.clear();
}

// =============================================================================
// ID Parsing and Creation
// =============================================================================

/**
 * Parse a region ID to extract generation, region, shard information.
 *
 * ID Format: g{gen}:{region}:{shard}:{randomPart}
 *
 * @param id - Resource ID to parse
 * @returns Parsed region ID
 * @throws Error if ID format is invalid
 *
 * @example
 * parseRegionId('g1:apac:3:session_abc123')
 * // => { generation: 1, regionKey: 'apac', shardIndex: 3, randomPart: 'session_abc123' }
 */
export function parseRegionId(id: string): ParsedRegionId {
  const match = id.match(/^g(\d+):(\w+):(\d+):(.+)$/);
  if (!match) {
    throw new Error(`Invalid region ID format: ${id}`);
  }
  return {
    generation: parseInt(match[1], 10),
    regionKey: match[2],
    shardIndex: parseInt(match[3], 10),
    randomPart: match[4],
  };
}

/**
 * Create a region ID with embedded generation, region, and shard info.
 *
 * @param generation - Generation number
 * @param regionKey - Region key
 * @param shardIndex - Shard index
 * @param randomPart - Random part (resource-specific ID)
 * @returns Region ID string
 *
 * @example
 * createRegionId(1, 'apac', 3, 'session_abc123')
 * // => 'g1:apac:3:session_abc123'
 */
export function createRegionId(
  generation: number,
  regionKey: string,
  shardIndex: number,
  randomPart: string
): string {
  return `g${generation}:${regionKey}:${shardIndex}:${randomPart}`;
}

// =============================================================================
// DO Instance Name Building
// =============================================================================

/**
 * Build a DO instance name for region-sharded resources.
 *
 * Instance Name Format: {tenantId}:{region}:{typeAbbrev}:{shard}
 *
 * @param tenantId - Tenant ID
 * @param regionKey - Region key
 * @param resourceType - Resource type
 * @param shardIndex - Shard index
 * @returns DO instance name
 *
 * @example
 * buildRegionInstanceName('default', 'apac', 'session', 3)
 * // => 'default:apac:s:3'
 */
export function buildRegionInstanceName(
  tenantId: string,
  regionKey: string,
  resourceType: RegionShardResourceType,
  shardIndex: number
): string {
  const typeAbbrev = TYPE_ABBREV[resourceType];
  return `${tenantId}:${regionKey}:${typeAbbrev}:${shardIndex}`;
}

// =============================================================================
// Shard Resolution
// =============================================================================

/**
 * Resolve region key from shard index using region distribution.
 *
 * @param shardIndex - Shard index
 * @param regions - Region distribution
 * @returns Region key
 *
 * @example
 * resolveRegionForShard(3, { apac: { startShard: 0, endShard: 3, shardCount: 4 }, ... })
 * // => 'apac'
 */
export function resolveRegionForShard(
  shardIndex: number,
  regions: Record<string, RegionRange>
): string {
  for (const [regionKey, range] of Object.entries(regions)) {
    if (shardIndex >= range.startShard && shardIndex <= range.endShard) {
      return regionKey;
    }
  }
  // Default fallback to first region with shards
  const firstRegion = Object.entries(regions).find(([, range]) => range.shardCount > 0);
  return firstRegion ? firstRegion[0] : 'enam';
}

/**
 * Resolve shard for new resource creation.
 *
 * @param config - Region shard configuration
 * @param shardKey - Key for shard calculation (e.g., userId:clientId)
 * @returns Shard resolution result
 *
 * @example
 * resolveShardForNewResource(config, 'user123:client456')
 * // => { generation: 1, regionKey: 'apac', shardIndex: 3 }
 */
export function resolveShardForNewResource(
  config: RegionShardConfig,
  shardKey: string
): ShardResolution {
  // Calculate shard index using FNV-1a hash
  const shardIndex = fnv1a32(shardKey) % config.currentTotalShards;

  // Resolve region from shard index
  const regionKey = resolveRegionForShard(shardIndex, config.currentRegions);

  return {
    generation: config.currentGeneration,
    regionKey,
    shardIndex,
  };
}

/**
 * Resolve shard from existing resource ID.
 *
 * @param id - Resource ID
 * @returns Shard resolution result
 */
export function resolveShardFromId(id: string): ShardResolution {
  const parsed = parseRegionId(id);
  return {
    generation: parsed.generation,
    regionKey: parsed.regionKey,
    shardIndex: parsed.shardIndex,
  };
}

// =============================================================================
// Generation Management
// =============================================================================

/**
 * Find generation config by generation number.
 *
 * @param config - Full region shard configuration
 * @param generation - Generation number to find
 * @returns Generation config or null if not found
 */
export function findGenerationConfig(
  config: RegionShardConfig,
  generation: number
): RegionGenerationConfig | null {
  if (generation === config.currentGeneration) {
    return {
      generation: config.currentGeneration,
      totalShards: config.currentTotalShards,
      regions: config.currentRegions,
    };
  }

  return config.previousGenerations.find((g) => g.generation === generation) ?? null;
}

/**
 * Create a new region generation with updated shard count and region distribution.
 *
 * @param currentConfig - Current configuration
 * @param newTotalShards - New total shard count
 * @param newRegions - New region distribution
 * @param updatedBy - Who is making the change
 * @returns Updated configuration
 */
export function createNewRegionGeneration(
  currentConfig: RegionShardConfig,
  newTotalShards: number,
  newRegions: Record<string, RegionRange>,
  updatedBy?: string
): RegionShardConfig {
  const now = Date.now();

  // Add current generation to previous generations
  const previousGenerations: RegionGenerationConfig[] = [
    {
      generation: currentConfig.currentGeneration,
      totalShards: currentConfig.currentTotalShards,
      regions: currentConfig.currentRegions,
      deprecatedAt: now,
    },
    ...currentConfig.previousGenerations,
  ].slice(0, currentConfig.maxPreviousGenerations);

  return {
    currentGeneration: currentConfig.currentGeneration + 1,
    currentTotalShards: newTotalShards,
    currentRegions: newRegions,
    previousGenerations,
    maxPreviousGenerations: currentConfig.maxPreviousGenerations,
    updatedAt: now,
    updatedBy,
  };
}

// =============================================================================
// Region Distribution Calculation
// =============================================================================

/**
 * Calculate region ranges from percentage distribution.
 *
 * @param totalShards - Total number of shards
 * @param distribution - Region percentage distribution (must sum to 100)
 * @returns Region ranges
 *
 * @example
 * calculateRegionRanges(20, { apac: 20, enam: 40, weur: 40 })
 * // => {
 * //   apac: { startShard: 0, endShard: 3, shardCount: 4 },
 * //   enam: { startShard: 4, endShard: 11, shardCount: 8 },
 * //   weur: { startShard: 12, endShard: 19, shardCount: 8 }
 * // }
 */
export function calculateRegionRanges(
  totalShards: number,
  distribution: Record<string, number>
): Record<string, RegionRange> {
  const regions: Record<string, RegionRange> = {};
  let currentShard = 0;

  // Sort regions by percentage (descending) to allocate larger regions first
  const sortedRegions = Object.entries(distribution).sort(([, a], [, b]) => b - a);

  for (const [regionKey, percentage] of sortedRegions) {
    if (percentage === 0) {
      regions[regionKey] = { startShard: -1, endShard: -1, shardCount: 0 };
      continue;
    }

    const shardCount = Math.round((totalShards * percentage) / 100);
    const actualShardCount = Math.max(shardCount, 1); // At least 1 shard if percentage > 0

    regions[regionKey] = {
      startShard: currentShard,
      endShard: currentShard + actualShardCount - 1,
      shardCount: actualShardCount,
    };

    currentShard += actualShardCount;
  }

  // Adjust the last allocated region to ensure all shards are covered
  // Find the region with the highest endShard (last allocated region)
  let lastAllocatedKey: string | null = null;
  let highestEndShard = -1;
  for (const [regionKey, range] of Object.entries(regions)) {
    if (range.shardCount > 0 && range.endShard > highestEndShard) {
      highestEndShard = range.endShard;
      lastAllocatedKey = regionKey;
    }
  }

  if (lastAllocatedKey && currentShard < totalShards) {
    regions[lastAllocatedKey].endShard = totalShards - 1;
    regions[lastAllocatedKey].shardCount =
      regions[lastAllocatedKey].endShard - regions[lastAllocatedKey].startShard + 1;
  } else if (currentShard > totalShards && lastAllocatedKey) {
    // Handle over-allocation due to rounding up
    const excess = currentShard - totalShards;
    regions[lastAllocatedKey].endShard -= excess;
    regions[lastAllocatedKey].shardCount =
      regions[lastAllocatedKey].endShard - regions[lastAllocatedKey].startShard + 1;
  }

  return regions;
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Region shard validation result.
 */
export interface RegionShardValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate region shard request body.
 *
 * Rules:
 * 1. regionDistribution must sum to 100
 * 2. totalShards >= active region count
 * 3. shardCount = 0 regions are allowed
 * 4. totalShards and regionDistribution must be consistent
 *
 * @param body - Request body
 * @returns Validation result
 */
export function validateRegionShardRequest(body: {
  totalShards: number;
  regionDistribution: Record<string, number>;
}): RegionShardValidationResult {
  const { totalShards, regionDistribution } = body;

  // 0. Check for invalid region keys
  for (const regionKey of Object.keys(regionDistribution)) {
    if (!VALID_REGION_KEYS.includes(regionKey as (typeof VALID_REGION_KEYS)[number])) {
      return { valid: false, error: `Invalid region key: ${regionKey}` };
    }
  }

  // 1. Check for negative values
  for (const [region, pct] of Object.entries(regionDistribution)) {
    if (pct < 0) {
      return { valid: false, error: `Region ${region} has negative percentage: ${pct}` };
    }
  }

  // 2. regionDistribution must sum to 100
  const sum = Object.values(regionDistribution).reduce((a, b) => a + b, 0);
  if (sum !== 100) {
    return { valid: false, error: `Region distribution must sum to 100, got ${sum}` };
  }

  // 3. totalShards >= active region count
  const activeRegions = Object.entries(regionDistribution).filter(([, pct]) => pct > 0).length;
  if (totalShards < activeRegions) {
    return {
      valid: false,
      error: `Total shards (${totalShards}) must be >= active region count (${activeRegions})`,
    };
  }

  // 4. shardCount = 0 regions are allowed (no check needed)

  // 5. totalShards and regionDistribution consistency
  for (const [region, pct] of Object.entries(regionDistribution)) {
    if (pct > 0) {
      const shardCount = Math.round((totalShards * pct) / 100);
      if (shardCount === 0) {
        return {
          valid: false,
          error: `Cannot allocate ${pct}% of ${totalShards} shards to ${region} (would be 0)`,
        };
      }
    }
  }

  return { valid: true };
}

// =============================================================================
// KV Configuration Management
// =============================================================================

/**
 * Build KV key for region shard configuration.
 *
 * @param tenantId - Tenant ID
 * @returns KV key string
 */
export function buildRegionShardConfigKvKey(tenantId: string): string {
  return `${REGION_SHARD_CONFIG_KV_PREFIX}:${tenantId}`;
}

/**
 * Get region shard configuration from KV with caching.
 *
 * @param env - Environment with KV binding
 * @param tenantId - Tenant ID (default: 'default')
 * @returns Region shard configuration
 */
export async function getRegionShardConfig(
  env: Env,
  tenantId: string = DEFAULT_TENANT_ID
): Promise<RegionShardConfig> {
  const cacheKey = `region-shard-config:${tenantId}`;
  const now = Date.now();

  // Check cache
  const cached = regionShardConfigCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.config;
  }

  let config: RegionShardConfig | null = null;

  // Try KV
  const kv = env.AUTHRIM_CONFIG;
  if (kv) {
    const kvKey = buildRegionShardConfigKvKey(tenantId);
    config = await kv.get<RegionShardConfig>(kvKey, { type: 'json' });
  }

  // Default configuration if not found
  if (!config) {
    const defaultRegions = calculateRegionRanges(DEFAULT_TOTAL_SHARDS, DEFAULT_REGION_DISTRIBUTION);
    config = {
      currentGeneration: 1,
      currentTotalShards: DEFAULT_TOTAL_SHARDS,
      currentRegions: defaultRegions,
      previousGenerations: [],
      maxPreviousGenerations: REGION_MAX_PREVIOUS_GENERATIONS,
      updatedAt: now,
    };
  }

  // Update cache
  regionShardConfigCache.set(cacheKey, {
    config,
    expiresAt: now + REGION_SHARD_CONFIG_CACHE_TTL_MS,
  });

  return config;
}

/**
 * Save region shard configuration to KV.
 *
 * @param env - Environment with KV binding
 * @param tenantId - Tenant ID
 * @param config - Configuration to save
 */
export async function saveRegionShardConfig(
  env: Env,
  tenantId: string,
  config: RegionShardConfig
): Promise<void> {
  const kv = env.AUTHRIM_CONFIG;
  if (!kv) {
    throw new Error('AUTHRIM_CONFIG KV binding not available');
  }

  const kvKey = buildRegionShardConfigKvKey(tenantId);
  await kv.put(kvKey, JSON.stringify(config));

  // Invalidate cache
  const cacheKey = `region-shard-config:${tenantId}`;
  regionShardConfigCache.delete(cacheKey);
}

/**
 * Delete region shard configuration from KV.
 *
 * @param env - Environment with KV binding
 * @param tenantId - Tenant ID
 */
export async function deleteRegionShardConfig(env: Env, tenantId: string): Promise<void> {
  const kv = env.AUTHRIM_CONFIG;
  if (!kv) {
    throw new Error('AUTHRIM_CONFIG KV binding not available');
  }

  const kvKey = buildRegionShardConfigKvKey(tenantId);
  await kv.delete(kvKey);

  // Invalidate cache
  const cacheKey = `region-shard-config:${tenantId}`;
  regionShardConfigCache.delete(cacheKey);
}

// =============================================================================
// DO Stub Helper
// =============================================================================

/**
 * Get a region-aware Durable Object stub with locationHint.
 *
 * @param namespace - DO namespace
 * @param instanceName - DO instance name
 * @param regionKey - Region key for locationHint
 * @returns DO stub
 *
 * @example
 * const stub = getRegionAwareDOStub(env.SESSION_STORE, 'default:apac:s:3', 'apac');
 */
export function getRegionAwareDOStub<T extends Rpc.DurableObjectBranded | undefined = undefined>(
  namespace: DurableObjectNamespace<T>,
  instanceName: string,
  regionKey: string
): DurableObjectStub<T> {
  const id = namespace.idFromName(instanceName);

  // locationHint is only effective on the first get() call for a given ID
  return namespace.get(id, {
    locationHint: regionKey as DurableObjectLocationHint,
  });
}

// =============================================================================
// High-Level Helper Functions
// =============================================================================

/**
 * Create a new region-aware resource ID and get the DO stub.
 *
 * @param env - Environment with DO and KV bindings
 * @param namespace - DO namespace
 * @param tenantId - Tenant ID
 * @param resourceType - Resource type
 * @param shardKey - Key for shard calculation
 * @param randomPart - Random part for the ID
 * @returns Object with id, stub, and resolution info
 */
export async function createRegionAwareResource<
  T extends Rpc.DurableObjectBranded | undefined = undefined,
>(
  env: Env,
  namespace: DurableObjectNamespace<T>,
  tenantId: string,
  resourceType: RegionShardResourceType,
  shardKey: string,
  randomPart: string
): Promise<{
  id: string;
  stub: DurableObjectStub<T>;
  resolution: ShardResolution;
  instanceName: string;
}> {
  const config = await getRegionShardConfig(env, tenantId);
  const resolution = resolveShardForNewResource(config, shardKey);

  const id = createRegionId(
    resolution.generation,
    resolution.regionKey,
    resolution.shardIndex,
    randomPart
  );
  const instanceName = buildRegionInstanceName(
    tenantId,
    resolution.regionKey,
    resourceType,
    resolution.shardIndex
  );
  const stub = getRegionAwareDOStub(namespace, instanceName, resolution.regionKey);

  return { id, stub, resolution, instanceName };
}

/**
 * Get the DO stub for an existing region-aware resource.
 *
 * @param namespace - DO namespace
 * @param tenantId - Tenant ID
 * @param resourceType - Resource type
 * @param resourceId - Resource ID (with embedded region info)
 * @returns Object with stub and resolution info
 */
export function getRegionAwareResourceStub<
  T extends Rpc.DurableObjectBranded | undefined = undefined,
>(
  namespace: DurableObjectNamespace<T>,
  tenantId: string,
  resourceType: RegionShardResourceType,
  resourceId: string
): {
  stub: DurableObjectStub<T>;
  resolution: ShardResolution;
  instanceName: string;
} {
  const resolution = resolveShardFromId(resourceId);
  const instanceName = buildRegionInstanceName(
    tenantId,
    resolution.regionKey,
    resourceType,
    resolution.shardIndex
  );
  const stub = getRegionAwareDOStub(namespace, instanceName, resolution.regionKey);

  return { stub, resolution, instanceName };
}

// =============================================================================
// Additional Helpers
// =============================================================================

/**
 * Get default region shard configuration.
 *
 * @returns Default configuration
 */
export function getDefaultRegionShardConfig(): RegionShardConfig {
  const defaultRegions = calculateRegionRanges(DEFAULT_TOTAL_SHARDS, DEFAULT_REGION_DISTRIBUTION);
  return {
    currentGeneration: 1,
    currentTotalShards: DEFAULT_TOTAL_SHARDS,
    currentRegions: defaultRegions,
    previousGenerations: [],
    maxPreviousGenerations: REGION_MAX_PREVIOUS_GENERATIONS,
    updatedAt: Date.now(),
  };
}

/**
 * Validate region distribution percentages.
 *
 * @param distribution - Region percentage distribution
 * @returns Validation result
 */
export function validateRegionDistribution(
  distribution: Record<string, number>
): RegionShardValidationResult {
  // Check for negative values
  for (const [region, pct] of Object.entries(distribution)) {
    if (pct < 0) {
      return { valid: false, error: `Region ${region} has negative percentage: ${pct}` };
    }
  }

  // Check for invalid region keys
  for (const regionKey of Object.keys(distribution)) {
    if (!VALID_REGION_KEYS.includes(regionKey as (typeof VALID_REGION_KEYS)[number])) {
      return { valid: false, error: `Invalid region key: ${regionKey}` };
    }
  }

  // Check sum equals 100
  const sum = Object.values(distribution).reduce((a, b) => a + b, 0);
  if (sum !== 100) {
    return { valid: false, error: `Region distribution must sum to 100, got ${sum}` };
  }

  return { valid: true };
}

/**
 * Calculate region distribution from percentage values.
 * Alias for calculateRegionRanges for clearer naming.
 *
 * @param totalShards - Total number of shards
 * @param distribution - Region percentage distribution
 * @returns Region ranges
 */
export function calculateRegionDistribution(
  totalShards: number,
  distribution: Record<string, number>
): Record<string, RegionRange> {
  return calculateRegionRanges(totalShards, distribution);
}
