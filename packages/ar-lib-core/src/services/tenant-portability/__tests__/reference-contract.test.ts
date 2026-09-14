import { describe, expect, it } from 'vitest';
import {
  validateTenantPortableReferences,
  type TenantPortableReferenceInventory,
} from '../reference-contract';

const source = { tenantId: 'tenant-a', issuer: 'https://issuer.example', productVersion: '0.4.2' };
const modules = new Set(['authorization', 'users', 'admin']);
const role = {
  tenantId: source.tenantId,
  module: 'authorization',
  collection: 'roles',
  id: 'role-a',
};
const user = { tenantId: source.tenantId, module: 'users', collection: 'users', id: 'user-a' };

function fixtures(): TenantPortableReferenceInventory[] {
  return [
    { bundleId: 'monthly-settings', source: { ...source }, records: [role], references: [] },
    {
      bundleId: 'daily-users',
      source: { ...source },
      records: [user],
      references: [{ from: user, to: { ...role, meaning: 'resource', requirement: 'required' } }],
    },
  ];
}

describe('tenant portability reference contract', () => {
  it('resolves independently acquired settings and users in one input set', () => {
    expect(validateTenantPortableReferences(fixtures(), source, modules)).toEqual({
      issues: [],
      unresolvedProvenance: [],
    });
  });

  it('blocks a daily user reference absent from the older settings bundle', () => {
    const inputs = fixtures();
    inputs[1].references = [
      {
        from: user,
        to: { ...role, id: 'new-role', meaning: 'resource', requirement: 'required' },
      },
    ];
    expect(validateTenantPortableReferences(inputs, source, modules).issues).toEqual([
      expect.objectContaining({ code: 'missing_required_reference' }),
    ]);
  });

  it.each([
    { tenantId: 'tenant-b' },
    { issuer: 'https://issuer.example/' },
    { productVersion: '0.4.3' },
  ])('rejects different source identity %j', (change) => {
    const inputs = fixtures();
    inputs[1].source = { ...source, ...change };
    expect(validateTenantPortableReferences(inputs, source, modules).issues).toContainEqual({
      code: 'source_mismatch',
      bundleId: 'daily-users',
    });
  });

  it('does not silently merge duplicate records or duplicate bundle inputs', () => {
    const [settings] = fixtures();
    const result = validateTenantPortableReferences([settings, settings], source, modules);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      'duplicate_bundle',
      'duplicate_record',
    ]);
  });

  it('retains historical actors without turning them into live principals', () => {
    const inputs = fixtures();
    const actor = {
      tenantId: source.tenantId,
      module: 'admin',
      collection: 'admins',
      id: 'old-admin',
      meaning: 'admin_actor' as const,
      requirement: 'provenance' as const,
    };
    inputs[0].references = [{ from: role, to: actor }];
    const historical = validateTenantPortableReferences(inputs, source, modules);
    expect(historical.issues).toEqual([]);
    expect(historical.unresolvedProvenance).toEqual(inputs[0].references);
    inputs[0].references = [{ from: role, to: { ...actor, meaning: 'admin_principal' } }];
    const executable = validateTenantPortableReferences(inputs, source, modules);
    expect(executable.unresolvedProvenance).toEqual([]);
    expect(executable.issues[0].code).toBe('missing_required_reference');
  });

  it('rejects cross-tenant references even if matching foreign records are supplied', () => {
    const inputs = fixtures();
    const foreign = { ...role, tenantId: 'tenant-b' };
    inputs[0].records = [foreign];
    inputs[1].references = [
      { from: user, to: { ...foreign, meaning: 'resource', requirement: 'required' } },
    ];
    expect(
      validateTenantPortableReferences(inputs, source, modules).issues.map((issue) => issue.code)
    ).toEqual(['cross_tenant_identity', 'cross_tenant_identity']);
  });

  it('rejects unknown modules and dependencies whose owner is not in their bundle', () => {
    const inputs = fixtures();
    inputs[0].references = [
      {
        from: user,
        to: { ...role, module: 'unknown', meaning: 'resource', requirement: 'required' },
      },
    ];
    expect(
      validateTenantPortableReferences(inputs, source, modules).issues.map((issue) => issue.code)
    ).toEqual(['missing_reference_owner', 'unknown_module']);
  });

  it('requires an input and does not confuse composite identity delimiters', () => {
    expect(validateTenantPortableReferences([], source, modules).issues).toEqual([
      { code: 'empty_input' },
    ]);
    const inputs = fixtures();
    inputs[0].records = [
      { ...role, collection: 'roles:a', id: 'b' },
      { ...role, collection: 'roles', id: 'a:b' },
    ];
    inputs[1].references = [];
    expect(validateTenantPortableReferences(inputs, source, modules).issues).toEqual([]);
  });
});
