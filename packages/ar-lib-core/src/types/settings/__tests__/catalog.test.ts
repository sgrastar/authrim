import { describe, it, expect } from 'vitest';
import { CATEGORY_SCOPE_CONFIG, settingsParentScopes, type CategoryName } from '../catalog';

function categoryAllowing(scopes: string[]): CategoryName {
  const found = (Object.keys(CATEGORY_SCOPE_CONFIG) as CategoryName[]).find((category) => {
    const allowed = CATEGORY_SCOPE_CONFIG[category].allowedScopes;
    return (
      allowed.length === scopes.length && scopes.every((scope) => allowed.includes(scope as never))
    );
  });
  if (!found) throw new Error(`No category allows exactly ${scopes.join(', ')}`);
  return found;
}

describe('settingsParentScopes', () => {
  const client = { type: 'client' as const, id: 'client_1', tenantId: 'tenant_1' };
  const tenant = { type: 'tenant' as const, id: 'tenant_1' };

  it('lets a client inherit from its tenant when the category allows the tenant scope', () => {
    const category = categoryAllowing(['tenant', 'client']);
    expect(settingsParentScopes(category, client)).toEqual([{ type: 'tenant', id: 'tenant_1' }]);
  });

  it('lets a tenant inherit from the platform when the category allows the platform scope', () => {
    const category = categoryAllowing(['platform', 'tenant']);
    expect(settingsParentScopes(category, tenant)).toEqual([{ type: 'platform' }]);
  });

  it('skips scopes the category does not allow', () => {
    const tenantOnly = categoryAllowing(['tenant']);
    expect(settingsParentScopes(tenantOnly, tenant)).toEqual([]);
    const tenantAndClient = categoryAllowing(['tenant', 'client']);
    expect(settingsParentScopes(tenantAndClient, tenant)).toEqual([]);
  });

  it('gives the platform no parents', () => {
    const category = categoryAllowing(['platform', 'tenant']);
    expect(settingsParentScopes(category, { type: 'platform' })).toEqual([]);
  });
});
