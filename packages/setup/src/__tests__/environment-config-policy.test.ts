import { describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../core/config.js';
import { hasDatabaseTopologyChange } from '../core/environment-config-policy.js';

describe('environment config policy', () => {
  it('allows non-topology changes', () => {
    const current = createDefaultConfig('test');
    const next = structuredClone(current);
    next.components.adminUi = false;
    expect(hasDatabaseTopologyChange(current, next)).toBe(false);
  });

  it('detects Control Plane, placement, audit reference, and database changes', () => {
    const current = createDefaultConfig('test');
    for (const mutate of [
      (next: typeof current) => {
        next.controlPlane.automaticProvisioning = false;
      },
      (next: typeof current) => {
        next.tenant.placementPolicy = 'shared_pool';
      },
      (next: typeof current) => {
        next.profiles.references.hyperdrive.primary = {
          binding: 'HD_PRIMARY',
          id: 'hd-primary',
          driver: 'postgres',
        };
      },
      (next: typeof current) => {
        next.database.core.location = 'weur';
      },
    ]) {
      const next = structuredClone(current);
      mutate(next);
      expect(hasDatabaseTopologyChange(current, next)).toBe(true);
    }
  });
});
