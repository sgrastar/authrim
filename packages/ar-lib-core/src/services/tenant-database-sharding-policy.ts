import type { TenantDatabaseRegistryRow } from '../repositories/admin/tenant-database-registry';

export type TenantUserCreationShardPolicy = 'hash_user_id' | 'region_affinity';
export type TenantShardLookupMode = 'single_shard' | 'operator_repair_fanout';

export interface TenantDatabaseShardHint {
  shardGroup: string;
  shardIndex: number;
  shardCount: number;
  shardKeyStrategy: TenantDatabaseRegistryRow['shard_key_strategy'];
  regionHint?: string | null;
}

export interface TenantShardSelection {
  policy: TenantUserCreationShardPolicy;
  shardGroup: string;
  shardIndex: number;
  shardCount: number;
  automaticRegionMovement: false;
}

export interface TenantShardLookupPlan {
  mode: TenantShardLookupMode;
  shardHint: TenantDatabaseShardHint | null;
}

export interface TenantShardManifest {
  tenantId: string;
  role: TenantDatabaseRegistryRow['role'];
  generation: number;
  shardGroup: string;
  shardCount: number;
  shards: TenantDatabaseShardHint[];
}

export const DEFAULT_TENANT_USER_CREATION_SHARD_POLICY: TenantUserCreationShardPolicy =
  'hash_user_id';
export const TENANT_REGION_AFFINITY_AUTOMATIC_MOVEMENT_ENABLED = false;

function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function normalizeShardCount(shardCount: number): number {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error('tenant_shard_count_must_be_positive_integer');
  }
  return shardCount;
}

export function selectTenantUserCreationShard(options: {
  tenantId: string;
  userId: string;
  shardCount: number;
  shardGroup?: string;
  policy?: TenantUserCreationShardPolicy;
}): TenantShardSelection {
  const shardCount = normalizeShardCount(options.shardCount);
  const policy = options.policy ?? DEFAULT_TENANT_USER_CREATION_SHARD_POLICY;
  const shardIndex = fnv1a32(`${options.tenantId}:${options.userId}`) % shardCount;

  return {
    policy,
    shardGroup: options.shardGroup ?? 'default',
    shardIndex,
    shardCount,
    automaticRegionMovement: TENANT_REGION_AFFINITY_AUTOMATIC_MOVEMENT_ENABLED,
  };
}

export function createTenantShardLookupPlan(options: {
  shardHint?: TenantDatabaseShardHint | null;
  operatorRepairFanout?: boolean;
}): TenantShardLookupPlan {
  if (options.shardHint) {
    return { mode: 'single_shard', shardHint: options.shardHint };
  }
  if (options.operatorRepairFanout) {
    return { mode: 'operator_repair_fanout', shardHint: null };
  }
  throw new Error('tenant_shard_hint_required_for_runtime_lookup');
}

export function buildTenantShardManifest(options: {
  tenantId: string;
  role: TenantDatabaseRegistryRow['role'];
  generation: number;
  rows: Pick<
    TenantDatabaseRegistryRow,
    'shard_group' | 'shard_index' | 'shard_count' | 'shard_key_strategy' | 'region_hint'
  >[];
}): TenantShardManifest {
  const shardGroup = options.rows[0]?.shard_group ?? 'default';
  const shardCount = normalizeShardCount(options.rows[0]?.shard_count ?? 1);
  return {
    tenantId: options.tenantId,
    role: options.role,
    generation: options.generation,
    shardGroup,
    shardCount,
    shards: options.rows
      .map((row) => ({
        shardGroup: row.shard_group,
        shardIndex: row.shard_index,
        shardCount: row.shard_count,
        shardKeyStrategy: row.shard_key_strategy,
        regionHint: row.region_hint,
      }))
      .sort((left, right) => left.shardIndex - right.shardIndex),
  };
}

export function buildTenantDiscoveryShardHintMetadata(
  shardHint: TenantDatabaseShardHint
): Record<string, unknown> {
  return {
    shard_hint: {
      shard_group: shardHint.shardGroup,
      shard_index: shardHint.shardIndex,
      shard_count: shardHint.shardCount,
      shard_key_strategy: shardHint.shardKeyStrategy,
      region_hint: shardHint.regionHint ?? null,
    },
  };
}
