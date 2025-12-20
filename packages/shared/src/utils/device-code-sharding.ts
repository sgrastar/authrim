/**
 * Device Code Sharding Helper (Region Sharding Version)
 *
 * Provides utilities for generating region-sharded device codes and routing
 * device authorization operations to the correct Durable Object shard with locationHint.
 *
 * Device Code format: g{gen}:{region}:{shard}:dev_{device_code}
 * DO instance name: {tenantId}:{region}:dev:{shard}
 *
 * Sharding Strategy:
 * - Uses FNV-1a hash of `client_id` as shard key
 * - Colocates device authorization requests from the same client
 * - Region-aware placement using locationHint
 *
 * Security Considerations:
 * - Device code single-use enforcement is per-DO instance (atomic)
 * - User code polling is rate-limited per shard
 * - ID format embeds shard info for self-routing (no external lookup)
 * - Generation-based versioning for configuration changes
 *
 * @see docs/architecture/durable-objects-sharding.md
 * @see RFC 8628 - OAuth 2.0 Device Authorization Grant
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
 * Type alias for DeviceCodeStore stub
 * Uses generic stub type since DeviceCodeStore uses fetch() pattern
 */
type DeviceCodeStoreStub = DurableObjectStub;

/**
 * Default tenant ID
 */
const DEFAULT_TENANT_ID = 'default';

/**
 * Default device code TTL (600 seconds = 10 minutes as per RFC 8628)
 */
export const DEVICE_CODE_DEFAULT_TTL_SECONDS = 600;

/**
 * Default polling interval (5 seconds as per RFC 8628)
 */
export const DEVICE_CODE_DEFAULT_INTERVAL_SECONDS = 5;

/**
 * Generate a new region-sharded device code.
 *
 * Uses FNV-1a hash of client_id to determine shard.
 * This colocates device authorization requests from the same client.
 *
 * @param env - Environment with KV binding
 * @param tenantId - Tenant ID
 * @param clientId - Client identifier (for sharding)
 * @param deviceCode - The device code value
 * @returns Object containing deviceCodeId, shardIndex, regionKey, generation
 *
 * @example
 * const { deviceCodeId, shardIndex } = await generateDeviceCodeId(
 *   env, 'tenant1', 'client123', 'GmRhmhcxhwAzkoEqiMEg_DnyEysNkuNhszIyS'
 * );
 * // deviceCodeId: "g1:apac:3:dev_GmRhmhcxhwAzkoEqiMEg_DnyEysNkuNhszIyS"
 */
export async function generateDeviceCodeId(
  env: Env,
  tenantId: string,
  clientId: string,
  deviceCode: string
): Promise<{
  deviceCodeId: string;
  shardIndex: number;
  regionKey: string;
  generation: number;
}> {
  // Get region shard config
  const config = await getRegionShardConfig(env, tenantId);

  // Resolve shard using client_id as key
  const resolution = resolveShardForNewResourceTyped(config, 'device', clientId);

  // Create device code ID with embedded region info
  const deviceCodeId = createRegionId(
    resolution.generation,
    resolution.regionKey,
    resolution.shardIndex,
    `${ID_PREFIX.device}_${deviceCode}`
  );

  return {
    deviceCodeId,
    shardIndex: resolution.shardIndex,
    regionKey: resolution.regionKey,
    generation: resolution.generation,
  };
}

/**
 * Parse a region-sharded device code ID to extract shard info.
 *
 * @param deviceCodeId - Region-sharded device code ID
 * @returns Parsed region ID with deviceCode, or null if invalid format
 *
 * @example
 * const result = parseDeviceCodeId("g1:apac:3:dev_GmRhmhcxhw...");
 * // { generation: 1, regionKey: 'apac', shardIndex: 3, deviceCode: 'GmRhmhcxhw...' }
 */
export function parseDeviceCodeId(
  deviceCodeId: string
): (ParsedRegionId & { deviceCode: string }) | null {
  try {
    const parsed = parseRegionId(deviceCodeId);
    // Verify this is a device code ID
    if (!parsed.randomPart.startsWith(`${ID_PREFIX.device}_`)) {
      return null;
    }
    return {
      ...parsed,
      deviceCode: parsed.randomPart.substring(ID_PREFIX.device.length + 1), // Remove 'dev_' prefix
    };
  } catch {
    return null;
  }
}

/**
 * Get DeviceCodeStore Durable Object stub for an existing device code ID.
 *
 * Parses the device code ID to extract region and shard info, then routes
 * to the correct DO instance with locationHint.
 *
 * @param env - Environment with DO bindings
 * @param deviceCodeId - Region-sharded device code ID
 * @param tenantId - Tenant ID
 * @returns Object containing DO stub and resolution info
 * @throws Error if deviceCodeId format is invalid
 *
 * @example
 * const { stub, resolution } = getDeviceCodeStoreById(env, "g1:apac:3:dev_abc...");
 * const response = await stub.fetch(new Request('https://internal/poll'));
 */
export function getDeviceCodeStoreById(
  env: Env,
  deviceCodeId: string,
  tenantId: string = DEFAULT_TENANT_ID
): {
  stub: DeviceCodeStoreStub;
  resolution: ShardResolution;
  instanceName: string;
  deviceCode: string;
} {
  const parsed = parseDeviceCodeId(deviceCodeId);
  if (!parsed) {
    throw new Error(`Invalid region-sharded device code ID format: ${deviceCodeId}`);
  }

  const resolution: ShardResolution = {
    generation: parsed.generation,
    regionKey: parsed.regionKey,
    shardIndex: parsed.shardIndex,
  };

  const instanceName = buildRegionInstanceName(
    tenantId,
    resolution.regionKey,
    'device',
    resolution.shardIndex
  );

  const stub = getRegionAwareDOStub(
    env.DEVICE_CODE_STORE as unknown as DurableObjectNamespace,
    instanceName,
    resolution.regionKey
  ) as DeviceCodeStoreStub;

  return { stub, resolution, instanceName, deviceCode: parsed.deviceCode };
}

/**
 * Get DeviceCodeStore Durable Object stub for creating a new device code.
 *
 * @param env - Environment with DO bindings
 * @param tenantId - Tenant ID
 * @param clientId - Client identifier
 * @param deviceCode - The device code value
 * @returns Object containing DO stub, deviceCodeId, and resolution info
 *
 * @example
 * const { stub, deviceCodeId } = await getDeviceCodeStoreForNewCode(
 *   env, 'tenant1', 'client123', 'GmRhmhcxhw...'
 * );
 */
export async function getDeviceCodeStoreForNewCode(
  env: Env,
  tenantId: string,
  clientId: string,
  deviceCode: string
): Promise<{
  stub: DeviceCodeStoreStub;
  deviceCodeId: string;
  resolution: ShardResolution;
  instanceName: string;
}> {
  const { deviceCodeId, shardIndex, regionKey, generation } = await generateDeviceCodeId(
    env,
    tenantId,
    clientId,
    deviceCode
  );

  const resolution: ShardResolution = {
    generation,
    regionKey,
    shardIndex,
  };

  const instanceName = buildRegionInstanceName(tenantId, regionKey, 'device', shardIndex);
  const stub = getRegionAwareDOStub(
    env.DEVICE_CODE_STORE as unknown as DurableObjectNamespace,
    instanceName,
    regionKey
  ) as DeviceCodeStoreStub;

  return { stub, deviceCodeId, resolution, instanceName };
}
