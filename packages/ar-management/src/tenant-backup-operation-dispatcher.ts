import { requireDedicatedAdminDatabaseAdapter, type Env } from '@authrim/ar-lib-core';
import {
  runTenantBackupOperationCleanupStep,
  type TenantBackupOperationCleanupAdapter,
} from '@authrim/ar-lib-core/services/tenant-portability/operation-cleanup';
import type { TenantBackupOperationHandlers } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import { runTenantBackupScheduler } from '@authrim/ar-lib-core/services/tenant-portability/operation-scheduler';
import {
  runTenantBackupExportOperationStep,
  type TenantBackupInstalledExportAdapter,
} from './tenant-backup-export-dispatcher';
import {
  runTenantBackupImportOperationStep,
  type TenantBackupInstalledImportAdapter,
} from './tenant-backup-import-dispatcher';

/**
 * Complete server-installed operation surface. Callers must construct this from deployed code and
 * trusted resource inventories; uploaded bundle metadata cannot select or replace an adapter.
 */
export interface TenantBackupInstalledOperationAdapter {
  export: TenantBackupInstalledExportAdapter;
  import: TenantBackupInstalledImportAdapter;
  cleanup: TenantBackupOperationCleanupAdapter;
}

/** Join the common durable scheduler to kind-specific phase and cancellation dispatchers. */
export function createTenantBackupOperationHandlers(
  env: Env,
  adapter: TenantBackupInstalledOperationAdapter,
  now: () => number = Date.now
): TenantBackupOperationHandlers {
  const database = requireDedicatedAdminDatabaseAdapter(env, 'tenant-backup');
  return {
    run(context) {
      return context.operation.kind === 'export'
        ? runTenantBackupExportOperationStep(env, context, adapter.export, now)
        : runTenantBackupImportOperationStep(env, context, adapter.import, now);
    },
    cleanup(context) {
      return runTenantBackupOperationCleanupStep({
        database,
        context,
        adapter: adapter.cleanup,
        artifactBucket: env.EXPORT_ARTIFACTS,
        now,
      });
    },
  };
}

/** Run one bounded production scheduling tick with an explicitly installed adapter registry. */
export function processTenantBackupOperations(
  env: Env,
  adapter: TenantBackupInstalledOperationAdapter,
  signal: AbortSignal,
  now: () => number = Date.now
) {
  return runTenantBackupScheduler(
    requireDedicatedAdminDatabaseAdapter(env, 'tenant-backup'),
    createTenantBackupOperationHandlers(env, adapter, now),
    signal,
    now
  );
}
