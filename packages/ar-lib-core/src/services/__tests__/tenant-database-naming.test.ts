import { describe, expect, it } from 'vitest';
import {
  buildTenantDatabaseBindingPlan,
  evaluateTenantDatabaseBindingCapacity,
  normalizeTenantBindingNamePart,
  normalizeTenantDatabaseNamePart,
} from '../tenant-database-naming';

describe('tenant-database-naming', () => {
  it('builds deterministic D1 database names and binding refs', () => {
    const plan = buildTenantDatabaseBindingPlan({
      environment: 'prod-us',
      tenantId: 'tenant_123',
      tenantSlug: 'Example University',
      role: 'tenant_core',
    });

    expect(plan.databaseName).toMatch(
      /^prod-us-authrim-tenant-example-university-core-db-[a-f0-9]{8}$/u
    );
    expect(plan.bindingRef).toMatch(/^PROD_US_TDB_EXAMPLE_UNIVERSITY_[A-F0-9]{8}_CORE$/u);
    expect(plan.workerShard).toBe('primary');
    expect(
      buildTenantDatabaseBindingPlan({
        environment: 'prod-us',
        tenantId: 'tenant_123',
        tenantSlug: 'Example University',
        role: 'tenant_core',
      })
    ).toEqual(plan);
  });

  it('normalizes unsafe name and binding parts', () => {
    expect(normalizeTenantDatabaseNamePart(' Tenant:_A!! ', 'tenant')).toBe('tenant-a');
    expect(normalizeTenantBindingNamePart(' Tenant:_A!! ', 'TENANT')).toBe('TENANT_A');
    expect(normalizeTenantDatabaseNamePart('!!!', 'tenant')).toBe('tenant');
    expect(normalizeTenantBindingNamePart('!!!', 'TENANT')).toBe('TENANT');
  });

  it('flags binding capacity warnings before the hard limit', () => {
    expect(
      evaluateTenantDatabaseBindingCapacity({
        currentBindings: 2990,
        tenantsToAdd: 5,
        rolesPerTenant: 2,
      }).state
    ).toBe('warning');

    expect(
      evaluateTenantDatabaseBindingCapacity({
        currentBindings: 4998,
        tenantsToAdd: 2,
        rolesPerTenant: 2,
      }).state
    ).toBe('exceeds_limit');
  });
});
