import { expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { PHASE3_SQLITE_DATASET_REGISTRATIONS } from '@authrim/ar-lib-core/services/tenant-portability/phase3-sqlite-modules';
import type { PlannedInstalledSqliteDataset } from '@authrim/ar-lib-core/services/tenant-portability/installed-sqlite-datasets';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import { createPhase3TenantBackupInstalledAdapter } from '../tenant-backup-phase3-adapter';

function database() {
  return {
    query: vi.fn(async () => []),
    queryOne: vi.fn(async () => null),
    execute: vi.fn(async () => ({ rowsAffected: 0 })),
    transaction: vi.fn(async (callback: (value: unknown) => unknown) => callback({})),
    batch: vi.fn(async () => []),
    isHealthy: vi.fn(async () => true),
    getType: vi.fn(() => 'd1'),
    close: vi.fn(async () => {}),
  };
}

function planned(): PlannedInstalledSqliteDataset[] {
  return PHASE3_SQLITE_DATASET_REGISTRATIONS.map((registration, ordinal) => ({
    ordinal,
    firstOrdinal: registration.family === 'core' ? 0 : 1,
    resourceId: registration.family === 'core' ? 'core-db' : 'admin-db',
    family: registration.family,
    table: registration.table,
    capture: {
      table: registration.table,
      tenantColumn: 'tenant_id',
      columns: ['id', 'tenant_id'],
      primaryKey: ['id'],
      uniqueKeys: [],
      ...(registration.partitions
        ? { rowPartition: { column: 'permission_type', values: registration.partitions } }
        : {}),
    },
    dataset: registration.dataset,
    ...(registration.partitions ? { partitions: registration.partitions } : {}),
  }));
}

function fixture() {
  const logicalReferenceDatabase = {
    query: vi.fn(async () => []),
  };
  const resolveAdminRestoreDatabase = vi.fn(async () => logicalReferenceDatabase as never);
  const prepareActivation = vi.fn(async () => {});
  const env = { DB_ADMIN: database(), RP_TOKEN_ENCRYPTION_KEY: '11'.repeat(32) } as unknown as Env;
  const adapter = createPhase3TenantBackupInstalledAdapter({
    env,
    planned: planned(),
    ports: {
      export: {
        prepareSources: vi.fn(async () => ({ cursor: null, done: true })),
        assertSources: vi.fn(async () => {}),
        assertBoundaryReady: vi.fn(async () => {}),
      },
      import: {
        assertSources: vi.fn(async () => {}),
        restoreTargets: vi.fn(async () => []),
        resolveRestoreTarget: vi.fn(async () => ({})) as never,
        loadValidatedDataset: vi.fn(async () => ({}) as never),
        assertValidatedUnpublishedPlan: vi.fn(async () => {}),
        prepareActivation,
        activate: vi.fn(async () => {}),
        verifyActivation: vi.fn(async () => {}),
      },
      otherStores: {
        load: vi.fn(async () => ({}) as never),
      },
      cleanup: {
        resolveSnapshotSource: vi.fn(async () => ({}) as never),
        cleanupRestoreTarget: vi.fn(async () => {}),
        cleanupAdditionalPage: vi.fn(async () => ({ done: true })),
        assertClean: vi.fn(async () => {}),
      },
      resolveAdminRestoreDatabase,
    },
  });
  return { adapter, resolveAdminRestoreDatabase, logicalReferenceDatabase, prepareActivation };
}

const selection = {
  settings: true,
  users: false,
  admin: false,
  artifacts: false,
  logs: { audit: false, other: false, sensitive: false, period: 'all' as const },
};

it('installs the complete Phase 3 SQL registry and required physical databases', () => {
  const { adapter } = fixture();
  expect(adapter.export.requiredDatabases).toEqual({
    roles: ['tenant_core'],
    fixed: ['DB_ADMIN'],
  });
  expect(adapter.export.datasets(selection)).toHaveLength(
    PHASE3_SQLITE_DATASET_REGISTRATIONS.length
  );
  expect(adapter.import.datasets(selection)).toHaveLength(
    PHASE3_SQLITE_DATASET_REGISTRATIONS.length
  );
});

it('checks logical references before persisting activation intent', async () => {
  const { adapter, resolveAdminRestoreDatabase, logicalReferenceDatabase, prepareActivation } =
    fixture();
  const context = {
    operation: { tenant_id: 'tenant-a' },
    lease: { tenantId: 'tenant-a' },
  } as unknown as TenantBackupStepContext;
  await adapter.import.prepareActivation(context, 'ab'.repeat(32));
  expect(resolveAdminRestoreDatabase).toHaveBeenCalledWith(context, 'ab'.repeat(32));
  expect(logicalReferenceDatabase.query).toHaveBeenCalledTimes(2);
  expect(prepareActivation).toHaveBeenCalledWith(context, 'ab'.repeat(32));
  expect(logicalReferenceDatabase.query.mock.invocationCallOrder[0]).toBeLessThan(
    prepareActivation.mock.invocationCallOrder[0]!
  );
});

it('refuses an incomplete installed SQL plan', () => {
  const full = planned();
  expect(() =>
    createPhase3TenantBackupInstalledAdapter({
      env: { DB_ADMIN: database() } as unknown as Env,
      planned: full.slice(1),
      ports: fixturePorts(),
    })
  ).toThrow('backup_phase3_plan_incomplete');
});

function fixturePorts() {
  return {
    export: {
      prepareSources: vi.fn(async () => ({ cursor: null, done: true })),
      assertSources: vi.fn(async () => {}),
      assertBoundaryReady: vi.fn(async () => {}),
    },
    import: {
      assertSources: vi.fn(async () => {}),
      restoreTargets: vi.fn(async () => []),
      resolveRestoreTarget: vi.fn(async () => ({}) as never),
      loadValidatedDataset: vi.fn(async () => ({}) as never),
      assertValidatedUnpublishedPlan: vi.fn(async () => {}),
      prepareActivation: vi.fn(async () => {}),
      activate: vi.fn(async () => {}),
      verifyActivation: vi.fn(async () => {}),
    },
    otherStores: { load: vi.fn(async () => ({}) as never) },
    cleanup: {
      resolveSnapshotSource: vi.fn(async () => ({}) as never),
      cleanupRestoreTarget: vi.fn(async () => {}),
      cleanupAdditionalPage: vi.fn(async () => ({ done: true })),
      assertClean: vi.fn(async () => {}),
    },
    resolveAdminRestoreDatabase: vi.fn(async () => ({ query: vi.fn(async () => []) }) as never),
  };
}
