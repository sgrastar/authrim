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

  return {
    name: multiTenantEnabled ? tenant?.name || 'default' : 'default',
    displayName: tenant?.displayName || 'Default Tenant',
    multiTenant: multiTenantEnabled,
    baseDomain: multiTenantEnabled ? baseDomain : undefined,
    userIdFormat: tenant?.userIdFormat || 'nanoid',
    primaryTenant: multiTenantEnabled ? tenant?.primaryTenant : undefined,
    nakedDomain: multiTenantEnabled ? (tenant?.nakedDomain ?? false) : false,
  };
}
