import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_DURABLE_STORAGE_PROFILE_ID,
  SHARED_D1_STORAGE_PROFILE_ID,
  TENANT_D1_STORAGE_PROFILE_ID,
} from '../../types/runtime-profile';
import {
  describeStorageProfileCapabilityStatus,
  findUnsupportedStorageProfileRouteCapability,
} from '../storage-profile-capabilities';
import type { StorageProfile } from '../../types/runtime-profile';

function profile(
  id: string,
  deploymentProfile: StorageProfile['deploymentProfile']
): StorageProfile {
  return {
    id,
    kind: 'storage',
    label: id,
    deploymentProfile,
    slices: {},
  };
}

describe('storage profile capability status', () => {
  it('marks shared D1 as MVP ready', () => {
    const status = describeStorageProfileCapabilityStatus(
      profile(SHARED_D1_STORAGE_PROFILE_ID, 'shared-d1')
    );

    expect(status).toEqual(
      expect.objectContaining({
        deploymentProfile: 'shared-d1',
        mvpReady: true,
        unsupportedCount: 0,
      })
    );
  });

  it('exposes tenant-d1 partial and unsupported MVP capabilities', () => {
    const status = describeStorageProfileCapabilityStatus(
      profile(TENANT_D1_STORAGE_PROFILE_ID, 'tenant-d1')
    );

    expect(status.mvpReady).toBe(false);
    expect(status.unsupportedCount).toBeGreaterThan(0);
    expect(status.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'user_core_pii_resolution', state: 'supported' }),
        expect.objectContaining({ id: 'session_clients', state: 'supported' }),
        expect.objectContaining({ id: 'device_ciba_cold_persistence', state: 'unsupported' }),
      ])
    );
  });

  it('identifies tenant-d1 routes that should fail closed until routed', () => {
    const tenantD1 = profile(TENANT_D1_STORAGE_PROFILE_ID, 'tenant-d1');
    const sharedD1 = profile(SHARED_D1_STORAGE_PROFILE_ID, 'shared-d1');

    expect(findUnsupportedStorageProfileRouteCapability(tenantD1, '/device_authorization')).toEqual(
      expect.objectContaining({
        id: 'device_ciba_cold_persistence',
        state: 'unsupported',
      })
    );
    expect(findUnsupportedStorageProfileRouteCapability(tenantD1, '/api/ciba/approve')).toEqual(
      expect.objectContaining({
        id: 'device_ciba_cold_persistence',
        state: 'unsupported',
      })
    );
    expect(
      findUnsupportedStorageProfileRouteCapability(tenantD1, '/api/admin/jobs/users/bulk-update')
    ).toEqual(
      expect.objectContaining({
        id: 'admin_user_bulk_jobs',
        state: 'unsupported',
        criticality: 'admin_critical',
      })
    );
    expect(
      findUnsupportedStorageProfileRouteCapability(sharedD1, '/device_authorization')
    ).toBeNull();
  });

  it('marks external-durable core and PII routing as partial until full production gates pass', () => {
    const status = describeStorageProfileCapabilityStatus(
      profile(EXTERNAL_DURABLE_STORAGE_PROFILE_ID, 'external-durable')
    );

    expect(status.mvpReady).toBe(false);
    expect(status.partialCount).toBeGreaterThan(0);
    expect(status.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'external_core_pii_runtime', state: 'partial' }),
        expect.objectContaining({ id: 'external_custom_claims', state: 'supported' }),
      ])
    );
  });

  it('does not leave user-critical tenant-d1 endpoints in an unsupported state', () => {
    const status = describeStorageProfileCapabilityStatus(
      profile(TENANT_D1_STORAGE_PROFILE_ID, 'tenant-d1')
    );

    expect(
      status.capabilities.filter(
        (capability) =>
          capability.criticality === 'user_critical' && capability.state === 'unsupported'
      )
    ).toEqual([]);
  });
});
