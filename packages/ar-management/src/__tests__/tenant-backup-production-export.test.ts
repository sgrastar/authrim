import { beforeEach, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => {
  const record = (resourceId: string) => ({
    resourceId,
    assertSource: vi.fn(),
    start: vi.fn(),
    readNext: vi.fn(),
    release: vi.fn(),
    assertReleased: vi.fn(),
  });
  return {
    record,
    phase8: vi.fn(),
    plan: vi.fn(async () => []),
    resources: vi.fn(),
  };
});

vi.mock('@authrim/ar-lib-core/services/tenant-portability/database-resources', () => ({
  resolveBackupTenantDatabaseResources: mocks.resources,
}));
vi.mock('../tenant-backup-phase8-plan-loader', () => ({
  loadPhase8InstalledSqlitePlan: mocks.plan,
}));
vi.mock('../tenant-backup-phase8-adapter', () => ({
  createPhase8TenantBackupInstalledAdapter: mocks.phase8,
}));
vi.mock('../tenant-backup-saml-port', () => ({
  createTenantBackupSamlPorts: () => ({
    saml: mocks.record('saml-local-signing:key-manager'),
    validateSamlBundle: vi.fn(),
  }),
}));
vi.mock('../tenant-backup-directory-secrets-port', () => ({
  createTenantBackupDirectorySecretPorts: () => ({
    directorySecrets: mocks.record('directory-secrets:settings'),
  }),
}));
vi.mock('../tenant-backup-public-assets-port', () => ({
  createTenantBackupPublicAssetPorts: () => ({
    publicAssets: mocks.record('public-assets:settings'),
    userAvatars: mocks.record('public-assets:users'),
  }),
}));
vi.mock('../tenant-backup-plugin-configuration-port', () => ({
  createTenantBackupPluginConfigurationPorts: () => ({
    pluginConfiguration: mocks.record('plugin-configuration:tenant-kv'),
    assertPluginSupported: vi.fn(),
  }),
}));
vi.mock('../tenant-backup-logical-placement-port', () => ({
  createTenantBackupLogicalPlacementPorts: () => ({
    logicalPlacement: mocks.record('logical-placement:tenant'),
  }),
}));
vi.mock('../tenant-backup-key-manager-port', () => ({
  createTenantBackupKeyManagerSnapshotPort: () => ({
    assertSource: vi.fn(),
    start: vi.fn(),
    load: vi.fn(),
    release: vi.fn(),
    assertReleased: vi.fn(),
  }),
}));
vi.mock('../tenant-backup-r2-object-snapshot-port', () => ({
  createTenantBackupR2ObjectSnapshotPorts: () => ({
    artifactObjects: mocks.record('r2-bodies:artifacts.object_catalog_bodies'),
    logArchiveObjects: mocks.record('r2-bodies:logs.archive_object_bodies'),
  }),
}));
vi.mock('../tenant-backup-r2-catalog-lister', () => ({
  createTenantBackupR2CatalogLister: vi.fn(() => vi.fn()),
}));
vi.mock('../tenant-backup-pii-log-port', () => ({
  createTenantBackupPiiLogTransformPort: () => ({
    loadExternalPiiLogValues: vi.fn(),
  }),
}));

import { createProductionTenantBackupExportAdapter } from '../tenant-backup-production-export';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resources.mockResolvedValue([
    {
      databaseId: 'core-a',
      database: {
        query: vi.fn(async () => [{ tenant_key: 'tenant-key-a' }]),
      },
    },
  ]);
  mocks.phase8.mockReturnValue({ export: { installed: true }, import: {}, cleanup: {} });
});

it('installs deployed export ports and keeps import targets fail closed', async () => {
  const context = {
    lease: { tenantId: 'tenant-a', operationId: 'operation-a' },
    signal: new AbortController().signal,
  } as never;
  const installed = await createProductionTenantBackupExportAdapter({} as Env, context);

  expect(installed.export).toEqual({ installed: true });
  const input = mocks.phase8.mock.calls[0]?.[0] as unknown as {
    ports: {
      tenantKey: string;
      recordSnapshots: { userAvatars: { resourceId: string } };
      export: { prepareSources(): Promise<{ cursor: string | null; done: boolean }> };
      import: { restoreTargets(): Promise<unknown> };
    };
  };
  expect(input.ports.tenantKey).toBe('tenant-key-a');
  expect(input.ports.recordSnapshots.userAvatars.resourceId).toBe('public-assets:users');
  await expect(input.ports.export.prepareSources()).resolves.toEqual({ cursor: null, done: true });
  await expect(input.ports.import.restoreTargets()).rejects.toThrow(
    'backup_import_restore_target_unavailable'
  );
  expect(mocks.plan).toHaveBeenCalledWith(expect.anything(), context, expect.any(Function));
});
