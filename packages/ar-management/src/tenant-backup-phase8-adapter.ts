import {
  derivePluginInstallationId,
  requireDedicatedAdminDatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import type { DatabaseAdapter } from '@authrim/ar-lib-core/db/adapter';
import { TenantBackupAdminMappingStore } from '@authrim/ar-lib-core/services/tenant-portability/admin-mapping-store';
import type { PlannedInstalledSqliteDataset } from '@authrim/ar-lib-core/services/tenant-portability/installed-sqlite-datasets';
import { PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS } from '@authrim/ar-lib-core/services/tenant-portability/phase8-sqlite-modules';
import { createPhase8SqliteInspectionPolicies } from '@authrim/ar-lib-core/services/tenant-portability/phase8-sqlite-references';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import {
  normalizePortableTenantKeyRow,
  PORTABLE_TENANT_KEY_SQLITE_DATASETS,
} from '@authrim/ar-lib-core/services/tenant-portability/portable-tenant-key';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import { TenantBackupRestoreHoldStore } from '@authrim/ar-lib-core/services/tenant-portability/restore-hold-store';
import {
  createUserAvatarDatasetPolicy,
  USER_AVATARS_DATASET,
} from '@authrim/ar-lib-core/services/tenant-portability/phase5-record-datasets';
import {
  ARTIFACT_OBJECT_BODIES_DATASET,
  createPortableR2ObjectDatasetPolicies,
  LOG_ARCHIVE_OBJECT_BODIES_DATASET,
} from '@authrim/ar-lib-core/services/tenant-portability/portable-r2-object';
import {
  createPhase5TenantBackupInstalledAdapter,
  type Phase5InstalledAdapterPorts,
} from './tenant-backup-phase5-adapter';
import type { TenantBackupInstalledOperationAdapter } from './tenant-backup-operation-dispatcher';
import {
  createPhase8TenantBackupRowFilter,
  createPhase8TenantBackupRowTransform,
  PHASE8_TRANSFORMED_SQLITE_DATASETS,
  type Phase8SensitiveRowTransformPort,
} from './tenant-backup-phase8-row-transform';
import {
  createPhase8OtherStoreHandlers,
  type Phase8OtherStorePorts,
} from './tenant-backup-phase8-other-stores';
import { createTenantBackupAdminEnvelopePorts } from './tenant-backup-admin-envelope-port';
import { createTenantBackupValidatedInputPorts } from './tenant-backup-validated-input-port';
import { createTenantBackupR2ObjectRestorePorts } from './tenant-backup-r2-object-restore-port';
import { createTenantBackupR2CatalogFinalizer } from './tenant-backup-r2-catalog-finalizer';
import { createTenantBackupR2CatalogLister } from './tenant-backup-r2-catalog-lister';
import { createTenantBackupR2ObjectSnapshotPorts } from './tenant-backup-r2-object-snapshot-port';
import { createTenantBackupR2ReferenceSelectionLoader } from './tenant-backup-r2-reference-selection';

export interface Phase8InstalledAdapterPorts extends Omit<
  Phase5InstalledAdapterPorts,
  'recordSnapshots' | 'rowTransform' | 'otherStores' | 'import'
> {
  import: Omit<
    Phase5InstalledAdapterPorts['import'],
    'loadValidatedDataset' | 'assertValidatedUnpublishedPlan'
  > & {
    /** Additive physical-route guard; bundle and plan validation remain fixed inside this adapter. */
    assertUnpublishedTarget(context: TenantBackupStepContext, planDigest: string): Promise<void>;
  };
  rowTransform: Omit<Phase8SensitiveRowTransformPort, 'transformAdminEnvelope'>;
  otherStores: Omit<
    Phase8OtherStorePorts,
    'restoreAdminEnvelope' | 'verifyAdminEnvelope' | 'importR2Chunk' | 'verifyR2Chunk'
  >;
  recordSnapshots: Omit<Phase5InstalledAdapterPorts['recordSnapshots'], 'validateAdminEnvelope'> & {
    validatePhase8Envelope(datasetId: string, row: PortableSqliteRow): Promise<void>;
    userAvatars: Phase5InstalledAdapterPorts['recordSnapshots']['publicAssets'];
  };
  resolveAdminR2RestoreDatabase(
    context: TenantBackupStepContext,
    planDigest: string,
    sourceDatabaseId: string
  ): Promise<Pick<DatabaseAdapter, 'query' | 'batch' | 'getType'>>;
  resolveCoreR2RestoreDatabase(
    context: TenantBackupStepContext,
    planDigest: string,
    sourceDatabaseId: string
  ): Promise<Pick<DatabaseAdapter, 'query' | 'batch' | 'getType'>>;
}

function requireR2Policy(
  policies: ReturnType<typeof createPortableR2ObjectDatasetPolicies>,
  datasetId: string
) {
  const policy = policies.find(({ dataset }) => dataset.id === datasetId);
  if (!policy) throw new Error('backup_phase8_r2_policy_missing');
  return policy;
}

/**
 * Full installed SQL adapter for Phase 8. Core and PII follow the sealed tenant routing inventory;
 * Admin remains the fixed management database. Plugin Runner data stays behind its service binding.
 */
export function createPhase8TenantBackupInstalledAdapter(
  input: {
    env: Env;
    ports: Phase8InstalledAdapterPorts;
    now?: () => number;
  } & (
    | {
        planned: readonly PlannedInstalledSqliteDataset[];
        loadPlanned?: never;
      }
    | {
        planned?: never;
        loadPlanned(
          context: TenantBackupStepContext
        ): Promise<readonly PlannedInstalledSqliteDataset[]>;
      }
  )
) {
  if (Boolean(input.planned) === Boolean(input.loadPlanned))
    throw new Error('backup_phase8_plan_loader');
  const database = requireDedicatedAdminDatabaseAdapter(input.env, 'tenant-backup');
  const adminMappings = new TenantBackupAdminMappingStore(database);
  const restoreHolds = new TenantBackupRestoreHoldStore(database);
  const encryptionKey = input.env.PII_ENCRYPTION_KEY;
  if (!encryptionKey) throw new Error('backup_phase8_restore_hold_key_invalid');
  const keyVersionValue = input.env.PII_ENCRYPTION_KEY_VERSION ?? '1';
  if (!/^[1-9][0-9]{0,8}$/.test(keyVersionValue))
    throw new Error('backup_phase8_restore_hold_key_invalid');
  const keyVersion = Number(keyVersionValue);
  const now = input.now ?? Date.now;
  const adminEnvelopes = createTenantBackupAdminEnvelopePorts(input.env);
  const planCache = new WeakMap<
    TenantBackupStepContext,
    Promise<readonly PlannedInstalledSqliteDataset[]>
  >();
  const loadInstalledPlan = (context: TenantBackupStepContext) => {
    if (input.planned) return Promise.resolve(input.planned);
    const cached = planCache.get(context);
    if (cached) return cached;
    const loaded = input.loadPlanned(context);
    planCache.set(context, loaded);
    return loaded;
  };
  const r2Snapshots = createTenantBackupR2ObjectSnapshotPorts({
    env: input.env,
    assertSource: (context) => input.ports.export.assertSources(context),
    list: createTenantBackupR2CatalogLister({ tenantKey: input.ports.tenantKey }),
  });
  const loadR2References = createTenantBackupR2ReferenceSelectionLoader(r2Snapshots);
  const r2Objects = createTenantBackupR2ObjectRestorePorts({
    env: input.env,
    database,
    targetTenantKey: input.ports.tenantKey,
    finalizer: createTenantBackupR2CatalogFinalizer({
      targetTenantKey: input.ports.tenantKey,
      resolveAdmin: (context, planDigest, sourceDatabaseId) =>
        input.ports.resolveAdminR2RestoreDatabase(context, planDigest, sourceDatabaseId),
      resolveCore: (context, planDigest, sourceDatabaseId) =>
        input.ports.resolveCoreR2RestoreDatabase(context, planDigest, sourceDatabaseId),
    }),
    now,
  });
  const rowTransform = {
    ...input.ports.rowTransform,
    transformAdminEnvelope: (datasetId: string, rowJson: string) =>
      adminEnvelopes.transformAdminEnvelope(datasetId, rowJson),
  };
  const transformSensitiveRow = createPhase8TenantBackupRowTransform(input.env, rowTransform);
  const portableTenantKeyIds = new Set<string>(PORTABLE_TENANT_KEY_SQLITE_DATASETS);
  const transformedDatasetIds = [
    ...new Set([...PHASE8_TRANSFORMED_SQLITE_DATASETS, ...PORTABLE_TENANT_KEY_SQLITE_DATASETS]),
  ];
  const transformPortableRow = async (
    value: Parameters<typeof transformSensitiveRow>[0]
  ): Promise<string> => {
    let rowJson = (PHASE8_TRANSFORMED_SQLITE_DATASETS as readonly string[]).includes(
      value.datasetId
    )
      ? await transformSensitiveRow(value)
      : value.rowJson;
    if (portableTenantKeyIds.has(value.datasetId)) {
      const entry = (await loadInstalledPlan(value.context)).find(
        ({ dataset }) => dataset.id === value.datasetId
      );
      if (!entry) throw new Error('backup_phase8_plan_loader');
      const required =
        (!('parent' in entry.capture) && entry.capture.tenantIdentity === 'tenantKey') ||
        entry.dataset.id === 'core.tenants';
      rowJson = normalizePortableTenantKeyRow(
        entry.capture,
        rowJson,
        input.ports.tenantKey,
        required
      );
    }
    return rowJson;
  };
  const otherStores = {
    ...input.ports.otherStores,
    ...r2Objects,
    restoreAdminEnvelope: (...args: Parameters<typeof adminEnvelopes.restoreAdminEnvelope>) =>
      adminEnvelopes.restoreAdminEnvelope(...args),
    verifyAdminEnvelope: (...args: Parameters<typeof adminEnvelopes.verifyAdminEnvelope>) =>
      adminEnvelopes.verifyAdminEnvelope(...args),
  };
  const policyInput: Parameters<typeof createPhase8SqliteInspectionPolicies>[1] = {
    tenantKey: input.ports.tenantKey,
    validateAdminEnvelope: (datasetId, rowValue) =>
      adminEnvelopes.validateAdminEnvelope(datasetId, rowValue),
    validatePhase8Envelope: (datasetId, rowValue) =>
      input.ports.recordSnapshots.validatePhase8Envelope(datasetId, rowValue),
    resolveAdminReference: (context, sourceAdminId) =>
      adminMappings.resolveFrozen(context.lease.tenantId, context.lease.operationId, sourceAdminId),
    resolvePluginReference: async (context, sourceInstallationId, pluginId) => {
      if (
        !/^[A-Za-z0-9_.:-]{1,256}$/.test(sourceInstallationId) ||
        !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(pluginId) ||
        !input.env.AUTHRIM_ENVIRONMENT_NAME
      )
        throw new Error('backup_phase8_plugin_mapping_invalid');
      return derivePluginInstallationId({
        environmentId: input.env.AUTHRIM_ENVIRONMENT_NAME,
        tenantId: context.lease.tenantId,
        pluginId,
        purpose: 'dynamic-plugin',
      });
    },
    restoreHold: {
      write: (context, hold) =>
        restoreHolds.write({
          tenantId: context.lease.tenantId,
          operationId: context.lease.operationId,
          ...hold,
          encryptionKey,
          keyVersion,
          now: now(),
        }),
      verify: (context, hold) =>
        restoreHolds.verify({
          tenantId: context.lease.tenantId,
          operationId: context.lease.operationId,
          ...hold,
          encryptionKey,
          keyVersion,
        }),
    },
  };
  const policies = input.planned
    ? createPhase8SqliteInspectionPolicies(input.planned, policyInput)
    : null;
  const loadPlanned = input.loadPlanned;
  let installed: TenantBackupInstalledOperationAdapter | undefined;
  const validatedInput = createTenantBackupValidatedInputPorts({
    env: input.env,
    datasets: (selection) => {
      if (!installed) throw new Error('backup_phase8_adapter_initializing');
      return installed.import.datasets(selection);
    },
    loadPolicy: (context, datasetId) => {
      if (!installed) throw new Error('backup_phase8_adapter_initializing');
      return installed.import.loadPolicy(context, datasetId);
    },
    assertSources: (context) => input.ports.import.assertSources(context),
    assertUnpublishedTarget: (context, planDigest) =>
      input.ports.import.assertUnpublishedTarget(context, planDigest),
    now: input.now,
  });
  const r2Policies = createPortableR2ObjectDatasetPolicies();
  installed = createPhase5TenantBackupInstalledAdapter({
    env: input.env,
    planned: input.planned ?? [],
    now: input.now,
    ports: {
      ...input.ports,
      rowTransform,
      otherStores,
      recordSnapshots: {
        ...input.ports.recordSnapshots,
        validateAdminEnvelope: (datasetId, rowValue) =>
          adminEnvelopes.validateAdminEnvelope(datasetId, rowValue),
      },
      import: {
        ...input.ports.import,
        ...validatedInput,
        assertRestoreApproval: (context) =>
          adminMappings.assertApproved(context.lease.tenantId, context.lease.operationId),
      },
    },
    sqliteExtension: {
      ...(policies
        ? { policies }
        : {
            loadPolicies: async (context: TenantBackupStepContext) => {
              if (!loadPlanned) throw new Error('backup_phase8_plan_loader');
              return createPhase8SqliteInspectionPolicies(
                await loadInstalledPlan(context),
                policyInput
              );
            },
          }),
      requiredDatabases: {
        roles: ['tenant_core', 'tenant_pii'],
        fixed: ['DB_ADMIN'],
      },
      registrations: PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS,
      transformedDatasetIds,
      filterRow: createPhase8TenantBackupRowFilter({ loadReferences: loadR2References }),
      transformRow: transformPortableRow,
      otherStores: createPhase8OtherStoreHandlers(input.env, otherStores),
      recordSnapshots: [
        {
          dataset: USER_AVATARS_DATASET,
          policy: createUserAvatarDatasetPolicy(),
          port: input.ports.recordSnapshots.userAvatars,
        },
        {
          dataset: ARTIFACT_OBJECT_BODIES_DATASET,
          policy: requireR2Policy(r2Policies, ARTIFACT_OBJECT_BODIES_DATASET.id),
          port: r2Snapshots.artifactObjects,
        },
        {
          dataset: LOG_ARCHIVE_OBJECT_BODIES_DATASET,
          policy: requireR2Policy(r2Policies, LOG_ARCHIVE_OBJECT_BODIES_DATASET.id),
          port: r2Snapshots.logArchiveObjects,
        },
      ],
    },
  });
  return installed;
}
