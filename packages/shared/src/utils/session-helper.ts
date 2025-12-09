/**
 * Session Store Sharding Helper
 *
 * Provides utilities for generating sharded session IDs and routing
 * session operations to the correct Durable Object shard.
 *
 * Session ID format: {shardIndex}_session_{uuid}
 * DO instance name: tenant:default:session:shard-{shardIndex}
 *
 * IMPORTANT:
 * - generateShardedSessionId() uses FNV-1a hash of UUID to determine shard
 * - parseShardedSessionId() only parses the prefix (no re-hashing)
 * - This prevents "generation vs retrieval shard mismatch" bugs
 */

import type { Env } from '../types/env';
import {
  fnv1a32,
  getSessionShardCount,
  buildSessionShardInstanceName,
  remapShardIndex,
  DEFAULT_SESSION_SHARD_COUNT,
} from './tenant-context';

/**
 * Generate a new sharded session ID.
 *
 * Uses FNV-1a hash of the UUID to determine which shard the session belongs to.
 * The shard index is embedded in the session ID for later retrieval.
 *
 * @param shardCount - Number of shards (default: 32)
 * @returns Object containing sessionId and shardIndex
 *
 * @example
 * const { sessionId, shardIndex } = generateShardedSessionId(32);
 * // sessionId: "7_session_abc123-def456-..."
 * // shardIndex: 7
 */
export function generateShardedSessionId(shardCount: number = DEFAULT_SESSION_SHARD_COUNT): {
  sessionId: string;
  shardIndex: number;
} {
  const uuid = crypto.randomUUID();
  const shardIndex = fnv1a32(uuid) % shardCount;
  return {
    sessionId: `${shardIndex}_session_${uuid}`,
    shardIndex,
  };
}

/**
 * Parse a sharded session ID to extract shard index and UUID.
 *
 * IMPORTANT: This function only parses the prefix - it does NOT re-hash.
 * The shard index is extracted directly from the session ID format.
 *
 * @param sessionId - Sharded session ID (format: {shardIndex}_session_{uuid})
 * @returns Object containing shardIndex and uuid, or null if invalid format
 *
 * @example
 * const result = parseShardedSessionId("7_session_abc123");
 * // { shardIndex: 7, uuid: "abc123" }
 *
 * const invalid = parseShardedSessionId("invalid-session-id");
 * // null
 */
export function parseShardedSessionId(
  sessionId: string
): { shardIndex: number; uuid: string } | null {
  // Format: {shardIndex}_session_{uuid}
  const match = sessionId.match(/^(\d+)_session_(.+)$/);
  if (!match) {
    return null;
  }

  const shardIndex = parseInt(match[1], 10);
  if (isNaN(shardIndex) || shardIndex < 0) {
    return null;
  }

  return {
    shardIndex,
    uuid: match[2],
  };
}

/**
 * Get SessionStore Durable Object stub for an existing session ID.
 *
 * Parses the session ID to extract the shard index, then routes to
 * the correct DO instance. Supports scale-down via remapShardIndex().
 *
 * @param env - Environment object with DO bindings
 * @param sessionId - Sharded session ID
 * @returns Promise<DurableObjectStub> for the session's shard
 * @throws Error if sessionId format is invalid
 *
 * @example
 * const store = await getSessionStoreBySessionId(env, "7_session_abc123");
 * const response = await store.fetch(new Request(...));
 */
export async function getSessionStoreBySessionId(env: Env, sessionId: string) {
  const parsed = parseShardedSessionId(sessionId);
  if (!parsed) {
    throw new Error(`Invalid session ID format: ${sessionId}`);
  }

  // Get current shard count (cached for 10 seconds) and remap for scale-down support
  const currentShardCount = await getSessionShardCount(env);
  const actualShardIndex = remapShardIndex(parsed.shardIndex, currentShardCount);

  const instanceName = buildSessionShardInstanceName(actualShardIndex);
  const id = env.SESSION_STORE.idFromName(instanceName);
  return env.SESSION_STORE.get(id);
}

/**
 * Get SessionStore Durable Object stub and generate a new session ID.
 *
 * This is the entry point for creating new sessions. It:
 * 1. Gets the current shard count from KV/environment
 * 2. Generates a new sharded session ID
 * 3. Returns the DO stub for the target shard
 *
 * @param env - Environment object with DO bindings
 * @returns Object containing DO stub and new sessionId
 *
 * @example
 * const { stub, sessionId } = await getSessionStoreForNewSession(env);
 * const response = await stub.fetch(new Request(..., {
 *   body: JSON.stringify({ sessionId, ... })
 * }));
 */
export async function getSessionStoreForNewSession(env: Env) {
  const shardCount = await getSessionShardCount(env);
  const { sessionId, shardIndex } = generateShardedSessionId(shardCount);

  const instanceName = buildSessionShardInstanceName(shardIndex);
  const id = env.SESSION_STORE.idFromName(instanceName);
  const stub = env.SESSION_STORE.get(id);

  return { stub, sessionId };
}

/**
 * Check if a session ID is in the sharded format.
 *
 * @param sessionId - Session ID to check
 * @returns true if the session ID follows the sharded format
 */
export function isShardedSessionId(sessionId: string): boolean {
  return parseShardedSessionId(sessionId) !== null;
}
