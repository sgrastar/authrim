import type { TenantConfig } from './config.js';

export function hasApiCustomDomain(baseDomain?: string | null): boolean {
  return !!baseDomain?.trim();
}

export function normalizeTenantConfigForApiDomain(tenant?: Partial<TenantConfig> | null): TenantConfig {
  const baseDomain = tenant?.baseDomain?.trim() || undefined;
  const customDomainEnabled = hasApiCustomDomain(baseDomain);

  return {
    name: customDomainEnabled ? tenant?.name || 'default' : 'default',
    displayName: tenant?.displayName || 'Default Tenant',
    multiTenant: customDomainEnabled,
    baseDomain,
    userIdFormat: tenant?.userIdFormat || 'nanoid',
    primaryTenant: customDomainEnabled ? tenant?.primaryTenant : undefined,
    nakedDomain: customDomainEnabled ? tenant?.nakedDomain ?? false : false,
  };
}
