import {
  plannedInstalledSqliteDatasetSources,
  resolveInstalledSqliteDatasets,
  selectInstalledSqliteDatasets,
  type InstalledSqliteDatasetRegistration,
} from '@authrim/ar-lib-core/services/tenant-portability/installed-sqlite-datasets';
import { readNextShardedSqliteDatasetChunk } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-sharded-dataset-reader';
import type {
  AdapterContext,
  TenantBackupInstalledExportAdapter,
} from './tenant-backup-export-dispatcher';

type RequiredDatabases = TenantBackupInstalledExportAdapter['requiredDatabases'];

export interface TenantBackupInstalledSqliteExportPorts {
  /** Materialize legacy values in bounded, replayable pages before snapshot admission. */
  prepareSources(
    input: AdapterContext & { cursor: string | null }
  ): Promise<{ cursor: string | null; done: boolean }>;
  /** Check installed module versions, secret handling and routing/DDL stability. */
  assertSources(input: AdapterContext): Promise<void>;
  /** Hold the installed source mutation/DDL guard during snapshot admission. */
  assertBoundaryReady(input: AdapterContext): Promise<void>;
  /** Transform environment-encrypted fields before bundle encryption. */
  transformedDatasetIds?: readonly string[];
  filterRow?(
    input: AdapterContext & {
      datasetId: string;
      resourceId: string;
      rowJson: string;
      boundaryUnixMs?: number;
    }
  ): Promise<boolean>;
  transformRow?(
    input: AdapterContext & { datasetId: string; resourceId: string; rowJson: string }
  ): Promise<string>;
}

async function planned(
  input: AdapterContext,
  registrations: readonly InstalledSqliteDatasetRegistration[]
) {
  return resolveInstalledSqliteDatasets({
    inventory: input.inventory,
    lease: input.context.lease,
    registrations,
  });
}

/**
 * Installed SQL-only module adapter. It accepts a plan only when every selected SQL table has an
 * exact registration; a limited module therefore cannot silently export a subset of a full schema.
 */
export function createTenantBackupInstalledSqliteExportAdapter(input: {
  requiredDatabases: RequiredDatabases;
  registrations: readonly InstalledSqliteDatasetRegistration[];
  ports: TenantBackupInstalledSqliteExportPorts;
}): TenantBackupInstalledExportAdapter {
  const registrations = input.registrations.map((registration) => structuredClone(registration));
  const transformedDatasetIds = input.ports.transformedDatasetIds ?? [];
  if (
    new Set(transformedDatasetIds).size !== transformedDatasetIds.length ||
    transformedDatasetIds.some(
      (datasetId) => !registrations.some((registration) => registration.dataset.id === datasetId)
    ) ||
    Boolean(transformedDatasetIds.length) !== (typeof input.ports.transformRow === 'function')
  )
    throw new Error('backup_sqlite_export_adapter_transform');
  return {
    requiredDatabases: {
      roles: [...input.requiredDatabases.roles],
      fixed: [...input.requiredDatabases.fixed],
    },
    datasets: (selection) => selectInstalledSqliteDatasets(registrations, selection),
    prepareSources: (context) => input.ports.prepareSources(context),
    assertSources: (context) => input.ports.assertSources(context),
    assertBoundaryReady: (context) => input.ports.assertBoundaryReady(context),
    async additionalParticipants() {
      return [];
    },
    async assertCoverage(context) {
      const selected = await planned(context, registrations);
      const expectedDatasets = selectInstalledSqliteDatasets(registrations, context.selection)
        .map((dataset) => dataset.id)
        .sort();
      if (
        JSON.stringify(selected.map((entry) => entry.dataset.id).sort()) !==
          JSON.stringify(expectedDatasets) ||
        JSON.stringify(context.participants.map((participant) => participant.resourceId).sort()) !==
          JSON.stringify(context.sqliteResources.map((resource) => resource.resourceId).sort())
      )
        throw new Error('backup_sqlite_export_adapter_coverage');
    },
    async readNext(context) {
      const selected = await planned(context, registrations);
      const dataset = selected.find((entry) => entry.dataset.id === context.datasetId);
      if (!dataset) throw new Error('backup_sqlite_export_adapter_dataset');
      const sources = plannedInstalledSqliteDatasetSources(dataset);
      const shards = await Promise.all(
        sources.map(async (source) => {
          const snapshot = await context.snapshotResources.loadCapture(
            context.context.lease,
            source.resourceId
          );
          return {
            resourceId: source.resourceId,
            firstOrdinal: source.firstOrdinal,
            snapshotId: snapshot.snapshotId,
          };
        })
      );
      const expectedShardIdentity = JSON.stringify(shards);
      return readNextShardedSqliteDatasetChunk(
        {
          context: context.context,
          inventory: context.inventory,
          resources: context.snapshotResources,
          dataset: dataset.dataset,
          table: dataset.table,
          family: dataset.family,
          shards,
          partitions: dataset.partitions,
          selection: context.selection,
          resolveSource: (shard) =>
            context
              .resolveSource({ resourceId: shard.resourceId, family: dataset.family })
              .then((database) => ({ resourceId: shard.resourceId, database })),
          assertResourceSet: async () => {
            const current = (await planned(context, registrations)).find(
              (entry) => entry.dataset.id === context.datasetId
            );
            if (!current) throw new Error('backup_sqlite_export_adapter_dataset');
            const currentShards = await Promise.all(
              plannedInstalledSqliteDatasetSources(current).map(async (source) => ({
                resourceId: source.resourceId,
                firstOrdinal: source.firstOrdinal,
                snapshotId: (
                  await context.snapshotResources.loadCapture(
                    context.context.lease,
                    source.resourceId
                  )
                ).snapshotId,
              }))
            );
            if (JSON.stringify(currentShards) !== expectedShardIdentity)
              throw new Error('backup_sqlite_export_adapter_coverage');
          },
          assertSourceStable: () => input.ports.assertSources(context),
          filterShardRow: input.ports.filterRow
            ? (shard, rowJson) =>
                input.ports.filterRow?.({
                  ...context,
                  datasetId: dataset.dataset.id,
                  resourceId: shard.resourceId,
                  rowJson,
                }) ?? Promise.reject(new Error('backup_sqlite_export_adapter_filter'))
            : undefined,
          transformShardRow:
            transformedDatasetIds.includes(dataset.dataset.id) && input.ports.transformRow
              ? (shard, rowJson) =>
                  input.ports.transformRow?.({
                    ...context,
                    datasetId: dataset.dataset.id,
                    resourceId: shard.resourceId,
                    rowJson,
                  }) ?? Promise.reject(new Error('backup_sqlite_export_adapter_transform'))
              : undefined,
        },
        context.cursor
      );
    },
    async releaseAdditionalResources() {
      return { done: true };
    },
    async assertPublishable(context) {
      const selected = await planned(context, registrations);
      if (
        selected.length !== selectInstalledSqliteDatasets(registrations, context.selection).length
      )
        throw new Error('backup_sqlite_export_adapter_coverage');
      await context.snapshotResources.assertReleased(context.context.lease);
      await input.ports.assertSources(context);
    },
  };
}
