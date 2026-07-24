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

  it('detects storage, reference, database, and tenant pool changes', () => {
    const current = createDefaultConfig('test');
    for (const mutate of [
      (next: typeof current) => {
        next.profiles.defaults.storage = 'builtin:storage:single-db';
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
      (next: typeof current) => {
        next.tenantD1 = { preallocatedSlots: 5 };
      },
    ]) {
      const next = structuredClone(current);
      mutate(next);
      expect(hasDatabaseTopologyChange(current, next)).toBe(true);
    }
  });
});
