import type { TenantConfig } from './config.js';

export function hasApiCustomDomain(baseDomain?: string | null): boolean {
  return !!baseDomain?.trim();
}

export function normalizeTenantConfigForApiDomain(
  tenant?: Partial<TenantConfig> | null
): TenantConfig {
  const baseDomain = tenant?.baseDomain?.trim() || undefined;
  const customDomainEnabled = hasApiCustomDomain(baseDomain);
  const multiTenantEnabled = customDomainEnabled && tenant?.multiTenant === true;
  const initialTenantName = tenant?.name?.trim() || 'default';
  const primaryTenant = tenant?.primaryTenant?.trim() || initialTenantName;

  return {
    name: initialTenantName,
    displayName: tenant?.displayName || 'Initial Tenant',
    placementPolicy: tenant?.placementPolicy ?? 'tenant_exclusive',
    multiTenant: multiTenantEnabled,
    baseDomain: multiTenantEnabled ? baseDomain : undefined,
    userIdFormat: tenant?.userIdFormat || 'nanoid',
    primaryTenant: multiTenantEnabled ? primaryTenant : undefined,
    nakedDomain: multiTenantEnabled ? (tenant?.nakedDomain ?? false) : false,
  };
}
