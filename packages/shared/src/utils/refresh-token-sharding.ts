/**
 * Refresh Token Sharding Utilities
 *
 * Generation-based sharding with region support for RefreshTokenRotator Durable Objects.
 * Enables dynamic shard count and region changes without breaking existing tokens.
 *
 * Key Features:
 * - Region-aware routing with locationHint support
 * - Generation-based routing (each generation has fixed shard count)
 * - Legacy token compatibility (generation=0)
 * - SHA-256 hash-based shard assignment
 * - KV-based configuration with caching
 *
 * @see region-sharding.ts for region sharding design
 * @see docs/architecture/refresh-token-sharding.md
 */

import type { Env } from '../types/env';
import { DEFAULT_TENANT_ID } from './tenant-context';
import {
  getRegionShardConfig,
  resolveShardForNewResource,
  buildRegionInstanceName,
  getRegionAwareDOStub,
  createRegionId,
  parseRegionId,
  type RegionShardConfig,
  type ShardResolution,
} from './region-sharding';

// =============================================================================
// Types
// =============================================================================

/**
 * Parsed JTI (JWT ID) for refresh tokens.
 */
export interface ParsedRefreshTokenJti {
  /** Generation number (0 = legacy) */
  generation: number;
  /** Shard index (null for legacy tokens) */
  shardIndex: number | null;
  /** Region key (null for legacy tokens) */
  regionKey: string | null;
  /** Random part of the JTI */
  randomPart: string;
  /** Whether this is a legacy format token */
  isLegacy: boolean;
  /** Whether this is a region-aware format token */
  isRegionAware: boolean;
}

/**
 * Shard configuration for a single generation.
 */
export interface GenerationConfig {
  generation: number;
  shardCount: number;
  deprecatedAt?: number;
}

/**
 * Full shard configuration from KV.
 */
export interface RefreshTokenShardConfig {
  /** Current generation number */
  currentGeneration: number;
  /** Number of shards in current generation */
  currentShardCount: number;
  /** Previous generation configs (for routing existing tokens) */
  previousGenerations: GenerationConfig[];
  /** Last update timestamp (ms) */
  updatedAt: number;
  /** Who updated the config */
  updatedBy?: string;
}

// =============================================================================
// Constants
// =============================================================================

/** Default shard count for production */
export const DEFAULT_REFRESH_TOKEN_SHARD_COUNT = 16;

/** Default shard count for load testing */
export const LOAD_TEST_SHARD_COUNT = 32;

/** Cache TTL for shard configuration (10 seconds) */
export const SHARD_CONFIG_CACHE_TTL_MS = 10000;

/** Maximum number of previous generations to keep */
export const MAX_PREVIOUS_GENERATIONS = 5;

/** KV key prefix for shard configuration */
export const SHARD_CONFIG_KV_PREFIX = 'refresh-token-shards';

/** Global config key (used when no client-specific config exists) */
export const GLOBAL_CONFIG_KEY = '__global__';

// =============================================================================
// JTI Parsing and Creation
// =============================================================================

/**
 * Parse a refresh token JTI to extract generation, region, and shard information.
 *
 * JTI Formats:
 * - Region-aware format: g{gen}:{region}:{shard}:{randomPart}
 * - Legacy format: v{generation}_{shardIndex}_{randomPart}
 * - Very old format: rt_{uuid} (treated as generation=0)
 *
 * @param jti - JWT ID to parse
 * @returns Parsed JTI information
 *
 * @example
 * parseRefreshTokenJti('g1:wnam:7:rt_abc123')
 * // => { generation: 1, shardIndex: 7, regionKey: 'wnam', randomPart: 'rt_abc123', isLegacy: false, isRegionAware: true }
 *
 * parseRefreshTokenJti('v1_7_rt_abc123')
 * // => { generation: 1, shardIndex: 7, regionKey: null, randomPart: 'rt_abc123', isLegacy: false, isRegionAware: false }
 *
 * parseRefreshTokenJti('rt_abc123')
 * // => { generation: 0, shardIndex: null, regionKey: null, randomPart: 'rt_abc123', isLegacy: true, isRegionAware: false }
 */
export function parseRefreshTokenJti(jti: string): ParsedRefreshTokenJti {
  // Region-aware format: g{gen}:{region}:{shard}:{random}
  const regionFormatMatch = jti.match(/^g(\d+):(\w+):(\d+):(.+)$/);
  if (regionFormatMatch) {
    return {
      generation: parseInt(regionFormatMatch[1], 10),
      shardIndex: parseInt(regionFormatMatch[3], 10),
      regionKey: regionFormatMatch[2],
      randomPart: regionFormatMatch[4],
      isLegacy: false,
      isRegionAware: true,
    };
  }

  // Legacy format: v{gen}_{shard}_{random}
  const legacyFormatMatch = jti.match(/^v(\d+)_(\d+)_(.+)$/);
  if (legacyFormatMatch) {
    return {
      generation: parseInt(legacyFormatMatch[1], 10),
      shardIndex: parseInt(legacyFormatMatch[2], 10),
      regionKey: null,
      randomPart: legacyFormatMatch[3],
      isLegacy: false,
      isRegionAware: false,
    };
  }

  // Very old format: anything without prefix
  return {
    generation: 0,
    shardIndex: null,
    regionKey: null,
    randomPart: jti,
    isLegacy: true,
    isRegionAware: false,
  };
}

/**
 * Create a region-aware JTI for refresh tokens.
 *
 * @param generation - Generation number
 * @param regionKey - Region key
 * @param shardIndex - Shard index
 * @param randomPart - Random part (typically rt_{uuid})
 * @returns Formatted JTI string
 *
 * @example
 * createRegionAwareRefreshTokenJti(1, 'wnam', 7, 'rt_abc123')
 * // => 'g1:wnam:7:rt_abc123'
 */
export function createRegionAwareRefreshTokenJti(
  generation: number,
  regionKey: string,
  shardIndex: number,
  randomPart: string
): string {
  return createRegionId(generation, regionKey, shardIndex, randomPart);
}

/**
 * Create a legacy-format JTI for refresh tokens.
 * @deprecated Use createRegionAwareRefreshTokenJti for new tokens
 *
 * @param generation - Generation number
 * @param shardIndex - Shard index
 * @param randomPart - Random part (typically rt_{uuid})
 * @returns Formatted JTI string
 *
 * @example
 * createRefreshTokenJti(1, 7, 'rt_abc123')
 * // => 'v1_7_rt_abc123'
 */
export function createRefreshTokenJti(
  generation: number,
  shardIndex: number,
  randomPart: string
): string {
  return `v${generation}_${shardIndex}_${randomPart}`;
}

/**
 * Generate a random part for refresh token JTI.
 *
 * @returns Random JTI part in format rt_{uuid}
 */
export function generateRefreshTokenRandomPart(): string {
  return `rt_${crypto.randomUUID()}`;
}

// =============================================================================
// Shard Index Calculation
// =============================================================================

/**
 * Calculate shard index for a user/client combination.
 * Uses SHA-256 hash for even distribution.
 *
 * @param userId - User identifier
 * @param clientId - Client identifier
 * @param shardCount - Number of shards
 * @returns Shard index (0 to shardCount - 1)
 *
 * @example
 * await getRefreshTokenShardIndex('user-123', 'client-abc', 8)
 * // => 3 (deterministic based on hash)
 */
export async function getRefreshTokenShardIndex(
  userId: string,
  clientId: string,
  shardCount: number
): Promise<number> {
  const key = `${userId}:${clientId}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(key);

  // SHA-256 hash
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);

  // Use first 4 bytes as 32-bit unsigned integer
  const hashInt =
    ((hashArray[0] << 24) | (hashArray[1] << 16) | (hashArray[2] << 8) | hashArray[3]) >>> 0;

  return hashInt % shardCount;
}

/**
 * Synchronous shard index calculation using simple string hash.
 * Use this when async is not feasible (e.g., in load testing scripts).
 *
 * @param userId - User identifier
 * @param clientId - Client identifier
 * @param shardCount - Number of shards
 * @returns Shard index (0 to shardCount - 1)
 */
export function getRefreshTokenShardIndexSync(
  userId: string,
  clientId: string,
  shardCount: number
): number {
  const key = `${userId}:${clientId}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    const char = key.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash) % shardCount;
}

/**
 * Remap shard index for fallback scenarios.
 *
 * In generation-based sharding, remap is typically NOT needed because:
 * - Each generation has fixed shard count
 * - JTI contains exact shard info for routing
 *
 * This function is used only for:
 * - Invalid shard index (shardIndex >= shardCount)
 * - Emergency fallback scenarios
 *
 * @param shardIndex - Original shard index
 * @param shardCount - Current shard count
 * @returns Valid shard index (0 to shardCount - 1)
 */
export function remapRefreshTokenShardIndex(shardIndex: number, shardCount: number): number {
  if (shardCount <= 0) {
    throw new Error('Invalid shard count: must be greater than 0');
  }
  return Math.abs(shardIndex) % shardCount;
}

// =============================================================================
// DO Instance Name Building
// =============================================================================

/**
 * Build a region-aware Durable Object instance name for RefreshTokenRotator.
 *
 * @param tenantId - Tenant ID
 * @param regionKey - Region key
 * @param shardIndex - Shard index
 * @returns DO instance name
 *
 * @example
 * buildRegionAwareRefreshTokenInstanceName('default', 'wnam', 7)
 * // => 'default:wnam:rt:7'
 */
export function buildRegionAwareRefreshTokenInstanceName(
  tenantId: string,
  regionKey: string,
  shardIndex: number
): string {
  return buildRegionInstanceName(tenantId, regionKey, 'refresh', shardIndex);
}

/**
 * Build a Durable Object instance name for RefreshTokenRotator.
 * @deprecated Use buildRegionAwareRefreshTokenInstanceName for new tokens
 *
 * Instance Name Patterns:
 * - Legacy (gen=0): tenant:{tenantId}:refresh-rotator:{clientId}
 * - New format: tenant:{tenantId}:refresh-rotator:{clientId}:v{gen}:shard-{index}
 *
 * @param clientId - Client identifier
 * @param generation - Generation number (0 for legacy)
 * @param shardIndex - Shard index (null for legacy)
 * @param tenantId - Tenant identifier (default: 'default')
 * @returns DO instance name
 *
 * @example
 * buildRefreshTokenRotatorInstanceName('client-abc', 1, 7)
 * // => 'tenant:default:refresh-rotator:client-abc:v1:shard-7'
 *
 * buildRefreshTokenRotatorInstanceName('client-abc', 0, null)
 * // => 'tenant:default:refresh-rotator:client-abc'
 */
export function buildRefreshTokenRotatorInstanceName(
  clientId: string,
  generation: number,
  shardIndex: number | null,
  tenantId: string = DEFAULT_TENANT_ID
): string {
  // Legacy (generation=0 or no shard index)
  if (generation === 0 || shardIndex === null) {
    return `tenant:${tenantId}:refresh-rotator:${clientId}`;
  }

  // New format with generation and shard
  return `tenant:${tenantId}:refresh-rotator:${clientId}:v${generation}:shard-${shardIndex}`;
}

/**
 * Get RefreshTokenRotator DO ID from environment.
 *
 * @param env - Environment with DO bindings
 * @param clientId - Client identifier
 * @param generation - Generation number
 * @param shardIndex - Shard index
 * @returns Durable Object ID
 */
export function getRefreshTokenRotatorId(
  env: Env,
  clientId: string,
  generation: number,
  shardIndex: number | null
): DurableObjectId {
  const instanceName = buildRefreshTokenRotatorInstanceName(clientId, generation, shardIndex);
  return env.REFRESH_TOKEN_ROTATOR.idFromName(instanceName);
}

// =============================================================================
// KV Configuration Management
// =============================================================================

/**
 * In-memory cache for shard configuration.
 */
const shardConfigCache = new Map<string, { config: RefreshTokenShardConfig; expiresAt: number }>();

/**
 * Build KV key for shard configuration.
 *
 * @param clientId - Client ID (null for global)
 * @returns KV key string
 */
export function buildShardConfigKvKey(clientId: string | null): string {
  return `${SHARD_CONFIG_KV_PREFIX}:${clientId ?? GLOBAL_CONFIG_KEY}`;
}

/**
 * Get shard configuration from KV with caching.
 *
 * Priority:
 * 1. In-memory cache (if not expired)
 * 2. KV (client-specific)
 * 3. KV (global)
 * 4. Default configuration
 *
 * @param env - Environment with KV binding
 * @param clientId - Client identifier
 * @returns Shard configuration
 */
export async function getRefreshTokenShardConfig(
  env: Env,
  clientId: string
): Promise<RefreshTokenShardConfig> {
  const cacheKey = `shard-config:${clientId}`;
  const now = Date.now();

  // Check cache
  const cached = shardConfigCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.config;
  }

  // Try client-specific config
  let config: RefreshTokenShardConfig | null = null;

  // Use AUTHRIM_CONFIG KV namespace (bound as env.AUTHRIM_CONFIG)
  const kv = env.AUTHRIM_CONFIG ?? env.KV;
  if (kv) {
    // Client-specific
    const clientConfig = await kv.get<RefreshTokenShardConfig>(
      buildShardConfigKvKey(clientId),
      'json'
    );
    if (clientConfig) {
      config = clientConfig;
    } else {
      // Global fallback
      const globalConfig = await kv.get<RefreshTokenShardConfig>(
        buildShardConfigKvKey(null),
        'json'
      );
      if (globalConfig) {
        config = globalConfig;
      }
    }
  }

  // Default configuration
  if (!config) {
    config = {
      currentGeneration: 1,
      currentShardCount: DEFAULT_REFRESH_TOKEN_SHARD_COUNT,
      previousGenerations: [],
      updatedAt: now,
    };
  }

  // Update cache
  shardConfigCache.set(cacheKey, {
    config,
    expiresAt: now + SHARD_CONFIG_CACHE_TTL_MS,
  });

  return config;
}

/**
 * Save shard configuration to KV.
 *
 * @param env - Environment with KV binding
 * @param clientId - Client identifier (null for global)
 * @param config - Configuration to save
 */
export async function saveRefreshTokenShardConfig(
  env: Env,
  clientId: string | null,
  config: RefreshTokenShardConfig
): Promise<void> {
  // Use AUTHRIM_CONFIG KV namespace (bound as env.AUTHRIM_CONFIG)
  const kv = env.AUTHRIM_CONFIG ?? env.KV;
  if (!kv) {
    throw new Error('KV binding not available (AUTHRIM_CONFIG or KV)');
  }

  await kv.put(buildShardConfigKvKey(clientId), JSON.stringify(config));

  // Invalidate cache
  const cacheKey = `shard-config:${clientId ?? GLOBAL_CONFIG_KEY}`;
  shardConfigCache.delete(cacheKey);
}

/**
 * Clear shard configuration cache.
 * Useful for testing or after configuration changes.
 */
export function clearShardConfigCache(): void {
  shardConfigCache.clear();
}

// =============================================================================
// Generation Management
// =============================================================================

/**
 * Create a new generation with updated shard count.
 *
 * @param currentConfig - Current configuration
 * @param newShardCount - New shard count
 * @param updatedBy - Who is making the change
 * @returns Updated configuration
 */
export function createNewGeneration(
  currentConfig: RefreshTokenShardConfig,
  newShardCount: number,
  updatedBy?: string
): RefreshTokenShardConfig {
  const now = Date.now();

  // Add current generation to previous generations
  const previousGenerations: GenerationConfig[] = [
    {
      generation: currentConfig.currentGeneration,
      shardCount: currentConfig.currentShardCount,
      deprecatedAt: now,
    },
    ...currentConfig.previousGenerations,
  ].slice(0, MAX_PREVIOUS_GENERATIONS);

  return {
    currentGeneration: currentConfig.currentGeneration + 1,
    currentShardCount: newShardCount,
    previousGenerations,
    updatedAt: now,
    updatedBy,
  };
}

/**
 * Find shard count for a specific generation.
 *
 * @param config - Shard configuration
 * @param generation - Generation number to look up
 * @returns Shard count for the generation, or null if not found
 */
export function findGenerationShardCount(
  config: RefreshTokenShardConfig,
  generation: number
): number | null {
  // Current generation
  if (generation === config.currentGeneration) {
    return config.currentShardCount;
  }

  // Previous generations
  const prev = config.previousGenerations.find((g) => g.generation === generation);
  if (prev) {
    return prev.shardCount;
  }

  // Legacy generation
  if (generation === 0) {
    return 1; // Legacy uses single DO per client
  }

  return null;
}

// =============================================================================
// Token Routing
// =============================================================================

/**
 * Result of routing a refresh token.
 */
export interface RefreshTokenRouteResult {
  stub: DurableObjectStub;
  shardIndex: number | null;
  instanceName: string;
  regionKey: string | null;
  isRegionAware: boolean;
  isLegacy: boolean;
}

/**
 * Route a refresh token to the appropriate DO instance with region support.
 *
 * @param env - Environment with DO bindings
 * @param jti - Token JTI
 * @param clientId - Client identifier
 * @param tenantId - Tenant ID (default: 'default')
 * @returns Route result with DO stub and routing info
 */
export function routeRefreshTokenWithRegion(
  env: Env,
  jti: string,
  clientId: string,
  tenantId: string = DEFAULT_TENANT_ID
): RefreshTokenRouteResult {
  const parsed = parseRefreshTokenJti(jti);

  // Region-aware format: use embedded region/shard info with locationHint
  if (parsed.isRegionAware && parsed.regionKey && parsed.shardIndex !== null) {
    const instanceName = buildRegionAwareRefreshTokenInstanceName(
      tenantId,
      parsed.regionKey,
      parsed.shardIndex
    );
    const stub = getRegionAwareDOStub(env.REFRESH_TOKEN_ROTATOR, instanceName, parsed.regionKey);
    return {
      stub,
      shardIndex: parsed.shardIndex,
      instanceName,
      regionKey: parsed.regionKey,
      isRegionAware: true,
      isLegacy: false,
    };
  }

  // Legacy format: use existing routing
  const rotatorId = getRefreshTokenRotatorId(env, clientId, parsed.generation, parsed.shardIndex);
  const stub = env.REFRESH_TOKEN_ROTATOR.get(rotatorId);
  const instanceName = buildRefreshTokenRotatorInstanceName(
    clientId,
    parsed.generation,
    parsed.shardIndex,
    tenantId
  );

  return {
    stub,
    shardIndex: parsed.shardIndex,
    instanceName,
    regionKey: null,
    isRegionAware: false,
    isLegacy: parsed.isLegacy,
  };
}

/**
 * Route a refresh token to the appropriate DO instance.
 * @deprecated Use routeRefreshTokenWithRegion for better region support
 *
 * @param env - Environment with DO bindings
 * @param jti - Token JTI
 * @param clientId - Client identifier
 * @returns Durable Object stub for the RefreshTokenRotator
 */
export function routeRefreshToken(env: Env, jti: string, clientId: string): DurableObjectStub {
  const result = routeRefreshTokenWithRegion(env, jti, clientId);
  return result.stub;
}

/**
 * Get routing information for a refresh token (for logging/debugging).
 *
 * @param jti - Token JTI
 * @param clientId - Client identifier
 * @param tenantId - Tenant ID (default: 'default')
 * @returns Routing information
 */
export function getRefreshTokenRoutingInfo(
  jti: string,
  clientId: string,
  tenantId: string = DEFAULT_TENANT_ID
): {
  generation: number;
  shardIndex: number | null;
  regionKey: string | null;
  instanceName: string;
  isLegacy: boolean;
  isRegionAware: boolean;
} {
  const parsed = parseRefreshTokenJti(jti);

  let instanceName: string;
  if (parsed.isRegionAware && parsed.regionKey && parsed.shardIndex !== null) {
    instanceName = buildRegionAwareRefreshTokenInstanceName(
      tenantId,
      parsed.regionKey,
      parsed.shardIndex
    );
  } else {
    instanceName = buildRefreshTokenRotatorInstanceName(
      clientId,
      parsed.generation,
      parsed.shardIndex,
      tenantId
    );
  }

  return {
    generation: parsed.generation,
    shardIndex: parsed.shardIndex,
    regionKey: parsed.regionKey,
    instanceName,
    isLegacy: parsed.isLegacy,
    isRegionAware: parsed.isRegionAware,
  };
}

// =============================================================================
// Region-Aware JTI Generation
// =============================================================================

/**
 * Result of generating a region-aware refresh token JTI.
 */
export interface RegionAwareRefreshTokenJtiResult {
  jti: string;
  generation: number;
  shardIndex: number;
  regionKey: string;
  instanceName: string;
}

/**
 * Generate a new region-aware JTI for refresh tokens.
 *
 * Uses region_shard_config for shard distribution across regions.
 *
 * @param env - Environment object with KV bindings
 * @param userId - User identifier (for shard calculation)
 * @param clientId - Client identifier (for shard calculation)
 * @param tenantId - Tenant ID (default: 'default')
 * @returns Promise containing the new JTI and routing info
 */
export async function generateRegionAwareRefreshTokenJti(
  env: Env,
  userId: string,
  clientId: string,
  tenantId: string = DEFAULT_TENANT_ID
): Promise<RegionAwareRefreshTokenJtiResult> {
  const config = await getRegionShardConfig(env, tenantId);
  const randomPart = generateRefreshTokenRandomPart();

  // Use userId:clientId as shard key for consistent routing
  const shardKey = `${userId}:${clientId}`;
  const resolution = resolveShardForNewResource(config, shardKey);

  const jti = createRegionAwareRefreshTokenJti(
    resolution.generation,
    resolution.regionKey,
    resolution.shardIndex,
    randomPart
  );

  const instanceName = buildRegionAwareRefreshTokenInstanceName(
    tenantId,
    resolution.regionKey,
    resolution.shardIndex
  );

  return {
    jti,
    generation: resolution.generation,
    shardIndex: resolution.shardIndex,
    regionKey: resolution.regionKey,
    instanceName,
  };
}
