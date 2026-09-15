import { describe, expect, it } from 'vitest';
import type { TenantBundleManifest } from '../bundle-manifest';
import { PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS } from '../phase8-sqlite-modules';
import {
  groupPhase8SqliteRestoreDatasets,
  phase8SqliteRestoreTargetRole,
} from '../phase8-restore-targets';

const source = {
  tenantId: 'tenant-a',
  issuer: 'https://tenant.example.test',
  productVersion: '0.4.2',
};

function manifest(
  datasets: TenantBundleManifest['datasets'],
  bundleId = '12'.repeat(16)
): TenantBundleManifest {
  return {
    formatVersion: 1,
    bundleId,
    source,
    snapshotId: 'snapshot-a',
    boundaryUnixMs: 1,
    inventoryDigestSha256: 'ab'.repeat(32),
    selection: {
      settings: true,
      users: true,
      admin: true,
      artifacts: true,
      logs: { audit: true, other: true, sensitive: true, period: 'all' },
    },
    datasets,
  };
}

describe('Phase 8 SQL restore target placement', () => {
  it('classifies every installed SQL dataset by logical family and selection kind', () => {
    const placements = PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.map(({ dataset }) => [
      dataset.id,
      phase8SqliteRestoreTargetRole(dataset),
    ]);
    expect(placements).toHaveLength(PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.length);
    expect(Object.fromEntries(placements)).toMatchObject({
      'core.tenants': 'tenant_core/default',
      'core.users': 'tenant_core/users',
      'core.resource_permissions.users': 'tenant_core/users',
      'core.resource_permissions.settings': 'tenant_core/default',
      'pii.users_pii': 'tenant_pii',
      'admin.admin_roles': 'admin',
    });
  });

  it('groups validated manifest/policy pairs without trusting source shard identity', () => {
    const selected = [
      PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.find(
        ({ dataset }) => dataset.id === 'core.users'
      )!.dataset,
      PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.find(
        ({ dataset }) => dataset.id === 'core.tenants'
      )!.dataset,
      PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.find(
        ({ dataset }) => dataset.id === 'pii.users_pii'
      )!.dataset,
      PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.find(
        ({ dataset }) => dataset.id === 'admin.admin_roles'
      )!.dataset,
    ];
    const input = manifest(selected);
    const grouped = groupPhase8SqliteRestoreDatasets(
      selected.map((dataset) => ({
        manifest: input,
        policy: {
          dataset,
          schema: { table: dataset.id.split('.')[1]!, columns: [], primaryKey: ['id'] },
        },
      }))
    );
    expect([...grouped.keys()]).toEqual([
      'admin',
      'tenant_core/default',
      'tenant_core/users',
      'tenant_pii',
    ]);
    expect(grouped.get('tenant_core/users')?.map(({ policy }) => policy.dataset.id)).toEqual([
      'core.users',
    ]);
  });

  it('rejects unknown families, non-SQL datasets, mismatched manifests and duplicates', () => {
    const users = PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.find(
      ({ dataset }) => dataset.id === 'core.users'
    )!.dataset;
    const input = manifest([users]);
    const entry = {
      manifest: input,
      policy: { dataset: users, schema: { table: 'users', columns: [], primaryKey: ['id'] } },
    };
    expect(() => groupPhase8SqliteRestoreDatasets([entry, entry])).toThrow(
      'backup_phase8_restore_target_invalid'
    );
    expect(() =>
      groupPhase8SqliteRestoreDatasets([
        {
          ...entry,
          manifest: manifest([{ ...users, kind: 'settings' }]),
        },
      ])
    ).toThrow('backup_phase8_restore_target_invalid');
    expect(() => phase8SqliteRestoreTargetRole({ ...users, store: 'object' })).toThrow(
      'backup_phase8_restore_target_invalid'
    );
    expect(() => phase8SqliteRestoreTargetRole({ ...users, id: 'lookup.users' })).toThrow(
      'backup_phase8_restore_target_invalid'
    );
  });
});
