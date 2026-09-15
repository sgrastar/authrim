import type { Env } from '@authrim/ar-lib-core';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import type { TenantPortableDataset } from '@authrim/ar-lib-core/services/tenant-portability/module-contract';
import {
  KEY_MANAGER_TENANT_BACKUP_DATASET,
  createKeyManagerTenantBackupInspectionPolicy,
  encodeKeyManagerTenantBackupRow,
} from '@authrim/ar-lib-core/services/tenant-portability/key-manager-dataset';
import type { KeyManagerTenantBackupSnapshot } from '@authrim/ar-lib-core/services/tenant-portability/key-manager-portability';
import { assertPhase4ExternalPrerequisitesResolved } from '@authrim/ar-lib-core/services/tenant-portability/phase4-external-prerequisites';
import { verifyPhase4LogicalReferences } from '@authrim/ar-lib-core/services/tenant-portability/phase4-logical-references';
import { assertPhase5DeliverySafety } from '@authrim/ar-lib-core/services/tenant-portability/phase5-delivery-safety';
import { createTenantBackupRestorePreview } from '@authrim/ar-lib-core/services/tenant-portability/restore-preview';
import { verifyPhase5LogicalReferences } from '@authrim/ar-lib-core/services/tenant-portability/phase5-logical-references';
import type { PlannedInstalledSqliteDataset } from '@authrim/ar-lib-core/services/tenant-portability/installed-sqlite-datasets';
import type { InstalledSqliteDatasetRegistration } from '@authrim/ar-lib-core/services/tenant-portability/installed-sqlite-datasets';
import {
  LOGICAL_PLACEMENT_DATASET,
  PLUGIN_CONFIGURATION_DATASET,
  PUBLIC_ASSETS_DATASET,
  createPhase5RecordDatasetPolicies,
  type PortablePluginConfiguration,
} from '@authrim/ar-lib-core/services/tenant-portability/phase5-record-datasets';
import { PHASE5_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS } from '@authrim/ar-lib-core/services/tenant-portability/phase5-sqlite-modules';
import { createPhase5SqliteInspectionPolicies } from '@authrim/ar-lib-core/services/tenant-portability/phase5-sqlite-references';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import type { SqliteDatasetInspectionPolicy } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import { verifyPhase3LogicalReferences } from '@authrim/ar-lib-core/services/tenant-portability/phase3-logical-references';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import { tenantDatasetSelectionRule } from '@authrim/ar-lib-core/services/tenant-portability/selection-contract';
import type { TenantBackupBoundaryStart } from '@authrim/ar-lib-core/services/tenant-portability/snapshot-boundary';
import {
  createTenantBackupInstalledCleanupAdapter,
  type TenantBackupInstalledCleanupPorts,
} from './tenant-backup-cleanup-adapter';
import type { AdapterContext } from './tenant-backup-export-dispatcher';
import type { TenantBackupInstalledOperationAdapter } from './tenant-backup-operation-dispatcher';
import {
  createPhase4RecordDatasetPolicies,
  DIRECTORY_CONNECTOR_SECRETS_DATASET,
  SAML_LOCAL_SIGNING_DATASET,
} from './tenant-backup-phase4-record-datasets';
import {
  createPhase5OtherStoreHandlers,
  type Phase5OtherStorePorts,
} from './tenant-backup-phase5-other-stores';
import {
  createPhase5TenantBackupRowTransform,
  PHASE5_TRANSFORMED_SQLITE_DATASETS,
  type Phase5SensitiveRowTransformPort,
} from './tenant-backup-phase5-row-transform';
import {
  createTenantBackupInstalledSqliteExportAdapter,
  type TenantBackupInstalledSqliteExportPorts,
} from './tenant-backup-sqlite-export-adapter';
import {
  createTenantBackupInstalledSqliteImportAdapter,
  type TenantBackupInstalledSqliteImportPorts,
} from './tenant-backup-sqlite-import-adapter';

const KEY_MANAGER_RESOURCE_ID = 'key-manager:tenant';
const DONE_CURSOR = JSON.stringify({ version: 1, emitted: true });

type Phase5ExportPorts = Omit<
  TenantBackupInstalledSqliteExportPorts,
  'transformedDatasetIds' | 'transformRow'
>;
type Phase5ImportPorts = Omit<
  TenantBackupInstalledSqliteImportPorts,
  'restoreOtherStores' | 'verifyOtherStores'
>;

export interface Phase5KeyManagerSnapshotPorts {
  assertSource(context: AdapterContext): Promise<void>;
  start(
    context: AdapterContext,
    snapshotId: string,
    assertHeld: () => Promise<void>
  ): Promise<void>;
  load(context: AdapterContext, snapshotId: string): Promise<KeyManagerTenantBackupSnapshot>;
  release(context: AdapterContext, snapshotId: string): Promise<void>;
  assertReleased(context: AdapterContext, snapshotId: string): Promise<void>;
}

export interface Phase5RecordSnapshotPort {
  resourceId: string;
  assertSource(context: AdapterContext): Promise<void>;
  start(
    context: AdapterContext,
    snapshotId: string,
    assertHeld: () => Promise<void>
  ): Promise<void>;
  readNext(
    context: AdapterContext,
    snapshotId: string,
    cursor: string | null,
    signal: AbortSignal
  ): Promise<{ bytes: Uint8Array; nextCursor: string } | null>;
  release(context: AdapterContext, snapshotId: string): Promise<void>;
  assertReleased(context: AdapterContext, snapshotId: string): Promise<void>;
}

export interface Phase5InstalledAdapterPorts {
  export: Phase5ExportPorts;
  import: Phase5ImportPorts;
  otherStores: Phase5OtherStorePorts;
  rowTransform: Phase5SensitiveRowTransformPort;
  tenantKey: string;
  keyManagerSnapshot: Phase5KeyManagerSnapshotPorts;
  recordSnapshots: {
    validateSamlBundle(bundle: unknown, tenantId: string): Promise<void>;
    validateAdminEnvelope(datasetId: string, row: PortableSqliteRow): Promise<void>;
    assertPluginSupported(configuration: PortablePluginConfiguration): Promise<void>;
    saml: Phase5RecordSnapshotPort;
    directorySecrets: Phase5RecordSnapshotPort;
    publicAssets: Phase5RecordSnapshotPort;
    pluginConfiguration: Phase5RecordSnapshotPort;
    logicalPlacement: Phase5RecordSnapshotPort;
  };
  cleanup: TenantBackupInstalledCleanupPorts;
  resolveAdminRestoreDatabase(
    context: TenantBackupStepContext,
    planDigest: string
  ): Promise<Pick<DatabaseAdapter, 'query'>>;
  resolveCoreRestoreDatabase(
    context: TenantBackupStepContext,
    planDigest: string
  ): Promise<Pick<DatabaseAdapter, 'query'>>;
  loadExternalPrerequisites(context: TenantBackupStepContext, planDigest: string): Promise<unknown>;
  loadDeliverySafety(context: TenantBackupStepContext, planDigest: string): Promise<unknown>;
}

interface InstalledSqliteExtension {
  policies?: readonly SqliteDatasetInspectionPolicy[];
  loadPolicies?(
    context: TenantBackupStepContext
  ): Promise<readonly SqliteDatasetInspectionPolicy[]>;
  requiredDatabases: Parameters<
    typeof createTenantBackupInstalledSqliteExportAdapter
  >[0]['requiredDatabases'];
  registrations: readonly InstalledSqliteDatasetRegistration[];
  transformedDatasetIds: readonly string[];
  filterRow?: NonNullable<TenantBackupInstalledSqliteExportPorts['filterRow']>;
  transformRow: NonNullable<TenantBackupInstalledSqliteExportPorts['transformRow']>;
  otherStores?: ReturnType<typeof createPhase5OtherStoreHandlers>;
  recordSnapshots?: readonly {
    dataset: TenantPortableDataset;
    policy: SqliteDatasetInspectionPolicy;
    port: Phase5RecordSnapshotPort;
  }[];
}

async function digest(parts: readonly string[]): Promise<string> {
  const value = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(parts))
  );
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function snapshotId(context: AdapterContext, resourceId: string): Promise<string> {
  const head = await context.inventory.headForLease(context.context.lease);
  if (head.state !== 'sealed') throw new Error('backup_phase5_key_manager_snapshot');
  return digest([
    'authrim-portable-record-snapshot-v1',
    context.context.lease.tenantId,
    context.context.lease.operationId,
    head.chain_digest,
    resourceId,
  ]);
}

function keyManagerSelected(context: AdapterContext): boolean {
  const rule = tenantDatasetSelectionRule(
    KEY_MANAGER_TENANT_BACKUP_DATASET.kind,
    context.selection
  );
  return rule.action === 'selected' || rule.action === 'resolve_references';
}

function selectedRecordSnapshots<T extends { dataset: TenantPortableDataset }>(
  records: readonly T[],
  context: AdapterContext
): T[] {
  return records.filter(({ dataset }) => {
    const rule = tenantDatasetSelectionRule(dataset.kind, context.selection);
    return rule.action === 'selected' || rule.action === 'resolve_references';
  });
}

/** Complete Phase 5 adapter: SQL settings plus the tenant KeyManager DO snapshot. */
export function createPhase5TenantBackupInstalledAdapter(input: {
  env: Env;
  planned: readonly PlannedInstalledSqliteDataset[];
  ports: Phase5InstalledAdapterPorts;
  /** Server-installed Phase 8 extension; never accepted from an upload or API request. */
  sqliteExtension?: InstalledSqliteExtension;
  now?: () => number;
}): TenantBackupInstalledOperationAdapter {
  if (
    input.sqliteExtension &&
    Boolean(input.sqliteExtension.policies) === Boolean(input.sqliteExtension.loadPolicies)
  )
    throw new Error('backup_phase5_sqlite_policy_loader');
  const staticSqlitePolicies = input.sqliteExtension
    ? (input.sqliteExtension.policies ?? null)
    : createPhase5SqliteInspectionPolicies(input.planned, {
        tenantKey: input.ports.tenantKey,
        validateAdminEnvelope: input.ports.recordSnapshots.validateAdminEnvelope,
      });
  const nonSqlitePolicies = [
    createKeyManagerTenantBackupInspectionPolicy(),
    ...createPhase4RecordDatasetPolicies({
      validateSamlBundle: input.ports.recordSnapshots.validateSamlBundle,
    }),
    ...createPhase5RecordDatasetPolicies({
      assertPluginSupported: input.ports.recordSnapshots.assertPluginSupported,
    }),
    ...(input.sqliteExtension?.recordSnapshots ?? []).map(({ policy }) => policy),
  ];
  const policies = staticSqlitePolicies ? [...staticSqlitePolicies, ...nonSqlitePolicies] : null;
  const sqlExport = createTenantBackupInstalledSqliteExportAdapter({
    requiredDatabases: input.sqliteExtension?.requiredDatabases ?? {
      roles: ['tenant_core'],
      fixed: ['DB_ADMIN'],
    },
    registrations:
      input.sqliteExtension?.registrations ?? PHASE5_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS,
    ports: {
      ...input.ports.export,
      transformedDatasetIds:
        input.sqliteExtension?.transformedDatasetIds ?? PHASE5_TRANSFORMED_SQLITE_DATASETS,
      ...(input.sqliteExtension?.filterRow ? { filterRow: input.sqliteExtension.filterRow } : {}),
      transformRow:
        input.sqliteExtension?.transformRow ??
        createPhase5TenantBackupRowTransform(input.env, input.ports.rowTransform),
    },
  });
  const otherStores =
    input.sqliteExtension?.otherStores ??
    createPhase5OtherStoreHandlers(input.env, input.ports.otherStores);
  const recordSnapshots: Array<{
    dataset: TenantPortableDataset;
    port: Phase5RecordSnapshotPort;
  }> = [
    { dataset: SAML_LOCAL_SIGNING_DATASET, port: input.ports.recordSnapshots.saml },
    {
      dataset: DIRECTORY_CONNECTOR_SECRETS_DATASET,
      port: input.ports.recordSnapshots.directorySecrets,
    },
    { dataset: PUBLIC_ASSETS_DATASET, port: input.ports.recordSnapshots.publicAssets },
    {
      dataset: PLUGIN_CONFIGURATION_DATASET,
      port: input.ports.recordSnapshots.pluginConfiguration,
    },
    { dataset: LOGICAL_PLACEMENT_DATASET, port: input.ports.recordSnapshots.logicalPlacement },
    ...(input.sqliteExtension?.recordSnapshots ?? []).map(({ dataset, port }) => ({
      dataset,
      port,
    })),
  ];
  if (
    new Set(recordSnapshots.map(({ dataset }) => dataset.id)).size !== recordSnapshots.length ||
    new Set(recordSnapshots.map(({ port }) => port.resourceId)).size !== recordSnapshots.length ||
    recordSnapshots.some(
      ({ dataset, port }) =>
        !/^[A-Za-z0-9_.:-]{1,128}$/.test(port.resourceId) ||
        !nonSqlitePolicies.some(
          ({ dataset: policyDataset }) =>
            policyDataset.id === dataset.id &&
            JSON.stringify(policyDataset) === JSON.stringify(dataset)
        )
    )
  )
    throw new Error('backup_phase5_record_snapshot_ports');
  return {
    export: {
      ...sqlExport,
      async tenantKey() {
        if (!input.ports.tenantKey || input.ports.tenantKey.length > 256)
          throw new Error('backup_phase5_tenant_key');
        return input.ports.tenantKey;
      },
      datasets(selection) {
        const datasets = [...sqlExport.datasets(selection)];
        const rule = tenantDatasetSelectionRule(KEY_MANAGER_TENANT_BACKUP_DATASET.kind, selection);
        if (rule.action === 'selected' || rule.action === 'resolve_references')
          datasets.push(structuredClone(KEY_MANAGER_TENANT_BACKUP_DATASET));
        for (const record of recordSnapshots) {
          const recordRule = tenantDatasetSelectionRule(record.dataset.kind, selection);
          if (recordRule.action === 'selected' || recordRule.action === 'resolve_references')
            datasets.push(structuredClone(record.dataset));
        }
        return datasets;
      },
      async assertSources(context) {
        await sqlExport.assertSources(context);
        if (keyManagerSelected(context)) await input.ports.keyManagerSnapshot.assertSource(context);
        await Promise.all(
          selectedRecordSnapshots(recordSnapshots, context).map(({ port }) =>
            port.assertSource(context)
          )
        );
      },
      async assertBoundaryReady(context) {
        await sqlExport.assertBoundaryReady(context);
        if (keyManagerSelected(context)) await input.ports.keyManagerSnapshot.assertSource(context);
        await Promise.all(
          selectedRecordSnapshots(recordSnapshots, context).map(({ port }) =>
            port.assertSource(context)
          )
        );
      },
      async additionalParticipants(context) {
        const participants = await sqlExport.additionalParticipants(context);
        const extra: TenantBackupBoundaryStart[] = [];
        if (keyManagerSelected(context)) {
          const keyManagerId = await snapshotId(context, KEY_MANAGER_RESOURCE_ID);
          extra.push({
            resourceId: KEY_MANAGER_RESOURCE_ID,
            snapshotId: keyManagerId,
            start: (assertHeld) =>
              input.ports.keyManagerSnapshot.start(context, keyManagerId, assertHeld),
          });
        }
        for (const record of selectedRecordSnapshots(recordSnapshots, context)) {
          const recordSnapshotId = await snapshotId(context, record.port.resourceId);
          extra.push({
            resourceId: record.port.resourceId,
            snapshotId: recordSnapshotId,
            start: (assertHeld) => record.port.start(context, recordSnapshotId, assertHeld),
          });
        }
        return [...participants, ...extra];
      },
      async assertCoverage(context) {
        const sqlResourceIds = new Set(context.sqliteResources.map(({ resourceId }) => resourceId));
        await sqlExport.assertCoverage({
          ...context,
          participants: context.participants.filter(({ resourceId }) =>
            sqlResourceIds.has(resourceId)
          ),
        });
        const keyManagerParticipants = context.participants.filter(
          ({ resourceId }) => resourceId === KEY_MANAGER_RESOURCE_ID
        );
        if (keyManagerParticipants.length !== (keyManagerSelected(context) ? 1 : 0))
          throw new Error('backup_phase5_key_manager_coverage');
        if (
          keyManagerParticipants[0] &&
          keyManagerParticipants[0].snapshotId !==
            (await snapshotId(context, KEY_MANAGER_RESOURCE_ID))
        )
          throw new Error('backup_phase5_key_manager_coverage');
        for (const record of recordSnapshots) {
          const selected = tenantDatasetSelectionRule(record.dataset.kind, context.selection);
          const matches = context.participants.filter(
            ({ resourceId }) => resourceId === record.port.resourceId
          );
          const required =
            selected.action === 'selected' || selected.action === 'resolve_references';
          if (
            matches.length !== (required ? 1 : 0) ||
            (matches[0] &&
              matches[0].snapshotId !== (await snapshotId(context, record.port.resourceId)))
          )
            throw new Error('backup_phase5_record_snapshot_coverage');
        }
      },
      async readNext(context) {
        const record = recordSnapshots.find(({ dataset }) => dataset.id === context.datasetId);
        if (record)
          return record.port.readNext(
            context,
            await snapshotId(context, record.port.resourceId),
            context.cursor,
            context.signal
          );
        if (context.datasetId !== KEY_MANAGER_TENANT_BACKUP_DATASET.id)
          return sqlExport.readNext(context);
        if (context.cursor === DONE_CURSOR) return null;
        if (context.cursor !== null) throw new Error('backup_phase5_key_manager_cursor');
        context.signal.throwIfAborted();
        const keyManagerId = await snapshotId(context, KEY_MANAGER_RESOURCE_ID);
        const snapshot = await input.ports.keyManagerSnapshot.load(context, keyManagerId);
        context.signal.throwIfAborted();
        return {
          bytes: await encodeKeyManagerTenantBackupRow(context.context.lease.tenantId, snapshot),
          nextCursor: DONE_CURSOR,
        };
      },
      async releaseAdditionalResources(context) {
        const result = await sqlExport.releaseAdditionalResources(context);
        if (!result.done) return result;
        if (keyManagerSelected(context))
          await input.ports.keyManagerSnapshot.release(
            context,
            await snapshotId(context, KEY_MANAGER_RESOURCE_ID)
          );
        for (const record of recordSnapshots) {
          const rule = tenantDatasetSelectionRule(record.dataset.kind, context.selection);
          if (rule.action === 'selected' || rule.action === 'resolve_references')
            await record.port.release(context, await snapshotId(context, record.port.resourceId));
        }
        return { done: true };
      },
      async assertPublishable(context) {
        await sqlExport.assertPublishable(context);
        if (keyManagerSelected(context))
          await input.ports.keyManagerSnapshot.assertReleased(
            context,
            await snapshotId(context, KEY_MANAGER_RESOURCE_ID)
          );
        for (const record of recordSnapshots) {
          const rule = tenantDatasetSelectionRule(record.dataset.kind, context.selection);
          if (rule.action === 'selected' || rule.action === 'resolve_references')
            await record.port.assertReleased(
              context,
              await snapshotId(context, record.port.resourceId)
            );
        }
      },
    },
    import: (() => {
      const ports: TenantBackupInstalledSqliteImportPorts = {
        ...input.ports.import,
        ...otherStores,
        async previewRestore(context, planDigest) {
          const [prerequisites, deliverySafety] = await Promise.all([
            input.ports.loadExternalPrerequisites(context, planDigest),
            input.ports.loadDeliverySafety(context, planDigest),
          ]);
          return createTenantBackupRestorePreview({
            planDigest,
            prerequisites,
            deliverySafety,
          });
        },
        async prepareActivation(context, planDigest) {
          assertPhase4ExternalPrerequisitesResolved(
            await input.ports.loadExternalPrerequisites(context, planDigest)
          );
          const [admin, core] = await Promise.all([
            input.ports.resolveAdminRestoreDatabase(context, planDigest),
            input.ports.resolveCoreRestoreDatabase(context, planDigest),
          ]);
          await verifyPhase3LogicalReferences({
            tenantId: context.lease.tenantId,
            admin,
          });
          await verifyPhase4LogicalReferences({
            tenantId: context.lease.tenantId,
            admin,
            core,
          });
          await verifyPhase5LogicalReferences({
            tenantId: context.lease.tenantId,
            admin,
            core,
          });
          assertPhase5DeliverySafety(await input.ports.loadDeliverySafety(context, planDigest));
          await input.ports.import.prepareActivation(context, planDigest);
        },
      };
      if (policies) return createTenantBackupInstalledSqliteImportAdapter({ policies, ports });
      const datasets = [
        ...(
          input.sqliteExtension?.registrations ?? PHASE5_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS
        ).map(({ dataset }) => dataset),
        ...nonSqlitePolicies.map(({ dataset }) => dataset),
      ];
      return createTenantBackupInstalledSqliteImportAdapter({
        datasets,
        async loadPolicies(context) {
          const sqlitePolicies = await input.sqliteExtension!.loadPolicies!(context);
          return [...sqlitePolicies, ...nonSqlitePolicies];
        },
        ports,
      });
    })(),
    cleanup: createTenantBackupInstalledCleanupAdapter(input.env, input.ports.cleanup, input.now),
  };
}
