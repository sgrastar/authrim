/**
 * VP Request Sharding Helper (Region Sharding Version)
 *
 * Provides utilities for generating region-sharded VP request IDs and routing
 * VP request operations to the correct Durable Object shard with locationHint.
 *
 * VP Request ID format: g{gen}:{region}:{shard}:vp_{uuid}
 * DO instance name: {tenantId}:{region}:vp:{shard}
 *
 * Sharding Strategy:
 * - Uses FNV-1a hash of `tenantId:clientId` as shard key
 * - Colocates requests from the same client for caching benefits
 * - Region-aware placement using locationHint
 *
 * Security Considerations:
 * - Nonce single-use enforcement is per-DO instance (atomic)
 * - ID format embeds shard info for self-routing (no external lookup)
 * - Generation-based versioning for configuration changes
 */

import type { Env } from '../types';
import type { DurableObjectNamespace, DurableObjectStub } from '@cloudflare/workers-types';
import {
  getRegionShardConfig,
  resolveShardForNewResource,
  parseRegionId,
  createRegionId,
  buildRegionInstanceName,
  getRegionAwareDOStub,
  type ParsedRegionId,
  type ShardResolution,
} from '@authrim/shared';

/**
 * Type alias for VPRequestStore stub
 * Uses generic stub type since VPRequestStore uses fetch() pattern
 */
type VPRequestStoreStub = DurableObjectStub;

/**
 * Default tenant ID
 */
const DEFAULT_TENANT_ID = 'default';

/**
 * Generate a new region-sharded VP request ID.
 *
 * Uses FNV-1a hash of tenantId:clientId to determine shard.
 * This colocates requests from the same client for better caching.
 *
 * @param env - Environment with KV binding
 * @param tenantId - Tenant ID
 * @param clientId - Client identifier
 * @param uuid - Unique request identifier
 * @returns Object containing requestId, shardIndex, regionKey, generation
 *
 * @example
 * const { requestId, shardIndex, regionKey } = await generateVPRequestId(
 *   env, 'tenant1', 'client123', crypto.randomUUID()
 * );
 * // requestId: "g1:apac:3:vp_abc123..."
 */
export async function generateVPRequestId(
  env: Env,
  tenantId: string,
  clientId: string,
  uuid: string
): Promise<{
  requestId: string;
  shardIndex: number;
  regionKey: string;
  generation: number;
}> {
  // Get region shard config from shared KV (AUTHRIM_CONFIG)
  const config = await getRegionShardConfig(
    { AUTHRIM_CONFIG: env.AUTHRIM_CONFIG } as Parameters<typeof getRegionShardConfig>[0],
    tenantId
  );

  // Use tenantId:clientId as shard key
  const shardKey = `${tenantId}:${clientId}`;
  const resolution = resolveShardForNewResource(config, shardKey);

  // Create VP request ID with embedded region info
  const requestId = createRegionId(
    resolution.generation,
    resolution.regionKey,
    resolution.shardIndex,
    `vp_${uuid}`
  );

  return {
    requestId,
    shardIndex: resolution.shardIndex,
    regionKey: resolution.regionKey,
    generation: resolution.generation,
  };
}

/**
 * Parse a region-sharded VP request ID to extract shard info.
 *
 * @param requestId - Region-sharded VP request ID
 * @returns Parsed region ID with uuid, or null if invalid format
 *
 * @example
 * const result = parseVPRequestId("g1:apac:3:vp_abc123...");
 * // { generation: 1, regionKey: 'apac', shardIndex: 3, uuid: 'abc123...' }
 */
export function parseVPRequestId(requestId: string): (ParsedRegionId & { uuid: string }) | null {
  try {
    const parsed = parseRegionId(requestId);
    // Verify this is a VP request ID
    if (!parsed.randomPart.startsWith('vp_')) {
      return null;
    }
    return {
      ...parsed,
      uuid: parsed.randomPart.substring(3), // Remove 'vp_' prefix
    };
  } catch {
    return null;
  }
}

/**
 * Get VPRequestStore Durable Object stub for an existing request ID.
 *
 * Parses the request ID to extract region and shard info, then routes
 * to the correct DO instance with locationHint.
 *
 * @param env - Environment with DO bindings
 * @param requestId - Region-sharded VP request ID
 * @param tenantId - Tenant ID
 * @returns Object containing DO stub and resolution info
 * @throws Error if requestId format is invalid
 *
 * @example
 * const { stub, resolution } = getVPRequestStoreById(env, "g1:apac:3:vp_abc...");
 * const response = await stub.fetch(new Request('https://internal/get'));
 */
export function getVPRequestStoreById(
  env: Env,
  requestId: string,
  tenantId: string = DEFAULT_TENANT_ID
): {
  stub: VPRequestStoreStub;
  resolution: ShardResolution;
  instanceName: string;
  uuid: string;
} {
  const parsed = parseVPRequestId(requestId);
  if (!parsed) {
    throw new Error(`Invalid region-sharded VP request ID format: ${requestId}`);
  }

  const resolution: ShardResolution = {
    generation: parsed.generation,
    regionKey: parsed.regionKey,
    shardIndex: parsed.shardIndex,
  };

  const instanceName = buildRegionInstanceName(
    tenantId,
    resolution.regionKey,
    'vprequest',
    resolution.shardIndex
  );

  const stub = getRegionAwareDOStub(
    env.VP_REQUEST_STORE as unknown as DurableObjectNamespace,
    instanceName,
    resolution.regionKey
  ) as VPRequestStoreStub;

  return { stub, resolution, instanceName, uuid: parsed.uuid };
}

/**
 * Get VPRequestStore Durable Object stub for creating a new request.
 *
 * @param env - Environment with DO bindings
 * @param tenantId - Tenant ID
 * @param clientId - Client identifier
 * @param uuid - Unique request identifier
 * @returns Object containing DO stub, requestId, and resolution info
 *
 * @example
 * const { stub, requestId } = await getVPRequestStoreForNewRequest(
 *   env, 'tenant1', 'client123', crypto.randomUUID()
 * );
 */
export async function getVPRequestStoreForNewRequest(
  env: Env,
  tenantId: string,
  clientId: string,
  uuid: string
): Promise<{
  stub: VPRequestStoreStub;
  requestId: string;
  resolution: ShardResolution;
  instanceName: string;
}> {
  const { requestId, shardIndex, regionKey, generation } = await generateVPRequestId(
    env,
    tenantId,
    clientId,
    uuid
  );

  const resolution: ShardResolution = {
    generation,
    regionKey,
    shardIndex,
  };

  const instanceName = buildRegionInstanceName(tenantId, regionKey, 'vprequest', shardIndex);
  const stub = getRegionAwareDOStub(
    env.VP_REQUEST_STORE as unknown as DurableObjectNamespace,
    instanceName,
    regionKey
  ) as VPRequestStoreStub;

  return { stub, requestId, resolution, instanceName };
}
