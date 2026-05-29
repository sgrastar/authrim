import { describe, expect, it } from 'vitest';
import type { StorageProfile } from '../../types/runtime-profile';
import {
  getStorageSliceBoundaryPolicy,
  listStorageSliceBoundaryPolicies,
  validateTenantStorageProfileOverride,
} from '../storage-boundary-policy';

function createStorageProfile(id: string, slices: StorageProfile['slices']): StorageProfile {
  return {
    id,
    kind: 'storage',
    label: id,
    slices,
  };
}

describe('storage-boundary-policy', () => {
  it('treats identity_core as the protected auth-core identity plane', () => {
    expect(getStorageSliceBoundaryPolicy('identity_core')).toEqual({
      slice: 'identity_core',
      boundaryClass: 'auth_core',
      tenantOverrideAllowed: false,
      d1Default: true,
      nonD1OptionRequired: false,
    });
  });

  it('lists the current machine-readable boundary policy for every storage slice', () => {
    expect(listStorageSliceBoundaryPolicies()).toEqual([
      {
        slice: 'identity_core',
        boundaryClass: 'auth_core',
        tenantOverrideAllowed: false,
        d1Default: true,
        nonD1OptionRequired: false,
      },
      {
        slice: 'identity_pii',
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
      {
        slice: 'passkeys',
        boundaryClass: 'auth_core',
        tenantOverrideAllowed: false,
        d1Default: true,
        nonD1OptionRequired: false,
      },
      {
        slice: 'linked_identities',
        boundaryClass: 'pii',
        tenantOverrideAllowed: true,
        d1Default: true,
        nonD1OptionRequired: true,
      },
      {
        slice: 'consent',
        boundaryClass: 'auth_core',
        tenantOverrideAllowed: false,
        d1Default: true,
        nonD1OptionRequired: false,
      },
      {
        slice: 'authorization',
        boundaryClass: 'authorization',
        tenantOverrideAllowed: false,
        d1Default: true,
        nonD1OptionRequired: false,
      },
    ]);
  });

  it('allows tenant overrides that only move PII or custom slices', () => {
    const defaultProfile = createStorageProfile('default', {
      identity_core: {
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
      identity_pii: {
        driver: 'postgres',
        connectionRef: 'tenant-pii',
        role: 'pii',
      },
    });

    expect(validateTenantStorageProfileOverride(defaultProfile, candidateProfile)).toBeNull();
  });

  it('rejects tenant overrides that move protected passkey or authorization slices', () => {
    const defaultProfile = createStorageProfile('default', {
      identity_core: {
        driver: 'd1',
        bindingRef: 'DB',
        role: 'core',
      },
      passkeys: {
        driver: 'd1',
        bindingRef: 'DB',
        role: 'core',
      },
    });
    const candidateProfile = createStorageProfile('tenant-custom', {
      passkeys: {
        driver: 'postgres',
        connectionRef: 'tenant-passkeys',
        role: 'core',
      },
    });

    expect(validateTenantStorageProfileOverride(defaultProfile, candidateProfile)).toEqual({
      code: 'tenant_protected_storage_slice_override_not_allowed',
      message: expect.stringContaining('protected passkeys storage'),
    });
  });

  it('rejects tenant overrides that change the auth core slice target', () => {
    const defaultProfile = createStorageProfile('default', {
      identity_core: {
        driver: 'd1',
        bindingRef: 'DB',
        role: 'core',
      },
    });
    const candidateProfile = createStorageProfile('tenant-auth-core', {
      identity_core: {
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

  it('treats omitted identity_core as an implicit D1 target when comparing against external defaults', () => {
    const defaultProfile = createStorageProfile('default-external', {
      identity_core: {
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
