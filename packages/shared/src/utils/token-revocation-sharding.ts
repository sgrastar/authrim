/**
 * TokenRevocationStore Sharding Helper (Generation-Based with Region Sharding)
 *
 * Provides utilities for routing TokenRevocationStore operations to sharded
 * Durable Object instances based on JTI (JWT ID).
 *
 * Generation-Based Sharding Strategy:
 * - Region-aware JTI format: g{gen}:{region}:{shard}:{randomPart}
 * - Legacy JTI format: rv{generation}_{shardIndex}_{randomPart}
 * - Very old format: any other format (uses LEGACY_SHARD_COUNT for routing)
 * - Enables dynamic shard count and region changes without breaking existing tokens
 * - Each generation has fixed shard count, stored in KV
 * - locationHint support for DO placement optimization
 *
 * DO instance name (region-aware): {tenantId}:{region}:rv:{shardIndex}
 * DO instance name (legacy): tenant:default:token-revocation:shard-{shardIndex}
 *
 * Configuration:
 * - KV: AUTHRIM_CONFIG namespace, key: "region_shard_config:default" (for region-aware)
 * - KV: AUTHRIM_CONFIG namespace, key: "revocation_shard_config" (JSON, legacy)
 * - Fallback KV key: "revocation_shards" (simple number, for backward compat)
 * - Environment variable: AUTHRIM_REVOCATION_SHARDS
 * - Default: 16 shards
 *
 * @see region-sharding.ts for region sharding design
 * @see refresh-token-sharding.ts for design reference
 */

import type { Env } from '../types/env';
import { fnv1a32, DEFAULT_TENANT_ID } from './tenant-context';
import {
  getRegionShardConfig,
  resolveShardForNewResource,
  resolveRegionForShard,
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
 * Parsed JTI for access tokens (revocation routing).
 */
export interface ParsedRevocationJti {
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
export interface RevocationGenerationConfig {
  generation: number;
  shardCount: number;
  deprecatedAt?: number;
}

/**
 * Full shard configuration from KV.
 */
export interface RevocationShardConfig {
  /** Current generation number */
  currentGeneration: number;
  /** Number of shards in current generation */
  currentShardCount: number;
  /** Previous generation configs (for routing existing tokens) */
  previousGenerations: RevocationGenerationConfig[];
  /** Last update timestamp (ms) */
  updatedAt: number;
  /** Who updated the config */
  updatedBy?: string;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Default shard count for token revocation store sharding.
 * Can be overridden via KV or AUTHRIM_REVOCATION_SHARDS environment variable.
 */
export const DEFAULT_REVOCATION_SHARD_COUNT = 16;

/**
 * Legacy shard count used for tokens without generation info.
 * This should match the original default to ensure backward compatibility.
 */
export const LEGACY_SHARD_COUNT = 4;

/**
 * Cache TTL for shard configuration (10 seconds).
 * Matches other sharding utilities for consistency.
 */
const CACHE_TTL_MS = 10_000;

/**
 * Maximum number of previous generations to keep.
 */
export const MAX_REVOCATION_PREVIOUS_GENERATIONS = 5;

/**
 * KV key for full shard configuration (JSON).
 */
export const REVOCATION_SHARD_CONFIG_KEY = 'revocation_shard_config';

/**
 * KV key for simple shard count (backward compat).
 */
export const REVOCATION_SHARDS_KEY = 'revocation_shards';

// =============================================================================
// JTI Parsing and Creation
// =============================================================================

/**
 * Parse a JTI to extract generation, region, and shard information.
 *
 * JTI Formats:
 * - Region-aware format: g{gen}:{region}:{shard}:{randomPart}
 * - Legacy format: rv{generation}_{shardIndex}_{randomPart}
 * - Very old format: anything without prefix (uses LEGACY_SHARD_COUNT for routing)
 *
 * @param jti - JWT ID to parse
 * @returns Parsed JTI information
 *
 * @example
 * parseRevocationJti('g1:wnam:7:at_abc123')
 * // => { generation: 1, shardIndex: 7, regionKey: 'wnam', randomPart: 'at_abc123', isLegacy: false, isRegionAware: true }
 *
 * parseRevocationJti('rv1_7_at_abc123')
 * // => { generation: 1, shardIndex: 7, regionKey: null, randomPart: 'at_abc123', isLegacy: false, isRegionAware: false }
 *
 * parseRevocationJti('at_abc123')
 * // => { generation: 0, shardIndex: null, regionKey: null, randomPart: 'at_abc123', isLegacy: true, isRegionAware: false }
 */
export function parseRevocationJti(jti: string): ParsedRevocationJti {
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

  // Legacy format: rv{gen}_{shard}_{random}
  const legacyFormatMatch = jti.match(/^rv(\d+)_(\d+)_(.+)$/);
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
 * Create a region-aware JTI for access tokens (revocation-aware).
 *
 * @param generation - Generation number
 * @param regionKey - Region key
 * @param shardIndex - Shard index
 * @param randomPart - Random part (typically at_{uuid})
 * @returns Formatted JTI string
 *
 * @example
 * createRegionAwareRevocationJti(1, 'wnam', 7, 'at_abc123')
 * // => 'g1:wnam:7:at_abc123'
 */
export function createRegionAwareRevocationJti(
  generation: number,
  regionKey: string,
  shardIndex: number,
  randomPart: string
): string {
  return createRegionId(generation, regionKey, shardIndex, randomPart);
}

/**
 * Create a legacy-format JTI for access tokens (revocation-aware).
 * @deprecated Use createRegionAwareRevocationJti for new tokens
 *
 * @param generation - Generation number
 * @param shardIndex - Shard index
 * @param randomPart - Random part (typically at_{uuid})
 * @returns Formatted JTI string
 *
 * @example
 * createRevocationJti(1, 7, 'at_abc123')
 * // => 'rv1_7_at_abc123'
 */
export function createRevocationJti(
  generation: number,
  shardIndex: number,
  randomPart: string
): string {
  return `rv${generation}_${shardIndex}_${randomPart}`;
}

/**
 * Generate a random part for access token JTI.
 *
 * @returns Random JTI part in format at_{uuid}
 */
export function generateAccessTokenRandomPart(): string {
  return `at_${crypto.randomUUID()}`;
}

// =============================================================================
// In-Memory Caching
// =============================================================================

/**
 * Cached revocation shard config.
 */
let cachedRevocationConfig: RevocationShardConfig | null = null;
let cachedRevocationConfigAt = 0;

/**
 * Legacy cache for simple shard count (backward compat).
 */
let cachedRevocationShardCount: number | null = null;
let cachedRevocationShardAt = 0;

// =============================================================================
// Configuration Loading
// =============================================================================

/**
 * Get current revocation shard configuration from KV.
 *
 * Priority:
 * 1. KV: revocation_shard_config (full JSON config)
 * 2. KV: revocation_shards (simple number, converted to config)
 * 3. Environment variable: AUTHRIM_REVOCATION_SHARDS
 * 4. Default configuration
 *
 * @param env - Environment object with KV and variables
 * @returns Revocation shard configuration
 */
export async function getRevocationShardConfig(env: Env): Promise<RevocationShardConfig> {
  const now = Date.now();

  // Check cache
  if (cachedRevocationConfig !== null && now - cachedRevocationConfigAt < CACHE_TTL_MS) {
    return cachedRevocationConfig;
  }

  let config: RevocationShardConfig | null = null;

  if (env.AUTHRIM_CONFIG) {
    // Try full config first
    const fullConfig = await env.AUTHRIM_CONFIG.get<RevocationShardConfig>(
      REVOCATION_SHARD_CONFIG_KEY,
      { type: 'json' }
    );
    if (fullConfig) {
      config = fullConfig;
    } else {
      // Fallback to simple shard count
      const simpleCount = await env.AUTHRIM_CONFIG.get(REVOCATION_SHARDS_KEY);
      if (simpleCount) {
        const parsed = parseInt(simpleCount, 10);
        if (!isNaN(parsed) && parsed > 0) {
          // Convert simple count to config format
          config = {
            currentGeneration: 1,
            currentShardCount: parsed,
            previousGenerations: [
              {
                generation: 0,
                shardCount: LEGACY_SHARD_COUNT,
              },
            ],
            updatedAt: now,
          };
        }
      }
    }
  }

  // Fallback to environment variable
  if (!config && env.AUTHRIM_REVOCATION_SHARDS) {
    const parsed = parseInt(env.AUTHRIM_REVOCATION_SHARDS, 10);
    if (!isNaN(parsed) && parsed > 0) {
      config = {
        currentGeneration: 1,
        currentShardCount: parsed,
        previousGenerations: [
          {
            generation: 0,
            shardCount: LEGACY_SHARD_COUNT,
          },
        ],
        updatedAt: now,
      };
    }
  }

  // Default configuration
  if (!config) {
    config = {
      currentGeneration: 1,
      currentShardCount: DEFAULT_REVOCATION_SHARD_COUNT,
      previousGenerations: [],
      updatedAt: now,
    };
  }

  // Update cache
  cachedRevocationConfig = config;
  cachedRevocationConfigAt = now;

  return config;
}

/**
 * Get current revocation shard count (backward-compatible function).
 *
 * @param env - Environment object
 * @returns Current revocation shard count
 */
export async function getRevocationShardCount(env: Env): Promise<number> {
  const config = await getRevocationShardConfig(env);
  return config.currentShardCount;
}

/**
 * Find shard count for a specific revocation generation.
 *
 * @param config - Shard configuration
 * @param generation - Generation number to look up
 * @returns Shard count for the generation
 */
export function findRevocationGenerationShardCount(
  config: RevocationShardConfig,
  generation: number
): number {
  // Current generation
  if (generation === config.currentGeneration) {
    return config.currentShardCount;
  }

  // Previous generations
  const prev = config.previousGenerations.find((g) => g.generation === generation);
  if (prev) {
    return prev.shardCount;
  }

  // Legacy generation (0) or unknown - use LEGACY_SHARD_COUNT
  return LEGACY_SHARD_COUNT;
}

// =============================================================================
// Shard Index Calculation
// =============================================================================

/**
 * Calculate shard index from JTI (JWT ID) using hash.
 * Used only for legacy tokens without embedded shard info.
 *
 * @param jti - JWT ID
 * @param shardCount - Number of shards
 * @returns Shard index (0 to shardCount - 1)
 */
export function getRevocationShardIndex(jti: string, shardCount: number): number {
  return fnv1a32(jti) % shardCount;
}

/**
 * Calculate shard index for a new token.
 * Uses random assignment for even distribution.
 *
 * @param shardCount - Number of shards
 * @returns Shard index (0 to shardCount - 1)
 */
export function getRandomShardIndex(shardCount: number): number {
  return Math.floor(Math.random() * shardCount);
}

// =============================================================================
// DO Instance Name Building
// =============================================================================

/**
 * Build a region-aware Durable Object instance name for token revocation.
 *
 * @param tenantId - Tenant ID
 * @param regionKey - Region key
 * @param shardIndex - Shard index
 * @returns DO instance name for the shard
 *
 * @example
 * buildRegionAwareRevocationInstanceName('default', 'wnam', 7)
 * // => "default:wnam:rv:7"
 */
export function buildRegionAwareRevocationInstanceName(
  tenantId: string,
  regionKey: string,
  shardIndex: number
): string {
  return buildRegionInstanceName(tenantId, regionKey, 'revocation', shardIndex);
}

/**
 * Build a legacy sharded Durable Object instance name for token revocation.
 * @deprecated Use buildRegionAwareRevocationInstanceName for new tokens
 *
 * @param shardIndex - Shard index
 * @returns DO instance name for the shard
 *
 * @example
 * buildRevocationShardInstanceName(2)
 * // => "tenant:default:token-revocation:shard-2"
 */
export function buildRevocationShardInstanceName(shardIndex: number): string {
  return `tenant:${DEFAULT_TENANT_ID}:token-revocation:shard-${shardIndex}`;
}

// =============================================================================
// Main Routing Function
// =============================================================================

/**
 * Result of getting a revocation store.
 */
export interface RevocationStoreResult {
  stub: DurableObjectStub;
  shardIndex: number;
  instanceName: string;
  regionKey: string | null;
  isRegionAware: boolean;
}

/**
 * Get TokenRevocationStore Durable Object stub for a JTI.
 *
 * Routes based on:
 * - Region-aware format (g{gen}:{region}:{shard}:{random}): Uses embedded region/shard info with locationHint
 * - Legacy format (rv{gen}_{shard}_{random}): Uses embedded shard info without locationHint
 * - Very old format: Uses hash-based routing with LEGACY_SHARD_COUNT
 *
 * @param env - Environment object with DO bindings
 * @param jti - JWT ID for sharding
 * @param tenantId - Tenant ID (default: 'default')
 * @returns Promise containing DO stub and shard info
 */
export async function getRevocationStoreByJti(
  env: Env,
  jti: string,
  tenantId: string = DEFAULT_TENANT_ID
): Promise<RevocationStoreResult> {
  const parsed = parseRevocationJti(jti);

  // Region-aware format: use embedded region/shard info with locationHint
  if (parsed.isRegionAware && parsed.regionKey && parsed.shardIndex !== null) {
    const instanceName = buildRegionAwareRevocationInstanceName(
      tenantId,
      parsed.regionKey,
      parsed.shardIndex
    );
    const stub = getRegionAwareDOStub(env.TOKEN_REVOCATION_STORE, instanceName, parsed.regionKey);
    return {
      stub,
      shardIndex: parsed.shardIndex,
      instanceName,
      regionKey: parsed.regionKey,
      isRegionAware: true,
    };
  }

  // Legacy or very old format
  let shardIndex: number;

  if (parsed.isLegacy) {
    // Very old token: use hash-based routing with LEGACY_SHARD_COUNT
    shardIndex = getRevocationShardIndex(jti, LEGACY_SHARD_COUNT);
  } else {
    // Legacy format (rv{gen}_{shard}_{random}): use embedded shard index
    const config = await getRevocationShardConfig(env);
    const generationShardCount = findRevocationGenerationShardCount(config, parsed.generation);

    if (parsed.shardIndex !== null && parsed.shardIndex < generationShardCount) {
      shardIndex = parsed.shardIndex;
    } else {
      // Invalid shard index - fall back to hash-based routing
      console.warn(
        `Invalid shard index ${parsed.shardIndex} for generation ${parsed.generation} (max: ${generationShardCount}). Falling back to hash.`
      );
      shardIndex = getRevocationShardIndex(parsed.randomPart, generationShardCount);
    }
  }

  const instanceName = buildRevocationShardInstanceName(shardIndex);
  const id = env.TOKEN_REVOCATION_STORE.idFromName(instanceName);
  const stub = env.TOKEN_REVOCATION_STORE.get(id);

  return {
    stub,
    shardIndex,
    instanceName,
    regionKey: null,
    isRegionAware: false,
  };
}

// =============================================================================
// JTI Generation for New Tokens
// =============================================================================

/**
 * Result of generating a region-aware JTI.
 */
export interface RegionAwareJtiResult {
  jti: string;
  generation: number;
  shardIndex: number;
  regionKey: string;
  instanceName: string;
}

/**
 * Generate a new region-aware JTI with embedded generation, region, and shard information.
 *
 * Uses region_shard_config for shard distribution across regions.
 *
 * @param env - Environment object with KV bindings
 * @param tenantId - Tenant ID (default: 'default')
 * @returns Promise containing the new JTI and routing info
 */
export async function generateRegionAwareJti(
  env: Env,
  tenantId: string = DEFAULT_TENANT_ID
): Promise<RegionAwareJtiResult> {
  const config = await getRegionShardConfig(env, tenantId);
  const randomPart = generateAccessTokenRandomPart();

  // Use a random shard key for even distribution
  const shardKey = crypto.randomUUID();
  const resolution = resolveShardForNewResource(config, shardKey);

  const jti = createRegionAwareRevocationJti(
    resolution.generation,
    resolution.regionKey,
    resolution.shardIndex,
    randomPart
  );

  const instanceName = buildRegionAwareRevocationInstanceName(
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

/**
 * Generate a new JTI with embedded shard information.
 * @deprecated Use generateRegionAwareJti for new tokens
 *
 * @param env - Environment object with KV bindings
 * @returns Promise containing the new JTI and shard info
 */
export async function generateShardedJti(
  env: Env
): Promise<{ jti: string; generation: number; shardIndex: number }> {
  const config = await getRevocationShardConfig(env);
  const generation = config.currentGeneration;
  const shardCount = config.currentShardCount;
  const shardIndex = getRandomShardIndex(shardCount);
  const randomPart = generateAccessTokenRandomPart();
  const jti = createRevocationJti(generation, shardIndex, randomPart);

  return { jti, generation, shardIndex };
}

// =============================================================================
// Configuration Management
// =============================================================================

/**
 * Save revocation shard configuration to KV.
 *
 * @param env - Environment with KV binding
 * @param config - Configuration to save
 */
export async function saveRevocationShardConfig(
  env: Env,
  config: RevocationShardConfig
): Promise<void> {
  if (!env.AUTHRIM_CONFIG) {
    throw new Error('AUTHRIM_CONFIG KV binding not available');
  }

  await env.AUTHRIM_CONFIG.put(REVOCATION_SHARD_CONFIG_KEY, JSON.stringify(config));

  // Clear cache
  resetRevocationShardCountCache();
}

/**
 * Create a new generation with updated shard count.
 *
 * @param currentConfig - Current configuration
 * @param newShardCount - New shard count
 * @param updatedBy - Who is making the change
 * @returns Updated configuration
 */
export function createNewRevocationGeneration(
  currentConfig: RevocationShardConfig,
  newShardCount: number,
  updatedBy?: string
): RevocationShardConfig {
  const now = Date.now();

  // Add current generation to previous generations
  const previousGenerations: RevocationGenerationConfig[] = [
    {
      generation: currentConfig.currentGeneration,
      shardCount: currentConfig.currentShardCount,
      deprecatedAt: now,
    },
    ...currentConfig.previousGenerations,
  ].slice(0, MAX_REVOCATION_PREVIOUS_GENERATIONS);

  return {
    currentGeneration: currentConfig.currentGeneration + 1,
    currentShardCount: newShardCount,
    previousGenerations,
    updatedAt: now,
    updatedBy,
  };
}

/**
 * Reset the cached shard count/config.
 * Useful for testing or when immediate configuration reload is needed.
 */
export function resetRevocationShardCountCache(): void {
  cachedRevocationShardCount = null;
  cachedRevocationShardAt = 0;
  cachedRevocationConfig = null;
  cachedRevocationConfigAt = 0;
}

/**
 * Get all shard instance names for iteration/health checks.
 *
 * @param shardCount - Number of shards
 * @returns Array of shard instance names
 */
export function getAllRevocationShardNames(shardCount: number): string[] {
  return Array.from({ length: shardCount }, (_, i) => buildRevocationShardInstanceName(i));
}
