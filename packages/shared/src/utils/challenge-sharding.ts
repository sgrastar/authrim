/**
 * ChallengeStore Sharding Helper
 *
 * Provides utilities for routing ChallengeStore operations to sharded
 * Durable Object instances based on email address.
 *
 * DO instance name: tenant:default:challenge:shard-{shardIndex}
 *
 * Sharding Strategy:
 * - Email-based sharding: fnv1a32(email.toLowerCase()) % shardCount
 * - Same email always routes to same shard (locality for same user)
 * - Consistent with SessionStore/AuthCodeStore patterns
 *
 * Configuration:
 * - KV: AUTHRIM_CONFIG namespace, key: "challenge_shards"
 * - Environment variable: AUTHRIM_CHALLENGE_SHARDS
 * - Default: 16 shards
 */

import type { Env } from '../types/env';
import type { ChallengeStore } from '../durable-objects/ChallengeStore';
import { fnv1a32, DEFAULT_TENANT_ID } from './tenant-context';

/**
 * Default shard count for challenge store sharding.
 * Can be overridden via KV or AUTHRIM_CHALLENGE_SHARDS environment variable.
 */
export const DEFAULT_CHALLENGE_SHARD_COUNT = 16;

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
 * 3. Default (DEFAULT_CHALLENGE_SHARD_COUNT = 16)
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
 * Uses FNV-1a hash for fast, synchronous calculation with good distribution.
 *
 * @param email - Email address (will be lowercased)
 * @param shardCount - Number of shards
 * @returns Shard index (0 to shardCount - 1)
 *
 * @example
 * const shardIndex = getChallengeShardIndexByEmail("user@example.com", 16);
 * // Always returns same shard for same email
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
 * Routes to the appropriate shard based on the email hash.
 *
 * @param env - Environment object with DO bindings
 * @param email - Email address for sharding
 * @returns Promise<DurableObjectStub<ChallengeStore>> for the challenge shard
 *
 * @example
 * const challengeStore = await getChallengeStoreByEmail(env, "user@example.com");
 * await challengeStore.storeChallengeRpc({ ... });
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
