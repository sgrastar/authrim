import type { Env } from '@authrim/ar-lib-core';
import type { PlannedInstalledSqliteDataset } from '@authrim/ar-lib-core/services/tenant-portability/installed-sqlite-datasets';
import { PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS } from '@authrim/ar-lib-core/services/tenant-portability/phase8-sqlite-modules';
import { expect, it, vi } from 'vitest';
import {
  createPhase8TenantBackupInstalledAdapter,
  type Phase8InstalledAdapterPorts,
} from '../tenant-backup-phase8-adapter';

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
    } as unknown as Env,
    planned: planned(),
    ports: ports(),
  });
  expect(adapter.export.requiredDatabases).toEqual({
    roles: ['tenant_core', 'tenant_pii'],
    fixed: ['DB_ADMIN'],
  });
  expect(adapter.export.datasets(all)).toHaveLength(
    PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.length + 7
  );
  expect(adapter.export.datasets(all).map(({ id }) => id)).toContain(
    'pii.identity_identifier_replacement_challenges'
  );
  expect(adapter.export.datasets(all).map(({ id }) => id)).not.toContain(
    'plugin_runner.plugin_runner_egress_audit'
  );
  expect(adapter.export.datasets(all).map(({ id }) => id)).toContain('users.public_avatars');
});

it('includes user avatars without settings assets for a users-only backup', () => {
  const adapter = createPhase8TenantBackupInstalledAdapter({
    env: {
      DB_ADMIN: database(),
      PII_ENCRYPTION_KEY: '11'.repeat(32),
      OBJECT_ENCRYPTION_ROOT_KEY: '22'.repeat(32),
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
    } as unknown as Env,
    loadPlanned,
    ports: installedPorts,
  });
  const context = {
    operation: { id: 'operation-a', tenant_id: 'tenant-a' },
  } as never;

  const policy = await adapter.import.loadPolicy(context, 'core.users_core');

  expect(policy.dataset.id).toBe('core.users_core');
  expect(loadPlanned).toHaveBeenCalledWith(context);
  expect(installedPorts.import.assertSources).toHaveBeenCalledWith(context);
});
