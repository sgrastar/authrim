import { describe, expect, it } from 'vitest';
import { resolveInitialTenantPlacement } from '../cli/commands/init.js';

describe('initial tenant placement option', () => {
  it('preserves tenant_exclusive as the default', () => {
    expect(resolveInitialTenantPlacement(undefined)).toBe('tenant_exclusive');
    expect(resolveInitialTenantPlacement('tenant_exclusive')).toBe('tenant_exclusive');
  });

  it('allows an explicit shared_pool environment and rejects unknown values', () => {
    expect(resolveInitialTenantPlacement('shared_pool')).toBe('shared_pool');
    expect(() => resolveInitialTenantPlacement('shared' as 'shared_pool')).toThrow(
      'invalid_initial_tenant_placement'
    );
  });
});
