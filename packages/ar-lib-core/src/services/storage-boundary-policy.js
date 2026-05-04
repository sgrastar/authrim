export const AUTH_CORE_STORAGE_SLICE = 'users_core';
export const AUTH_CORE_STORAGE_SLICES = [AUTH_CORE_STORAGE_SLICE];
export const STORAGE_SLICE_BOUNDARY_POLICIES = {
    users_core: {
        slice: 'users_core',
        boundaryClass: 'auth_core',
        tenantOverrideAllowed: false,
        d1Default: true,
        nonD1OptionRequired: false,
        compatibilityShorthand: true,
    },
    users_pii: {
        slice: 'users_pii',
        boundaryClass: 'pii',
        tenantOverrideAllowed: true,
        d1Default: true,
        nonD1OptionRequired: true,
    },
    custom_claims: {
        slice: 'custom_claims',
        boundaryClass: 'custom_extension',
        tenantOverrideAllowed: true,
        d1Default: true,
        nonD1OptionRequired: true,
    },
    registration_fields: {
        slice: 'registration_fields',
        boundaryClass: 'custom_extension',
        tenantOverrideAllowed: true,
        d1Default: true,
        nonD1OptionRequired: true,
    },
    custom_pii: {
        slice: 'custom_pii',
        boundaryClass: 'custom_extension',
        tenantOverrideAllowed: true,
        d1Default: true,
        nonD1OptionRequired: true,
    },
};
const IMPLICIT_AUTH_CORE_TARGET = {
    driver: 'd1',
    bindingRef: 'DB',
    role: 'core',
};
function normalizeStorageTarget(target) {
    return {
        driver: target.driver,
        bindingRef: target.bindingRef ?? null,
        connectionRef: target.connectionRef ?? null,
        role: target.role ?? null,
    };
}
function formatStorageTarget(target) {
    const normalized = normalizeStorageTarget(target);
    const locator = normalized.bindingRef !== null
        ? `binding:${normalized.bindingRef}`
        : normalized.connectionRef !== null
            ? `connection:${normalized.connectionRef}`
            : 'unresolved';
    const role = normalized.role ?? 'unspecified';
    return `${normalized.driver}/${locator}/${role}`;
}
export function getStorageSliceBoundaryPolicy(slice) {
    return STORAGE_SLICE_BOUNDARY_POLICIES[slice];
}
export function listStorageSliceBoundaryPolicies() {
    return Object.values(STORAGE_SLICE_BOUNDARY_POLICIES);
}
export function getEffectiveAuthCoreTarget(profile) {
    return profile.slices.users_core ?? IMPLICIT_AUTH_CORE_TARGET;
}
export function storageTargetsEqual(left, right) {
    const normalizedLeft = normalizeStorageTarget(left);
    const normalizedRight = normalizeStorageTarget(right);
    return (normalizedLeft.driver === normalizedRight.driver &&
        normalizedLeft.bindingRef === normalizedRight.bindingRef &&
        normalizedLeft.connectionRef === normalizedRight.connectionRef &&
        normalizedLeft.role === normalizedRight.role);
}
export function validateTenantStorageProfileOverride(defaultProfile, candidateProfile) {
    const defaultTarget = getEffectiveAuthCoreTarget(defaultProfile);
    const candidateTarget = getEffectiveAuthCoreTarget(candidateProfile);
    if (storageTargetsEqual(defaultTarget, candidateTarget)) {
        return null;
    }
    return {
        code: 'tenant_auth_core_override_not_allowed',
        message: `Tenant storage profile overrides may not change the auth core plane ` +
            `(${AUTH_CORE_STORAGE_SLICE}). ` +
            `Expected ${formatStorageTarget(defaultTarget)} to match environment default ` +
            `but received ${formatStorageTarget(candidateTarget)}.`,
    };
}
