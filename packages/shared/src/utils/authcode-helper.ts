/**
 * Authorization Code Store Sharding Helper (Region Sharding Version)
 *
 * Provides utilities for generating region-sharded authorization codes and routing
 * auth code operations to the correct Durable Object shard with locationHint.
 *
 * Auth Code format: g{gen}:{region}:{shard}:ac_{randomCode}
 * DO instance name: {tenantId}:{region}:ac:{shard}
 *
 * IMPORTANT:
 * - generateRegionShardedAuthCode() uses region shard config to determine shard and region
 * - parseRegionShardedAuthCode() extracts generation, region, and shard from the code
 * - locationHint is used to place DO instances closer to users in specific regions
 * - Shard is determined by userId:clientId hash for colocation with RefreshToken
 */

import type { Env } from '../types/env';
import type { DurableObjectNamespace, DurableObjectStub } from '@cloudflare/workers-types';
import type { AuthorizationCodeStore } from '../durable-objects/AuthorizationCodeStore';
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

/**
 * Type alias for AuthorizationCodeStore stub returned from region-aware functions
 */
type AuthCodeStoreStub = DurableObjectStub<AuthorizationCodeStore>;

/**
 * Generate a new region-sharded authorization code.
 *
 * Uses FNV-1a hash of userId:clientId to determine which shard the code belongs to,
 * then resolves the region from the shard index using the region shard config.
 * This ensures colocation with RefreshToken for the same user+client pair.
 *
 * @param env - Environment with KV binding for region shard config
 * @param userId - User identifier (sub claim)
 * @param clientId - OAuth client identifier
 * @param randomCode - Random opaque code string
 * @param tenantId - Tenant ID (default: 'default')
 * @returns Object containing authCode, shardIndex, regionKey, and generation
 *
 * @example
 * const { authCode, shardIndex, regionKey, generation } = await generateRegionShardedAuthCode(
 *   env, 'user123', 'client456', 'randomCode789'
 * );
 * // authCode: "g1:apac:3:ac_randomCode789"
 */
export async function generateRegionShardedAuthCode(
  env: Env,
  userId: string,
  clientId: string,
  randomCode: string,
  tenantId: string = DEFAULT_TENANT_ID
): Promise<{
  authCode: string;
  shardIndex: number;
  regionKey: string;
  generation: number;
}> {
  const config = await getRegionShardConfig(env, tenantId);

  // Use userId:clientId as the shard key for colocation with RefreshToken
  const shardKey = `${userId}:${clientId}`;
  const resolution = resolveShardForNewResource(config, shardKey);

  // Create auth code with embedded region info
  const authCode = createRegionId(
    resolution.generation,
    resolution.regionKey,
    resolution.shardIndex,
    `ac_${randomCode}`
  );

  return {
    authCode,
    shardIndex: resolution.shardIndex,
    regionKey: resolution.regionKey,
    generation: resolution.generation,
  };
}

/**
 * Parse a region-sharded authorization code to extract shard info.
 *
 * @param authCode - Region-sharded auth code (format: g{gen}:{region}:{shard}:ac_{randomCode})
 * @returns Parsed region ID with opaqueCode, or null if invalid format
 *
 * @example
 * const result = parseRegionShardedAuthCode("g1:apac:3:ac_randomCode789");
 * // { generation: 1, regionKey: 'apac', shardIndex: 3, opaqueCode: 'randomCode789' }
 */
export function parseRegionShardedAuthCode(
  authCode: string
): (ParsedRegionId & { opaqueCode: string }) | null {
  try {
    const parsed = parseRegionId(authCode);
    // Verify this is an auth code
    if (!parsed.randomPart.startsWith('ac_')) {
      return null;
    }
    return {
      ...parsed,
      opaqueCode: parsed.randomPart.substring(3), // Remove 'ac_' prefix
    };
  } catch {
    return null;
  }
}

/**
 * Get AuthorizationCodeStore Durable Object stub for an existing auth code.
 *
 * Parses the auth code to extract the region and shard info, then routes to
 * the correct DO instance with locationHint for optimal placement.
 *
 * @param env - Environment object with DO bindings
 * @param authCode - Region-sharded authorization code
 * @param tenantId - Tenant ID (default: 'default')
 * @returns Object containing DO stub and resolution info
 * @throws Error if authCode format is invalid
 *
 * @example
 * const { stub, resolution, opaqueCode } = getAuthCodeStoreByCode(env, "g1:apac:3:ac_xyz789");
 * const response = await stub.fetch(new Request(...));
 */
export function getAuthCodeStoreByCode(
  env: Env,
  authCode: string,
  tenantId: string = DEFAULT_TENANT_ID
): {
  stub: AuthCodeStoreStub;
  resolution: ShardResolution;
  instanceName: string;
  opaqueCode: string;
} {
  const parsed = parseRegionShardedAuthCode(authCode);
  if (!parsed) {
    throw new Error(`Invalid region-sharded auth code format: ${authCode}`);
  }

  const resolution: ShardResolution = {
    generation: parsed.generation,
    regionKey: parsed.regionKey,
    shardIndex: parsed.shardIndex,
  };

  const instanceName = buildRegionInstanceName(
    tenantId,
    resolution.regionKey,
    'authcode',
    resolution.shardIndex
  );

  const stub = getRegionAwareDOStub(
    env.AUTH_CODE_STORE as unknown as DurableObjectNamespace,
    instanceName,
    resolution.regionKey
  ) as AuthCodeStoreStub;

  return { stub, resolution, instanceName, opaqueCode: parsed.opaqueCode };
}

/**
 * Get AuthorizationCodeStore Durable Object stub for creating a new auth code.
 *
 * This is the entry point for creating new authorization codes. It:
 * 1. Gets the region shard config from KV
 * 2. Generates a new region-sharded auth code
 * 3. Returns the DO stub with locationHint for the target region
 *
 * @param env - Environment object with DO bindings
 * @param userId - User identifier (sub claim)
 * @param clientId - OAuth client identifier
 * @param randomCode - Random opaque code string
 * @param tenantId - Tenant ID (default: 'default')
 * @returns Object containing DO stub, new authCode, and resolution info
 *
 * @example
 * const { stub, authCode, resolution } = await getAuthCodeStoreForNewCode(
 *   env, 'user123', 'client456', 'randomCode789'
 * );
 * const response = await stub.fetch(new Request(..., {
 *   body: JSON.stringify({ code: authCode, ... })
 * }));
 */
export async function getAuthCodeStoreForNewCode(
  env: Env,
  userId: string,
  clientId: string,
  randomCode: string,
  tenantId: string = DEFAULT_TENANT_ID
): Promise<{
  stub: AuthCodeStoreStub;
  authCode: string;
  resolution: ShardResolution;
  instanceName: string;
}> {
  const { authCode, shardIndex, regionKey, generation } = await generateRegionShardedAuthCode(
    env,
    userId,
    clientId,
    randomCode,
    tenantId
  );

  const resolution: ShardResolution = {
    generation,
    regionKey,
    shardIndex,
  };

  const instanceName = buildRegionInstanceName(tenantId, regionKey, 'authcode', shardIndex);
  const stub = getRegionAwareDOStub(
    env.AUTH_CODE_STORE as unknown as DurableObjectNamespace,
    instanceName,
    regionKey
  ) as AuthCodeStoreStub;

  return { stub, authCode, resolution, instanceName };
}

/**
 * Check if an authorization code is in the region-sharded format.
 *
 * @param authCode - Authorization code to check
 * @returns true if the auth code follows the region-sharded format
 */
export function isRegionShardedAuthCode(authCode: string): boolean {
  return parseRegionShardedAuthCode(authCode) !== null;
}
