import { isDatabaseSource, MysqlAdapter, PostgresAdapter } from '../db';
function normalizeBindingCandidates(ref) {
    if (!ref) {
        return [];
    }
    const normalized = ref.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
    return [...new Set([ref, normalized, `HYPERDRIVE_${normalized}`])];
}
function resolveHyperdriveBinding(env, target) {
    if (target.driver !== 'postgres' && target.driver !== 'mysql') {
        return null;
    }
    const refs = [
        ...normalizeBindingCandidates(target.bindingRef),
        ...normalizeBindingCandidates(target.connectionRef),
    ];
    for (const ref of refs) {
        const binding = env[ref];
        if (binding && typeof binding === 'object' && 'connectionString' in binding) {
            return binding;
        }
    }
    return null;
}
export function getBoundStorageTargetSource(env, target, options = {}) {
    if (target.bindingRef) {
        const candidate = env[target.bindingRef];
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
export function getOptionalStorageSliceTarget(profile, slice) {
    return profile.slices[slice] ?? null;
}
export function getRequiredStorageSliceTarget(profile, slice) {
    const target = getOptionalStorageSliceTarget(profile, slice);
    if (!target) {
        throw new Error(`storage_profile_slice_not_configured:${slice}`);
    }
    return target;
}
