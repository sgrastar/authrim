import { describe, expect, it } from 'vitest';
import { usesRoutedAccountStorage } from '../tenant-routed-storage';

describe('usesRoutedAccountStorage', () => {
  it.each([
    ['shared pool', { route: { allocationScope: 'shared_pool' } }, true],
    ['tenant exclusive', { route: { allocationScope: 'tenant_exclusive' } }, true],
    ['legacy tenant D1', { storageProfileId: 'builtin:storage:tenant-d1' }, true],
    ['legacy standard', { storageProfileId: 'builtin:storage:standard' }, false],
    ['missing metadata', undefined, false],
  ] as const)('classifies %s storage', (_label, metadata, expected) => {
    expect(usesRoutedAccountStorage(metadata as never)).toBe(expected);
  });
});
