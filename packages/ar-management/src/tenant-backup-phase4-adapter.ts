import type { Env } from '@authrim/ar-lib-core';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import {
  KEY_MANAGER_TENANT_BACKUP_DATASET,
  createKeyManagerTenantBackupInspectionPolicy,
  encodeKeyManagerTenantBackupRow,
} from '@authrim/ar-lib-core/services/tenant-portability/key-manager-dataset';
import type { KeyManagerTenantBackupSnapshot } from '@authrim/ar-lib-core/services/tenant-portability/key-manager-portability';
import { assertPhase4ExternalPrerequisitesResolved } from '@authrim/ar-lib-core/services/tenant-portability/phase4-external-prerequisites';
import { verifyPhase4LogicalReferences } from '@authrim/ar-lib-core/services/tenant-portability/phase4-logical-references';
import type { PlannedInstalledSqliteDataset } from '@authrim/ar-lib-core/services/tenant-portability/installed-sqlite-datasets';
import { PHASE4_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS } from '@authrim/ar-lib-core/services/tenant-portability/phase4-sqlite-modules';
import { createPhase4SqliteInspectionPolicies } from '@authrim/ar-lib-core/services/tenant-portability/phase4-sqlite-references';
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
  createPhase4OtherStoreHandlers,
  type Phase4OtherStorePorts,
} from './tenant-backup-phase4-other-stores';
import {
  createPhase4RecordDatasetPolicies,
  DIRECTORY_CONNECTOR_SECRETS_DATASET,
  SAML_LOCAL_SIGNING_DATASET,
} from './tenant-backup-phase4-record-datasets';
import {
  createPhase4TenantBackupRowTransform,
  PHASE4_TRANSFORMED_SQLITE_DATASETS,
} from './tenant-backup-phase4-row-transform';
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

type Phase4ExportPorts = Omit<
  TenantBackupInstalledSqliteExportPorts,
  'transformedDatasetIds' | 'transformRow'
>;
type Phase4ImportPorts = Omit<
  TenantBackupInstalledSqliteImportPorts,
  'restoreOtherStores' | 'verifyOtherStores'
>;

export interface Phase4KeyManagerSnapshotPorts {
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

export interface Phase4RecordSnapshotPort {
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

export interface Phase4InstalledAdapterPorts {
  export: Phase4ExportPorts;
  import: Phase4ImportPorts;
  otherStores: Phase4OtherStorePorts;
  keyManagerSnapshot: Phase4KeyManagerSnapshotPorts;
  recordSnapshots: {
    validateSamlBundle(bundle: unknown, tenantId: string): Promise<void>;
    saml: Phase4RecordSnapshotPort;
    directorySecrets: Phase4RecordSnapshotPort;
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
  if (head.state !== 'sealed') throw new Error('backup_phase4_key_manager_snapshot');
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

/** Complete Phase 4 adapter: SQL settings plus the tenant KeyManager DO snapshot. */
export function createPhase4TenantBackupInstalledAdapter(input: {
  env: Env;
  planned: readonly PlannedInstalledSqliteDataset[];
  ports: Phase4InstalledAdapterPorts;
  now?: () => number;
}): TenantBackupInstalledOperationAdapter {
  const policies = [
    ...createPhase4SqliteInspectionPolicies(input.planned),
    createKeyManagerTenantBackupInspectionPolicy(),
    ...createPhase4RecordDatasetPolicies({
      validateSamlBundle: input.ports.recordSnapshots.validateSamlBundle,
    }),
  ];
  const sqlExport = createTenantBackupInstalledSqliteExportAdapter({
    requiredDatabases: { roles: ['tenant_core'], fixed: ['DB_ADMIN'] },
    registrations: PHASE4_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS,
    ports: {
      ...input.ports.export,
      transformedDatasetIds: PHASE4_TRANSFORMED_SQLITE_DATASETS,
      transformRow: createPhase4TenantBackupRowTransform(input.env),
    },
  });
  const otherStores = createPhase4OtherStoreHandlers(input.env, input.ports.otherStores);
  const recordSnapshots = [
    { dataset: SAML_LOCAL_SIGNING_DATASET, port: input.ports.recordSnapshots.saml },
    {
      dataset: DIRECTORY_CONNECTOR_SECRETS_DATASET,
      port: input.ports.recordSnapshots.directorySecrets,
    },
  ] as const;
  if (
    new Set(recordSnapshots.map(({ port }) => port.resourceId)).size !== recordSnapshots.length ||
    recordSnapshots.some(({ port }) => !/^[A-Za-z0-9_.:-]{1,128}$/.test(port.resourceId))
  )
    throw new Error('backup_phase4_record_snapshot_ports');
  return {
    export: {
      ...sqlExport,
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
        await input.ports.keyManagerSnapshot.assertSource(context);
        await Promise.all(recordSnapshots.map(({ port }) => port.assertSource(context)));
      },
      async assertBoundaryReady(context) {
        await sqlExport.assertBoundaryReady(context);
        await input.ports.keyManagerSnapshot.assertSource(context);
        await Promise.all(recordSnapshots.map(({ port }) => port.assertSource(context)));
      },
      async additionalParticipants(context) {
        const participants = await sqlExport.additionalParticipants(context);
        if (!keyManagerSelected(context)) return participants;
        const keyManagerId = await snapshotId(context, KEY_MANAGER_RESOURCE_ID);
        const participant: TenantBackupBoundaryStart = {
          resourceId: KEY_MANAGER_RESOURCE_ID,
          snapshotId: keyManagerId,
          start: (assertHeld) =>
            input.ports.keyManagerSnapshot.start(context, keyManagerId, assertHeld),
        };
        const extra: TenantBackupBoundaryStart[] = [participant];
        for (const record of recordSnapshots) {
          const rule = tenantDatasetSelectionRule(record.dataset.kind, context.selection);
          if (rule.action !== 'selected' && rule.action !== 'resolve_references') continue;
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
          throw new Error('backup_phase4_key_manager_coverage');
        if (
          keyManagerParticipants[0] &&
          keyManagerParticipants[0].snapshotId !==
            (await snapshotId(context, KEY_MANAGER_RESOURCE_ID))
        )
          throw new Error('backup_phase4_key_manager_coverage');
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
            throw new Error('backup_phase4_record_snapshot_coverage');
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
        if (context.cursor !== null) throw new Error('backup_phase4_key_manager_cursor');
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
    import: createTenantBackupInstalledSqliteImportAdapter({
      policies,
      ports: {
        ...input.ports.import,
        ...otherStores,
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
          await input.ports.import.prepareActivation(context, planDigest);
        },
      },
    }),
    cleanup: createTenantBackupInstalledCleanupAdapter(input.env, input.ports.cleanup, input.now),
  };
}
