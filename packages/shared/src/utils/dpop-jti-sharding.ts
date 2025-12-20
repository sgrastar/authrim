/**
 * DPoP JTI Sharding Helper (Region Sharding Version)
 *
 * Provides utilities for generating region-sharded DPoP JTI IDs and routing
 * JTI operations to the correct Durable Object shard with locationHint.
 *
 * JTI ID format: g{gen}:{region}:{shard}:dpp_{jti}
 * DO instance name: {tenantId}:{region}:dpp:{shard}
 *
 * Sharding Strategy:
 * - Uses FNV-1a hash of `client_id` as shard key
 * - Colocates JTI checks for the same client for better caching
 * - Region-aware placement using locationHint
 *
 * TTL Strategy:
 * - TTL = min(access_token_exp - now, serverMaxAccessTokenTTL) + 5min skew
 * - Hard Cap: 1 hour maximum (DO storage stability)
 *
 * Security Considerations:
 * - JTI single-use enforcement is per-DO instance (atomic)
 * - ID format embeds shard info for self-routing (no external lookup)
 * - Generation-based versioning for configuration changes
 *
 * @see docs/architecture/durable-objects-sharding.md
 */

import type { Env } from '../types/env';
import type { DurableObjectNamespace, DurableObjectStub } from '@cloudflare/workers-types';
import {
  getRegionShardConfig,
  resolveShardForNewResourceTyped,
  parseRegionId,
  createRegionId,
  buildRegionInstanceName,
  getRegionAwareDOStub,
  type ParsedRegionId,
  type ShardResolution,
  ID_PREFIX,
} from './region-sharding';

/**
 * Type alias for DPoPJTIStore stub
 * Uses generic stub type since DPoPJTIStore uses fetch() pattern
 */
type DPoPJTIStoreStub = DurableObjectStub;

/**
 * Default tenant ID
 */
const DEFAULT_TENANT_ID = 'default';

/**
 * DPoP JTI TTL constants
 */
export const DPOP_JTI_SKEW_SECONDS = 5 * 60; // 5 minutes
export const DPOP_JTI_HARD_CAP_SECONDS = 60 * 60; // 1 hour max
export const DPOP_JTI_DEFAULT_TTL_SECONDS = 5 * 60; // 5 minutes default

/**
 * Calculate DPoP JTI TTL based on access token expiration.
 *
 * Formula: min(access_token_exp - now, serverMaxTTL) + skew
 * Hard Cap: 1 hour maximum
 *
 * @param accessTokenExpSeconds - Access token expiration in seconds from now
 * @param serverMaxTTLSeconds - Server's maximum access token TTL (optional)
 * @returns TTL in seconds for the JTI entry
 *
 * @example
 * const ttl = calculateDPoPJTITTL(3600); // 1 hour token
 * // => 3900 (1 hour + 5 min skew, capped at 1 hour = 3600)
 */
export function calculateDPoPJTITTL(
  accessTokenExpSeconds: number,
  serverMaxTTLSeconds?: number
): number {
  // Use the smaller of token exp and server max
  let baseTTL = accessTokenExpSeconds;
  if (serverMaxTTLSeconds !== undefined) {
    baseTTL = Math.min(baseTTL, serverMaxTTLSeconds);
  }

  // Add skew for clock drift tolerance
  const ttlWithSkew = baseTTL + DPOP_JTI_SKEW_SECONDS;

  // Apply hard cap
  return Math.min(ttlWithSkew, DPOP_JTI_HARD_CAP_SECONDS);
}

/**
 * Generate a new region-sharded DPoP JTI ID.
 *
 * Uses FNV-1a hash of client_id to determine shard.
 * This colocates JTI checks for the same client for better performance.
 *
 * @param env - Environment with KV binding
 * @param tenantId - Tenant ID
 * @param clientId - Client identifier (for sharding)
 * @param jti - JTI value from DPoP proof
 * @returns Object containing jtiId, shardIndex, regionKey, generation
 *
 * @example
 * const { jtiId, shardIndex, regionKey } = await generateDPoPJTIId(
 *   env, 'tenant1', 'client123', 'abc-def-ghi'
 * );
 * // jtiId: "g1:apac:3:dpp_abc-def-ghi"
 */
export async function generateDPoPJTIId(
  env: Env,
  tenantId: string,
  clientId: string,
  jti: string
): Promise<{
  jtiId: string;
  shardIndex: number;
  regionKey: string;
  generation: number;
}> {
  // Get region shard config
  const config = await getRegionShardConfig(env, tenantId);

  // Resolve shard using client_id as key
  const resolution = resolveShardForNewResourceTyped(config, 'dpop', clientId);

  // Create DPoP JTI ID with embedded region info
  const jtiId = createRegionId(
    resolution.generation,
    resolution.regionKey,
    resolution.shardIndex,
    `${ID_PREFIX.dpop}_${jti}`
  );

  return {
    jtiId,
    shardIndex: resolution.shardIndex,
    regionKey: resolution.regionKey,
    generation: resolution.generation,
  };
}

/**
 * Parse a region-sharded DPoP JTI ID to extract shard info.
 *
 * @param jtiId - Region-sharded DPoP JTI ID
 * @returns Parsed region ID with jti, or null if invalid format
 *
 * @example
 * const result = parseDPoPJTIId("g1:apac:3:dpp_abc-def-ghi");
 * // { generation: 1, regionKey: 'apac', shardIndex: 3, jti: 'abc-def-ghi' }
 */
export function parseDPoPJTIId(jtiId: string): (ParsedRegionId & { jti: string }) | null {
  try {
    const parsed = parseRegionId(jtiId);
    // Verify this is a DPoP JTI ID
    if (!parsed.randomPart.startsWith(`${ID_PREFIX.dpop}_`)) {
      return null;
    }
    return {
      ...parsed,
      jti: parsed.randomPart.substring(ID_PREFIX.dpop.length + 1), // Remove 'dpp_' prefix
    };
  } catch {
    return null;
  }
}

/**
 * Get DPoPJTIStore Durable Object stub for an existing JTI ID.
 *
 * Parses the JTI ID to extract region and shard info, then routes
 * to the correct DO instance with locationHint.
 *
 * @param env - Environment with DO bindings
 * @param jtiId - Region-sharded DPoP JTI ID
 * @param tenantId - Tenant ID
 * @returns Object containing DO stub and resolution info
 * @throws Error if jtiId format is invalid
 *
 * @example
 * const { stub, resolution } = getDPoPJTIStoreById(env, "g1:apac:3:dpp_abc...");
 * const response = await stub.fetch(new Request('https://internal/check'));
 */
export function getDPoPJTIStoreById(
  env: Env,
  jtiId: string,
  tenantId: string = DEFAULT_TENANT_ID
): {
  stub: DPoPJTIStoreStub;
  resolution: ShardResolution;
  instanceName: string;
  jti: string;
} {
  const parsed = parseDPoPJTIId(jtiId);
  if (!parsed) {
    throw new Error(`Invalid region-sharded DPoP JTI ID format: ${jtiId}`);
  }

  const resolution: ShardResolution = {
    generation: parsed.generation,
    regionKey: parsed.regionKey,
    shardIndex: parsed.shardIndex,
  };

  const instanceName = buildRegionInstanceName(
    tenantId,
    resolution.regionKey,
    'dpop',
    resolution.shardIndex
  );

  const stub = getRegionAwareDOStub(
    env.DPOP_JTI_STORE as unknown as DurableObjectNamespace,
    instanceName,
    resolution.regionKey
  ) as DPoPJTIStoreStub;

  return { stub, resolution, instanceName, jti: parsed.jti };
}

/**
 * Get DPoPJTIStore Durable Object stub for checking/storing a new JTI.
 *
 * @param env - Environment with DO bindings
 * @param tenantId - Tenant ID
 * @param clientId - Client identifier
 * @param jti - JTI value from DPoP proof
 * @returns Object containing DO stub, jtiId, and resolution info
 *
 * @example
 * const { stub, jtiId } = await getDPoPJTIStoreForNewJTI(
 *   env, 'tenant1', 'client123', 'abc-def-ghi'
 * );
 */
export async function getDPoPJTIStoreForNewJTI(
  env: Env,
  tenantId: string,
  clientId: string,
  jti: string
): Promise<{
  stub: DPoPJTIStoreStub;
  jtiId: string;
  resolution: ShardResolution;
  instanceName: string;
}> {
  const { jtiId, shardIndex, regionKey, generation } = await generateDPoPJTIId(
    env,
    tenantId,
    clientId,
    jti
  );

  const resolution: ShardResolution = {
    generation,
    regionKey,
    shardIndex,
  };

  const instanceName = buildRegionInstanceName(tenantId, regionKey, 'dpop', shardIndex);
  const stub = getRegionAwareDOStub(
    env.DPOP_JTI_STORE as unknown as DurableObjectNamespace,
    instanceName,
    regionKey
  ) as DPoPJTIStoreStub;

  return { stub, jtiId, resolution, instanceName };
}

/**
 * Check and store a DPoP JTI atomically.
 *
 * This is a high-level helper that handles the full JTI check flow:
 * 1. Get the appropriate shard based on client_id
 * 2. Check if JTI already exists (replay attack prevention)
 * 3. Store JTI with calculated TTL if new
 *
 * @param env - Environment with DO bindings
 * @param tenantId - Tenant ID
 * @param clientId - Client identifier
 * @param jti - JTI value from DPoP proof
 * @param accessTokenExpSeconds - Access token expiration in seconds
 * @returns Object with isReplay flag and jtiId
 *
 * @example
 * const result = await checkAndStoreDPoPJTI(env, 'tenant1', 'client123', 'jti-value', 3600);
 * if (result.isReplay) {
 *   throw new Error('DPoP proof replay detected');
 * }
 */
export async function checkAndStoreDPoPJTI(
  env: Env,
  tenantId: string,
  clientId: string,
  jti: string,
  accessTokenExpSeconds: number
): Promise<{
  isReplay: boolean;
  jtiId: string;
}> {
  const { stub, jtiId } = await getDPoPJTIStoreForNewJTI(env, tenantId, clientId, jti);

  const ttl = calculateDPoPJTITTL(accessTokenExpSeconds);

  const response = await stub.fetch(
    new Request('https://dpop-jti-store/check-and-store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jti,
        ttl,
      }),
    })
  );

  if (!response.ok) {
    throw new Error(`DPoP JTI check failed: ${response.status}`);
  }

  const result = (await response.json()) as { exists: boolean };

  return {
    isReplay: result.exists,
    jtiId,
  };
}
