import { isDatabaseSource, MysqlAdapter, PostgresAdapter, type DatabaseSource } from '../db';
import type { StorageProfile, StorageSlice, StorageTarget } from '../types/runtime-profile';

function normalizeBindingCandidates(ref: string | undefined): string[] {
  if (!ref) {
    return [];
  }

  const normalized = ref.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
  return [...new Set([ref, normalized, `HYPERDRIVE_${normalized}`])];
}

function resolveHyperdriveBinding(
  env: object,
  target: StorageTarget
): Hyperdrive | null {
  if (target.driver !== 'postgres' && target.driver !== 'mysql') {
    return null;
  }

  const refs = [
    ...normalizeBindingCandidates(target.bindingRef),
    ...normalizeBindingCandidates(target.connectionRef),
  ];

  for (const ref of refs) {
    const binding = (env as Record<string, unknown>)[ref];
    if (binding && typeof binding === 'object' && 'connectionString' in binding) {
      return binding as Hyperdrive;
    }
  }

  return null;
}

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

    const hyperdrive = resolveHyperdriveBinding(env, target);
    if (hyperdrive) {
      return target.driver === 'postgres'
        ? new PostgresAdapter({ hyperdrive, partition: target.role ?? 'core' })
        : new MysqlAdapter({ hyperdrive, partition: target.role ?? 'core' });
    }

    throw new Error(`storage_profile_binding_not_configured:${target.bindingRef}`);
  }

  if (target.connectionRef) {
    const hyperdrive = resolveHyperdriveBinding(env, target);
    if (hyperdrive) {
      return target.driver === 'postgres'
        ? new PostgresAdapter({ hyperdrive, partition: target.role ?? 'core' })
        : new MysqlAdapter({ hyperdrive, partition: target.role ?? 'core' });
    }

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
