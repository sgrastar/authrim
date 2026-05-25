import type { StorageProfile, StorageSlice, StorageTarget } from '../types/runtime-profile';

export const AUTH_CORE_STORAGE_SLICE = 'users_core' as const;
export const AUTH_CORE_STORAGE_SLICES = [AUTH_CORE_STORAGE_SLICE] as const;

export type StorageBoundaryClass = 'auth_core' | 'pii' | 'custom_extension' | 'authorization';

export interface StorageSliceBoundaryPolicy {
  slice: StorageSlice;
  boundaryClass: StorageBoundaryClass;
  tenantOverrideAllowed: boolean;
  d1Default: boolean;
  nonD1OptionRequired: boolean;
  compatibilityShorthand?: boolean;
}

export const STORAGE_SLICE_BOUNDARY_POLICIES: Readonly<
  Record<StorageSlice, StorageSliceBoundaryPolicy>
> = {
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
  passkeys: {
    slice: 'passkeys',
    boundaryClass: 'auth_core',
    tenantOverrideAllowed: false,
    d1Default: true,
    nonD1OptionRequired: false,
  },
  linked_identities: {
    slice: 'linked_identities',
    boundaryClass: 'pii',
    tenantOverrideAllowed: true,
    d1Default: true,
    nonD1OptionRequired: true,
  },
  consent: {
    slice: 'consent',
    boundaryClass: 'auth_core',
    tenantOverrideAllowed: false,
    d1Default: true,
    nonD1OptionRequired: false,
  },
  authorization: {
    slice: 'authorization',
    boundaryClass: 'authorization',
    tenantOverrideAllowed: false,
    d1Default: true,
    nonD1OptionRequired: false,
  },
} as const;

const IMPLICIT_AUTH_CORE_TARGET: StorageTarget = {
  driver: 'd1',
  bindingRef: 'DB',
  role: 'core',
};

export interface StorageBoundaryViolation {
  code:
    | 'tenant_auth_core_override_not_allowed'
    | 'tenant_protected_storage_slice_override_not_allowed';
  message: string;
}

interface NormalizedStorageTarget {
  driver: StorageTarget['driver'];
  bindingRef: string | null;
  connectionRef: string | null;
  role: StorageTarget['role'] | null;
}

function normalizeStorageTarget(target: StorageTarget): NormalizedStorageTarget {
  return {
    driver: target.driver,
    bindingRef: target.bindingRef ?? null,
    connectionRef: target.connectionRef ?? null,
    role: target.role ?? null,
  };
}

function formatStorageTarget(target: StorageTarget): string {
  const normalized = normalizeStorageTarget(target);
  const locator =
    normalized.bindingRef !== null
      ? `binding:${normalized.bindingRef}`
      : normalized.connectionRef !== null
        ? `connection:${normalized.connectionRef}`
        : 'unresolved';
  const role = normalized.role ?? 'unspecified';
  return `${normalized.driver}/${locator}/${role}`;
}

export function getStorageSliceBoundaryPolicy(slice: StorageSlice): StorageSliceBoundaryPolicy {
  return STORAGE_SLICE_BOUNDARY_POLICIES[slice];
}

export function listStorageSliceBoundaryPolicies(): StorageSliceBoundaryPolicy[] {
  return Object.values(STORAGE_SLICE_BOUNDARY_POLICIES);
}

export function getEffectiveAuthCoreTarget(profile: StorageProfile): StorageTarget {
  return profile.slices.users_core ?? IMPLICIT_AUTH_CORE_TARGET;
}

function getEffectiveStorageSliceTarget(
  profile: StorageProfile,
  slice: StorageSlice
): StorageTarget | null {
  if (slice === AUTH_CORE_STORAGE_SLICE) {
    return getEffectiveAuthCoreTarget(profile);
  }
  return profile.slices[slice] ?? null;
}

export function storageTargetsEqual(left: StorageTarget, right: StorageTarget): boolean {
  const normalizedLeft = normalizeStorageTarget(left);
  const normalizedRight = normalizeStorageTarget(right);

  return (
    normalizedLeft.driver === normalizedRight.driver &&
    normalizedLeft.bindingRef === normalizedRight.bindingRef &&
    normalizedLeft.connectionRef === normalizedRight.connectionRef &&
    normalizedLeft.role === normalizedRight.role
  );
}

export function validateTenantStorageProfileOverride(
  defaultProfile: StorageProfile,
  candidateProfile: StorageProfile
): StorageBoundaryViolation | null {
  const defaultTarget = getEffectiveAuthCoreTarget(defaultProfile);
  const candidateTarget = getEffectiveAuthCoreTarget(candidateProfile);

  if (storageTargetsEqual(defaultTarget, candidateTarget)) {
    for (const policy of listStorageSliceBoundaryPolicies()) {
      if (policy.tenantOverrideAllowed || policy.slice === AUTH_CORE_STORAGE_SLICE) {
        continue;
      }
      const candidateSliceTarget = getEffectiveStorageSliceTarget(candidateProfile, policy.slice);
      if (!candidateSliceTarget) {
        continue;
      }
      const defaultSliceTarget = getEffectiveStorageSliceTarget(defaultProfile, policy.slice);
      if (defaultSliceTarget && storageTargetsEqual(defaultSliceTarget, candidateSliceTarget)) {
        continue;
      }
      return {
        code: 'tenant_protected_storage_slice_override_not_allowed',
        message:
          `Tenant storage profile overrides cannot change protected ${policy.slice} storage from ` +
          `${defaultSliceTarget ? formatStorageTarget(defaultSliceTarget) : 'inherited'} to ` +
          `${formatStorageTarget(candidateSliceTarget)}.`,
      };
    }
    return null;
  }

  return {
    code: 'tenant_auth_core_override_not_allowed',
    message:
      `Tenant storage profile overrides may not change the auth core plane ` +
      `(${AUTH_CORE_STORAGE_SLICE}). ` +
      `Expected ${formatStorageTarget(defaultTarget)} to match environment default ` +
      `but received ${formatStorageTarget(candidateTarget)}.`,
  };
}
