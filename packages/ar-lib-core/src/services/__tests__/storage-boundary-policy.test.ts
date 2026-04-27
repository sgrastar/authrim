import { describe, expect, it } from 'vitest';
import type { StorageProfile } from '../../types/runtime-profile';
import {
  getStorageSliceBoundaryPolicy,
  listStorageSliceBoundaryPolicies,
  validateTenantStorageProfileOverride,
} from '../storage-boundary-policy';

function createStorageProfile(
  id: string,
  slices: StorageProfile['slices']
): StorageProfile {
  return {
    id,
    kind: 'storage',
    label: id,
    slices,
  };
}

describe('storage-boundary-policy', () => {
  it('treats users_core as auth-core shorthand instead of tenant-overridable user data', () => {
    expect(getStorageSliceBoundaryPolicy('users_core')).toEqual({
      slice: 'users_core',
      boundaryClass: 'auth_core',
      tenantOverrideAllowed: false,
      d1Default: true,
      nonD1OptionRequired: false,
      compatibilityShorthand: true,
    });
  });

  it('lists the current machine-readable boundary policy for every storage slice', () => {
    expect(listStorageSliceBoundaryPolicies()).toEqual([
      {
        slice: 'users_core',
        boundaryClass: 'auth_core',
        tenantOverrideAllowed: false,
        d1Default: true,
        nonD1OptionRequired: false,
        compatibilityShorthand: true,
      },
      {
        slice: 'users_pii',
        boundaryClass: 'pii',
        tenantOverrideAllowed: true,
        d1Default: true,
        nonD1OptionRequired: true,
      },
      {
        slice: 'custom_claims',
        boundaryClass: 'custom_extension',
        tenantOverrideAllowed: true,
        d1Default: true,
        nonD1OptionRequired: true,
      },
      {
        slice: 'registration_fields',
        boundaryClass: 'custom_extension',
        tenantOverrideAllowed: true,
        d1Default: true,
        nonD1OptionRequired: true,
      },
      {
        slice: 'custom_pii',
        boundaryClass: 'custom_extension',
        tenantOverrideAllowed: true,
        d1Default: true,
        nonD1OptionRequired: true,
      },
    ]);
  });

  it('allows tenant overrides that only move PII or custom slices', () => {
    const defaultProfile = createStorageProfile('default', {
      users_core: {
        driver: 'd1',
        bindingRef: 'DB',
        role: 'core',
      },
    });
    const candidateProfile = createStorageProfile('tenant-custom', {
      custom_claims: {
        driver: 'postgres',
        connectionRef: 'tenant-custom',
        role: 'core',
      },
      users_pii: {
        driver: 'postgres',
        connectionRef: 'tenant-pii',
        role: 'pii',
      },
    });

    expect(validateTenantStorageProfileOverride(defaultProfile, candidateProfile)).toBeNull();
  });

  it('rejects tenant overrides that change the auth core slice target', () => {
    const defaultProfile = createStorageProfile('default', {
      users_core: {
        driver: 'd1',
        bindingRef: 'DB',
        role: 'core',
      },
    });
    const candidateProfile = createStorageProfile('tenant-auth-core', {
      users_core: {
        driver: 'postgres',
        connectionRef: 'tenant-core',
        role: 'core',
      },
    });

    expect(validateTenantStorageProfileOverride(defaultProfile, candidateProfile)).toEqual(
      expect.objectContaining({
        code: 'tenant_auth_core_override_not_allowed',
      })
    );
  });

  it('treats omitted users_core as an implicit D1 target when comparing against external defaults', () => {
    const defaultProfile = createStorageProfile('default-external', {
      users_core: {
        driver: 'postgres',
        connectionRef: 'core-primary',
        role: 'core',
      },
    });
    const candidateProfile = createStorageProfile('tenant-custom', {
      custom_claims: {
        driver: 'postgres',
        connectionRef: 'tenant-custom',
        role: 'core',
      },
    });

    expect(validateTenantStorageProfileOverride(defaultProfile, candidateProfile)).toEqual(
      expect.objectContaining({
        code: 'tenant_auth_core_override_not_allowed',
      })
    );
  });
});
