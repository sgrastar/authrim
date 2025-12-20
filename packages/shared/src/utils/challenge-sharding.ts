/**
 * ChallengeStore Sharding Helper (Region Sharding Version)
 *
 * Provides utilities for routing ChallengeStore operations to sharded
 * Durable Object instances with region-based locationHint.
 *
 * DO instance name: {tenantId}:{region}:ch:{shard}
 * Challenge ID format: g{gen}:{region}:{shard}:ch_{uuid}
 *
 * Sharding Strategy:
 * - Challenge ID or User ID based sharding with region distribution
 * - Same key always routes to same shard in same region
 * - locationHint ensures DO placement in optimal region
 *
 * Configuration:
 * - KV: region_shard_config:{tenantId} for dynamic region distribution
 * - Fallback to legacy shard count settings if region config not present
 */

import type { Env } from '../types/env';
import type { DurableObjectNamespace, DurableObjectStub } from '@cloudflare/workers-types';
import type { ChallengeStore } from '../durable-objects/ChallengeStore';
import { fnv1a32, DEFAULT_TENANT_ID } from './tenant-context';
import {
  getRegionShardConfig,
  resolveShardForNewResource,
  parseRegionId,
  createRegionId,
  buildRegionInstanceName,
  getRegionAwareDOStub,
  type ParsedRegionId,
  type ShardResolution,
} from './region-sharding';

/**
 * Type alias for ChallengeStore stub
 */
type ChallengeStoreStub = DurableObjectStub<ChallengeStore>;

/**
 * Default shard count for challenge store sharding.
 * Can be overridden via KV or AUTHRIM_CHALLENGE_SHARDS environment variable.
 */
export const DEFAULT_CHALLENGE_SHARD_COUNT = 4;

/**
 * Cache TTL for shard count (10 seconds).
 * Matches other sharding utilities for consistency.
 */
const CACHE_TTL_MS = 10_000;

/**
 * Cached challenge shard count to avoid repeated KV lookups.
 */
let cachedChallengeShardCount: number | null = null;
let cachedChallengeShardAt = 0;

/**
 * Get current challenge shard count from KV or environment variable.
 *
 * Priority:
 * 1. KV (AUTHRIM_CONFIG namespace, key: "challenge_shards")
 * 2. Environment variable (AUTHRIM_CHALLENGE_SHARDS)
 * 3. Default (DEFAULT_CHALLENGE_SHARD_COUNT = 4)
 *
 * @param env - Environment object with KV and variables
 * @returns Current challenge shard count
 */
async function getCurrentChallengeShardCount(env: Env): Promise<number> {
  // KV takes priority (allows dynamic changes without deployment)
  if (env.AUTHRIM_CONFIG) {
    const kvValue = await env.AUTHRIM_CONFIG.get('challenge_shards');
    if (kvValue) {
      const parsed = parseInt(kvValue, 10);
      if (!isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }

  // Fallback to environment variable
  if (env.AUTHRIM_CHALLENGE_SHARDS) {
    const parsed = parseInt(env.AUTHRIM_CHALLENGE_SHARDS, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }

  // Default value
  return DEFAULT_CHALLENGE_SHARD_COUNT;
}

/**
 * Get challenge shard count with caching.
 *
 * Caches the result for 10 seconds to minimize KV overhead.
 *
 * @param env - Environment object
 * @returns Current challenge shard count
 */
export async function getChallengeShardCount(env: Env): Promise<number> {
  const now = Date.now();

  // Return cached value if within TTL
  if (cachedChallengeShardCount !== null && now - cachedChallengeShardAt < CACHE_TTL_MS) {
    return cachedChallengeShardCount;
  }

  // Fetch fresh value
  const count = await getCurrentChallengeShardCount(env);

  // Update cache
  cachedChallengeShardCount = count;
  cachedChallengeShardAt = now;

  return count;
}

/**
 * Calculate shard index from email address.
 *
 * @deprecated Use getChallengeShardIndexByChallengeId or getChallengeShardIndexByUserId instead.
 * Email-based sharding includes PII in DO instance names.
 *
 * @param email - Email address (will be lowercased)
 * @param shardCount - Number of shards
 * @returns Shard index (0 to shardCount - 1)
 */
export function getChallengeShardIndexByEmail(email: string, shardCount: number): number {
  return fnv1a32(email.toLowerCase()) % shardCount;
}

/**
 * Calculate shard index from user ID.
 * Alternative to email-based sharding for authenticated flows.
 *
 * @param userId - User identifier
 * @param shardCount - Number of shards
 * @returns Shard index (0 to shardCount - 1)
 */
export function getChallengeShardIndexByUserId(userId: string, shardCount: number): number {
  return fnv1a32(userId) % shardCount;
}

/**
 * Build a sharded Durable Object instance name for challenges.
 *
 * @param shardIndex - Shard index
 * @returns DO instance name for the shard
 *
 * @example
 * buildChallengeShardInstanceName(7)
 * // => "tenant:default:challenge:shard-7"
 */
export function buildChallengeShardInstanceName(shardIndex: number): string {
  return `tenant:${DEFAULT_TENANT_ID}:challenge:shard-${shardIndex}`;
}

/**
 * Get ChallengeStore Durable Object stub for an email address.
 *
 * @deprecated Use getChallengeStoreByChallengeId or getChallengeStoreByUserId instead.
 * Email-based sharding includes PII in DO instance names, which is not recommended.
 * Use UUID-based sharding (challengeId, otpSessionId, userId) for better privacy.
 *
 * Routes to the appropriate shard based on the email hash.
 *
 * @param env - Environment object with DO bindings
 * @param email - Email address for sharding
 * @returns Promise<DurableObjectStub<ChallengeStore>> for the challenge shard
 */
export async function getChallengeStoreByEmail(
  env: Env,
  email: string
): Promise<DurableObjectStub<ChallengeStore>> {
  const shardCount = await getChallengeShardCount(env);
  const shardIndex = getChallengeShardIndexByEmail(email, shardCount);
  const instanceName = buildChallengeShardInstanceName(shardIndex);

  const id = env.CHALLENGE_STORE.idFromName(instanceName);
  return env.CHALLENGE_STORE.get(id);
}

/**
 * Get ChallengeStore Durable Object stub for a user ID.
 *
 * Routes to the appropriate shard based on the user ID hash.
 * Use this for authenticated flows where email may not be available.
 *
 * @param env - Environment object with DO bindings
 * @param userId - User identifier for sharding
 * @returns Promise<DurableObjectStub<ChallengeStore>> for the challenge shard
 *
 * @example
 * const challengeStore = await getChallengeStoreByUserId(env, userId);
 * await challengeStore.consumeChallengeRpc({ ... });
 */
export async function getChallengeStoreByUserId(
  env: Env,
  userId: string
): Promise<DurableObjectStub<ChallengeStore>> {
  const shardCount = await getChallengeShardCount(env);
  const shardIndex = getChallengeShardIndexByUserId(userId, shardCount);
  const instanceName = buildChallengeShardInstanceName(shardIndex);

  const id = env.CHALLENGE_STORE.idFromName(instanceName);
  return env.CHALLENGE_STORE.get(id);
}

/**
 * Get ChallengeStore using the legacy global instance.
 *
 * DEPRECATED: Use getChallengeStoreByEmail or getChallengeStoreByUserId instead.
 *
 * This function is provided for backward compatibility during migration.
 * The global instance will not be removed, but new code should use sharded access.
 *
 * @param env - Environment object with DO bindings
 * @returns DurableObjectStub<ChallengeStore> for the global (singleton) instance
 */
export function getChallengeStoreGlobal(env: Env): DurableObjectStub<ChallengeStore> {
  const id = env.CHALLENGE_STORE.idFromName('global');
  return env.CHALLENGE_STORE.get(id);
}

/**
 * Calculate shard index from a challenge ID (UUID).
 * Used when email is not available (e.g., passkey discoverable credentials).
 *
 * @param challengeId - Challenge identifier (UUID)
 * @param shardCount - Number of shards
 * @returns Shard index (0 to shardCount - 1)
 */
export function getChallengeShardIndexByChallengeId(
  challengeId: string,
  shardCount: number
): number {
  return fnv1a32(challengeId) % shardCount;
}

/**
 * Get ChallengeStore Durable Object stub by challenge ID.
 *
 * Routes to the appropriate shard based on the challenge ID hash.
 * Use this for passkey authentication where email may not be provided.
 *
 * @param env - Environment object with DO bindings
 * @param challengeId - Challenge identifier (UUID) for sharding
 * @returns Promise<DurableObjectStub<ChallengeStore>> for the challenge shard
 *
 * @example
 * const challengeStore = await getChallengeStoreByChallengeId(env, challengeId);
 * await challengeStore.consumeChallengeRpc({ ... });
 */
export async function getChallengeStoreByChallengeId(
  env: Env,
  challengeId: string
): Promise<DurableObjectStub<ChallengeStore>> {
  const shardCount = await getChallengeShardCount(env);
  const shardIndex = getChallengeShardIndexByChallengeId(challengeId, shardCount);
  const instanceName = buildChallengeShardInstanceName(shardIndex);

  const id = env.CHALLENGE_STORE.idFromName(instanceName);
  return env.CHALLENGE_STORE.get(id);
}

/**
 * Reset the cached shard count.
 * Useful for testing or when immediate configuration reload is needed.
 */
export function resetChallengeShardCountCache(): void {
  cachedChallengeShardCount = null;
  cachedChallengeShardAt = 0;
}

/**
 * Calculate shard index from a DID.
 *
 * @param did - Decentralized Identifier
 * @param shardCount - Number of shards
 * @returns Shard index (0 to shardCount - 1)
 */
export function getChallengeShardIndexByDID(did: string, shardCount: number): number {
  return fnv1a32(did) % shardCount;
}

/**
 * Get ChallengeStore Durable Object stub by DID.
 *
 * Routes to the appropriate shard based on the DID hash.
 * Use this for DID-based authentication flows.
 *
 * @param env - Environment object with DO bindings
 * @param did - Decentralized Identifier for sharding
 * @returns DurableObjectStub<ChallengeStore> for the challenge shard
 *
 * @example
 * const challengeStore = getChallengeStoreByDID(env, 'did:web:example.com');
 * await challengeStore.storeChallengeRpc({ ... });
 */
export function getChallengeStoreByDID(env: Env, did: string): DurableObjectStub<ChallengeStore> {
  // Use a synchronous version for DID - simpler since it's just for sharding
  const shardCount = cachedChallengeShardCount || DEFAULT_CHALLENGE_SHARD_COUNT;
  const shardIndex = getChallengeShardIndexByDID(did, shardCount);
  const instanceName = buildChallengeShardInstanceName(shardIndex);

  const id = env.CHALLENGE_STORE.idFromName(instanceName);
  return env.CHALLENGE_STORE.get(id);
}

// =============================================================================
// Region-Aware Functions (New)
// =============================================================================

/**
 * Generate a new region-sharded challenge ID.
 *
 * Uses FNV-1a hash of the shardKey to determine which shard the challenge belongs to,
 * then resolves the region from the shard index using the region shard config.
 *
 * @param env - Environment with KV binding for region shard config
 * @param shardKey - Key for shard calculation (e.g., userId, email, or challengeId)
 * @param tenantId - Tenant ID (default: 'default')
 * @returns Object containing challengeId, shardIndex, regionKey, and generation
 *
 * @example
 * const { challengeId, uuid, resolution } = await generateRegionShardedChallengeId(env, userId);
 * // challengeId: "g1:apac:3:ch_abc123-def456-..."
 */
export async function generateRegionShardedChallengeId(
  env: Env,
  shardKey: string,
  tenantId: string = DEFAULT_TENANT_ID
): Promise<{
  challengeId: string;
  uuid: string;
  shardIndex: number;
  regionKey: string;
  generation: number;
}> {
  const uuid = crypto.randomUUID();
  const config = await getRegionShardConfig(env, tenantId);
  const resolution = resolveShardForNewResource(config, shardKey);

  // Create challenge ID with embedded region info
  const challengeId = createRegionId(
    resolution.generation,
    resolution.regionKey,
    resolution.shardIndex,
    `ch_${uuid}`
  );

  return {
    challengeId,
    uuid,
    shardIndex: resolution.shardIndex,
    regionKey: resolution.regionKey,
    generation: resolution.generation,
  };
}

/**
 * Parse a region-sharded challenge ID to extract shard info.
 *
 * @param challengeId - Region-sharded challenge ID (format: g{gen}:{region}:{shard}:ch_{uuid})
 * @returns Parsed region ID with uuid, or null if invalid format
 *
 * @example
 * const result = parseRegionShardedChallengeId("g1:apac:3:ch_abc123");
 * // { generation: 1, regionKey: 'apac', shardIndex: 3, uuid: 'abc123' }
 */
export function parseRegionShardedChallengeId(
  challengeId: string
): (ParsedRegionId & { uuid: string }) | null {
  try {
    const parsed = parseRegionId(challengeId);
    // Verify this is a challenge ID
    if (!parsed.randomPart.startsWith('ch_')) {
      return null;
    }
    return {
      ...parsed,
      uuid: parsed.randomPart.substring(3), // Remove 'ch_' prefix
    };
  } catch {
    return null;
  }
}

/**
 * Check if a challenge ID is in the region-sharded format.
 *
 * @param challengeId - Challenge ID to check
 * @returns true if the challenge ID follows the region-sharded format
 */
export function isRegionShardedChallengeId(challengeId: string): boolean {
  return parseRegionShardedChallengeId(challengeId) !== null;
}

/**
 * Get ChallengeStore Durable Object stub for a region-sharded challenge ID.
 *
 * Parses the challenge ID to extract the region and shard info, then routes to
 * the correct DO instance with locationHint for optimal placement.
 *
 * @param env - Environment object with DO bindings
 * @param challengeId - Region-sharded challenge ID
 * @param tenantId - Tenant ID (default: 'default')
 * @returns Object containing DO stub and resolution info
 * @throws Error if challengeId format is invalid
 *
 * @example
 * const { stub, resolution } = getRegionAwareChallengeStore(env, "g1:apac:3:ch_abc123");
 * const response = await stub.consumeChallengeRpc({ ... });
 */
export function getRegionAwareChallengeStore(
  env: Env,
  challengeId: string,
  tenantId: string = DEFAULT_TENANT_ID
): {
  stub: ChallengeStoreStub;
  resolution: ShardResolution;
  instanceName: string;
} {
  const parsed = parseRegionShardedChallengeId(challengeId);
  if (!parsed) {
    throw new Error(`Invalid region-sharded challenge ID format: ${challengeId}`);
  }

  const resolution: ShardResolution = {
    generation: parsed.generation,
    regionKey: parsed.regionKey,
    shardIndex: parsed.shardIndex,
  };

  const instanceName = buildRegionInstanceName(
    tenantId,
    resolution.regionKey,
    'challenge',
    resolution.shardIndex
  );

  const stub = getRegionAwareDOStub(
    env.CHALLENGE_STORE as unknown as DurableObjectNamespace,
    instanceName,
    resolution.regionKey
  ) as ChallengeStoreStub;

  return { stub, resolution, instanceName };
}

/**
 * Get ChallengeStore Durable Object stub and generate a new challenge ID.
 *
 * This is the entry point for creating new challenges. It:
 * 1. Gets the region shard config from KV
 * 2. Generates a new region-sharded challenge ID
 * 3. Returns the DO stub with locationHint for the target region
 *
 * @param env - Environment object with DO bindings
 * @param shardKey - Key for shard calculation (e.g., userId, email)
 * @param tenantId - Tenant ID (default: 'default')
 * @returns Object containing DO stub, new challengeId, and resolution info
 *
 * @example
 * const { stub, challengeId, resolution } = await getRegionAwareChallengeStoreForNew(env, userId);
 * await stub.storeChallengeRpc({ id: challengeId, ... });
 */
export async function getRegionAwareChallengeStoreForNew(
  env: Env,
  shardKey: string,
  tenantId: string = DEFAULT_TENANT_ID
): Promise<{
  stub: ChallengeStoreStub;
  challengeId: string;
  uuid: string;
  resolution: ShardResolution;
  instanceName: string;
}> {
  const { challengeId, uuid, shardIndex, regionKey, generation } =
    await generateRegionShardedChallengeId(env, shardKey, tenantId);

  const resolution: ShardResolution = {
    generation,
    regionKey,
    shardIndex,
  };

  const instanceName = buildRegionInstanceName(tenantId, regionKey, 'challenge', shardIndex);
  const stub = getRegionAwareDOStub(
    env.CHALLENGE_STORE as unknown as DurableObjectNamespace,
    instanceName,
    regionKey
  ) as ChallengeStoreStub;

  return { stub, challengeId, uuid, resolution, instanceName };
}
