import { fn, constructionsOf, must, make } from './control-rpc-harness';
import type { ControlEnv } from '../../types';

/** Every collaborator whose `reconcile*`/`handoff*` result the worker wraps in `.catch`. */
const ASYNC_METHODS = [
  'TenantDisasterRecoveryService.reconcileDrain',
  'TenantDisasterRecoveryService.reconcileBindingSmoke',
  'TenantDisasterRecoveryService.handoffBindingSmokeToSetup',
  'SigningKeyCandidateVerifier.reconcile',
  'LookupHmacCandidateVerifier.reconcile',
  'ControlService.reconcilePending',
  'ControlService.replenishLowWatermark',
  'ReleaseMigrationRolloutReconciler.reconcile',
  'WorkerBindingReconciler.reconcile',
  'ServiceSiteBindingReconciler.reconcile',
  'PluginResourceBindingReconciler.reconcile',
  'WorkerInventoryReconciler.reconcile',
  'ReadReplicationService.reconcile',
  'ReadReplicationService.reconcileDrift',
  'BootstrapHandoffVerifier.reconcile',
  'TenantPlacementMigrationReconciler.reconcile',
  'PluginResourceReconciler.reconcile',
  'PluginResourceMigrationReconciler.reconcile',
  'PluginResourceCleanupService.reconcile',
  'ShardCleanupService.reconcile',
  'LookupRegistryPublisher.reconcile',
  'LookupHmacKeyStatePublisher.reconcile',
  'PluginRunnerRegistryPublisher.reconcile',
  'AccountScaleOutForecastService.observe',
  'LookupScaleOutForecastService.reconcileProvisioningOperations',
  'handoffPluginResourceOperationsToSetup',
  'scanControlR2BucketMetrics',
] as const;

export const READY_ENV: Partial<ControlEnv> = {
  AUTHRIM_AUTOMATIC_PROVISIONING: 'true',
  CLOUDFLARE_D1_API_TOKEN: ' d1-token ',
  CLOUDFLARE_WORKERS_API_TOKEN: 'workers-token',
  CLOUDFLARE_KV_API_TOKEN: 'kv-token',
  CLOUDFLARE_R2_API_TOKEN: 'r2-token',
  MIGRATION_RELEASES: { marker: 'bucket' } as unknown as R2Bucket,
};

/** Resets every async collaborator to resolve, and the shard cleanup factory to a recorded instance. */
export function primeScheduledDefaults(): void {
  for (const key of ASYNC_METHODS) fn(key).mockResolvedValue(undefined);
  fn('AccountScaleOutForecastService.observe').mockResolvedValue({
    capacityRequests: [],
    views: [],
  });
  fn('LookupScaleOutForecastService.reconcileProvisioningOperations').mockResolvedValue({
    capacityRequests: [],
  });
  fn('D1ControlRepository.hasReadyAutomaticProvisioning').mockResolvedValue(true);
  fn('D1ControlRepository.resumeAutomaticBootstrapOperations').mockResolvedValue(0);
  fn('cloudflareMigrationExecutor').mockReturnValue('executor');
  fn('ShardCleanupService.fromEnv').mockReturnValue(
    new Proxy({}, { get: (_target, property) => fn(`ShardCleanupService.${String(property)}`) })
  );
  fn('createControlApiClients').mockReturnValue({
    d1: {
      marker: 'd1',
      getD1Database: fn('d1.getD1Database'),
      queryD1Batch: fn('d1.queryD1Batch'),
    },
    workers: {
      marker: 'workers',
      getWorkerSettings: fn('workers.getWorkerSettings'),
      listWorkerDeployments: fn('workers.listWorkerDeployments'),
    },
  });
}

export function runScheduled(
  overrides: Partial<ControlEnv> = {},
  props: Parameters<typeof make>[0] = {}
): { run: () => Promise<void>; env: ControlEnv; waitUntil: ReturnType<typeof make>['waitUntil'] } {
  const { control, env, waitUntil } = make(props, overrides);
  return { run: () => control.scheduled(), env, waitUntil };
}

export function firstConstruction(name: string): { args: readonly unknown[]; instance: unknown } {
  return must(constructionsOf(name)[0]);
}

export function clockOf(value: unknown): number {
  if (typeof value !== 'function') throw new Error('not a clock');
  return (value as () => number)();
}
