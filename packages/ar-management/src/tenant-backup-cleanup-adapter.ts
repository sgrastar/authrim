import { requireDedicatedAdminDatabaseAdapter, type Env } from '@authrim/ar-lib-core';
import type { TenantBackupOperationCleanupAdapter } from '@authrim/ar-lib-core/services/tenant-portability/operation-cleanup';
import {
  cleanupTenantBackupRestoreTargetPage,
  type TenantBackupRestoreCleanupTarget,
} from '@authrim/ar-lib-core/services/tenant-portability/restore-target-cleanup';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import { abortTenantBackupBoundary } from './tenant-backup-services';

type SnapshotResolver = TenantBackupOperationCleanupAdapter['resolveSnapshotSource'];

/** Product-specific cleanup ports; every callback is compiled into the deployed Worker. */
export interface TenantBackupInstalledCleanupPorts {
  resolveSnapshotSource: SnapshotResolver;
  /** Import only: settle the restore target discard before anything is removed. */
  prepareImportCleanup?(context: TenantBackupStepContext): Promise<{ done: boolean }>;
  /** Clean one page of one restore target; `done` only once nothing of the import remains there. */
  cleanupRestoreTarget(
    context: TenantBackupStepContext,
    target: Readonly<TenantBackupRestoreCleanupTarget>
  ): Promise<{ done: boolean }>;
  cleanupAdditionalPage(context: TenantBackupStepContext): Promise<{ done: boolean }>;
  assertClean(context: TenantBackupStepContext): Promise<void>;
}

/** Bind common Control/Admin cleanup to provider-aware installed resource cleanup. */
export function createTenantBackupInstalledCleanupAdapter(
  env: Env,
  ports: TenantBackupInstalledCleanupPorts,
  now: () => number = Date.now
): TenantBackupOperationCleanupAdapter {
  const database = requireDedicatedAdminDatabaseAdapter(env, 'tenant-backup');
  return {
    abortBoundary: (context) => abortTenantBackupBoundary(env, context, now),
    ...(ports.prepareImportCleanup
      ? { prepareImportCleanup: (context) => ports.prepareImportCleanup!(context) }
      : {}),
    resolveSnapshotSource: (resourceId, signal) => ports.resolveSnapshotSource(resourceId, signal),
    cleanupStagingPage: (context) =>
      cleanupTenantBackupRestoreTargetPage({
        database,
        context,
        cleanup: (target) => ports.cleanupRestoreTarget(context, target),
        now,
      }),
    cleanupAdditionalPage: (context) => ports.cleanupAdditionalPage(context),
    assertClean: (context) => ports.assertClean(context),
  };
}
