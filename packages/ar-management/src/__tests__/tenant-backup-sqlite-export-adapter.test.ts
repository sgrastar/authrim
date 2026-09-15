import { beforeEach, expect, it, vi } from 'vitest';
import type { AdapterContext } from '../tenant-backup-export-dispatcher';

const mocks = vi.hoisted(() => ({
  planned: vi.fn(),
  read: vi.fn(),
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/installed-sqlite-datasets', () => ({
  resolveInstalledSqliteDatasets: mocks.planned,
  plannedInstalledSqliteDatasetSources: (
    entry: typeof planned & {
      sources?: Array<{ resourceId: string; firstOrdinal: number; ordinal: number }>;
    }
  ) =>
    entry.sources ?? [
      {
        resourceId: entry.resourceId,
        firstOrdinal: entry.firstOrdinal,
        ordinal: entry.ordinal,
      },
    ],
  selectInstalledSqliteDatasets: (registrations: Array<{ dataset: typeof registration }>) =>
    registrations.map(({ dataset }) => dataset),
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/sqlite-sharded-dataset-reader', () => ({
  readNextShardedSqliteDatasetChunk: mocks.read,
}));

import { createTenantBackupInstalledSqliteExportAdapter } from '../tenant-backup-sqlite-export-adapter';

const registration = {
  family: 'core' as const,
  table: 'roles',
  dataset: {
    id: 'core.roles',
    module: 'authorization' as const,
    kind: 'settings' as const,
    store: 'database' as const,
    schemaVersion: 1,
    disposition: 'include' as const,
  },
};
const planned = {
  ordinal: 2,
  firstOrdinal: 1,
  resourceId: 'physical-core',
  family: 'core' as const,
  table: 'roles',
  capture: {},
  dataset: registration.dataset,
};

function fixture() {
  const source = {};
  const snapshotResources = {
    loadCapture: vi.fn(async (_lease: unknown, resourceId: string) => ({
      resourceId,
      snapshotId: 'snapshot',
    })),
    assertReleased: vi.fn(async () => {}),
  };
  const context = {
    context: {
      operation: {},
      lease: { tenantId: 'tenant', operationId: 'operation', owner: 'worker', fencingToken: 1 },
      signal: new AbortController().signal,
    },
    inventory: {},
    snapshotResources,
    databases: {},
    selection: {},
    resolveSource: vi.fn(async () => source),
  } as unknown as AdapterContext;
  const ports = {
    prepareSources: vi.fn(async () => ({ cursor: null, done: true })),
    assertSources: vi.fn(async () => {}),
    assertBoundaryReady: vi.fn(async () => {}),
  };
  const adapter = createTenantBackupInstalledSqliteExportAdapter({
    requiredDatabases: { roles: ['tenant_core'], fixed: [] },
    registrations: [registration],
    ports,
  });
  return { adapter, context, ports, source, snapshotResources };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.planned.mockResolvedValue([planned]);
  mocks.read.mockResolvedValue({ bytes: new Uint8Array([1]), nextCursor: '{}' });
});

it('delegates bounded installed source preparation', async () => {
  const { adapter, context, ports } = fixture();
  await expect(adapter.prepareSources({ ...context, cursor: '{"page":1}' })).resolves.toEqual({
    cursor: null,
    done: true,
  });
  expect(ports.prepareSources).toHaveBeenCalledWith(
    expect.objectContaining({ cursor: '{"page":1}' })
  );
});

it('requires exact registered dataset and SQL participant coverage', async () => {
  const { adapter, context } = fixture();
  await adapter.assertCoverage({
    ...context,
    sqliteResources: [{ resourceId: 'physical-core' } as never],
    participants: [{ resourceId: 'physical-core', snapshotId: 'snapshot' }],
  });
  await expect(
    adapter.assertCoverage({
      ...context,
      sqliteResources: [{ resourceId: 'physical-core' } as never],
      participants: [
        { resourceId: 'physical-core', snapshotId: 'snapshot' },
        { resourceId: 'unregistered', snapshotId: 'other' },
      ],
    })
  ).rejects.toThrow('backup_sqlite_export_adapter_coverage');
  mocks.planned.mockResolvedValueOnce([]);
  await expect(
    adapter.assertCoverage({
      ...context,
      sqliteResources: [{ resourceId: 'physical-core' } as never],
      participants: [{ resourceId: 'physical-core', snapshotId: 'snapshot' }],
    })
  ).rejects.toThrow('backup_sqlite_export_adapter_coverage');
});

it('reads the persisted plan and exact snapshot rather than caller-supplied table metadata', async () => {
  const { adapter, context, source } = fixture();
  await adapter.readNext({
    ...context,
    datasetId: 'core.roles',
    cursor: null,
    signal: context.context.signal,
  });
  const input = mocks.read.mock.calls[0]?.[0] as {
    table: string;
    shards: Array<{ resourceId: string; firstOrdinal: number; snapshotId: string }>;
    resolveSource(shard: { resourceId: string }): Promise<unknown>;
  };
  expect(input).toEqual(
    expect.objectContaining({
      table: 'roles',
      shards: [{ resourceId: 'physical-core', firstOrdinal: 1, snapshotId: 'snapshot' }],
    })
  );
  await expect(input.resolveSource(input.shards[0])).resolves.toEqual({
    resourceId: 'physical-core',
    database: source,
  });
});

it('reads every frozen shard and passes physical identity to row filters', async () => {
  const { adapter, context, ports, snapshotResources } = fixture();
  const filterRow = vi.fn(async () => true);
  mocks.planned.mockResolvedValue([
    {
      ...planned,
      resourceId: 'physical-a',
      sources: [
        { resourceId: 'physical-a', ordinal: 2, firstOrdinal: 1 },
        { resourceId: 'physical-b', ordinal: 5, firstOrdinal: 4 },
      ],
    },
  ]);
  snapshotResources.loadCapture.mockImplementation(async (_lease: unknown, resourceId: string) => ({
    resourceId,
    snapshotId: `snapshot-${resourceId}`,
  }));
  const sharded = createTenantBackupInstalledSqliteExportAdapter({
    requiredDatabases: { roles: ['tenant_core'], fixed: [] },
    registrations: [registration],
    ports: { ...ports, filterRow },
  });
  await sharded.readNext({
    ...context,
    datasetId: 'core.roles',
    cursor: null,
    signal: context.context.signal,
  });
  const input = mocks.read.mock.calls[0]?.[0] as {
    shards: Array<{ resourceId: string; snapshotId: string }>;
    filterShardRow(shard: { resourceId: string }, rowJson: string): Promise<boolean>;
    assertResourceSet(): Promise<void>;
  };
  expect(input.shards).toEqual([
    { resourceId: 'physical-a', firstOrdinal: 1, snapshotId: 'snapshot-physical-a' },
    { resourceId: 'physical-b', firstOrdinal: 4, snapshotId: 'snapshot-physical-b' },
  ]);
  await expect(input.filterShardRow(input.shards[1], '{"id":"row"}')).resolves.toBe(true);
  expect(filterRow).toHaveBeenCalledWith(
    expect.objectContaining({ resourceId: 'physical-b', datasetId: 'core.roles' })
  );
  await expect(input.assertResourceSet()).resolves.toBeUndefined();
  snapshotResources.loadCapture.mockImplementation(async (_lease: unknown, resourceId: string) => ({
    resourceId,
    snapshotId: resourceId === 'physical-b' ? 'replacement' : `snapshot-${resourceId}`,
  }));
  await expect(input.assertResourceSet()).rejects.toThrow('backup_sqlite_export_adapter_coverage');
});

it('enables row transforms only for explicitly installed datasets', async () => {
  const { context, ports } = fixture();
  const transformRow = vi.fn(async ({ rowJson }: { rowJson: string }) => `${rowJson}:portable`);
  const adapter = createTenantBackupInstalledSqliteExportAdapter({
    requiredDatabases: { roles: ['tenant_core'], fixed: [] },
    registrations: [registration],
    ports: { ...ports, transformedDatasetIds: ['core.roles'], transformRow },
  });
  await adapter.readNext({
    ...context,
    datasetId: 'core.roles',
    cursor: null,
    signal: context.context.signal,
  });
  const reader = mocks.read.mock.calls[0]?.[0] as {
    transformRow(rowJson: string): Promise<string>;
  };
  await expect(reader.transformRow('row')).resolves.toBe('row:portable');
  expect(transformRow).toHaveBeenCalledWith(expect.objectContaining({ datasetId: 'core.roles' }));
  expect(() =>
    createTenantBackupInstalledSqliteExportAdapter({
      requiredDatabases: { roles: ['tenant_core'], fixed: [] },
      registrations: [registration],
      ports: { ...ports, transformedDatasetIds: ['unknown'], transformRow },
    })
  ).toThrow('backup_sqlite_export_adapter_transform');
});

it('requires all SQL snapshot receipts to be released before publication', async () => {
  const { adapter, context, ports, snapshotResources } = fixture();
  await adapter.assertPublishable({ ...context, inventoryDigest: 'ab'.repeat(32) });
  expect(snapshotResources.assertReleased).toHaveBeenCalledWith(context.context.lease);
  expect(ports.assertSources).toHaveBeenCalledWith(
    expect.objectContaining({ inventoryDigest: 'ab'.repeat(32) })
  );
  expect(await adapter.releaseAdditionalResources(context)).toEqual({ done: true });
});
