import { requireDedicatedAdminDatabaseAdapter, type Env } from '@authrim/ar-lib-core';
import {
  runTenantBackupOperationCleanupStep,
  type TenantBackupOperationCleanupAdapter,
} from '@authrim/ar-lib-core/services/tenant-portability/operation-cleanup';
import type { TenantBackupOperationHandlers } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import type {
  TenantBackupStepResult,
  TenantBackupStepContext,
} from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import { runSamlDrCoveredOperation } from '@authrim/ar-lib-core/services/tenant-portability/saml-dr-writer';
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
  /** Refresh the durable operation revision while retaining one live lease's installed plan. */
  bindContext?(context: Parameters<TenantBackupOperationHandlers['run']>[0]): void;
  /** Installed production coordinator: its actual held tenant fence replaces a writer permit. */
  runExclusiveImportActivation?(
    context: TenantBackupStepContext,
    now: () => number
  ): Promise<TenantBackupStepResult>;
}

export type TenantBackupInstalledOperationAdapterResolver =
  | TenantBackupInstalledOperationAdapter
  | ((
      context: Parameters<TenantBackupOperationHandlers['run']>[0],
      scopedEnv: Env
    ) => Promise<TenantBackupInstalledOperationAdapter>);

function resolveAdapter(
  resolver: TenantBackupInstalledOperationAdapterResolver,
  context: Parameters<TenantBackupOperationHandlers['run']>[0],
  scopedEnv: Env
) {
  return typeof resolver === 'function' ? resolver(context, scopedEnv) : Promise.resolve(resolver);
}

/** Join the common durable scheduler to kind-specific phase and cancellation dispatchers. */
export function createTenantBackupOperationHandlers(
  env: Env,
  adapter: TenantBackupInstalledOperationAdapterResolver,
  now: () => number = Date.now
): TenantBackupOperationHandlers {
  const database = requireDedicatedAdminDatabaseAdapter(env, 'tenant-backup');
  let cached:
    | {
        key: string;
        adapter: Promise<TenantBackupInstalledOperationAdapter>;
        environment: Env;
      }
    | undefined;
  const installedFor = (
    context: Parameters<TenantBackupOperationHandlers['run']>[0],
    scopedEnv: Env
  ) => {
    const key = [
      context.lease.operationId,
      context.lease.tenantId,
      context.lease.owner,
      context.lease.fencingToken,
    ].join(':');
    if (!cached || cached.key !== key || cached.environment !== scopedEnv) {
      cached = {
        key,
        environment: scopedEnv,
        adapter: resolveAdapter(adapter, context, scopedEnv),
      };
      return cached.adapter;
    }
    return cached.adapter.then((installed) => {
      installed.bindContext?.(context);
      return installed;
    });
  };
  return {
    async run(context) {
      if (context.operation.kind === 'export') {
        const installed = await installedFor(context, env);
        return runTenantBackupExportOperationStep(env, context, installed.export, now);
      }
      if (context.operation.phase === 'activate_restore') {
        const installed = await installedFor(context, env);
        if (installed.runExclusiveImportActivation)
          return installed.runExclusiveImportActivation(context, now);
        // A strict production activation must install its control-fence coordinator.
        if (env.ENABLE_SAML_DR_EXPORT === 'true')
          throw new Error('backup_import_activation_coordinator_unavailable');
      }
      return runSamlDrCoveredOperation(env, undefined, async (covered) => {
        const installed = await installedFor(context, covered);
        return runTenantBackupImportOperationStep(covered, context, installed.import, now);
      });
    },
    async cleanup(context) {
      return runSamlDrCoveredOperation(env, undefined, async (covered) => {
        const installed = await installedFor(context, covered);
        return runTenantBackupOperationCleanupStep({
          database,
          context,
          adapter: installed.cleanup,
          artifactBucket: covered.EXPORT_ARTIFACTS,
          now,
        });
      });
    },
  };
}

/** Run one bounded production scheduling tick with an explicitly installed adapter registry. */
export function processTenantBackupOperations(
  env: Env,
  adapter: TenantBackupInstalledOperationAdapterResolver,
  signal: AbortSignal,
  now: () => number = Date.now,
  kinds: readonly ('export' | 'import')[] = ['export', 'import'],
  maxTransitionsPerOperation = 1,
  budgetMs?: number,
  tickTransitions?: number
) {
  return runTenantBackupScheduler(
    requireDedicatedAdminDatabaseAdapter(env, 'tenant-backup'),
    createTenantBackupOperationHandlers(env, adapter, now),
    signal,
    now,
    kinds,
    maxTransitionsPerOperation,
    budgetMs,
    tickTransitions
  );
}
