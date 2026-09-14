import type { Env } from '@authrim/ar-lib-core';
import type { TenantPortableDataset } from '@authrim/ar-lib-core/services/tenant-portability/module-contract';
import type { TenantBackupSelection } from '@authrim/ar-lib-core/services/tenant-portability/selection-contract';
import type {
  TenantBackupStepContext,
  TenantBackupStepResult,
} from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import type { TenantBackupBoundaryStart } from '@authrim/ar-lib-core/services/tenant-portability/snapshot-boundary';
import { runPreparedSnapshotBoundaryStep } from '@authrim/ar-lib-core/services/tenant-portability/snapshot-boundary-step';
import { TenantBackupSnapshotResources } from '@authrim/ar-lib-core/services/tenant-portability/snapshot-resources';
import { runSqliteResourceDiscoveryStep } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-resource-discovery';
import type { SqliteCaptureResource } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-resource-discovery';
import type { TenantBackupSqliteCaptureInput } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-operation-capture';
import { runSqliteResourcePreparationStep } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-resource-preparation';
import { TenantBackupExecutionInventory } from '@authrim/ar-lib-core/services/tenant-portability/execution-inventory';
import {
  resolveTenantBackupDatabaseInventory,
  tenantBackupDatabaseFamily,
} from './tenant-backup-database-inventory';
import {
  loadTenantBackupExportExecution,
  runTenantBackupArtifactExecution,
  runTenantBackupExportPreparation,
} from './tenant-backup-execution';
import { getTenantBackupBoundaryClient } from './tenant-backup-services';

type RequiredDatabases = Parameters<typeof resolveTenantBackupDatabaseInventory>[2];
type ResolvedDatabases = Awaited<ReturnType<typeof resolveTenantBackupDatabaseInventory>>;
type BoundaryParticipant = Readonly<Pick<TenantBackupBoundaryStart, 'resourceId' | 'snapshotId'>>;

export interface AdapterContext {
  context: TenantBackupStepContext;
  inventory: TenantBackupExecutionInventory;
  snapshotResources: TenantBackupSnapshotResources;
  databases: ResolvedDatabases;
  selection: Awaited<ReturnType<typeof loadTenantBackupExportExecution>>['intent']['selection'];
  resolveSource(resource: {
    resourceId: string;
    family: SqliteCaptureResource['family'];
  }): Promise<TenantBackupSqliteCaptureInput['source']['database']>;
}

/** Server-installed code only. A bundle cannot add datasets, readers, participants or guards. */
export interface TenantBackupInstalledExportAdapter {
  requiredDatabases: RequiredDatabases;
  datasets(selection: TenantBackupSelection): readonly TenantPortableDataset[];
  /** Recheck module versions, non-SQL generations and source availability. */
  assertSources(input: AdapterContext): Promise<void>;
  /** Hold the installed routing/DDL guard while SQL capture definitions are checked or started. */
  assertBoundaryReady(input: AdapterContext): Promise<void>;
  /** Return every selected KV/DO/R2 participant; SQL participants are added by the dispatcher. */
  additionalParticipants(input: AdapterContext): Promise<readonly TenantBackupBoundaryStart[]>;
  /** Compare the final participant set against every selected installed storage dependency. */
  assertCoverage(
    input: AdapterContext & {
      sqliteResources: readonly SqliteCaptureResource[];
      participants: readonly BoundaryParticipant[];
    }
  ): Promise<void>;
  tenantKey?(input: AdapterContext): Promise<string>;
  readNext(
    input: AdapterContext & {
      datasetId: string;
      cursor: string | null;
      signal: AbortSignal;
    }
  ): Promise<{ bytes: Uint8Array; nextCursor: string } | null>;
  /** Release one page of installed non-SQL snapshot state after ciphertext verification. */
  releaseAdditionalResources(input: AdapterContext): Promise<{ done: boolean }>;
  assertPublishable(input: AdapterContext & { inventoryDigest: string }): Promise<void>;
}

function fail(): never {
  throw new Error('backup_export_dispatch_invalid');
}

function validateInstalledAdapter(adapter: TenantBackupInstalledExportAdapter): void {
  let datasets: readonly TenantPortableDataset[] = [];
  if (typeof adapter.datasets === 'function') {
    try {
      datasets = adapter.datasets({
        settings: true,
        users: true,
        admin: true,
        artifacts: true,
        logs: { audit: true, other: true, sensitive: true, period: 'all' },
      });
    } catch {
      return fail();
    }
  }
  if (
    typeof adapter.datasets !== 'function' ||
    !datasets.length ||
    datasets.length > 4096 ||
    new Set(datasets.map((dataset) => dataset.id)).size !== datasets.length ||
    datasets.some(
      (dataset) =>
        !/^[A-Za-z0-9_.:-]{1,256}$/.test(dataset.id) || dataset.disposition === 'unsupported'
    ) ||
    adapter.requiredDatabases.roles.length + adapter.requiredDatabases.fixed.length === 0 ||
    new Set(adapter.requiredDatabases.roles).size !== adapter.requiredDatabases.roles.length ||
    new Set(adapter.requiredDatabases.fixed).size !== adapter.requiredDatabases.fixed.length
  )
    fail();
}

function databaseResourceIds(databases: ResolvedDatabases): string[] {
  return [
    ...databases.tenant.map((resource) => resource.databaseId),
    ...databases.fixed.map((resource) => resource.databaseId),
  ].sort();
}

function verifiedArtifactCursor(value: string | null): string {
  try {
    const cursor = JSON.parse(value ?? 'null') as Record<string, unknown>;
    if (
      !cursor ||
      Array.isArray(cursor) ||
      Object.keys(cursor).sort().join(',') !== 'attemptId,nextPart,verifiedBytes,version' ||
      cursor.version !== 1 ||
      typeof cursor.attemptId !== 'string' ||
      !/^[A-Za-z0-9-]{1,64}$/.test(cursor.attemptId) ||
      !Number.isSafeInteger(cursor.nextPart) ||
      (cursor.nextPart as number) < 1 ||
      !Number.isSafeInteger(cursor.verifiedBytes) ||
      (cursor.verifiedBytes as number) < 1
    )
      fail();
    return JSON.stringify(cursor);
  } catch {
    return fail();
  }
}

/** Dispatch one export phase only; the common scheduler owns the outer lease/checkpoint. */
export async function runTenantBackupExportOperationStep(
  env: Env,
  context: TenantBackupStepContext,
  adapter: TenantBackupInstalledExportAdapter,
  now: () => number = Date.now
): Promise<TenantBackupStepResult> {
  if (context.operation.kind !== 'export' || context.operation.state !== 'running') fail();
  validateInstalledAdapter(adapter);
  const required = {
    roles: [...adapter.requiredDatabases.roles],
    fixed: [...adapter.requiredDatabases.fixed],
  };
  if (context.operation.phase === 'prepare')
    return runTenantBackupExportPreparation(env, context, required, now);
  const loaded = await loadTenantBackupExportExecution(env, context, now);
  const datasets = adapter.datasets(loaded.intent.selection).map((dataset) => ({ ...dataset }));
  if (
    !datasets.length ||
    datasets.length > 4096 ||
    new Set(datasets.map((dataset) => dataset.id)).size !== datasets.length ||
    datasets.some(
      (dataset) =>
        !/^[A-Za-z0-9_.:-]{1,256}$/.test(dataset.id) || dataset.disposition === 'unsupported'
    )
  )
    fail();
  const inventory = new TenantBackupExecutionInventory(loaded.database, context.lease, now);
  const snapshotResources = new TenantBackupSnapshotResources(loaded.database, now);
  const resolveDatabases = () => resolveTenantBackupDatabaseInventory(env, context, required, now);
  const resolveSource = async (resource: {
    resourceId: string;
    family: SqliteCaptureResource['family'];
  }) => {
    const databases = await resolveDatabases();
    const tenant = databases.tenant.find(
      (candidate) => candidate.databaseId === resource.resourceId
    );
    if (tenant) {
      if (tenantBackupDatabaseFamily(tenant) !== resource.family) fail();
      return tenant.database;
    }
    const fixed = databases.fixed.find((candidate) => candidate.databaseId === resource.resourceId);
    if (!fixed || fixed.family !== resource.family) fail();
    return fixed.database;
  };
  const resolveRecordedSource = async (resourceId: string) => {
    const databases = await resolveDatabases();
    const matches = [
      ...databases.tenant
        .filter((candidate) => candidate.databaseId === resourceId)
        .map((candidate) => candidate.database),
      ...databases.fixed
        .filter((candidate) => candidate.databaseId === resourceId)
        .map((candidate) => candidate.database),
    ];
    if (matches.length !== 1) fail();
    return { resourceId, database: matches[0] };
  };
  const adapterContext = async (): Promise<AdapterContext> => ({
    context,
    inventory,
    snapshotResources,
    databases: await resolveDatabases(),
    selection: loaded.intent.selection,
    resolveSource,
  });
  const assertSources = async () => adapter.assertSources(await adapterContext());

  if (context.operation.phase === 'discover_sqlite_resources') {
    await assertSources();
    const result = await runSqliteResourceDiscoveryStep({ context, inventory });
    await assertSources();
    return result;
  }
  if (context.operation.phase === 'prepare_capture_resources') {
    await assertSources();
    const common = await adapterContext();
    const tenantKey = adapter.tenantKey ? await adapter.tenantKey(common) : undefined;
    return runSqliteResourcePreparationStep({
      context,
      inventory,
      resources: snapshotResources,
      selection: loaded.intent.selection,
      tenantKey,
      assertBoundary: async () => adapter.assertBoundaryReady(await adapterContext()),
      resolveSource: async (resource) => ({
        resourceId: resource.resourceId,
        database: await resolveSource(resource),
      }),
    });
  }
  if (context.operation.phase === 'admit_snapshot_boundary') {
    const environmentId = env.AUTHRIM_ENVIRONMENT_NAME;
    if (!environmentId) throw new Error('backup_boundary_rpc_unavailable');
    const head = await inventory.headForLease(context.lease);
    const boundary = getTenantBackupBoundaryClient(env, {
      tenantId: context.lease.tenantId,
      operationId: context.lease.operationId,
      inventoryDigest: head.chain_digest,
    });
    const common = await adapterContext();
    const additionalParticipants = await adapter.additionalParticipants(common);
    const tenantKey = adapter.tenantKey ? await adapter.tenantKey(common) : undefined;
    return runPreparedSnapshotBoundaryStep({
      context,
      inventory,
      environmentId,
      boundaryTenantId: context.lease.tenantId,
      admission: boundary.admission,
      receipts: boundary.receipts,
      resources: snapshotResources,
      selection: loaded.intent.selection,
      tenantKey,
      additionalParticipants,
      resolveSource: async (resource) => ({
        resourceId: resource.resourceId,
        database: await resolveSource(resource),
      }),
      assertReady: async () => adapter.assertBoundaryReady(await adapterContext()),
      assertCoverage: async (sqliteResources, participants) => {
        const current = await adapterContext();
        if (
          JSON.stringify(sqliteResources.map((resource) => resource.resourceId).sort()) !==
          JSON.stringify(databaseResourceIds(current.databases))
        )
          fail();
        await adapter.assertCoverage({
          ...current,
          sqliteResources,
          participants: participants.map(({ resourceId, snapshotId }) => ({
            resourceId,
            snapshotId,
          })),
        });
      },
      now,
    });
  }
  if (context.operation.phase === 'release_export_resources') {
    const cursor = verifiedArtifactCursor(context.operation.cursor_json);
    await assertSources();
    const snapshots = await snapshotResources.cleanupPublishedPage(context, (resourceId) =>
      resolveRecordedSource(resourceId)
    );
    if (!snapshots.done)
      return { phase: 'release_export_resources', cursor, disposition: 'continue' };
    const additional = await adapter.releaseAdditionalResources(await adapterContext());
    await assertSources();
    return additional.done
      ? { phase: 'publish_artifact', cursor, disposition: 'continue' }
      : { phase: 'release_export_resources', cursor, disposition: 'continue' };
  }
  if (
    ['prepare_export_artifact', 'export_artifact', 'verify_artifact', 'publish_artifact'].includes(
      context.operation.phase
    )
  )
    return runTenantBackupArtifactExecution(
      env,
      context,
      {
        datasets,
        requiredDatabases: required,
        assertSources,
        readNext: async (datasetId, cursor, signal) =>
          adapter.readNext({ ...(await adapterContext()), datasetId, cursor, signal }),
        assertPublishable: async (inventoryDigest) =>
          adapter.assertPublishable({ ...(await adapterContext()), inventoryDigest }),
      },
      now
    );
  fail();
}
