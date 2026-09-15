import {
  derivePluginInstallationId,
  requireDedicatedAdminDatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { TenantBackupAdminMappingStore } from '@authrim/ar-lib-core/services/tenant-portability/admin-mapping-store';
import type { PlannedInstalledSqliteDataset } from '@authrim/ar-lib-core/services/tenant-portability/installed-sqlite-datasets';
import { PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS } from '@authrim/ar-lib-core/services/tenant-portability/phase8-sqlite-modules';
import { createPhase8SqliteInspectionPolicies } from '@authrim/ar-lib-core/services/tenant-portability/phase8-sqlite-references';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import { TenantBackupRestoreHoldStore } from '@authrim/ar-lib-core/services/tenant-portability/restore-hold-store';
import {
  createUserAvatarDatasetPolicy,
  USER_AVATARS_DATASET,
} from '@authrim/ar-lib-core/services/tenant-portability/phase5-record-datasets';
import {
  createPhase5TenantBackupInstalledAdapter,
  type Phase5InstalledAdapterPorts,
} from './tenant-backup-phase5-adapter';
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

export interface Phase8InstalledAdapterPorts extends Omit<
  Phase5InstalledAdapterPorts,
  'recordSnapshots' | 'rowTransform' | 'otherStores'
> {
  rowTransform: Phase8SensitiveRowTransformPort;
  otherStores: Phase8OtherStorePorts;
  recordSnapshots: Phase5InstalledAdapterPorts['recordSnapshots'] & {
    validatePhase8Envelope(datasetId: string, row: PortableSqliteRow): Promise<void>;
    userAvatars: Phase5InstalledAdapterPorts['recordSnapshots']['publicAssets'];
  };
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
  const policyInput: Parameters<typeof createPhase8SqliteInspectionPolicies>[1] = {
    tenantKey: input.ports.tenantKey,
    validateAdminEnvelope: input.ports.recordSnapshots.validateAdminEnvelope,
    validatePhase8Envelope: input.ports.recordSnapshots.validatePhase8Envelope,
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
  return createPhase5TenantBackupInstalledAdapter({
    env: input.env,
    planned: input.planned ?? [],
    now: input.now,
    ports: {
      ...input.ports,
      import: {
        ...input.ports.import,
        assertRestoreApproval: (context) =>
          adminMappings.assertApproved(context.lease.tenantId, context.lease.operationId),
      },
    },
    sqliteExtension: {
      ...(policies
        ? { policies }
        : {
            loadPolicies: async (context: TenantBackupStepContext) =>
              createPhase8SqliteInspectionPolicies(await input.loadPlanned!(context), policyInput),
          }),
      requiredDatabases: {
        roles: ['tenant_core', 'tenant_pii'],
        fixed: ['DB_ADMIN'],
      },
      registrations: PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS,
      transformedDatasetIds: PHASE8_TRANSFORMED_SQLITE_DATASETS,
      filterRow: createPhase8TenantBackupRowFilter(),
      transformRow: createPhase8TenantBackupRowTransform(input.env, input.ports.rowTransform),
      otherStores: createPhase8OtherStoreHandlers(input.env, input.ports.otherStores),
      recordSnapshots: [
        {
          dataset: USER_AVATARS_DATASET,
          policy: createUserAvatarDatasetPolicy(),
          port: input.ports.recordSnapshots.userAvatars,
        },
      ],
    },
  });
}
