export interface TenantSystemTenant {
  id: string;
  tenant_code: string;
  name: string;
  is_active: 0 | 1;
  primary?: boolean;
}

export const tenantSystemTenants: Record<'first' | 'second' | 'inactive', TenantSystemTenant> = {
  first: {
    id: 'first',
    tenant_code: 'first',
    name: 'First Tenant',
    is_active: 1,
    primary: true,
  },
  second: {
    id: 'second',
    tenant_code: 'second-code',
    name: 'Second Tenant',
    is_active: 1,
  },
  inactive: {
    id: 'inactive',
    tenant_code: 'inactive-code',
    name: 'Inactive Tenant',
    is_active: 0,
  },
};

export const tenantSystemExactEmailUsers = [
  { id: 'user-first', email: 'first.user@example.test', tenant_id: 'first', is_active: 1 },
  { id: 'user-shared-first', email: 'shared.user@example.test', tenant_id: 'first', is_active: 1 },
  {
    id: 'user-shared-second',
    email: 'shared.user@example.test',
    tenant_id: 'second',
    is_active: 1,
  },
] as const;

export const tenantSystemDomainMappings = [
  { domain: 'first.example.test', tenant_id: 'first', verified: true, tenant_active: true },
  { domain: 'shared.example.test', tenant_id: 'first', verified: true, tenant_active: true },
  { domain: 'shared.example.test', tenant_id: 'second', verified: true, tenant_active: true },
  { domain: 'inactive.example.test', tenant_id: 'inactive', verified: false, tenant_active: false },
] as const;

export const tenantSystemVanityDomains = [
  {
    id: 'vanity-first-primary',
    tenant_id: 'first',
    hostname: 'login.first.example.test',
    is_active: 1,
    is_primary: 1,
    status: 'active',
  },
  {
    id: 'vanity-second-pending',
    tenant_id: 'second',
    hostname: 'login.second.example.test',
    is_active: 1,
    is_primary: 1,
    status: 'pending',
  },
  {
    id: 'vanity-inactive',
    tenant_id: 'first',
    hostname: 'old.first.example.test',
    is_active: 0,
    is_primary: 0,
    status: 'active',
  },
] as const;

export const tenantSystemOidcClients = {
  first: {
    client_id: 'client_first',
    tenant_id: 'first',
    redirect_uris: ['https://app-first.example.test/callback'],
  },
  second: {
    client_id: 'client_second',
    tenant_id: 'second',
    redirect_uris: ['https://app-second.example.test/callback'],
  },
  unknown: {
    client_id: 'client_unknown',
  },
} as const;
