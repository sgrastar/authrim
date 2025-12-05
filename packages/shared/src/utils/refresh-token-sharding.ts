/**
 * Refresh Token Sharding Utilities
 *
 * Generation-based sharding for RefreshTokenRotator Durable Objects.
 * Enables dynamic shard count changes without breaking existing tokens.
 *
 * Key Features:
 * - Generation-based routing (each generation has fixed shard count)
 * - Legacy token compatibility (generation=0)
 * - SHA-256 hash-based shard assignment
 * - KV-based configuration with caching
 *
 * @see docs/architecture/refresh-token-sharding.md
 */

import type { Env } from '../types/env';
import { DEFAULT_TENANT_ID } from './tenant-context';

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
  /** Random part of the JTI */
  randomPart: string;
  /** Whether this is a legacy format token */
  isLegacy: boolean;
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
export const DEFAULT_REFRESH_TOKEN_SHARD_COUNT = 8;

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
 * Parse a refresh token JTI to extract generation and shard information.
 *
 * JTI Formats:
 * - New format: v{generation}_{shardIndex}_{randomPart}
 * - Legacy format: rt_{uuid} (treated as generation=0)
 *
 * @param jti - JWT ID to parse
 * @returns Parsed JTI information
 *
 * @example
 * parseRefreshTokenJti('v1_7_rt_abc123')
 * // => { generation: 1, shardIndex: 7, randomPart: 'rt_abc123', isLegacy: false }
 *
 * parseRefreshTokenJti('rt_abc123')
 * // => { generation: 0, shardIndex: null, randomPart: 'rt_abc123', isLegacy: true }
 */
export function parseRefreshTokenJti(jti: string): ParsedRefreshTokenJti {
  // New format: v{gen}_{shard}_{random}
  const newFormatMatch = jti.match(/^v(\d+)_(\d+)_(.+)$/);
  if (newFormatMatch) {
    return {
      generation: parseInt(newFormatMatch[1], 10),
      shardIndex: parseInt(newFormatMatch[2], 10),
      randomPart: newFormatMatch[3],
      isLegacy: false,
    };
  }

  // Legacy format: anything without v{gen}_{shard}_ prefix
  return {
    generation: 0,
    shardIndex: null,
    randomPart: jti,
    isLegacy: true,
  };
}

/**
 * Create a new-format JTI for refresh tokens.
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
 * Build a Durable Object instance name for RefreshTokenRotator.
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

  if (env.KV) {
    // Client-specific
    const clientConfig = await env.KV.get<RefreshTokenShardConfig>(
      buildShardConfigKvKey(clientId),
      'json'
    );
    if (clientConfig) {
      config = clientConfig;
    } else {
      // Global fallback
      const globalConfig = await env.KV.get<RefreshTokenShardConfig>(
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
  if (!env.KV) {
    throw new Error('KV binding not available');
  }

  await env.KV.put(buildShardConfigKvKey(clientId), JSON.stringify(config));

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
 * Route a refresh token to the appropriate DO instance.
 *
 * @param env - Environment with DO bindings
 * @param jti - Token JTI
 * @param clientId - Client identifier
 * @returns Durable Object stub for the RefreshTokenRotator
 */
export function routeRefreshToken(env: Env, jti: string, clientId: string): DurableObjectStub {
  const parsed = parseRefreshTokenJti(jti);

  const rotatorId = getRefreshTokenRotatorId(env, clientId, parsed.generation, parsed.shardIndex);

  return env.REFRESH_TOKEN_ROTATOR.get(rotatorId);
}

/**
 * Get routing information for a refresh token (for logging/debugging).
 *
 * @param jti - Token JTI
 * @param clientId - Client identifier
 * @returns Routing information
 */
export function getRefreshTokenRoutingInfo(
  jti: string,
  clientId: string
): {
  generation: number;
  shardIndex: number | null;
  instanceName: string;
  isLegacy: boolean;
} {
  const parsed = parseRefreshTokenJti(jti);
  const instanceName = buildRefreshTokenRotatorInstanceName(
    clientId,
    parsed.generation,
    parsed.shardIndex
  );

  return {
    generation: parsed.generation,
    shardIndex: parsed.shardIndex,
    instanceName,
    isLegacy: parsed.isLegacy,
  };
}
