import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TENANT_USER_CREATION_SHARD_POLICY,
  TENANT_REGION_AFFINITY_AUTOMATIC_MOVEMENT_ENABLED,
  buildTenantDiscoveryShardHintMetadata,
  buildTenantShardManifest,
  createTenantShardLookupPlan,
  selectTenantUserCreationShard,
} from '../tenant-database-sharding-policy';

describe('tenant database sharding policy', () => {
  it('uses hash_user_id as the initial user creation shard policy', () => {
    const first = selectTenantUserCreationShard({
      tenantId: 'tenant-a',
      userId: 'user-1',
      shardCount: 8,
    });
    const second = selectTenantUserCreationShard({
      tenantId: 'tenant-a',
      userId: 'user-1',
      shardCount: 8,
    });

    expect(DEFAULT_TENANT_USER_CREATION_SHARD_POLICY).toBe('hash_user_id');
    expect(TENANT_REGION_AFFINITY_AUTOMATIC_MOVEMENT_ENABLED).toBe(false);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      policy: 'hash_user_id',
      shardGroup: 'default',
      shardCount: 8,
      automaticRegionMovement: false,
    });
    expect(first.shardIndex).toBeGreaterThanOrEqual(0);
    expect(first.shardIndex).toBeLessThan(8);
  });

  it('requires a shard hint for normal runtime lookup and reserves fan-out for repair tools', () => {
    const shardHint = {
      shardGroup: 'default',
      shardIndex: 2,
      shardCount: 4,
      shardKeyStrategy: 'hash_user_id',
      regionHint: null,
    } as const;

    expect(createTenantShardLookupPlan({ shardHint })).toEqual({
      mode: 'single_shard',
      shardHint,
    });
    expect(() => createTenantShardLookupPlan({})).toThrow(
      'tenant_shard_hint_required_for_runtime_lookup'
    );
    expect(createTenantShardLookupPlan({ operatorRepairFanout: true })).toEqual({
      mode: 'operator_repair_fanout',
      shardHint: null,
    });
  });

  it('builds shard-aware manifests and discovery shard hint metadata', () => {
    const manifest = buildTenantShardManifest({
      tenantId: 'tenant-a',
      role: 'tenant_core',
      generation: 3,
      rows: [
        {
          shard_group: 'default',
          shard_index: 1,
          shard_count: 2,
          shard_key_strategy: 'hash_user_id',
          region_hint: 'wnam',
        },
        {
          shard_group: 'default',
          shard_index: 0,
          shard_count: 2,
          shard_key_strategy: 'hash_user_id',
          region_hint: 'enam',
        },
      ],
    });

    expect(manifest.shards.map((shard) => shard.shardIndex)).toEqual([0, 1]);
    expect(buildTenantDiscoveryShardHintMetadata(manifest.shards[0])).toEqual({
      shard_hint: {
        shard_group: 'default',
        shard_index: 0,
        shard_count: 2,
        shard_key_strategy: 'hash_user_id',
        region_hint: 'enam',
      },
    });
  });
});
