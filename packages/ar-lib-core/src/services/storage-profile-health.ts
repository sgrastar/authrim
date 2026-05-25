import { ensureDatabaseAdapter } from '../db';
import type { DatabaseSource, HealthStatus } from '../db';
import type {
  StorageLogicalSource,
  StorageProfile,
  StorageSlice,
  StorageTarget,
} from '../types/runtime-profile';
import {
  getBoundStorageTargetSource,
  getOptionalStorageLogicalSourceTarget,
  getOptionalStorageSliceTarget,
} from './storage-target-resolver';

export type StorageProfileHealthTargetKind = 'slice' | 'logical_source';

export interface StorageProfileHealthCheckResult {
  profileId: string;
  targetKind: StorageProfileHealthTargetKind;
  targetName: StorageSlice | StorageLogicalSource;
  driver: StorageTarget['driver'];
  role: StorageTarget['role'] | null;
  bindingRef: string | null;
  connectionRef: string | null;
  healthy: boolean;
  latencyMs: number;
  checkedAt: string;
  sourceHealth: HealthStatus;
}

function resolveHealthTarget(
  profile: StorageProfile,
  targetKind: StorageProfileHealthTargetKind,
  targetName: StorageSlice | StorageLogicalSource
): StorageTarget {
  const target =
    targetKind === 'slice'
      ? getOptionalStorageSliceTarget(profile, targetName as StorageSlice)
      : getOptionalStorageLogicalSourceTarget(profile, targetName as StorageLogicalSource);

  if (!target) {
    throw new Error(`storage_profile_health_target_not_configured:${targetKind}:${targetName}`);
  }

  return target;
}

export async function checkStorageProfileTargetHealth(
  env: object,
  profile: StorageProfile,
  targetKind: StorageProfileHealthTargetKind,
  targetName: StorageSlice | StorageLogicalSource,
  checkedAt = new Date().toISOString()
): Promise<StorageProfileHealthCheckResult> {
  const target = resolveHealthTarget(profile, targetKind, targetName);
  const envWithDatabases = env as { DB?: DatabaseSource; DB_PII?: DatabaseSource };
  const source = getBoundStorageTargetSource(env, target, {
    fallbackBindingRefs: {
      DB_PII: envWithDatabases.DB_PII ?? envWithDatabases.DB,
    },
  });
  const adapter = ensureDatabaseAdapter(source, `storage-profile-health:${profile.id}`);
  const sourceHealth = await adapter.isHealthy();

  return {
    profileId: profile.id,
    targetKind,
    targetName,
    driver: target.driver,
    role: target.role ?? null,
    bindingRef: target.bindingRef ?? null,
    connectionRef: target.connectionRef ?? null,
    healthy: sourceHealth.healthy,
    latencyMs: sourceHealth.latencyMs,
    checkedAt,
    sourceHealth,
  };
}
