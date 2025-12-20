/**
 * CIBA (Client-Initiated Backchannel Authentication) Sharding Helper
 *
 * Provides utilities for generating region-sharded CIBA auth request IDs and routing
 * CIBA operations to the correct Durable Object shard with locationHint.
 *
 * Auth Request ID format: g{gen}:{region}:{shard}:cba_{auth_req_id}
 * DO instance name: {tenantId}:{region}:cba:{shard}
 *
 * Sharding Strategy:
 * - Uses FNV-1a hash of `client_id` as shard key
 * - Colocates CIBA requests from the same client for better caching
 * - Region-aware placement using locationHint
 *
 * Security Considerations:
 * - Auth request single-use enforcement is per-DO instance (atomic)
 * - Polling is rate-limited per shard
 * - ID format embeds shard info for self-routing (no external lookup)
 * - Generation-based versioning for configuration changes
 *
 * @see docs/architecture/durable-objects-sharding.md
 * @see OpenID Connect CIBA Core 1.0
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
 * Type alias for CIBARequestStore stub
 * Uses generic stub type since CIBARequestStore uses fetch() pattern
 */
type CIBARequestStoreStub = DurableObjectStub;

/**
 * Default tenant ID
 */
const DEFAULT_TENANT_ID = 'default';

/**
 * Default CIBA request TTL (300 seconds = 5 minutes)
 */
export const CIBA_DEFAULT_TTL_SECONDS = 300;

/**
 * Default CIBA polling interval (5 seconds as per CIBA spec)
 */
export const CIBA_DEFAULT_INTERVAL_SECONDS = 5;

/**
 * Generate a new region-sharded CIBA auth request ID.
 *
 * Uses FNV-1a hash of client_id to determine shard.
 * This colocates CIBA requests from the same client for better performance.
 *
 * @param env - Environment with KV binding
 * @param tenantId - Tenant ID
 * @param clientId - Client identifier (for sharding)
 * @param authReqId - The authentication request ID
 * @returns Object containing cibaId, shardIndex, regionKey, generation
 *
 * @example
 * const { cibaId, shardIndex } = await generateCIBARequestId(
 *   env, 'tenant1', 'client123', 'G0JN-MDG2-WxhC-RMsE'
 * );
 * // cibaId: "g1:apac:3:cba_G0JN-MDG2-WxhC-RMsE"
 */
export async function generateCIBARequestId(
  env: Env,
  tenantId: string,
  clientId: string,
  authReqId: string
): Promise<{
  cibaId: string;
  shardIndex: number;
  regionKey: string;
  generation: number;
}> {
  // Get region shard config
  const config = await getRegionShardConfig(env, tenantId);

  // Resolve shard using client_id as key
  const resolution = resolveShardForNewResourceTyped(config, 'ciba', clientId);

  // Create CIBA request ID with embedded region info
  const cibaId = createRegionId(
    resolution.generation,
    resolution.regionKey,
    resolution.shardIndex,
    `${ID_PREFIX.ciba}_${authReqId}`
  );

  return {
    cibaId,
    shardIndex: resolution.shardIndex,
    regionKey: resolution.regionKey,
    generation: resolution.generation,
  };
}

/**
 * Parse a region-sharded CIBA request ID to extract shard info.
 *
 * @param cibaId - Region-sharded CIBA request ID
 * @returns Parsed region ID with authReqId, or null if invalid format
 *
 * @example
 * const result = parseCIBARequestId("g1:apac:3:cba_G0JN-MDG2-WxhC-RMsE");
 * // { generation: 1, regionKey: 'apac', shardIndex: 3, authReqId: 'G0JN-MDG2-WxhC-RMsE' }
 */
export function parseCIBARequestId(
  cibaId: string
): (ParsedRegionId & { authReqId: string }) | null {
  try {
    const parsed = parseRegionId(cibaId);
    // Verify this is a CIBA request ID
    if (!parsed.randomPart.startsWith(`${ID_PREFIX.ciba}_`)) {
      return null;
    }
    return {
      ...parsed,
      authReqId: parsed.randomPart.substring(ID_PREFIX.ciba.length + 1), // Remove 'cba_' prefix
    };
  } catch {
    return null;
  }
}

/**
 * Get CIBARequestStore Durable Object stub for an existing CIBA request ID.
 *
 * Parses the CIBA ID to extract region and shard info, then routes
 * to the correct DO instance with locationHint.
 *
 * @param env - Environment with DO bindings
 * @param cibaId - Region-sharded CIBA request ID
 * @param tenantId - Tenant ID
 * @returns Object containing DO stub and resolution info
 * @throws Error if cibaId format is invalid
 *
 * @example
 * const { stub, resolution } = getCIBARequestStoreById(env, "g1:apac:3:cba_abc...");
 * const response = await stub.fetch(new Request('https://internal/poll'));
 */
export function getCIBARequestStoreById(
  env: Env,
  cibaId: string,
  tenantId: string = DEFAULT_TENANT_ID
): {
  stub: CIBARequestStoreStub;
  resolution: ShardResolution;
  instanceName: string;
  authReqId: string;
} {
  const parsed = parseCIBARequestId(cibaId);
  if (!parsed) {
    throw new Error(`Invalid region-sharded CIBA request ID format: ${cibaId}`);
  }

  const resolution: ShardResolution = {
    generation: parsed.generation,
    regionKey: parsed.regionKey,
    shardIndex: parsed.shardIndex,
  };

  const instanceName = buildRegionInstanceName(
    tenantId,
    resolution.regionKey,
    'ciba',
    resolution.shardIndex
  );

  const stub = getRegionAwareDOStub(
    env.CIBA_REQUEST_STORE as unknown as DurableObjectNamespace,
    instanceName,
    resolution.regionKey
  ) as CIBARequestStoreStub;

  return { stub, resolution, instanceName, authReqId: parsed.authReqId };
}

/**
 * Get CIBARequestStore Durable Object stub for creating a new CIBA request.
 *
 * @param env - Environment with DO bindings
 * @param tenantId - Tenant ID
 * @param clientId - Client identifier
 * @param authReqId - The authentication request ID
 * @returns Object containing DO stub, cibaId, and resolution info
 *
 * @example
 * const { stub, cibaId } = await getCIBARequestStoreForNewRequest(
 *   env, 'tenant1', 'client123', 'G0JN-MDG2-WxhC-RMsE'
 * );
 */
export async function getCIBARequestStoreForNewRequest(
  env: Env,
  tenantId: string,
  clientId: string,
  authReqId: string
): Promise<{
  stub: CIBARequestStoreStub;
  cibaId: string;
  resolution: ShardResolution;
  instanceName: string;
}> {
  const { cibaId, shardIndex, regionKey, generation } = await generateCIBARequestId(
    env,
    tenantId,
    clientId,
    authReqId
  );

  const resolution: ShardResolution = {
    generation,
    regionKey,
    shardIndex,
  };

  const instanceName = buildRegionInstanceName(tenantId, regionKey, 'ciba', shardIndex);
  const stub = getRegionAwareDOStub(
    env.CIBA_REQUEST_STORE as unknown as DurableObjectNamespace,
    instanceName,
    regionKey
  ) as CIBARequestStoreStub;

  return { stub, cibaId, resolution, instanceName };
}
