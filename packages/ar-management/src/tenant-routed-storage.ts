import type { TenantMetadataContext } from '@authrim/ar-lib-core';

type LegacyTenantMetadataContext = Partial<TenantMetadataContext> & {
  storageProfileId?: string;
};

/**
 * Account data is routed through Lookup for both shared-pool and tenant-exclusive D1 storage.
 * The storageProfileId branch keeps compatibility with metadata emitted before allocationScope.
 */
export function usesRoutedAccountStorage(
  metadata: LegacyTenantMetadataContext | undefined
): boolean {
  const allocationScope = metadata?.route?.allocationScope;
  return (
    allocationScope === 'shared_pool' ||
    allocationScope === 'tenant_exclusive' ||
    metadata?.storageProfileId === 'builtin:storage:tenant-d1'
  );
}
