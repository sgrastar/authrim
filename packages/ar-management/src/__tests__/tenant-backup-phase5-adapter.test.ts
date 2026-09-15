import { expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import {
  decodeKeyManagerTenantBackupRow,
  KEY_MANAGER_TENANT_BACKUP_DATASET,
} from '@authrim/ar-lib-core/services/tenant-portability/key-manager-dataset';
import { emptyKeyManagerTenantBackupSnapshot } from '@authrim/ar-lib-core/services/tenant-portability/key-manager-portability';
import type { PlannedInstalledSqliteDataset } from '@authrim/ar-lib-core/services/tenant-portability/installed-sqlite-datasets';
import { PHASE5_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS } from '@authrim/ar-lib-core/services/tenant-portability/phase5-sqlite-modules';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import type { AdapterContext } from '../tenant-backup-export-dispatcher';
import {
  createPhase5TenantBackupInstalledAdapter,
  type Phase5InstalledAdapterPorts,
} from '../tenant-backup-phase5-adapter';

function planned(): PlannedInstalledSqliteDataset[] {
  return PHASE5_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.map((registration, ordinal) => ({
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

function fixture() {
  const snapshot = emptyKeyManagerTenantBackupSnapshot();
  const keyManagerSnapshot = {
    assertSource: vi.fn(async () => {}),
    start: vi.fn(async (_context, _snapshotId, assertHeld) => assertHeld()),
    load: vi.fn(async () => snapshot),
    release: vi.fn(async () => {}),
    assertReleased: vi.fn(async () => {}),
  };
  const recordSnapshot = (resourceId: string) => ({
    resourceId,
    assertSource: vi.fn(async () => {}),
    start: vi.fn(async (_context, _snapshotId, assertHeld) => assertHeld()),
    readNext: vi.fn(async () => null),
    release: vi.fn(async () => {}),
    assertReleased: vi.fn(async () => {}),
  });
  const ports = {
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
      prepareActivation: vi.fn(async () => {}),
      activate: vi.fn(async () => {}),
      verifyActivation: vi.fn(async () => {}),
    },
    tenantKey: 'tenant-key-a',
    rowTransform: { transformAdminEnvelope: vi.fn(async (_datasetId, rowJson) => rowJson) },
    otherStores: {
      phase4: {
        load: vi.fn(async () => ({}) as never),
        loadKeyManager: vi.fn(async () => ({}) as never),
        importKeyManager: vi.fn(async () => {}),
        verifyKeyManager: vi.fn(async () => true),
        loadRecord: vi.fn(async () => ({}) as never),
        validateSamlBundle: vi.fn(async () => {}),
        importSamlBundle: vi.fn(async () => {}),
        verifySamlBundle: vi.fn(async () => true),
        importDirectorySecret: vi.fn(async () => {}),
        verifyDirectorySecret: vi.fn(async () => true),
      },
      loadSqlite: vi.fn(async () => ({}) as never),
      loadRecord: vi.fn(async () => ({}) as never),
      restoreAdminEnvelope: vi.fn(async () => {}),
      verifyAdminEnvelope: vi.fn(async () => true),
      importAsset: vi.fn(async () => {}),
      verifyAsset: vi.fn(async () => true),
      importPlugin: vi.fn(async () => {}),
      verifyPlugin: vi.fn(async () => true),
      prepareLogicalTarget: vi.fn(async () => {}),
      verifyLogicalTarget: vi.fn(async () => true),
    },
    keyManagerSnapshot,
    recordSnapshots: {
      validateSamlBundle: vi.fn(async () => {}),
      validateAdminEnvelope: vi.fn(async () => {}),
      assertPluginSupported: vi.fn(async () => {}),
      saml: recordSnapshot('saml-signing:tenant'),
      directorySecrets: recordSnapshot('directory-secrets:tenant'),
      publicAssets: recordSnapshot('public-assets:tenant'),
      pluginConfiguration: recordSnapshot('plugin-configuration:tenant'),
      logicalPlacement: recordSnapshot('logical-placement:tenant'),
    },
    cleanup: {
      resolveSnapshotSource: vi.fn(async () => ({}) as never),
      cleanupRestoreTarget: vi.fn(async () => {}),
      cleanupAdditionalPage: vi.fn(async () => ({ done: true })),
      assertClean: vi.fn(async () => {}),
    },
    resolveAdminRestoreDatabase: vi.fn(async () => ({ query: vi.fn(async () => []) }) as never),
    resolveCoreRestoreDatabase: vi.fn(async () => ({ query: vi.fn(async () => []) }) as never),
    loadExternalPrerequisites: vi.fn(async (): Promise<unknown> => []),
    loadDeliverySafety: vi.fn(
      async (): Promise<unknown> => ({
        version: 1,
        sourceEnvironment: 'stopped',
        historicalDelivery: 'hold',
        scheduledCatchup: 'disabled',
        activation: 'new_events_only',
      })
    ),
  } satisfies Phase5InstalledAdapterPorts;
  const adapter = createPhase5TenantBackupInstalledAdapter({
    env: { DB_ADMIN: database(), RP_TOKEN_ENCRYPTION_KEY: '11'.repeat(32) } as unknown as Env,
    planned: planned(),
    ports,
  });
  return { adapter, ports, snapshot };
}

const selection = {
  settings: true,
  users: false,
  admin: false,
  artifacts: false,
  logs: { audit: false, other: false, sensitive: false, period: 'all' as const },
};

function adapterContext(): AdapterContext {
  const lease = {
    tenantId: 'tenant-a',
    operationId: 'operation-a',
  } as TenantBackupStepContext['lease'];
  return {
    context: { lease, signal: new AbortController().signal } as TenantBackupStepContext,
    selection,
    inventory: {
      headForLease: vi.fn(async () => ({ state: 'sealed', chain_digest: 'ab'.repeat(32) })),
    } as never,
    snapshotResources: {} as never,
    databases: {} as never,
    resolveSource: vi.fn(async () => ({})) as never,
  };
}

it('installs every Phase 5 SQL dataset and one tenant KeyManager DO dataset', async () => {
  const { adapter } = fixture();
  expect(adapter.export.datasets(selection)).toHaveLength(
    PHASE5_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.length + 6
  );
  expect(adapter.import.datasets(selection)).toHaveLength(
    PHASE5_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.length + 6
  );
  await expect(
    adapter.import.loadPolicy({} as TenantBackupStepContext, KEY_MANAGER_TENANT_BACKUP_DATASET.id)
  ).resolves.toMatchObject({ dataset: KEY_MANAGER_TENANT_BACKUP_DATASET });
});

it('captures, exports and releases the immutable KeyManager snapshot participant', async () => {
  const { adapter, ports, snapshot } = fixture();
  const context = adapterContext();
  const participants = await adapter.export.additionalParticipants(context);
  expect(participants).toHaveLength(6);
  expect(participants[0].resourceId).toBe('key-manager:tenant');
  const assertHeld = vi.fn(async () => {});
  await participants[0].start(assertHeld);

  const first = await adapter.export.readNext({
    ...context,
    datasetId: KEY_MANAGER_TENANT_BACKUP_DATASET.id,
    cursor: null,
    signal: context.context.signal,
  });
  expect(first).not.toBeNull();
  const rowJson = new TextDecoder().decode(first!.bytes).trimEnd();
  await expect(decodeKeyManagerTenantBackupRow(rowJson, 'tenant-a')).resolves.toEqual(snapshot);
  await expect(
    adapter.export.readNext({
      ...context,
      datasetId: KEY_MANAGER_TENANT_BACKUP_DATASET.id,
      cursor: first!.nextCursor,
      signal: context.context.signal,
    })
  ).resolves.toBeNull();

  await expect(adapter.export.releaseAdditionalResources(context)).resolves.toEqual({ done: true });
  expect(ports.keyManagerSnapshot.start).toHaveBeenCalledOnce();
  expect(ports.keyManagerSnapshot.release).toHaveBeenCalledOnce();
});

it('blocks activation until external prerequisites and logical references pass', async () => {
  const { adapter, ports } = fixture();
  const context = {
    lease: { tenantId: 'tenant-a' },
  } as TenantBackupStepContext;
  await adapter.import.prepareActivation(context, 'ab'.repeat(32));
  expect(ports.loadExternalPrerequisites).toHaveBeenCalledWith(context, 'ab'.repeat(32));
  expect(ports.loadExternalPrerequisites.mock.invocationCallOrder[0]).toBeLessThan(
    ports.import.prepareActivation.mock.invocationCallOrder[0]!
  );
  expect(ports.loadDeliverySafety).toHaveBeenCalledWith(context, 'ab'.repeat(32));
});

it('stops activation when historical delivery could resume', async () => {
  const { adapter, ports } = fixture();
  ports.loadDeliverySafety.mockResolvedValueOnce({
    version: 1,
    sourceEnvironment: 'stopped',
    historicalDelivery: 'resume',
    scheduledCatchup: 'disabled',
    activation: 'new_events_only',
  });
  await expect(
    adapter.import.prepareActivation(
      { lease: { tenantId: 'tenant-a' } } as TenantBackupStepContext,
      'ab'.repeat(32)
    )
  ).rejects.toThrow('backup_phase5_delivery_unsafe');
  expect(ports.import.prepareActivation).not.toHaveBeenCalled();
});

it('stops activation when a required external prerequisite is unresolved', async () => {
  const { adapter, ports } = fixture();
  ports.loadExternalPrerequisites.mockResolvedValueOnce([
    {
      id: 'kms/customer-key',
      kind: 'key_material',
      scope: 'tenant',
      resolution: 'target_binding',
      status: 'unresolved',
      required: true,
    },
  ]);
  await expect(
    adapter.import.prepareActivation(
      { lease: { tenantId: 'tenant-a' } } as TenantBackupStepContext,
      'ab'.repeat(32)
    )
  ).rejects.toThrow('backup_phase4_prerequisites_unresolved');
  expect(ports.import.prepareActivation).not.toHaveBeenCalled();
});

it('rejects an incomplete cumulative SQL plan before installing Phase 5', () => {
  const { ports } = fixture();
  expect(() =>
    createPhase5TenantBackupInstalledAdapter({
      env: {} as Env,
      planned: planned().slice(1),
      ports,
    })
  ).toThrow('backup_phase5_plan_incomplete');
});
