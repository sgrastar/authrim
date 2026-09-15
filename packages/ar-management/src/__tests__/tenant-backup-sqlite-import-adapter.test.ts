import { expect, it, vi } from 'vitest';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import {
  createTenantBackupInstalledSqliteImportAdapter,
  type TenantBackupInstalledSqliteImportPorts,
} from '../tenant-backup-sqlite-import-adapter';

const dataset = {
  id: 'core.roles',
  module: 'authorization' as const,
  kind: 'settings' as const,
  store: 'database' as const,
  schemaVersion: 1,
  disposition: 'include' as const,
};
const policy = {
  dataset,
  schema: {
    table: 'roles',
    columns: ['id', 'tenant_id'],
    primaryKey: ['id'],
    uniqueKeys: [],
    tenantColumn: 'tenant_id',
  },
  inspectRow: vi.fn(async () => []),
};

function fixture() {
  const context = {
    operation: { id: 'operation', tenant_id: 'tenant' },
  } as unknown as TenantBackupStepContext;
  const calls = {
    assertSources: vi.fn(async () => {}),
    restoreTargets: vi.fn(async () => []),
    resolveRestoreTarget: vi.fn(async () => ({})),
    loadValidatedDataset: vi.fn(async () => ({})),
    assertValidatedUnpublishedPlan: vi.fn(async () => {}),
    restoreOtherStores: vi.fn(async () => ({ cursor: null, done: true })),
    verifyOtherStores: vi.fn(async () => ({ cursor: null, done: true })),
    prepareActivation: vi.fn(async () => {}),
    activate: vi.fn(async () => {}),
    verifyActivation: vi.fn(async () => {}),
  };
  const ports = calls as unknown as TenantBackupInstalledSqliteImportPorts;
  return {
    context,
    ports,
    calls,
    adapter: createTenantBackupInstalledSqliteImportAdapter({ policies: [policy], ports }),
  };
}

it('uses only installed policies and rejects unknown bundle-selected datasets', async () => {
  const { adapter, context, calls } = fixture();
  expect(
    adapter.datasets({
      settings: true,
      users: false,
      admin: false,
      artifacts: false,
      logs: { audit: false, other: false, sensitive: false, period: 'all' },
    })
  ).toEqual([dataset]);
  const loaded = await adapter.loadPolicy(context, dataset.id);
  expect(loaded.dataset).toEqual(dataset);
  expect(loaded.schema.table).toBe('roles');
  await expect(adapter.loadPolicy(context, 'bundle.supplied')).rejects.toThrow(
    'backup_sqlite_import_adapter_dataset'
  );
  expect(calls.assertSources).toHaveBeenCalledTimes(2);
});

it('forwards operation context to target, source, plan, and activation ports', async () => {
  const { adapter, context, calls } = fixture();
  await adapter.restoreTargets(context);
  await adapter.resolveRestoreTarget(context, 'resource', 'provisioning');
  await adapter.loadValidatedDataset(context, { datasetId: dataset.id } as never);
  await adapter.assertValidatedUnpublishedPlan(context, 'ab'.repeat(32));
  await adapter.restoreOtherStores(context, 'ab'.repeat(32), '{"page":1}');
  await adapter.verifyOtherStores(context, 'ab'.repeat(32), '{"page":1}');
  await adapter.prepareActivation(context, 'ab'.repeat(32));
  await adapter.activate(context, 'ab'.repeat(32));
  await adapter.verifyActivation(context, 'ab'.repeat(32));

  expect(calls.restoreTargets).toHaveBeenCalledWith(context);
  expect(calls.resolveRestoreTarget).toHaveBeenCalledWith(context, 'resource', 'provisioning');
  expect(calls.loadValidatedDataset).toHaveBeenCalledWith(context, { datasetId: dataset.id });
  expect(calls.assertValidatedUnpublishedPlan).toHaveBeenCalledWith(context, 'ab'.repeat(32));
  expect(calls.restoreOtherStores).toHaveBeenCalledWith(context, 'ab'.repeat(32), '{"page":1}');
  expect(calls.verifyOtherStores).toHaveBeenCalledWith(context, 'ab'.repeat(32), '{"page":1}');
  expect(calls.verifyActivation).toHaveBeenCalledWith(context, 'ab'.repeat(32));
});

it('rejects duplicate SQL datasets, duplicate tables, and environment policies at construction', () => {
  const ports = fixture().ports;
  expect(() =>
    createTenantBackupInstalledSqliteImportAdapter({ policies: [policy, policy], ports })
  ).toThrow('backup_sqlite_import_adapter_invalid');
  expect(() =>
    createTenantBackupInstalledSqliteImportAdapter({
      policies: [policy, { ...policy, dataset: { ...dataset, id: 'core.other' } }],
      ports,
    })
  ).toThrow('backup_sqlite_import_adapter_invalid');
  expect(() =>
    createTenantBackupInstalledSqliteImportAdapter({
      policies: [{ ...policy, dataset: { ...dataset, store: 'environment' as const } }],
      ports,
    })
  ).toThrow('backup_sqlite_import_adapter_invalid');
});
