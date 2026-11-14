import { describe, expect, it, vi } from 'vitest';
import { resolveTenantRuntimePlacementSnapshot } from '../tenant-runtime-placement';

function envWithPolicy(policy: Record<string, unknown> | null) {
  return { CONTROL: { getTenantPlacementPolicy: vi.fn(async () => policy) } } as never;
}

const base = {
  tenantId: 'tenant-a',
  isolationPolicy: 'tenant_exclusive',
  policyGeneration: 3,
};

describe('resolveTenantRuntimePlacementSnapshot', () => {
  it.each(['provisioning', 'active', 'migrating'])('accepts a %s policy', async (state) => {
    await expect(
      resolveTenantRuntimePlacementSnapshot(envWithPolicy({ ...base, state }), 'tenant-a')
    ).resolves.toEqual({ isolationPolicy: 'tenant_exclusive', policyGeneration: 3 });
  });

  it('refuses a retired policy by default (active routes need a usable policy)', async () => {
    await expect(
      resolveTenantRuntimePlacementSnapshot(
        envWithPolicy({ ...base, state: 'retired' }),
        'tenant-a'
      )
    ).rejects.toThrow('tenant_runtime_registry_placement_invalid');
    await expect(
      resolveTenantRuntimePlacementSnapshot(
        envWithPolicy({ ...base, state: 'retired' }),
        'tenant-a',
        { allowRetired: false }
      )
    ).rejects.toThrow('tenant_runtime_registry_placement_invalid');
  });

  it('accepts a retired policy only when explicitly allowed', async () => {
    await expect(
      resolveTenantRuntimePlacementSnapshot(
        envWithPolicy({ ...base, state: 'retired' }),
        'tenant-a',
        { allowRetired: true }
      )
    ).resolves.toEqual({ isolationPolicy: 'tenant_exclusive', policyGeneration: 3 });
  });

  it('still refuses a missing, foreign or malformed policy when retired is allowed', async () => {
    const options = { allowRetired: true };
    await expect(
      resolveTenantRuntimePlacementSnapshot(envWithPolicy(null), 'tenant-a', options)
    ).rejects.toThrow('tenant_runtime_registry_placement_invalid');
    await expect(
      resolveTenantRuntimePlacementSnapshot(
        envWithPolicy({ ...base, tenantId: 'other', state: 'retired' }),
        'tenant-a',
        options
      )
    ).rejects.toThrow('tenant_runtime_registry_placement_invalid');
    await expect(
      resolveTenantRuntimePlacementSnapshot(
        envWithPolicy({ ...base, policyGeneration: 0, state: 'retired' }),
        'tenant-a',
        options
      )
    ).rejects.toThrow('tenant_runtime_registry_placement_invalid');
  });
});
