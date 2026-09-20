import {
  plannedInstalledSqliteDatasetSources,
  resolveInstalledSqliteDatasets,
  selectInstalledSqliteDatasets,
  type InstalledSqliteDatasetRegistration,
} from '@authrim/ar-lib-core/services/tenant-portability/installed-sqlite-datasets';
import { readNextShardedSqliteDatasetChunk } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-sharded-dataset-reader';
import { sqliteCapturePlan } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-capture-plan';
import { sqliteSnapshotExistenceQuery } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-snapshot';
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
  const planCache = new WeakMap<
    AdapterContext['context'],
    ReturnType<typeof resolveInstalledSqliteDatasets>
  >();
  const loadPlanned = (context: AdapterContext) => {
    const cached = planCache.get(context.context);
    if (cached) return cached;
    const resolved = planned(context, registrations);
    planCache.set(context.context, resolved);
    return resolved;
  };
  const captureCache = new WeakMap<
    object,
    Map<string, ReturnType<AdapterContext['snapshotResources']['loadCapture']>>
  >();
  const loadCapture = (context: AdapterContext, resourceId: string) => {
    const session = context.readSession;
    if (!session) return context.snapshotResources.loadCapture(context.context.lease, resourceId);
    let captures = captureCache.get(session);
    if (!captures) {
      captures = new Map();
      captureCache.set(session, captures);
    }
    let capture = captures.get(resourceId);
    if (!capture) {
      capture = context.snapshotResources.loadCapture(context.context.lease, resourceId);
      captures.set(resourceId, capture);
    }
    return capture;
  };
  const sourceCache = new WeakMap<
    object,
    Map<string, ReturnType<AdapterContext['resolveSource']>>
  >();
  const loadSource = (
    context: AdapterContext,
    resource: { resourceId: string; family: InstalledSqliteDatasetRegistration['family'] }
  ) => {
    const session = context.readSession;
    if (!session) return context.resolveSource(resource);
    let sources = sourceCache.get(session);
    if (!sources) {
      sources = new Map();
      sourceCache.set(session, sources);
    }
    let source = sources.get(resource.resourceId);
    if (!source) {
      source = context.resolveSource(resource);
      sources.set(resource.resourceId, source);
    }
    return source;
  };
  const materializedCache = new WeakMap<object, Promise<ReadonlySet<string>>>();
  const loadMaterialized = (
    context: AdapterContext,
    selected: Awaited<ReturnType<typeof planned>>
  ): Promise<ReadonlySet<string>> => {
    const session = context.readSession;
    if (!session) return Promise.resolve(new Set(selected.map(({ dataset }) => dataset.id)));
    const cached = materializedCache.get(session);
    if (cached) return cached;
    const loading = (async () => {
      const groups = new Map<
        string,
        {
          database: Awaited<ReturnType<AdapterContext['resolveSource']>>;
          probes: Array<{ datasetId: string; sql: string; params: unknown[] }>;
        }
      >();
      for (const entry of selected) {
        const schema = sqliteCapturePlan([entry.capture]).schemas.find(
          (candidate) => candidate.table === entry.table
        );
        if (!schema) throw new Error('backup_sqlite_export_adapter_dataset');
        for (const source of plannedInstalledSqliteDatasetSources(entry)) {
          const snapshot = await loadCapture(context, source.resourceId);
          const database = await loadSource(context, {
            resourceId: source.resourceId,
            family: entry.family,
          });
          let group = groups.get(source.resourceId);
          if (!group) {
            group = { database, probes: [] };
            groups.set(source.resourceId, group);
          }
          group.probes.push({
            datasetId: entry.dataset.id,
            sql: sqliteSnapshotExistenceQuery(schema, entry.partitions),
            params: [snapshot.snapshotId, context.context.lease.tenantId],
          });
        }
      }
      const nonEmpty = new Set<string>();
      const pages: Array<{
        database: Awaited<ReturnType<AdapterContext['resolveSource']>>;
        probes: Array<{ datasetId: string; sql: string; params: unknown[] }>;
      }> = [];
      for (const { database, probes } of groups.values()) {
        // Scalar EXISTS expressions avoid D1's compound-SELECT term limit. json_object accepts 32
        // key/value pairs comfortably below SQLite's function-argument limit, reducing the complete
        // registry preflight to roughly ten D1 reads without adding persisted execution steps.
        for (let offset = 0; offset < probes.length; offset += 32)
          pages.push({ database, probes: probes.slice(offset, offset + 32) });
      }
      let nextPage = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, pages.length) }, async () => {
          for (;;) {
            const page = pages[nextPage++];
            if (!page) return;
            const rows = await page.database.query<{ materialized_json: string }>(
              `SELECT json_object(${page.probes
                .map(({ sql }) => `?, EXISTS (${sql})`)
                .join(', ')}) AS materialized_json`,
              page.probes.flatMap(({ datasetId, params }) => [datasetId, ...params])
            );
            if (rows.length !== 1 || typeof rows[0]?.materialized_json !== 'string')
              throw new Error('backup_sqlite_export_adapter_materialization');
            let materialized: Record<string, unknown>;
            try {
              const parsed = JSON.parse(rows[0].materialized_json) as unknown;
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                throw new Error('invalid');
              materialized = parsed as Record<string, unknown>;
            } catch {
              throw new Error('backup_sqlite_export_adapter_materialization');
            }
            if (
              Object.keys(materialized).length !== page.probes.length ||
              page.probes.some(
                ({ datasetId }) => ![0, 1].includes(materialized[datasetId] as number)
              )
            )
              throw new Error('backup_sqlite_export_adapter_materialization');
            for (const { datasetId } of page.probes) {
              if (materialized[datasetId] === 1) nonEmpty.add(datasetId);
              else if (materialized[datasetId] !== 0)
                throw new Error('backup_sqlite_export_adapter_materialization');
            }
          }
        })
      );
      return nonEmpty;
    })();
    materializedCache.set(session, loading);
    return loading;
  };
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
      const selected = await loadPlanned(context);
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
      const selected = await loadPlanned(context);
      const dataset = selected.find((entry) => entry.dataset.id === context.datasetId);
      if (!dataset) throw new Error('backup_sqlite_export_adapter_dataset');
      if (
        context.cursor === null &&
        !(await loadMaterialized(context, selected)).has(context.datasetId)
      )
        return null;
      const sources = plannedInstalledSqliteDatasetSources(dataset);
      const shards = await Promise.all(
        sources.map(async (source) => {
          const snapshot = await loadCapture(context, source.resourceId);
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
          capture: dataset.capture,
          family: dataset.family,
          shards,
          partitions: dataset.partitions,
          selection: context.selection,
          resolveSource: (shard) =>
            loadSource(context, { resourceId: shard.resourceId, family: dataset.family }).then(
              (database) => ({ resourceId: shard.resourceId, database })
            ),
          assertResourceSet: async () => {
            const current = (await loadPlanned(context)).find(
              (entry) => entry.dataset.id === context.datasetId
            );
            if (!current) throw new Error('backup_sqlite_export_adapter_dataset');
            const currentShards = await Promise.all(
              plannedInstalledSqliteDatasetSources(current).map(async (source) => ({
                resourceId: source.resourceId,
                firstOrdinal: source.firstOrdinal,
                snapshotId: (await loadCapture(context, source.resourceId)).snapshotId,
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
      const selected = await loadPlanned(context);
      if (
        selected.length !== selectInstalledSqliteDatasets(registrations, context.selection).length
      )
        throw new Error('backup_sqlite_export_adapter_coverage');
      await context.snapshotResources.assertReleased(context.context.lease);
      await input.ports.assertSources(context);
    },
  };
}
