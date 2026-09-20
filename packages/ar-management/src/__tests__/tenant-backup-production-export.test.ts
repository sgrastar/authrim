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
    activate: vi.fn(),
    observe: vi.fn(),
    restorePlan: vi.fn(async () => []),
    restoreResolve: vi.fn(),
    restoreAssert: vi.fn(),
    restoreDatabaseForRole: vi.fn(),
    publishRuntimeState: vi.fn(),
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
vi.mock('../tenant-backup-production-restore-targets', () => ({
  createProductionTenantBackupRestoreTargets: () => ({
    platform: {
      queryOne: vi.fn(async () => ({ lifecycle_state: 'active' })),
    },
    plan: mocks.restorePlan,
    resolveTarget: mocks.restoreResolve,
    assertUnpublished: mocks.restoreAssert,
    databaseForRole: mocks.restoreDatabaseForRole,
  }),
}));
vi.mock('../admin-tenants', () => ({
  activateProvisionedTenantLifecycle: mocks.activate,
  resolveActiveTenantRuntimeRouteObservation: mocks.observe,
}));

import {
  createProductionTenantBackupExportAdapter,
  isEnvironmentLocalSystemClientRow,
} from '../tenant-backup-production-export';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resources.mockResolvedValue([
    {
      databaseId: 'core-a',
      assignments: [{ dataRole: 'tenant_core/default' }],
      database: {
        query: vi.fn(async () => [{ tenant_key: 'tenant-key-a' }]),
      },
    },
  ]);
  mocks.phase8.mockReturnValue({ export: { installed: true }, import: {}, cleanup: {} });
  mocks.restoreDatabaseForRole.mockResolvedValue({
    queryOne: vi.fn(async () => ({ lifecycle_state: 'active' })),
  });
  mocks.publishRuntimeState.mockResolvedValue({
    lookupRegistry: { generation: 1, status: 'published' },
    lookupHmacKeyState: { generation: 1, stateRevision: 1, status: 'published' },
    pluginRunnerRegistry: { generation: 1, status: 'published' },
  });
});

it('excludes setup-owned OAuth clients and their child rows from portable backups', async () => {
  const row = (values: Record<string, readonly [string, string | null]>) => JSON.stringify(values);
  const database = {
    queryOne: vi.fn(async (_sql: string, params: unknown[]) => ({
      description:
        params[1] === 'system-client'
          ? 'System-managed public OAuth client used by the built-in Authrim Login UI.'
          : 'Customer client',
    })),
  };
  await expect(
    isEnvironmentLocalSystemClientRow(
      database as never,
      'core.oauth_clients',
      row({
        description: [
          'text',
          'System-managed confidential client used by Authrim for downstream grant introspection.',
        ],
      })
    )
  ).resolves.toBe(true);
  await expect(
    isEnvironmentLocalSystemClientRow(
      database as never,
      'core.oauth_clients',
      row({ description: ['null', null] })
    )
  ).resolves.toBe(false);
  await expect(
    isEnvironmentLocalSystemClientRow(
      database as never,
      'core.web_origin_registry',
      row({ tenant_id: ['text', 'tenant-a'], client_id: ['text', 'system-client'] })
    )
  ).resolves.toBe(true);
  await expect(
    isEnvironmentLocalSystemClientRow(
      database as never,
      'core.client_consent_overrides',
      row({ tenant_id: ['text', 'tenant-a'], client_id: ['text', 'customer-client'] })
    )
  ).resolves.toBe(false);
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
      import: { planRestoreTargets(): Promise<unknown> };
    };
  };
  expect(input.ports.tenantKey).toBe('tenant-key-a');
  expect(input.ports.recordSnapshots.userAvatars.resourceId).toBe('public-assets:users');
  expect(input.ports.export.prepareSources).toEqual(expect.any(Function));
  await expect(input.ports.import.planRestoreTargets()).rejects.toThrow(
    'backup_import_restore_target_unavailable'
  );
});

it('resolves the tenant key only from the canonical default core database', async () => {
  mocks.resources.mockResolvedValue([
    {
      databaseId: 'core-a',
      assignments: [{ dataRole: 'tenant_core/default' }],
      database: { query: vi.fn(async () => [{ tenant_key: 'tenant-key-a' }]) },
    },
    {
      databaseId: 'core-b',
      assignments: [{ dataRole: 'tenant_core/users' }],
      database: { query: vi.fn(async () => [{ tenant_key: 'different-shard-key' }]) },
    },
  ]);
  const context = {
    lease: { tenantId: 'tenant-a', operationId: 'operation-a' },
    signal: new AbortController().signal,
  } as never;

  await expect(
    createProductionTenantBackupExportAdapter({} as Env, context)
  ).resolves.toBeDefined();
});

it('exports each logical dataset only from databases assigned to its data role', async () => {
  mocks.resources.mockResolvedValue([
    {
      databaseId: 'core-default',
      assignments: [{ dataRole: 'tenant_core/default' }],
      database: { query: vi.fn(async () => [{ tenant_key: 'tenant-key-a' }]) },
    },
    {
      databaseId: 'core-users',
      assignments: [{ dataRole: 'tenant_core/users' }],
      database: { query: vi.fn(async () => [{ tenant_key: 'tenant-key-a' }]) },
    },
  ]);
  const context = {
    operation: { kind: 'export' },
    lease: { tenantId: 'tenant-a', operationId: 'operation-a' },
    signal: new AbortController().signal,
  } as never;
  await createProductionTenantBackupExportAdapter({} as Env, context);
  const input = mocks.phase8.mock.calls[0]?.[0] as unknown as {
    ports: {
      allowSqliteSource(input: { datasetId: string; resourceId: string }): Promise<boolean>;
    };
  };

  await expect(
    input.ports.allowSqliteSource({ datasetId: 'core.tenants', resourceId: 'core-default' })
  ).resolves.toBe(true);
  await expect(
    input.ports.allowSqliteSource({ datasetId: 'core.tenants', resourceId: 'core-users' })
  ).resolves.toBe(false);
  await expect(
    input.ports.allowSqliteSource({ datasetId: 'core.users_core', resourceId: 'core-users' })
  ).resolves.toBe(true);
});

it('rejects ambiguous canonical default core databases', async () => {
  mocks.resources.mockResolvedValue([
    {
      databaseId: 'core-a',
      assignments: [{ dataRole: 'tenant_core/default' }],
      database: { query: vi.fn(async () => [{ tenant_key: 'tenant-key-a' }]) },
    },
    {
      databaseId: 'core-b',
      assignments: [{ dataRole: 'tenant_core/default' }],
      database: { query: vi.fn(async () => [{ tenant_key: 'tenant-key-b' }]) },
    },
  ]);
  const context = {
    lease: { tenantId: 'tenant-a', operationId: 'operation-a' },
    signal: new AbortController().signal,
  } as never;

  await expect(createProductionTenantBackupExportAdapter({} as Env, context)).rejects.toThrow(
    'backup_phase8_tenant_key'
  );
});

it('installs the production import targets, activation, and runtime-route verification', async () => {
  const platform = {
    query: vi.fn(async () => []),
    queryOne: vi.fn(async () => ({ tenant_key: 'tenant-key-a', lifecycle_state: 'active' })),
    execute: vi.fn(),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(async () => true),
    getType: vi.fn(() => 'd1'),
    close: vi.fn(),
  };
  const context = {
    operation: { kind: 'import', phase: 'verify_restore_activation' },
    lease: { tenantId: 'tenant-a', operationId: 'operation-a' },
    signal: new AbortController().signal,
  } as never;
  await createProductionTenantBackupExportAdapter(
    {
      DB: platform,
      CONTROL: { publishTenantBackupRuntimeState: mocks.publishRuntimeState },
    } as unknown as Env,
    context
  );
  expect(platform.queryOne).toHaveBeenCalledWith(
    expect.stringContaining('lifecycle_state IN (?)'),
    ['tenant-a', 'active']
  );

  const input = mocks.phase8.mock.calls[0]?.[0] as unknown as {
    ports: {
      cleanup: {
        cleanupAdditionalPage(context: unknown): Promise<{ done: boolean }>;
        assertClean(context: unknown): Promise<void>;
      };
      import: {
        planRestoreTargets(context: unknown, datasets: unknown[]): Promise<unknown[]>;
        prepareActivation(context: unknown): Promise<void>;
        activate(context: unknown): Promise<void>;
        verifyActivation(context: unknown): Promise<void>;
      };
    };
  };
  await expect(input.ports.import.planRestoreTargets(context, [])).resolves.toEqual([]);
  await expect(input.ports.cleanup.cleanupAdditionalPage(context)).resolves.toEqual({ done: true });
  await expect(input.ports.cleanup.assertClean(context)).resolves.toBeUndefined();
  await input.ports.import.prepareActivation(context);
  await input.ports.import.activate(context);
  await input.ports.import.verifyActivation(context);
  expect(mocks.restoreAssert).toHaveBeenCalled();
  expect(mocks.publishRuntimeState).toHaveBeenCalledOnce();
  expect(mocks.activate).toHaveBeenCalled();
  expect(mocks.observe).toHaveBeenCalledTimes(2);
});

it('allows import cleanup after the unpublished target lifecycle has changed', async () => {
  const platform = {
    query: vi.fn(async () => []),
    queryOne: vi.fn(async () => ({ tenant_key: 'tenant-key-a' })),
    execute: vi.fn(),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(async () => true),
    getType: vi.fn(() => 'd1'),
    close: vi.fn(),
  };
  const context = {
    operation: { kind: 'import', state: 'cancelling', phase: 'cleanup' },
    lease: { tenantId: 'tenant-a', operationId: 'operation-a' },
    signal: new AbortController().signal,
  } as never;

  await createProductionTenantBackupExportAdapter({ DB: platform } as unknown as Env, context);

  expect(platform.queryOne).toHaveBeenCalledWith(
    expect.stringContaining('lifecycle_state IN (?,?)'),
    ['tenant-a', 'provisioning', 'active']
  );
});
