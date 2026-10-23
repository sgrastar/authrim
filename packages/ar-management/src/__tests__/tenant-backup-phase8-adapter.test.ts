import type { Env } from '@authrim/ar-lib-core';
import type { PlannedInstalledSqliteDataset } from '@authrim/ar-lib-core/services/tenant-portability/installed-sqlite-datasets';
import { PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS } from '@authrim/ar-lib-core/services/tenant-portability/phase8-sqlite-modules';
import { expect, it, vi } from 'vitest';
import {
  createPhase8TenantBackupInstalledAdapter,
  type Phase8InstalledAdapterPorts,
} from '../tenant-backup-phase8-adapter';

const bundle = vi.hoisted(() => ({
  guardInput: undefined as
    | { loadBundleRoles(context: unknown): Promise<readonly string[]> }
    | undefined,
  datasets: vi.fn(),
  byId: vi.fn(),
  head: vi.fn(),
}));
vi.mock('../tenant-backup-restore-authority', async (original) => {
  const actual = await original<typeof import('../tenant-backup-restore-authority')>();
  return {
    ...actual,
    createTenantBackupRestoreAuthorityGuard: (
      input: Parameters<typeof actual.createTenantBackupRestoreAuthorityGuard>[0]
    ) => {
      bundle.guardInput = input;
      return actual.createTenantBackupRestoreAuthorityGuard(input);
    },
  };
});
vi.mock('../tenant-backup-validated-input-port', async (original) => {
  const actual = await original<typeof import('../tenant-backup-validated-input-port')>();
  return {
    ...actual,
    createTenantBackupValidatedInputPorts: (
      ...args: Parameters<typeof actual.createTenantBackupValidatedInputPorts>
    ) => ({
      ...actual.createTenantBackupValidatedInputPorts(...args),
      loadValidatedSqliteDatasets: bundle.datasets,
      loadValidatedDatasetById: bundle.byId,
    }),
  };
});
vi.mock(
  '@authrim/ar-lib-core/services/tenant-portability/restore-plan-inventory',
  async (original) => ({
    ...(await original<
      typeof import('@authrim/ar-lib-core/services/tenant-portability/restore-plan-inventory')
    >()),
    DatabaseTenantBackupRestorePlanInventory: class {
      headForLease = bundle.head;
    },
  })
);

function planned(): PlannedInstalledSqliteDataset[] {
  return PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.map((registration, ordinal) => ({
    ordinal,
    firstOrdinal: 0,
    resourceId: `${registration.family}-db`,
    family: registration.family,
    table: registration.table,
    dataset: registration.dataset,
    ...(registration.partitions ? { partitions: registration.partitions } : {}),
    capture: {
      table: registration.table,
      columns: registration.partitions ? ['id', 'tenant_id', 'resource_type'] : ['id', 'tenant_id'],
      primaryKey: ['id'],
      uniqueKeys: [],
      tenantColumn: 'tenant_id',
      ...(registration.partitions
        ? {
            rowPartition: {
              column: 'resource_type',
              values: PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.filter(
                (candidate) =>
                  candidate.family === registration.family && candidate.table === registration.table
              ).flatMap((candidate) => candidate.partitions ?? []),
            },
          }
        : {}),
    },
  }));
}

function recordSnapshot(resourceId: string) {
  return {
    resourceId,
    assertSource: vi.fn(),
    start: vi.fn(),
    readNext: vi.fn(),
    release: vi.fn(),
    assertReleased: vi.fn(),
  };
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
    close: vi.fn(),
  };
}

function ports(): Phase8InstalledAdapterPorts {
  return {
    tenantKey: 'tenant-key-a',
    export: {
      prepareSources: vi.fn(),
      assertSources: vi.fn(),
      assertBoundaryReady: vi.fn(),
    },
    import: { assertSources: vi.fn() } as never,
    otherStores: {} as never,
    rowTransform: {
      loadExternalPiiLogValues: vi.fn(async () => null),
    },
    keyManagerSnapshot: {} as never,
    recordSnapshots: {
      validateSamlBundle: vi.fn(),
      validatePhase8Envelope: vi.fn(),
      assertPluginSupported: vi.fn(),
      saml: recordSnapshot('saml'),
      directorySecrets: recordSnapshot('directory'),
      publicAssets: recordSnapshot('assets'),
      userAvatars: recordSnapshot('avatars'),
      pluginConfiguration: recordSnapshot('plugin'),
      logicalPlacement: recordSnapshot('placement'),
    },
    cleanup: {} as never,
    resolveAdminRestoreDatabase: vi.fn(),
    resolveCoreRestoreDatabase: vi.fn(),
    resolveAdminR2RestoreDatabase: vi.fn(),
    resolveCoreR2RestoreDatabase: vi.fn(),
    loadExternalPrerequisites: vi.fn(),
    loadDeliverySafety: vi.fn(),
  };
}

const all = {
  settings: true,
  users: true,
  admin: true,
  artifacts: true,
  logs: { audit: true, other: true, sensitive: true, period: 'all' as const },
};

it('installs the complete Core, PII, and Admin Phase 8 SQL adapter', () => {
  const adapter = createPhase8TenantBackupInstalledAdapter({
    env: {
      DB_ADMIN: database(),
      PII_ENCRYPTION_KEY: '11'.repeat(32),
      OBJECT_ENCRYPTION_ROOT_KEY: '22'.repeat(32),
      EXPORT_ARTIFACTS: {} as R2Bucket,
    } as unknown as Env,
    planned: planned(),
    ports: ports(),
  });
  expect(adapter.export.requiredDatabases).toEqual({
    roles: ['tenant_core', 'tenant_pii'],
    fixed: ['DB_ADMIN'],
  });
  expect(adapter.export.datasets(all)).toHaveLength(
    PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.length + 9
  );
  expect(adapter.export.datasets(all).map(({ id }) => id)).toContain(
    'pii.identity_identifier_replacement_challenges'
  );
  expect(adapter.export.datasets(all).map(({ id }) => id)).not.toContain(
    'plugin_runner.plugin_runner_egress_audit'
  );
  expect(adapter.export.datasets(all).map(({ id }) => id)).toContain('users.public_avatars');
  expect(adapter.export.datasets(all).map(({ id }) => id)).toContain(
    'artifacts.object_catalog_bodies'
  );
  expect(adapter.export.datasets(all).map(({ id }) => id)).toContain('logs.archive_object_bodies');
});

it('includes user avatars without settings assets for a users-only backup', () => {
  const adapter = createPhase8TenantBackupInstalledAdapter({
    env: {
      DB_ADMIN: database(),
      PII_ENCRYPTION_KEY: '11'.repeat(32),
      OBJECT_ENCRYPTION_ROOT_KEY: '22'.repeat(32),
      EXPORT_ARTIFACTS: {} as R2Bucket,
    } as unknown as Env,
    planned: planned(),
    ports: ports(),
  });
  const datasets = adapter.export.datasets({
    settings: false,
    users: true,
    admin: false,
    artifacts: false,
    logs: { audit: false, other: false, sensitive: false, period: 'all' },
  });
  expect(datasets.map(({ id }) => id)).toContain('users.public_avatars');
  expect(datasets.map(({ id }) => id)).not.toContain('flows-ui.public_assets');
});

it('loads import policies from the claimed operation physical plan', async () => {
  const installedPorts = ports();
  const loadPlanned = vi.fn(async () => planned());
  const adapter = createPhase8TenantBackupInstalledAdapter({
    env: {
      DB_ADMIN: database(),
      PII_ENCRYPTION_KEY: '11'.repeat(32),
      OBJECT_ENCRYPTION_ROOT_KEY: '22'.repeat(32),
      EXPORT_ARTIFACTS: {} as R2Bucket,
    } as unknown as Env,
    loadPlanned,
    ports: installedPorts,
  });
  const context = {
    operation: { id: 'operation-a', tenant_id: 'tenant-a' },
  } as never;

  const policy = await adapter.import.loadPolicy(context, 'core.users_core');
  const secondPolicy = await adapter.import.loadPolicy(context, 'core.tenants');

  expect(policy.dataset.id).toBe('core.users_core');
  expect(secondPolicy.dataset.id).toBe('core.tenants');
  expect(loadPlanned).toHaveBeenCalledWith(context);
  expect(loadPlanned).toHaveBeenCalledTimes(1);
  expect(installedPorts.import.assertSources).toHaveBeenCalledWith(context);
});

it('holds platform-only settings and global Admin assignments to the request authority', async () => {
  for (const source of ['planned', 'loadPlanned'] as const) {
    const adapter = createPhase8TenantBackupInstalledAdapter({
      env: {
        DB_ADMIN: database(),
        PII_ENCRYPTION_KEY: '11'.repeat(32),
        OBJECT_ENCRYPTION_ROOT_KEY: '22'.repeat(32),
        EXPORT_ARTIFACTS: {} as R2Bucket,
      } as unknown as Env,
      ...(source === 'planned' ? { planned: planned() } : { loadPlanned: async () => planned() }),
      ports: ports(),
    });
    const context = { operation: { id: 'operation-a', tenant_id: 'tenant-a' } } as never;
    for (const datasetId of [
      'admin.tenant_settings_documents',
      'admin.admin_role_assignments',
      'admin.admin_roles',
    ]) {
      const policy = await adapter.import.loadPolicy(context, datasetId);
      expect(policy.admitRow?.id, `${source}:${datasetId}`).toBe(
        `restore-authority-v1:${datasetId}`
      );
      expect(policy.restoreTransform?.id, `${source}:${datasetId}`).toContain(
        'restore-authority-v1'
      );
    }
    expect((await adapter.import.loadPolicy(context, 'core.users_core')).admitRow).toBeUndefined();
  }
});

it('reads the bundle roles from the validated input under the sealed restore plan', async () => {
  createPhase8TenantBackupInstalledAdapter({
    env: {
      DB_ADMIN: database(),
      PII_ENCRYPTION_KEY: '11'.repeat(32),
      OBJECT_ENCRYPTION_ROOT_KEY: '22'.repeat(32),
      EXPORT_ARTIFACTS: {} as R2Bucket,
    } as unknown as Env,
    planned: planned(),
    ports: ports(),
  });
  const context = { lease: { tenantId: 'tenant-a', operationId: 'operation-a' } };
  const rows = ['{"id":["text","role-a"]}', '{"id":["text","role-b"]}'];
  bundle.datasets.mockResolvedValue([{ policy: { dataset: { id: 'admin.admin_roles' } } }]);
  bundle.head.mockResolvedValue({ state: 'sealed', chain_digest: 'ab'.repeat(32) });
  bundle.byId.mockResolvedValue({
    readNextValidatedRow: async ({ sourceCursor }: { sourceCursor: string | null }) => {
      const index = sourceCursor === null ? 0 : Number(sourceCursor);
      return index < rows.length ? { rowJson: rows[index], nextCursor: String(index + 1) } : null;
    },
  });
  await expect(bundle.guardInput!.loadBundleRoles(context)).resolves.toEqual(rows);
  expect(bundle.byId).toHaveBeenCalledWith(context, 'ab'.repeat(32), 'admin.admin_roles');
  // No roles in the bundle: nothing to read.
  bundle.datasets.mockResolvedValue([{ policy: { dataset: { id: 'core.users_core' } } }]);
  await expect(bundle.guardInput!.loadBundleRoles(context)).resolves.toEqual([]);
  // A plan that is not sealed is not read.
  bundle.datasets.mockResolvedValue([{ policy: { dataset: { id: 'admin.admin_roles' } } }]);
  bundle.head.mockResolvedValue({ state: 'building', chain_digest: 'ab'.repeat(32) });
  await expect(bundle.guardInput!.loadBundleRoles(context)).rejects.toThrow(
    'backup_restore_authority_roles_unavailable'
  );
});
