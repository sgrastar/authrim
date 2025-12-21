/**
 * Session Store Sharding Helper (Region Sharding Version)
 *
 * Provides utilities for generating region-sharded session IDs and routing
 * session operations to the correct Durable Object shard with locationHint.
 *
 * Session ID format: g{gen}:{region}:{shard}:session_{uuid}
 * DO instance name: {tenantId}:{region}:s:{shard}
 *
 * IMPORTANT:
 * - generateRegionShardedSessionId() uses region shard config to determine shard and region
 * - parseRegionShardedSessionId() extracts generation, region, and shard from the ID
 * - locationHint is used to place DO instances closer to users in specific regions
 */

import type { Env } from '../types/env';
import type { DurableObjectNamespace, DurableObjectStub } from '@cloudflare/workers-types';
import type { SessionStore } from '../durable-objects/SessionStore';
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
import { DEFAULT_TENANT_ID } from './tenant-context';
import { generateSecureSessionId } from './crypto';

/**
 * Type alias for SessionStore stub returned from region-aware functions
 */
type SessionStoreStub = DurableObjectStub<SessionStore>;

/**
 * Generate a new region-sharded session ID.
 *
 * Uses FNV-1a hash of the random ID to determine which shard the session belongs to,
 * then resolves the region from the shard index using the region shard config.
 *
 * Security: Uses 128 bits of cryptographically secure random data (base64url encoded)
 * instead of UUID v4 (which has only 122 bits). This meets OWASP recommendations
 * for session identifier entropy.
 *
 * @param env - Environment with KV binding for region shard config
 * @param tenantId - Tenant ID (default: 'default')
 * @returns Object containing sessionId, shardIndex, regionKey, generation, and randomPart
 *
 * @example
 * const { sessionId, shardIndex, regionKey, generation } = await generateRegionShardedSessionId(env);
 * // sessionId: "g1:apac:3:session_X7g9_kPq2Lm4Rn8sT1wZ-A"
 * // shardIndex: 3
 * // regionKey: "apac"
 * // generation: 1
 */
export async function generateRegionShardedSessionId(
  env: Env,
  tenantId: string = DEFAULT_TENANT_ID
): Promise<{
  sessionId: string;
  shardIndex: number;
  regionKey: string;
  generation: number;
  randomPart: string;
}> {
  // Use 128-bit secure random ID instead of UUID (122 bits)
  // This meets OWASP recommendations for session ID entropy
  const randomPart = generateSecureSessionId();
  const config = await getRegionShardConfig(env, tenantId);

  // Use random part as the shard key for session distribution
  const resolution = resolveShardForNewResource(config, randomPart);

  // Create session ID with embedded region info
  const sessionId = createRegionId(
    resolution.generation,
    resolution.regionKey,
    resolution.shardIndex,
    `session_${randomPart}`
  );

  return {
    sessionId,
    shardIndex: resolution.shardIndex,
    regionKey: resolution.regionKey,
    generation: resolution.generation,
    randomPart,
  };
}

/**
 * Parse a region-sharded session ID to extract shard info.
 *
 * @param sessionId - Region-sharded session ID (format: g{gen}:{region}:{shard}:session_{uuid})
 * @returns Parsed region ID or null if invalid format
 *
 * @example
 * const result = parseRegionShardedSessionId("g1:apac:3:session_abc123");
 * // { generation: 1, regionKey: 'apac', shardIndex: 3, randomPart: 'session_abc123' }
 *
 * const invalid = parseRegionShardedSessionId("invalid-session-id");
 * // null
 */
export function parseRegionShardedSessionId(sessionId: string): ParsedRegionId | null {
  try {
    const parsed = parseRegionId(sessionId);
    // Verify this is a session ID
    if (!parsed.randomPart.startsWith('session_')) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Get SessionStore Durable Object stub for an existing session ID.
 *
 * Parses the session ID to extract the region and shard info, then routes to
 * the correct DO instance with locationHint for optimal placement.
 *
 * @param env - Environment object with DO bindings
 * @param sessionId - Region-sharded session ID
 * @param tenantId - Tenant ID (default: 'default')
 * @returns Object containing DO stub and resolution info
 * @throws Error if sessionId format is invalid
 *
 * @example
 * const { stub, resolution } = getSessionStoreBySessionId(env, "g1:apac:3:session_abc123");
 * const response = await stub.fetch(new Request(...));
 */
export function getSessionStoreBySessionId(
  env: Env,
  sessionId: string,
  tenantId: string = DEFAULT_TENANT_ID
): {
  stub: SessionStoreStub;
  resolution: ShardResolution;
  instanceName: string;
} {
  const parsed = parseRegionShardedSessionId(sessionId);
  if (!parsed) {
    throw new Error(`Invalid region-sharded session ID format: ${sessionId}`);
  }

  const resolution: ShardResolution = {
    generation: parsed.generation,
    regionKey: parsed.regionKey,
    shardIndex: parsed.shardIndex,
  };

  const instanceName = buildRegionInstanceName(
    tenantId,
    resolution.regionKey,
    'session',
    resolution.shardIndex
  );

  const stub = getRegionAwareDOStub(
    env.SESSION_STORE as unknown as DurableObjectNamespace,
    instanceName,
    resolution.regionKey
  ) as SessionStoreStub;

  return { stub, resolution, instanceName };
}

/**
 * Get SessionStore Durable Object stub and generate a new session ID.
 *
 * This is the entry point for creating new sessions. It:
 * 1. Gets the region shard config from KV
 * 2. Generates a new region-sharded session ID
 * 3. Returns the DO stub with locationHint for the target region
 *
 * @param env - Environment object with DO bindings
 * @param tenantId - Tenant ID (default: 'default')
 * @returns Object containing DO stub, new sessionId, and resolution info
 *
 * @example
 * const { stub, sessionId, resolution } = await getSessionStoreForNewSession(env);
 * const response = await stub.fetch(new Request(..., {
 *   body: JSON.stringify({ sessionId, ... })
 * }));
 */
export async function getSessionStoreForNewSession(
  env: Env,
  tenantId: string = DEFAULT_TENANT_ID
): Promise<{
  stub: SessionStoreStub;
  sessionId: string;
  resolution: ShardResolution;
  instanceName: string;
}> {
  const { sessionId, shardIndex, regionKey, generation } = await generateRegionShardedSessionId(
    env,
    tenantId
  );

  const resolution: ShardResolution = {
    generation,
    regionKey,
    shardIndex,
  };

  const instanceName = buildRegionInstanceName(tenantId, regionKey, 'session', shardIndex);
  const stub = getRegionAwareDOStub(
    env.SESSION_STORE as unknown as DurableObjectNamespace,
    instanceName,
    regionKey
  ) as SessionStoreStub;

  return { stub, sessionId, resolution, instanceName };
}

/**
 * Check if a session ID is in the region-sharded format.
 *
 * @param sessionId - Session ID to check
 * @returns true if the session ID follows the region-sharded format
 */
export function isRegionShardedSessionId(sessionId: string): boolean {
  return parseRegionShardedSessionId(sessionId) !== null;
}

/**
 * Extract the random part from a region-sharded session ID.
 *
 * @param sessionId - Region-sharded session ID
 * @returns Random part string (base64url) or null if invalid format
 */
export function extractSessionRandomPart(sessionId: string): string | null {
  const parsed = parseRegionShardedSessionId(sessionId);
  if (!parsed) {
    return null;
  }

  // randomPart is "session_{randomPart}"
  const match = parsed.randomPart.match(/^session_(.+)$/);
  return match ? match[1] : null;
}

/**
 * @deprecated Use extractSessionRandomPart instead
 * Extract UUID from a region-sharded session ID.
 */
export function extractSessionUuid(sessionId: string): string | null {
  return extractSessionRandomPart(sessionId);
}

// =============================================================================
// Legacy Aliases (for backward compatibility during migration)
// =============================================================================

/**
 * @deprecated Use isRegionShardedSessionId instead
 */
export const isShardedSessionId = isRegionShardedSessionId;

/**
 * @deprecated Use parseRegionShardedSessionId instead
 */
export const parseShardedSessionId = parseRegionShardedSessionId;
