import { describe, expect, it } from 'vitest';
import { requireSAMLTenantId, resolveSAMLTenantIdFromContext } from '../tenant';

describe('SAML tenant resolution', () => {
  it('requires a valid tenant id for tenant-owned runtime helpers', () => {
    expect(requireSAMLTenantId('tenant-a')).toBe('tenant-a');
    expect(() => requireSAMLTenantId(undefined)).toThrow('SAML tenant context is required');
    expect(() => requireSAMLTenantId('../tenant-a')).toThrow('SAML tenant context is required');
  });

  it('uses request context tenant before deployment default tenant', () => {
    const c = mockContext({
      contextTenantId: 'tenant-a',
      defaultTenantId: 'tenant-default',
    });

    expect(resolveSAMLTenantIdFromContext(c)).toBe('tenant-a');
  });

  it('allows a public X-Tenant-Id header only when it matches the resolved context tenant', () => {
    const c = mockContext({
      contextTenantId: 'tenant-a',
      headerTenantId: 'tenant-a',
      defaultTenantId: 'tenant-default',
    });

    expect(resolveSAMLTenantIdFromContext(c)).toBe('tenant-a');
  });

  it('rejects conflicting context tenant and public X-Tenant-Id header', () => {
    const c = mockContext({
      contextTenantId: 'tenant-a',
      headerTenantId: 'tenant-b',
      defaultTenantId: 'tenant-default',
    });

    expect(() => resolveSAMLTenantIdFromContext(c)).toThrow(
      'SAML tenant header conflicts with resolved tenant context'
    );
  });

  it('does not switch tenants from an arbitrary public X-Tenant-Id header', () => {
    const c = mockContext({
      headerTenantId: 'tenant-b',
      defaultTenantId: 'tenant-default',
    });

    expect(resolveSAMLTenantIdFromContext(c)).toBe('tenant-default');
  });

  it('uses explicit deployment default tenant for single-tenant deployments', () => {
    const c = mockContext({
      defaultTenantId: 'tenant-default',
    });

    expect(resolveSAMLTenantIdFromContext(c)).toBe('tenant-default');
  });

  it('fails closed when neither request context nor deployment default tenant exists', () => {
    expect(() => resolveSAMLTenantIdFromContext(mockContext({}))).toThrow(
      'SAML tenant context is missing'
    );
  });

  it('fails closed in multi-tenant runtime instead of using deployment default tenant', () => {
    const c = mockContext({
      baseDomain: 'auth.example.com',
      defaultTenantId: 'tenant-default',
    });

    expect(() => resolveSAMLTenantIdFromContext(c)).toThrow(
      'multi-tenant runtime requires request context resolution'
    );
  });

  it('rejects a public X-Tenant-Id header when multi-tenant request context is unresolved', () => {
    const c = mockContext({
      baseDomain: 'auth.example.com',
      headerTenantId: 'tenant-b',
      defaultTenantId: 'tenant-default',
    });

    expect(() => resolveSAMLTenantIdFromContext(c)).toThrow(
      'multi-tenant runtime requires request context resolution'
    );
  });
});

function mockContext(options: {
  contextTenantId?: string;
  headerTenantId?: string;
  baseDomain?: string;
  defaultTenantId?: string;
}) {
  return {
    env: {
      BASE_DOMAIN: options.baseDomain,
      DEFAULT_TENANT_ID: options.defaultTenantId,
    },
    get(key: string) {
      return key === 'tenantId' ? options.contextTenantId : undefined;
    },
    req: {
      header(name: string) {
        return name === 'X-Tenant-Id' ? options.headerTenantId : undefined;
      },
    },
  } as never;
}
