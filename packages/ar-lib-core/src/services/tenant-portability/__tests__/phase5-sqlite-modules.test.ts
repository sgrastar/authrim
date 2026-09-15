import { describe, expect, it } from 'vitest';
import { TENANT_DATASET_POLICIES } from '../dataset-registry.js';
import { PHASE4_REBUILT_SQLITE_TABLES } from '../phase4-sqlite-modules.js';
import {
  PHASE5_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS,
  PHASE5_REBUILT_TABLES,
  PHASE5_SQLITE_DATASET_REGISTRATIONS,
} from '../phase5-sqlite-modules.js';

describe('Phase 5 SQL settings registry', () => {
  it('adds every remaining Core/Admin settings table exactly once', () => {
    const cumulative = PHASE5_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS;
    expect(PHASE5_SQLITE_DATASET_REGISTRATIONS).toHaveLength(39);
    expect(cumulative).toHaveLength(115);
    expect(new Set(cumulative.map(({ dataset }) => dataset.id)).size).toBe(cumulative.length);

    const classified = TENANT_DATASET_POLICIES.filter(
      ({ family, kind, table }) =>
        (family === 'core' || family === 'admin') &&
        kind === 'settings' &&
        ![...PHASE4_REBUILT_SQLITE_TABLES, ...PHASE5_REBUILT_TABLES].includes(table as never)
    )
      .filter(({ family, table }) => family !== 'core' || table !== 'profile_registry')
      .map(({ family, table }) =>
        table === 'resource_permissions' ? `${family}.${table}.settings` : `${family}.${table}`
      );

    expect(cumulative.map(({ dataset }) => dataset.id).sort()).toEqual(classified.sort());
    expect(cumulative.some(({ table }) => table === 'profile_registry')).toBe(false);
  });

  it('keeps every new dataset behind the existing settings selection', () => {
    for (const { dataset } of PHASE5_SQLITE_DATASET_REGISTRATIONS) {
      expect(dataset).toMatchObject({ kind: 'settings', schemaVersion: 1, disposition: 'include' });
      expect(['authorization', 'credentials', 'flows-ui', 'integrations']).toContain(
        dataset.module
      );
    }
  });
});
