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

export type TenantBackupInstalledOperationAdapterResolver =
  | TenantBackupInstalledOperationAdapter
  | ((
      context: Parameters<TenantBackupOperationHandlers['run']>[0]
    ) => Promise<TenantBackupInstalledOperationAdapter>);

function resolveAdapter(
  resolver: TenantBackupInstalledOperationAdapterResolver,
  context: Parameters<TenantBackupOperationHandlers['run']>[0]
) {
  return typeof resolver === 'function' ? resolver(context) : Promise.resolve(resolver);
}

/** Join the common durable scheduler to kind-specific phase and cancellation dispatchers. */
export function createTenantBackupOperationHandlers(
  env: Env,
  adapter: TenantBackupInstalledOperationAdapterResolver,
  now: () => number = Date.now
): TenantBackupOperationHandlers {
  const database = requireDedicatedAdminDatabaseAdapter(env, 'tenant-backup');
  return {
    async run(context) {
      const installed = await resolveAdapter(adapter, context);
      return context.operation.kind === 'export'
        ? runTenantBackupExportOperationStep(env, context, installed.export, now)
        : runTenantBackupImportOperationStep(env, context, installed.import, now);
    },
    async cleanup(context) {
      const installed = await resolveAdapter(adapter, context);
      return runTenantBackupOperationCleanupStep({
        database,
        context,
        adapter: installed.cleanup,
        artifactBucket: env.EXPORT_ARTIFACTS,
        now,
      });
    },
  };
}

/** Run one bounded production scheduling tick with an explicitly installed adapter registry. */
export function processTenantBackupOperations(
  env: Env,
  adapter: TenantBackupInstalledOperationAdapterResolver,
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
