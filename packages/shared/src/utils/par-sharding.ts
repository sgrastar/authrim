/**
 * PAR (Pushed Authorization Request) Sharding Helper (Region Sharding Version)
 *
 * Provides utilities for generating region-sharded PAR request URIs and routing
 * PAR operations to the correct Durable Object shard with locationHint.
 *
 * Request URI format: g{gen}:{region}:{shard}:par_{uuid}
 * DO instance name: {tenantId}:{region}:par:{shard}
 *
 * Sharding Strategy:
 * - Uses FNV-1a hash of `client_id` as shard key
 * - Colocates PAR requests from the same client for better caching
 * - Region-aware placement using locationHint
 *
 * Security Considerations:
 * - Request URI single-use enforcement is per-DO instance (atomic)
 * - ID format embeds shard info for self-routing (no external lookup)
 * - Generation-based versioning for configuration changes
 * - Short TTL (typically 60 seconds) for PAR requests
 *
 * @see docs/architecture/durable-objects-sharding.md
 * @see RFC 9126 - OAuth 2.0 Pushed Authorization Requests
 */

import type { Env } from '../types/env';
import type { DurableObjectNamespace, DurableObjectStub } from '@cloudflare/workers-types';
import type { PARRequestData } from '../durable-objects/PARRequestStore';
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
 * PARRequestStore RPC stub interface
 * Includes RPC methods exposed by the PARRequestStore Durable Object
 */
interface PARRequestStoreStub extends DurableObjectStub {
  storeRequestRpc(request: {
    requestUri: string;
    data: Record<string, unknown>;
    ttl: number;
  }): Promise<void>;
  consumeRequestRpc(request: { requestUri: string; client_id: string }): Promise<PARRequestData>;
}

/**
 * Default tenant ID
 */
const DEFAULT_TENANT_ID = 'default';

/**
 * PAR request URI prefix as per RFC 9126
 */
export const PAR_REQUEST_URI_PREFIX = 'urn:ietf:params:oauth:request_uri:';

/**
 * Default PAR request TTL (60 seconds as per RFC 9126)
 */
export const PAR_DEFAULT_TTL_SECONDS = 60;

/**
 * Generate a new region-sharded PAR request URI.
 *
 * Uses FNV-1a hash of client_id to determine shard.
 * This colocates PAR requests from the same client for better performance.
 *
 * @param env - Environment with KV binding
 * @param tenantId - Tenant ID
 * @param clientId - Client identifier (for sharding)
 * @param uuid - Unique request identifier
 * @returns Object containing requestUri, shardIndex, regionKey, generation
 *
 * @example
 * const { requestUri, shardIndex } = await generatePARRequestUri(
 *   env, 'tenant1', 'client123', crypto.randomUUID()
 * );
 * // requestUri: "urn:ietf:params:oauth:request_uri:g1:apac:3:par_abc123..."
 */
export async function generatePARRequestUri(
  env: Env,
  tenantId: string,
  clientId: string,
  uuid: string
): Promise<{
  requestUri: string;
  internalId: string;
  shardIndex: number;
  regionKey: string;
  generation: number;
}> {
  // Get region shard config
  const config = await getRegionShardConfig(env, tenantId);

  // Resolve shard using client_id as key
  const resolution = resolveShardForNewResourceTyped(config, 'par', clientId);

  // Create internal ID with embedded region info
  const internalId = createRegionId(
    resolution.generation,
    resolution.regionKey,
    resolution.shardIndex,
    `${ID_PREFIX.par}_${uuid}`
  );

  // Create RFC 9126 compliant request_uri
  const requestUri = `${PAR_REQUEST_URI_PREFIX}${internalId}`;

  return {
    requestUri,
    internalId,
    shardIndex: resolution.shardIndex,
    regionKey: resolution.regionKey,
    generation: resolution.generation,
  };
}

/**
 * Parse a PAR request URI to extract shard info.
 *
 * @param requestUri - PAR request URI (with or without urn: prefix)
 * @returns Parsed region ID with uuid, or null if invalid format
 *
 * @example
 * const result = parsePARRequestUri("urn:ietf:params:oauth:request_uri:g1:apac:3:par_abc123");
 * // { generation: 1, regionKey: 'apac', shardIndex: 3, uuid: 'abc123' }
 */
export function parsePARRequestUri(requestUri: string): (ParsedRegionId & { uuid: string }) | null {
  try {
    // Remove the URN prefix if present
    let internalId = requestUri;
    if (requestUri.startsWith(PAR_REQUEST_URI_PREFIX)) {
      internalId = requestUri.substring(PAR_REQUEST_URI_PREFIX.length);
    }

    const parsed = parseRegionId(internalId);
    // Verify this is a PAR request ID
    if (!parsed.randomPart.startsWith(`${ID_PREFIX.par}_`)) {
      return null;
    }
    return {
      ...parsed,
      uuid: parsed.randomPart.substring(ID_PREFIX.par.length + 1), // Remove 'par_' prefix
    };
  } catch {
    return null;
  }
}

/**
 * Get PARRequestStore Durable Object stub for an existing request URI.
 *
 * Parses the request URI to extract region and shard info, then routes
 * to the correct DO instance with locationHint.
 *
 * @param env - Environment with DO bindings
 * @param requestUri - PAR request URI
 * @param tenantId - Tenant ID
 * @returns Object containing DO stub and resolution info
 * @throws Error if requestUri format is invalid
 *
 * @example
 * const { stub, resolution } = getPARRequestStoreByUri(env, "urn:...:g1:apac:3:par_abc...");
 * const response = await stub.fetch(new Request('https://internal/consume'));
 */
export function getPARRequestStoreByUri(
  env: Env,
  requestUri: string,
  tenantId: string = DEFAULT_TENANT_ID
): {
  stub: PARRequestStoreStub;
  resolution: ShardResolution;
  instanceName: string;
  uuid: string;
} {
  const parsed = parsePARRequestUri(requestUri);
  if (!parsed) {
    throw new Error(`Invalid PAR request URI format: ${requestUri}`);
  }

  const resolution: ShardResolution = {
    generation: parsed.generation,
    regionKey: parsed.regionKey,
    shardIndex: parsed.shardIndex,
  };

  const instanceName = buildRegionInstanceName(
    tenantId,
    resolution.regionKey,
    'par',
    resolution.shardIndex
  );

  const stub = getRegionAwareDOStub(
    env.PAR_REQUEST_STORE as unknown as DurableObjectNamespace,
    instanceName,
    resolution.regionKey
  ) as PARRequestStoreStub;

  return { stub, resolution, instanceName, uuid: parsed.uuid };
}

/**
 * Get PARRequestStore Durable Object stub for creating a new PAR request.
 *
 * @param env - Environment with DO bindings
 * @param tenantId - Tenant ID
 * @param clientId - Client identifier
 * @param uuid - Unique request identifier
 * @returns Object containing DO stub, requestUri, and resolution info
 *
 * @example
 * const { stub, requestUri } = await getPARRequestStoreForNewRequest(
 *   env, 'tenant1', 'client123', crypto.randomUUID()
 * );
 */
export async function getPARRequestStoreForNewRequest(
  env: Env,
  tenantId: string,
  clientId: string,
  uuid: string
): Promise<{
  stub: PARRequestStoreStub;
  requestUri: string;
  internalId: string;
  resolution: ShardResolution;
  instanceName: string;
}> {
  const { requestUri, internalId, shardIndex, regionKey, generation } = await generatePARRequestUri(
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

  const instanceName = buildRegionInstanceName(tenantId, regionKey, 'par', shardIndex);
  const stub = getRegionAwareDOStub(
    env.PAR_REQUEST_STORE as unknown as DurableObjectNamespace,
    instanceName,
    regionKey
  ) as PARRequestStoreStub;

  return { stub, requestUri, internalId, resolution, instanceName };
}
