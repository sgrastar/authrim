import type { Env } from '@authrim/ar-lib-core';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import type { PlannedInstalledSqliteDataset } from '@authrim/ar-lib-core/services/tenant-portability/installed-sqlite-datasets';
import { PHASE3_SQLITE_DATASET_REGISTRATIONS } from '@authrim/ar-lib-core/services/tenant-portability/phase3-sqlite-modules';
import { createPhase3SqliteInspectionPolicies } from '@authrim/ar-lib-core/services/tenant-portability/phase3-sqlite-references';
import { verifyPhase3LogicalReferences } from '@authrim/ar-lib-core/services/tenant-portability/phase3-logical-references';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import {
  createTenantBackupInstalledCleanupAdapter,
  type TenantBackupInstalledCleanupPorts,
} from './tenant-backup-cleanup-adapter';
import type { TenantBackupInstalledOperationAdapter } from './tenant-backup-operation-dispatcher';
import {
  createPhase3OtherStoreHandlers,
  type Phase3OtherStorePorts,
} from './tenant-backup-phase3-other-stores';
import {
  createPhase3TenantBackupRowTransform,
  PHASE3_TRANSFORMED_SQLITE_DATASETS,
} from './tenant-backup-phase3-row-transform';
import {
  createTenantBackupInstalledSqliteExportAdapter,
  type TenantBackupInstalledSqliteExportPorts,
} from './tenant-backup-sqlite-export-adapter';
import {
  createTenantBackupInstalledSqliteImportAdapter,
  type TenantBackupInstalledSqliteImportPorts,
} from './tenant-backup-sqlite-import-adapter';

type Phase3ExportPorts = Omit<
  TenantBackupInstalledSqliteExportPorts,
  'transformedDatasetIds' | 'transformRow'
>;
type Phase3ImportPorts = Omit<
  TenantBackupInstalledSqliteImportPorts,
  'restoreOtherStores' | 'verifyOtherStores'
>;

export interface Phase3InstalledAdapterPorts {
  export: Phase3ExportPorts;
  import: Phase3ImportPorts;
  otherStores: Phase3OtherStorePorts;
  cleanup: TenantBackupInstalledCleanupPorts;
  resolveAdminRestoreDatabase(
    context: TenantBackupStepContext,
    planDigest: string
  ): Promise<Pick<DatabaseAdapter, 'query'>>;
}

/**
 * Assemble the complete Phase 3 registry from installed code. The scheduler can only receive this
 * adapter after all Phase 3 SQL policies, secret handling, semantic checks and cleanup are present.
 */
export function createPhase3TenantBackupInstalledAdapter(input: {
  env: Env;
  planned: readonly PlannedInstalledSqliteDataset[];
  ports: Phase3InstalledAdapterPorts;
  now?: () => number;
}): TenantBackupInstalledOperationAdapter {
  const policies = createPhase3SqliteInspectionPolicies(input.planned);
  const otherStores = createPhase3OtherStoreHandlers(input.env, input.ports.otherStores);
  return {
    export: createTenantBackupInstalledSqliteExportAdapter({
      requiredDatabases: { roles: ['tenant_core'], fixed: ['DB_ADMIN'] },
      registrations: PHASE3_SQLITE_DATASET_REGISTRATIONS,
      ports: {
        ...input.ports.export,
        transformedDatasetIds: PHASE3_TRANSFORMED_SQLITE_DATASETS,
        transformRow: createPhase3TenantBackupRowTransform(input.env),
      },
    }),
    import: createTenantBackupInstalledSqliteImportAdapter({
      policies,
      ports: {
        ...input.ports.import,
        ...otherStores,
        async prepareActivation(context, planDigest) {
          await verifyPhase3LogicalReferences({
            tenantId: context.lease.tenantId,
            admin: await input.ports.resolveAdminRestoreDatabase(context, planDigest),
          });
          await input.ports.import.prepareActivation(context, planDigest);
        },
      },
    }),
    cleanup: createTenantBackupInstalledCleanupAdapter(input.env, input.ports.cleanup, input.now),
  };
}
