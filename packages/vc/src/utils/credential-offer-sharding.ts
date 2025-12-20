/**
 * Credential Offer Sharding Helper (Region Sharding Version)
 *
 * Provides utilities for generating region-sharded credential offer IDs and routing
 * offer operations to the correct Durable Object shard with locationHint.
 *
 * Offer ID format: g{gen}:{region}:{shard}:co_{uuid}
 * DO instance name: {tenantId}:{region}:co:{shard}
 *
 * Sharding Strategy:
 * - Uses FNV-1a hash of `tenantId:userId` as shard key
 * - Colocates offers for the same user for better UX (wallet can poll single shard)
 * - Region-aware placement using locationHint
 *
 * Security Considerations:
 * - Single-use enforcement via status transition (pending → claimed)
 * - Pre-authorized code single-use is atomic per-DO instance
 * - ID format embeds shard info for self-routing
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
 * Type alias for CredentialOfferStore stub
 * Uses generic stub type since CredentialOfferStore uses fetch() pattern
 */
type CredentialOfferStoreStub = DurableObjectStub;

/**
 * Default tenant ID
 */
const DEFAULT_TENANT_ID = 'default';

/**
 * Generate a new region-sharded credential offer ID.
 *
 * Uses FNV-1a hash of tenantId:userId to determine shard.
 * This colocates offers for the same user for better wallet polling.
 *
 * @param env - Environment with KV binding
 * @param tenantId - Tenant ID
 * @param userId - User identifier
 * @param uuid - Unique offer identifier
 * @returns Object containing offerId, shardIndex, regionKey, generation
 *
 * @example
 * const { offerId, shardIndex, regionKey } = await generateCredentialOfferId(
 *   env, 'tenant1', 'user123', crypto.randomUUID()
 * );
 * // offerId: "g1:apac:3:co_abc123..."
 */
export async function generateCredentialOfferId(
  env: Env,
  tenantId: string,
  userId: string,
  uuid: string
): Promise<{
  offerId: string;
  shardIndex: number;
  regionKey: string;
  generation: number;
}> {
  // Get region shard config from shared KV (AUTHRIM_CONFIG)
  const config = await getRegionShardConfig(
    { AUTHRIM_CONFIG: env.AUTHRIM_CONFIG } as Parameters<typeof getRegionShardConfig>[0],
    tenantId
  );

  // Use tenantId:userId as shard key
  const shardKey = `${tenantId}:${userId}`;
  const resolution = resolveShardForNewResource(config, shardKey);

  // Create credential offer ID with embedded region info
  const offerId = createRegionId(
    resolution.generation,
    resolution.regionKey,
    resolution.shardIndex,
    `co_${uuid}`
  );

  return {
    offerId,
    shardIndex: resolution.shardIndex,
    regionKey: resolution.regionKey,
    generation: resolution.generation,
  };
}

/**
 * Parse a region-sharded credential offer ID to extract shard info.
 *
 * @param offerId - Region-sharded credential offer ID
 * @returns Parsed region ID with uuid, or null if invalid format
 *
 * @example
 * const result = parseCredentialOfferId("g1:apac:3:co_abc123...");
 * // { generation: 1, regionKey: 'apac', shardIndex: 3, uuid: 'abc123...' }
 */
export function parseCredentialOfferId(
  offerId: string
): (ParsedRegionId & { uuid: string }) | null {
  try {
    const parsed = parseRegionId(offerId);
    // Verify this is a credential offer ID
    if (!parsed.randomPart.startsWith('co_')) {
      return null;
    }
    return {
      ...parsed,
      uuid: parsed.randomPart.substring(3), // Remove 'co_' prefix
    };
  } catch {
    return null;
  }
}

/**
 * Get CredentialOfferStore Durable Object stub for an existing offer ID.
 *
 * Parses the offer ID to extract region and shard info, then routes
 * to the correct DO instance with locationHint.
 *
 * @param env - Environment with DO bindings
 * @param offerId - Region-sharded credential offer ID
 * @param tenantId - Tenant ID
 * @returns Object containing DO stub and resolution info
 * @throws Error if offerId format is invalid
 *
 * @example
 * const { stub, resolution } = getCredentialOfferStoreById(env, "g1:apac:3:co_abc...");
 * const response = await stub.fetch(new Request('https://internal/get'));
 */
export function getCredentialOfferStoreById(
  env: Env,
  offerId: string,
  tenantId: string = DEFAULT_TENANT_ID
): {
  stub: CredentialOfferStoreStub;
  resolution: ShardResolution;
  instanceName: string;
  uuid: string;
} {
  const parsed = parseCredentialOfferId(offerId);
  if (!parsed) {
    throw new Error(`Invalid region-sharded credential offer ID format: ${offerId}`);
  }

  const resolution: ShardResolution = {
    generation: parsed.generation,
    regionKey: parsed.regionKey,
    shardIndex: parsed.shardIndex,
  };

  const instanceName = buildRegionInstanceName(
    tenantId,
    resolution.regionKey,
    'credoffer',
    resolution.shardIndex
  );

  const stub = getRegionAwareDOStub(
    env.CREDENTIAL_OFFER_STORE as unknown as DurableObjectNamespace,
    instanceName,
    resolution.regionKey
  ) as CredentialOfferStoreStub;

  return { stub, resolution, instanceName, uuid: parsed.uuid };
}

/**
 * Get CredentialOfferStore Durable Object stub for creating a new offer.
 *
 * @param env - Environment with DO bindings
 * @param tenantId - Tenant ID
 * @param userId - User identifier
 * @param uuid - Unique offer identifier
 * @returns Object containing DO stub, offerId, and resolution info
 *
 * @example
 * const { stub, offerId } = await getCredentialOfferStoreForNewOffer(
 *   env, 'tenant1', 'user123', crypto.randomUUID()
 * );
 */
export async function getCredentialOfferStoreForNewOffer(
  env: Env,
  tenantId: string,
  userId: string,
  uuid: string
): Promise<{
  stub: CredentialOfferStoreStub;
  offerId: string;
  resolution: ShardResolution;
  instanceName: string;
}> {
  const { offerId, shardIndex, regionKey, generation } = await generateCredentialOfferId(
    env,
    tenantId,
    userId,
    uuid
  );

  const resolution: ShardResolution = {
    generation,
    regionKey,
    shardIndex,
  };

  const instanceName = buildRegionInstanceName(tenantId, regionKey, 'credoffer', shardIndex);
  const stub = getRegionAwareDOStub(
    env.CREDENTIAL_OFFER_STORE as unknown as DurableObjectNamespace,
    instanceName,
    regionKey
  ) as CredentialOfferStoreStub;

  return { stub, offerId, resolution, instanceName };
}

/**
 * Generate pre-authorized code with region-sharding info.
 *
 * Pre-auth code format: g{gen}:{region}:{shard}:pac_{code}
 * This allows the token endpoint to route directly to the correct shard.
 *
 * @param env - Environment with KV binding
 * @param tenantId - Tenant ID
 * @param userId - User identifier
 * @param code - Random pre-authorized code
 * @returns Region-sharded pre-authorized code
 */
export async function generatePreAuthorizedCode(
  env: Env,
  tenantId: string,
  userId: string,
  code: string
): Promise<string> {
  const config = await getRegionShardConfig(
    { AUTHRIM_CONFIG: env.AUTHRIM_CONFIG } as Parameters<typeof getRegionShardConfig>[0],
    tenantId
  );

  const shardKey = `${tenantId}:${userId}`;
  const resolution = resolveShardForNewResource(config, shardKey);

  return createRegionId(
    resolution.generation,
    resolution.regionKey,
    resolution.shardIndex,
    `pac_${code}`
  );
}

/**
 * Parse a pre-authorized code to extract shard info.
 *
 * @param preAuthCode - Region-sharded pre-authorized code
 * @returns Parsed region ID with code, or null if invalid format
 */
export function parsePreAuthorizedCode(
  preAuthCode: string
): (ParsedRegionId & { code: string }) | null {
  try {
    const parsed = parseRegionId(preAuthCode);
    if (!parsed.randomPart.startsWith('pac_')) {
      return null;
    }
    return {
      ...parsed,
      code: parsed.randomPart.substring(4), // Remove 'pac_' prefix
    };
  } catch {
    return null;
  }
}
