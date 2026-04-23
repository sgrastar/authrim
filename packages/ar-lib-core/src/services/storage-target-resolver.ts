import { isDatabaseSource, type DatabaseSource } from '../db';
import type { StorageProfile, StorageSlice, StorageTarget } from '../types/runtime-profile';

export function getBoundStorageTargetSource(
  env: object,
  target: StorageTarget,
  options: {
    fallbackBindingRefs?: Record<string, DatabaseSource | null | undefined>;
  } = {}
): DatabaseSource {
  if (target.bindingRef) {
    const candidate = (env as Record<string, unknown>)[target.bindingRef];
    if (isDatabaseSource(candidate)) {
      return candidate;
    }

    const fallback = options.fallbackBindingRefs?.[target.bindingRef];
    if (isDatabaseSource(fallback)) {
      return fallback;
    }

    throw new Error(`storage_profile_binding_not_configured:${target.bindingRef}`);
  }

  if (target.connectionRef) {
    throw new Error(`storage_profile_connection_not_resolved:${target.connectionRef}`);
  }

  throw new Error('storage_profile_target_not_resolved');
}

export function getOptionalStorageSliceTarget(
  profile: StorageProfile,
  slice: StorageSlice
): StorageTarget | null {
  return profile.slices[slice] ?? null;
}

export function getRequiredStorageSliceTarget(
  profile: StorageProfile,
  slice: StorageSlice
): StorageTarget {
  const target = getOptionalStorageSliceTarget(profile, slice);
  if (!target) {
    throw new Error(`storage_profile_slice_not_configured:${slice}`);
  }
  return target;
}
