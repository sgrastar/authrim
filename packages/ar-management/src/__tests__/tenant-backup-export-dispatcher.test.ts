import { beforeEach, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import type { TenantBackupInstalledExportAdapter } from '../tenant-backup-export-dispatcher';
import { runTenantBackupExportOperationStep } from '../tenant-backup-export-dispatcher';

const mocks = vi.hoisted(() => ({
  prepare: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  load: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  artifact: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  resolveInventory: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  discover: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  prepareResources: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  boundaryStep: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  head: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  releaseSnapshots: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  database: {},
  source: {},
}));

vi.mock('@authrim/ar-lib-core', () => ({
  requireDedicatedAdminDatabaseAdapter: () => mocks.database,
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/execution-inventory', () => ({
  TenantBackupExecutionInventory: class {
    headForLease(...args: unknown[]) {
      return mocks.head(...args);
    }
  },
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/snapshot-resources', () => ({
  TenantBackupSnapshotResources: class {
    cleanupPublishedPage(...args: unknown[]) {
      return mocks.releaseSnapshots(...args);
    }
  },
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/sqlite-resource-discovery', () => ({
  runSqliteResourceDiscoveryStep: (...args: unknown[]) => mocks.discover(...args),
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/sqlite-resource-preparation', () => ({
  runSqliteResourcePreparationStep: (...args: unknown[]) => mocks.prepareResources(...args),
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/snapshot-boundary-step', () => ({
  runPreparedSnapshotBoundaryStep: (...args: unknown[]) => mocks.boundaryStep(...args),
}));
vi.mock('../tenant-backup-database-inventory', () => ({
  resolveTenantBackupDatabaseInventory: (...args: unknown[]) => mocks.resolveInventory(...args),
  tenantBackupDatabaseFamily: () => 'core',
}));
vi.mock('../tenant-backup-execution', () => ({
  loadTenantBackupExportExecution: (...args: unknown[]) => mocks.load(...args),
  runTenantBackupArtifactExecution: (...args: unknown[]) => mocks.artifact(...args),
  runTenantBackupExportPreparation: (...args: unknown[]) => mocks.prepare(...args),
}));
vi.mock('../tenant-backup-services', () => ({
  getTenantBackupBoundaryClient: () => ({ admission: {}, receipts: {} }),
}));

const selection = {
  settings: true,
  users: false,
  admin: false,
  artifacts: false,
  logs: { audit: false, other: false, sensitive: false, period: 'all' as const },
};
const env = {
  AUTHRIM_ENVIRONMENT_NAME: 'environment',
  EXPORT_ARTIFACTS: {},
} as unknown as Env;
const operation = {
  id: 'operation',
  tenant_id: 'tenant',
  kind: 'export',
  state: 'running',
  phase: 'prepare',
  cursor_json: null,
} as const;
const context = {
  operation,
  lease: {
    tenantId: 'tenant',
    operationId: 'operation',
    owner: 'worker',
    fencingToken: 1,
  },
  signal: new AbortController().signal,
} as unknown as TenantBackupStepContext;

function installed() {
  return {
    requiredDatabases: { roles: ['tenant_core'], fixed: [] },
    datasets: (_selection) => [
      {
        id: 'core.tenants',
        module: 'tenant-runtime',
        kind: 'settings',
        store: 'database',
        schemaVersion: 1,
        disposition: 'include',
      },
    ],
    prepareSources: vi.fn(
      async (): Promise<{ cursor: string | null; done: boolean }> => ({
        cursor: null,
        done: true,
      })
    ),
    assertSources: vi.fn(async () => {}),
    assertBoundaryReady: vi.fn(async () => {}),
    additionalParticipants: vi.fn(async () => [
      { resourceId: 'kv:settings', snapshotId: 'generation:1', async start() {} },
    ]),
    assertCoverage: vi.fn(async () => {}),
    readNext: vi.fn(async () => null),
    releaseAdditionalResources: vi.fn(async () => ({ done: true })),
    assertPublishable: vi.fn(async () => {}),
  } satisfies TenantBackupInstalledExportAdapter;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prepare.mockResolvedValue({ phase: 'prepare', cursor: '{}', disposition: 'continue' });
  mocks.load.mockResolvedValue({ database: mocks.database, intent: { selection } });
  mocks.resolveInventory.mockResolvedValue({
    tenant: [
      {
        databaseId: 'core_db',
        assignments: [{ role: 'tenant_core' }],
        database: mocks.source,
      },
    ],
    fixed: [],
  });
  mocks.head.mockResolvedValue({ chain_digest: 'ab'.repeat(32) });
  mocks.discover.mockResolvedValue({
    phase: 'prepare_capture_resources',
    cursor: '{}',
    disposition: 'continue',
  });
  mocks.prepareResources.mockImplementation(async (raw) => {
    const input = raw as {
      assertBoundary(): Promise<void>;
      resolveSource(resource: { resourceId: string; family: 'core' }): Promise<unknown>;
    };
    await input.assertBoundary();
    expect(await input.resolveSource({ resourceId: 'core_db', family: 'core' })).toEqual({
      resourceId: 'core_db',
      database: mocks.source,
    });
    return { phase: 'admit_snapshot_boundary', cursor: '{}', disposition: 'continue' };
  });
  mocks.boundaryStep.mockImplementation(async (raw) => {
    const input = raw as {
      assertReady(): Promise<void>;
      assertCoverage(
        resources: Array<{ resourceId: string }>,
        participants: Array<{ resourceId: string; snapshotId: string }>
      ): Promise<void>;
      additionalParticipants: Array<{ resourceId: string; snapshotId: string }>;
    };
    await input.assertReady();
    await input.assertCoverage(
      [{ resourceId: 'core_db' }],
      [{ resourceId: 'core_db', snapshotId: 'snapshot' }, ...input.additionalParticipants]
    );
    return { phase: 'prepare_export_artifact', cursor: '{}', disposition: 'continue' };
  });
  mocks.artifact.mockResolvedValue({
    phase: 'export_artifact',
    cursor: '{}',
    disposition: 'continue',
  });
  mocks.releaseSnapshots.mockResolvedValue({ done: true });
});

function phase(value: string): TenantBackupStepContext {
  return { ...context, operation: { ...context.operation, phase: value } };
}

it('routes prepare without constructing an unsealed downstream inventory', async () => {
  const adapter = installed();
  expect(await runTenantBackupExportOperationStep(env, context, adapter, () => 100)).toEqual({
    phase: 'prepare',
    cursor: '{}',
    disposition: 'continue',
  });
  expect(mocks.prepare).toHaveBeenCalledWith(
    env,
    context,
    adapter.requiredDatabases,
    expect.any(Function)
  );
  expect(mocks.load).not.toHaveBeenCalled();
});

it('runs installed source preparation in durable pages before SQL discovery', async () => {
  const adapter = installed();
  mocks.prepare.mockResolvedValueOnce({
    phase: 'discover_sqlite_resources',
    cursor: null,
    disposition: 'continue',
  });
  await expect(
    runTenantBackupExportOperationStep(env, context, adapter, () => 100)
  ).resolves.toEqual({
    phase: 'prepare_installed_sources',
    cursor: null,
    disposition: 'continue',
  });

  adapter.prepareSources.mockResolvedValueOnce({ cursor: '{"page":2}', done: false });
  await expect(
    runTenantBackupExportOperationStep(env, phase('prepare_installed_sources'), adapter)
  ).resolves.toEqual({
    phase: 'prepare_installed_sources',
    cursor: '{"page":2}',
    disposition: 'continue',
  });
  await expect(
    runTenantBackupExportOperationStep(env, phase('prepare_installed_sources'), adapter)
  ).resolves.toEqual({
    phase: 'discover_sqlite_resources',
    cursor: null,
    disposition: 'continue',
  });

  adapter.prepareSources.mockResolvedValueOnce({ cursor: null, done: false });
  await expect(
    runTenantBackupExportOperationStep(env, phase('prepare_installed_sources'), adapter)
  ).rejects.toThrow('backup_export_dispatch_invalid');
});

it('rechecks installed sources around discovery and trigger preparation', async () => {
  const adapter = installed();
  await runTenantBackupExportOperationStep(env, phase('discover_sqlite_resources'), adapter);
  expect(adapter.assertSources).toHaveBeenCalledTimes(2);
  await runTenantBackupExportOperationStep(env, phase('prepare_capture_resources'), adapter);
  expect(adapter.assertBoundaryReady).toHaveBeenCalled();
  expect(mocks.prepareResources).toHaveBeenCalledTimes(1);
});

it('requires exact SQL resource coverage before accepting non-SQL participants', async () => {
  const adapter = installed();
  await runTenantBackupExportOperationStep(env, phase('admit_snapshot_boundary'), adapter);
  expect(adapter.additionalParticipants).toHaveBeenCalledTimes(1);
  expect(adapter.assertCoverage).toHaveBeenCalledWith(
    expect.objectContaining({
      sqliteResources: [{ resourceId: 'core_db' }],
      participants: [
        { resourceId: 'core_db', snapshotId: 'snapshot' },
        { resourceId: 'kv:settings', snapshotId: 'generation:1' },
      ],
    })
  );

  mocks.boundaryStep.mockImplementationOnce(async (raw) => {
    const input = raw as {
      assertCoverage(
        resources: Array<{ resourceId: string }>,
        participants: Array<{ resourceId: string; snapshotId: string }>
      ): Promise<void>;
    };
    await input.assertCoverage([], []);
  });
  await expect(
    runTenantBackupExportOperationStep(env, phase('admit_snapshot_boundary'), adapter)
  ).rejects.toThrow('backup_export_dispatch_invalid');
});

it('forwards installed readers and final coverage to artifact execution', async () => {
  const adapter = installed();
  mocks.artifact.mockImplementationOnce(async (_env, _context, raw) => {
    const input = raw as {
      readNext(datasetId: string, cursor: string | null, signal: AbortSignal): Promise<unknown>;
      assertPublishable(digest: string): Promise<void>;
    };
    await input.readNext('core.tenants', null, context.signal);
    await input.assertPublishable('cd'.repeat(32));
    return { phase: 'export_artifact', cursor: '{}', disposition: 'continue' };
  });
  await runTenantBackupExportOperationStep(env, phase('export_artifact'), adapter);
  expect(adapter.readNext).toHaveBeenCalledWith(
    expect.objectContaining({ datasetId: 'core.tenants', cursor: null })
  );
  expect(adapter.assertPublishable).toHaveBeenCalledWith(
    expect.objectContaining({ inventoryDigest: 'cd'.repeat(32) })
  );
});

it('releases SQL and installed non-SQL snapshots in bounded slices before publication', async () => {
  const adapter = installed();
  const cursor = JSON.stringify({
    version: 2,
    attemptId: 'attempt',
    nextPart: 2,
    verifiedBytes: 10,
  });
  mocks.releaseSnapshots
    .mockResolvedValueOnce({ done: false })
    .mockResolvedValueOnce({ done: true });
  const release = {
    ...phase('release_export_resources'),
    operation: { ...context.operation, phase: 'release_export_resources', cursor_json: cursor },
  } as TenantBackupStepContext;
  await expect(runTenantBackupExportOperationStep(env, release, adapter)).resolves.toEqual({
    phase: 'release_export_resources',
    cursor,
    disposition: 'continue',
  });
  expect(adapter.releaseAdditionalResources).not.toHaveBeenCalled();
  await expect(runTenantBackupExportOperationStep(env, release, adapter)).resolves.toEqual({
    phase: 'publish_artifact',
    cursor,
    disposition: 'continue',
  });
  expect(adapter.releaseAdditionalResources).toHaveBeenCalledOnce();
});

it('rejects unknown export phases before invoking an installed adapter', async () => {
  const adapter = installed();
  await expect(runTenantBackupExportOperationStep(env, phase('unknown'), adapter)).rejects.toThrow(
    'backup_export_dispatch_invalid'
  );
  expect(adapter.readNext).not.toHaveBeenCalled();
});

it('rejects an incomplete installed adapter before planning physical sources', async () => {
  const adapter = installed();
  await expect(
    runTenantBackupExportOperationStep(env, context, { ...adapter, datasets: [] as never })
  ).rejects.toThrow('backup_export_dispatch_invalid');
  await expect(
    runTenantBackupExportOperationStep(env, context, {
      ...adapter,
      prepareSources: undefined as never,
    })
  ).rejects.toThrow('backup_export_dispatch_invalid');
  await expect(
    runTenantBackupExportOperationStep(env, context, {
      ...adapter,
      datasets: (selection) => [{ ...adapter.datasets(selection)[0], disposition: 'unsupported' }],
    })
  ).rejects.toThrow('backup_export_dispatch_invalid');
  expect(mocks.prepare).not.toHaveBeenCalled();
});
