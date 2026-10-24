import { describe, expect, it } from 'vitest';
import { usesRoutedAccountStorage as coreDefinition } from '@authrim/ar-lib-core';
import { usesRoutedAccountStorage } from '../tenant-routed-storage';

describe('usesRoutedAccountStorage', () => {
  it('is the one definition in ar-lib-core, the same ar-auth decides with', () => {
    expect(usesRoutedAccountStorage).toBe(coreDefinition);
  });

  it.each([
    ['shared pool', { route: { allocationScope: 'shared_pool' } }, true],
    ['tenant exclusive', { route: { allocationScope: 'tenant_exclusive' } }, true],
    ['missing metadata', undefined, false],
    // Only a single-database setup builds a context without a scope; its accounts stay there.
    ['a route without an allocation scope', { route: {} }, false],
    ['metadata without a route', { tenantId: 'tenant-1' }, false],
    // The pre-allocationScope profile id is not produced by any resolver any more.
    [
      'the legacy tenant D1 profile alone',
      { storageProfileId: 'builtin:storage:tenant-d1' },
      false,
    ],
  ] as const)('classifies %s storage', (_label, metadata, expected) => {
    expect(usesRoutedAccountStorage(metadata as never)).toBe(expected);
  });

  it('refuses an allocation scope it does not know instead of reading it as unrouted', () => {
    expect(() =>
      usesRoutedAccountStorage({ route: { allocationScope: 'global' } } as never)
    ).toThrow('tenant_metadata_allocation_scope_invalid');
  });
});
