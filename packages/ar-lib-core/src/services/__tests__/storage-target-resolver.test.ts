import { describe, expect, it } from 'vitest';
import { getBoundStorageTargetSource } from '../storage-target-resolver';

describe('storage-target-resolver', () => {
  it('fails closed when a tenant registry target reaches the legacy binding resolver', () => {
    expect(() =>
      getBoundStorageTargetSource(
        {},
        {
          driver: 'd1',
          resolverRef: 'tenant-database-registry',
          role: 'tenant_core',
          logicalSource: 'identity_core',
        }
      )
    ).toThrow('unsupported_storage_profile_target_resolver:tenant-database-registry');
  });

  it('fails closed when a required binding is missing', () => {
    expect(() =>
      getBoundStorageTargetSource(
        {},
        {
          driver: 'd1',
          bindingRef: 'TENANT_CORE_DB',
          role: 'tenant_core',
          logicalSource: 'identity_core',
        }
      )
    ).toThrow('storage_profile_binding_not_configured:TENANT_CORE_DB');
  });
});
