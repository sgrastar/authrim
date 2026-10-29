import {
  derivePluginInstallationId,
  requireDedicatedAdminDatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import type { DatabaseAdapter } from '@authrim/ar-lib-core/db/adapter';
import {
  ICEBERG_LOG_RECORDS_DATASETS,
  createIcebergLogRecordDatasetPolicy,
} from '@authrim/ar-lib-core/services/tenant-portability/portable-iceberg-log';
import { createTenantBackupIcebergLogRestorePorts } from './tenant-backup-iceberg-log-restore-port';
import type { createTenantBackupIcebergLogSnapshotPorts } from './tenant-backup-iceberg-log-snapshot-port';
import { TenantBackupAdminMappingStore } from '@authrim/ar-lib-core/services/tenant-portability/admin-mapping-store';
import type { PlannedInstalledSqliteDataset } from '@authrim/ar-lib-core/services/tenant-portability/installed-sqlite-datasets';
import { PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS } from '@authrim/ar-lib-core/services/tenant-portability/phase8-sqlite-modules';
import { tenantDatasetSelectionRule } from '@authrim/ar-lib-core/services/tenant-portability/selection-contract';
import { createPhase8SqliteInspectionPolicies } from '@authrim/ar-lib-core/services/tenant-portability/phase8-sqlite-references';
import type {
  PortableSqliteRow,
  SqliteDatasetInspectionPolicy,
} from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import {
  normalizePortableTenantKeyRow,
  PORTABLE_TENANT_KEY_SQLITE_DATASETS,
} from '@authrim/ar-lib-core/services/tenant-portability/portable-tenant-key';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import { TenantBackupRestoreHoldStore } from '@authrim/ar-lib-core/services/tenant-portability/restore-hold-store';
import { DatabaseTenantBackupRestorePlanInventory } from '@authrim/ar-lib-core/services/tenant-portability/restore-plan-inventory';
import { openPlannedSqliteRestoreTarget } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-restore-plan';
import { loadPlannedSqliteRestoreSequenceJob } from '@authrim/ar-lib-core/services/tenant-portability/restore-sqlite-sequence';
import type { Phase8ValidatedSqliteRestoreDataset } from '@authrim/ar-lib-core/services/tenant-portability/phase8-restore-targets';
import type { TenantBackupSqliteRestorePlanTarget } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-restore-plan-step';
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
import { tenantBackupRecordSnapshotId } from './tenant-backup-phase5-adapter';
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
import {
  prepareTenantBackupR2Plans,
  type TenantBackupR2PlanTarget,
} from './tenant-backup-r2-plan-builder';
import { createTenantBackupR2ObjectSnapshotPorts } from './tenant-backup-r2-object-snapshot-port';
import { createTenantBackupR2ReferenceSelectionLoader } from './tenant-backup-r2-reference-selection';
import type { TenantBackupInstalledSqliteExportPorts } from './tenant-backup-sqlite-export-adapter';
import {
  ADMIN_ROLES_DATASET,
  createTenantBackupRestoreAuthorityGuard,
} from './tenant-backup-restore-authority';
import { createTenantBackupGuestAuthority } from './tenant-backup-guest-authority';
import type { createProductionGuestRestoreAuthority } from './tenant-backup-guest-authority-production';

export interface Phase8InstalledAdapterPorts extends Omit<
  Phase5InstalledAdapterPorts,
  'recordSnapshots' | 'rowTransform' | 'otherStores' | 'import'
> {
  /** Production provides an authenticated live source; test adapters may install their own port. */
  guestAuthority?: ReturnType<typeof createProductionGuestRestoreAuthority>;
  icebergLogs: ReturnType<typeof createTenantBackupIcebergLogSnapshotPorts>;
  resolveCoreRestoreDatabase(
    context: TenantBackupStepContext,
    planDigest: string
  ): Promise<DatabaseAdapter>;
  /** Admit rows only from the physical database role that owns this logical dataset. */
  allowSqliteSource?(
    context: Parameters<NonNullable<TenantBackupInstalledSqliteExportPorts['filterRow']>>[0]
  ): Promise<boolean>;
  import: Omit<
    Phase5InstalledAdapterPorts['import'],
    'restoreTargets' | 'loadValidatedDataset' | 'assertValidatedUnpublishedPlan' | 'activate'
  > & {
    activate(
      context: TenantBackupStepContext,
      planDigest: string,
      admission?: { deadlineAt: number; assertHeld: () => Promise<void>; scopedEnv: Env }
    ): Promise<void>;
    planRestoreTargets(
      context: TenantBackupStepContext,
      datasets: readonly Phase8ValidatedSqliteRestoreDataset[]
    ): Promise<readonly TenantBackupSqliteRestorePlanTarget[]>;
    /** Additive physical-route guard; bundle and plan validation remain fixed inside this adapter. */
    assertUnpublishedTarget(context: TenantBackupStepContext, planDigest: string): Promise<void>;
  };
  rowTransform: Omit<Phase8SensitiveRowTransformPort, 'transformAdminEnvelope'>;
  otherStores: Omit<
    Phase8OtherStorePorts,
    | 'phase4'
    | 'loadSqlite'
    | 'loadRecord'
    | 'loadPhase8Sqlite'
    | 'loadPhase8Record'
    | 'restoreAdminEnvelope'
    | 'verifyAdminEnvelope'
    | 'importR2Chunk'
    | 'verifyR2Chunk'
    | 'isDatasetSelected'
    | 'importIcebergLog'
    | 'verifyIcebergLog'
  > & {
    phase4: Omit<Phase8OtherStorePorts['phase4'], 'load' | 'loadKeyManager' | 'loadRecord'>;
  };
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
  let planCache:
    | {
        leaseKey: string;
        value: Promise<readonly PlannedInstalledSqliteDataset[]>;
      }
    | undefined;
  const loadInstalledPlan = (context: TenantBackupStepContext) => {
    if (input.planned) return Promise.resolve(input.planned);
    if (!context.lease) return input.loadPlanned(context);
    const leaseKey = JSON.stringify([
      context.lease.tenantId,
      context.lease.operationId,
      context.lease.owner,
      context.lease.fencingToken,
    ]);
    if (planCache) {
      if (planCache.leaseKey !== leaseKey) throw new Error('backup_phase8_plan_loader');
      return planCache.value;
    }
    const loaded = input.loadPlanned(context);
    planCache = { leaseKey, value: loaded };
    return loaded;
  };
  const r2Snapshots = createTenantBackupR2ObjectSnapshotPorts({
    env: input.env,
    assertSource: (context) => input.ports.export.assertSources(context),
  });
  const r2PlanTargets = [
    { dataset: ARTIFACT_OBJECT_BODIES_DATASET, port: r2Snapshots.artifactObjects },
    { dataset: LOG_ARCHIVE_OBJECT_BODIES_DATASET, port: r2Snapshots.logArchiveObjects },
  ];
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
  const restoreAuthority = createTenantBackupRestoreAuthorityGuard({
    database,
    logEnv: input.env,
    now,
    // The bundle's own role definitions, from the validated input under the sealed restore plan.
    loadBundleRoles: async (context) => {
      const datasets = await validatedInput.loadValidatedSqliteDatasets(context);
      if (!datasets.some(({ policy }) => policy.dataset.id === ADMIN_ROLES_DATASET)) return [];
      const head = await new DatabaseTenantBackupRestorePlanInventory(
        database,
        context.lease,
        now
      ).headForLease(context.lease);
      if (head.state !== 'sealed' || !/^[a-f0-9]{64}$/.test(head.chain_digest))
        throw new Error('backup_restore_authority_roles_unavailable');
      const source = await validatedInput.loadValidatedDatasetById(
        context,
        head.chain_digest,
        ADMIN_ROLES_DATASET
      );
      const rows: string[] = [];
      let sourceCursor: string | null = null;
      for (;;) {
        const next = await source.readNextValidatedRow({ sourceCursor });
        if (!next) return rows;
        // Read only for a platform-tenant restore, a global assignment, or a role an existing
        // global grant reaches; well above what the role API lets a tenant hold.
        if (rows.length >= 16384) throw new Error('backup_restore_authority_roles_unavailable');
        rows.push(next.rowJson);
        sourceCursor = next.nextCursor;
      }
    },
  });
  const guestPort = input.ports.guestAuthority;
  const guestAuthority = guestPort
    ? createTenantBackupGuestAuthority({
        source: guestPort.source,
        authorize: guestPort.authorize,
        save: (context, witness) =>
          restoreHolds.writeGuestCurrentDenyWitness({
            witness,
            encryptionKey,
            keyVersion,
            now: now(),
            authorize: () => guestPort.authorize(context),
          }),
        load: (context, planDigest, assertCurrentSource) =>
          restoreHolds.readGuestCurrentDenyWitness({
            tenantId: context.lease.tenantId,
            operationId: context.lease.operationId,
            planDigest,
            encryptionKey,
            keyVersion,
            authorize: () => guestPort.authorize(context),
            assertCurrentSource,
          }),
        apply: async (context, planDigest, markers) => {
          if (!markers.length) return;
          const source = await loadValidatedSqlite(
            context,
            planDigest,
            'restore',
            'pii.guest_pii_erasure_markers'
          );
          await source.target.mergeCurrentGuestDeletedMarkers(markers);
        },
      })
    : undefined;
  const wrapPolicies = (policies: readonly SqliteDatasetInspectionPolicy[]) => {
    const wrapped = restoreAuthority.wrap(policies);
    return guestAuthority ? guestAuthority.wrap(wrapped) : wrapped;
  };
  const policies = input.planned
    ? wrapPolicies(createPhase8SqliteInspectionPolicies(input.planned, policyInput))
    : null;
  let dynamicPolicies: Promise<ReturnType<typeof createPhase8SqliteInspectionPolicies>> | undefined;
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
    loadPolicies: (context) => {
      if (!installed?.import.loadPolicies) throw new Error('backup_phase8_adapter_initializing');
      return installed.import.loadPolicies(context);
    },
    assertSources: (context) => input.ports.import.assertSources(context),
    assertUnpublishedTarget: (context, planDigest) =>
      input.ports.import.assertUnpublishedTarget(context, planDigest),
    now: input.now,
  });
  const restoreTargets = async (context: TenantBackupStepContext) => {
    const datasets = await validatedInput.loadValidatedSqliteDatasets(context);
    const targets = await input.ports.import.planRestoreTargets(context, datasets);
    const expected = [...datasets].map(({ policy }) => policy.dataset.id).sort();
    const actual = targets
      .flatMap((target) => target.datasets.map(({ policy }) => policy.dataset.id))
      .sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error('backup_phase8_restore_target_coverage');
    return targets;
  };
  const loadValidatedRecord = (
    context: TenantBackupStepContext,
    planDigest: string,
    datasetId: string
  ) => validatedInput.loadValidatedDatasetById(context, planDigest, datasetId);
  const loadValidatedSqlite = async (
    context: TenantBackupStepContext,
    planDigest: string,
    purpose: 'restore' | 'verify',
    datasetId: string
  ) => {
    const inventory = new DatabaseTenantBackupRestorePlanInventory(database, context.lease, now);
    const { job } = await loadPlannedSqliteRestoreSequenceJob(
      inventory,
      context.lease,
      planDigest,
      datasetId
    );
    const source = await validatedInput.loadValidatedDatasetById(context, planDigest, datasetId);
    const target = await openPlannedSqliteRestoreTarget({
      context,
      inventory,
      ordinal: job.targetOrdinal,
      targetId: job.targetId,
      now,
      mode: purpose === 'restore' ? 'write' : 'verify',
      resolve: (resourceId, provisioningId) =>
        input.ports.import.resolveRestoreTarget(context, resourceId, provisioningId),
      assertValidatedUnpublishedPlan: (digest) =>
        validatedInput.assertValidatedUnpublishedPlan(context, digest),
    });
    return { ...source, target };
  };
  const icebergRestores = createTenantBackupIcebergLogRestorePorts({
    env: input.env,
    tenantKey: input.ports.tenantKey,
    assertUnpublished: (context, planDigest) =>
      validatedInput.assertValidatedUnpublishedPlan(context, planDigest),
    resolveCore: (context, planDigest) =>
      input.ports.resolveCoreRestoreDatabase(context, planDigest),
  });
  const otherStores: Phase8OtherStorePorts = {
    ...input.ports.otherStores,
    phase4: {
      ...input.ports.otherStores.phase4,
      isDatasetSelected: (context, planDigest, datasetId) =>
        validatedInput.isDatasetSelected(context, planDigest, datasetId),
      load: loadValidatedSqlite,
      loadKeyManager: (context, planDigest) =>
        loadValidatedRecord(context, planDigest, 'credentials.key_manager_tenant_state'),
      loadRecord: (context, planDigest, _purpose, datasetId) =>
        loadValidatedRecord(context, planDigest, datasetId),
    },
    loadSqlite: loadValidatedSqlite,
    loadRecord: (context, planDigest, _purpose, datasetId) =>
      loadValidatedRecord(context, planDigest, datasetId),
    loadPhase8Sqlite: loadValidatedSqlite,
    loadPhase8Record: (context, planDigest, _purpose, datasetId) =>
      loadValidatedRecord(context, planDigest, datasetId),
    isDatasetSelected: (context, planDigest, datasetId) =>
      validatedInput.isDatasetSelected(context, planDigest, datasetId),
    ...r2Objects,
    ...icebergRestores,
    restoreAdminEnvelope: (...args: Parameters<typeof adminEnvelopes.restoreAdminEnvelope>) =>
      adminEnvelopes.restoreAdminEnvelope(...args),
    verifyAdminEnvelope: (...args: Parameters<typeof adminEnvelopes.verifyAdminEnvelope>) =>
      adminEnvelopes.verifyAdminEnvelope(...args),
  };
  const r2Policies = createPortableR2ObjectDatasetPolicies();
  const phase8RowFilter = createPhase8TenantBackupRowFilter({ loadReferences: loadR2References });
  installed = createPhase5TenantBackupInstalledAdapter({
    env: input.env,
    planned: input.planned ?? [],
    now: input.now,
    ports: {
      ...input.ports,
      rowTransform,
      otherStores,
      cleanup: {
        ...input.ports.cleanup,
        async cleanupAdditionalPage(context) {
          if (context.operation.kind === 'import') {
            const result = await icebergRestores.cleanupRestoredLogHolds(context);
            if (!result.complete) return { done: false };
          }
          return input.ports.cleanup.cleanupAdditionalPage(context);
        },
      },
      recordSnapshots: {
        ...input.ports.recordSnapshots,
        validateAdminEnvelope: (datasetId, rowValue) =>
          adminEnvelopes.validateAdminEnvelope(datasetId, rowValue),
      },
      import: {
        ...input.ports.import,
        ...validatedInput,
        restoreTargets,
        prepareActivation: async (context, planDigest) => {
          if (guestAuthority && guestPort && (await guestPort.enabled(context)))
            await guestAuthority.ready(context, planDigest);
          // Users-only DR may carry an approved pending purge without selecting any
          // PII log bodies. Rebuild its discovery scope before publishing the target.
          const datasets = await validatedInput.loadValidatedSqliteDatasets(context);
          if (datasets.some(({ policy }) => policy.dataset.id === 'pii.pii_log_purge_operations')) {
            const head = await new DatabaseTenantBackupRestorePlanInventory(
              database,
              context.lease,
              now
            ).headForLease(context.lease);
            if (head.state !== 'sealed' || head.chain_digest !== planDigest)
              throw new Error('backup_iceberg_restore_fenced');
            await icebergRestores.registerRestoredPiiPurgeScope(context, head.chain_digest);
          }
          await input.ports.import.prepareActivation(context, planDigest);
        },
        async activate(context, planDigest) {
          if (!guestAuthority || !guestPort || !(await guestPort.enabled(context)))
            return input.ports.import.activate(context, planDigest);
          const witness = await guestAuthority.ready(context, planDigest);
          await guestPort.withHeldBoundary(
            context,
            witness,
            async (deadlineAt, assertHeld, scopedEnv) => {
              await guestAuthority.assertCurrent(context, witness);
              await assertHeld();
              await input.ports.import.activate(context, planDigest, {
                deadlineAt,
                assertHeld,
                scopedEnv,
              });
            }
          );
        },
        async verifyActivation(context, planDigest) {
          await input.ports.import.verifyActivation(context, planDigest);
          await icebergRestores.activateRestoredLogHolds(context, planDigest);
        },
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
              dynamicPolicies ??= loadInstalledPlan(context).then((planned) =>
                wrapPolicies(createPhase8SqliteInspectionPolicies(planned, policyInput))
              );
              return dynamicPolicies;
            },
          }),
      requiredDatabases: {
        roles: ['tenant_core', 'tenant_pii'],
        fixed: ['DB_ADMIN'],
      },
      registrations: PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS,
      transformedDatasetIds,
      filterRow: async (rowInput) =>
        (!input.ports.allowSqliteSource || (await input.ports.allowSqliteSource(rowInput))) &&
        (await phase8RowFilter(rowInput)),
      transformRow: transformPortableRow,
      // R2 body plans are listed from the T0 SQL snapshot after the write hold.
      prepareArtifactResources: async (context) => {
        let stage: 'r2' | 'iceberg' = 'r2';
        let cursor: string | null = null;
        if (context.cursor !== null) {
          const parsed: unknown = JSON.parse(context.cursor);
          if (
            !parsed ||
            typeof parsed !== 'object' ||
            !('version' in parsed) ||
            parsed.version !== 1 ||
            !('stage' in parsed) ||
            (parsed.stage !== 'r2' && parsed.stage !== 'iceberg') ||
            !('cursor' in parsed) ||
            (parsed.cursor !== null && typeof parsed.cursor !== 'string') ||
            Object.keys(parsed).length !== 3
          )
            throw new Error('backup_phase8_artifact_cursor_invalid');
          stage = parsed.stage;
          cursor = parsed.cursor;
        }
        if (stage === 'iceberg') {
          const result = await input.ports.icebergLogs.prepareArtifactResources({
            ...context,
            cursor,
          });
          return result.done
            ? { cursor: null, done: true }
            : { cursor: JSON.stringify({ version: 1, stage, cursor: result.cursor }), done: false };
        }
        const targets: TenantBackupR2PlanTarget[] = [];
        for (const { dataset, port } of r2PlanTargets) {
          const rule = tenantDatasetSelectionRule(dataset.kind, context.selection);
          if (rule.action !== 'selected' && rule.action !== 'resolve_references') continue;
          targets.push({
            datasetId: dataset.id as TenantBackupR2PlanTarget['datasetId'],
            port,
            snapshotId: await tenantBackupRecordSnapshotId(context, port.resourceId),
          });
        }
        const result = await prepareTenantBackupR2Plans({
          context,
          planned: await loadInstalledPlan(context.context),
          targets,
          tenantKey: input.ports.tenantKey,
          boundaryUnixMs: context.boundaryUnixMs,
          cursor,
        });
        return {
          cursor: JSON.stringify({
            version: 1,
            stage: result.done ? 'iceberg' : 'r2',
            cursor: result.cursor,
          }),
          done: false,
        };
      },
      otherStores: (() => {
        const handlers = createPhase8OtherStoreHandlers(input.env, otherStores);
        return {
          ...handlers,
          async restoreOtherStores(
            context: TenantBackupStepContext,
            planDigest: string,
            cursor: string | null
          ) {
            if (!guestAuthority || !guestPort || !(await guestPort.enabled(context)))
              return handlers.restoreOtherStores(context, planDigest, cursor);
            if (cursor?.startsWith('{"guestCurrentDeny":')) {
              const value: unknown = JSON.parse(cursor);
              if (
                !value ||
                typeof value !== 'object' ||
                Array.isArray(value) ||
                Object.keys(value).join(',') !== 'guestCurrentDeny' ||
                !(
                  (value as Record<string, unknown>).guestCurrentDeny === null ||
                  typeof (value as Record<string, unknown>).guestCurrentDeny === 'string'
                )
              )
                throw new Error('backup_guest_current_deny_witness_invalid');
              const result = await guestAuthority.page(
                context,
                planDigest,
                (value as { guestCurrentDeny: string | null }).guestCurrentDeny
              );
              return {
                done: result.done,
                cursor: result.done ? null : JSON.stringify({ guestCurrentDeny: result.cursor }),
              };
            }
            const result = await handlers.restoreOtherStores(context, planDigest, cursor);
            return result.done
              ? { done: false, cursor: JSON.stringify({ guestCurrentDeny: null }) }
              : result;
          },
          async verifyOtherStores(
            context: TenantBackupStepContext,
            planDigest: string,
            cursor: string | null
          ) {
            const result = await handlers.verifyOtherStores(context, planDigest, cursor);
            if (result.done && guestAuthority && guestPort && (await guestPort.enabled(context)))
              await guestAuthority.ready(context, planDigest);
            return result;
          },
        };
      })(),
      recordSnapshots: [
        ...ICEBERG_LOG_RECORDS_DATASETS.map((dataset) => ({
          dataset,
          policy: createIcebergLogRecordDatasetPolicy(dataset.id),
          port: input.ports.icebergLogs.records,
        })),
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
