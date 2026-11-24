import { describe, expect, it, vi } from 'vitest';
import type { ControlEnv } from '../types';
import { constructionsOf, fn, must } from './support/control-rpc-harness';
import { useWiringEnvironment } from './support/rpc-wiring-suite';
import {
  READY_ENV,
  clockOf,
  firstConstruction,
  primeScheduledDefaults,
  runScheduled,
} from './support/scheduled-harness';

const mod = vi.hoisted(
  () => (names: Record<string, string[]>) => async (original: () => Promise<object>) =>
    (await import('./support/control-rpc-recorder')).partial(await original(), names)
);
const fnMod = vi.hoisted(
  () =>
    (names: string[], keep = true) =>
    async (original: () => Promise<object>) => {
      const { fn: recorded } = await import('./support/control-rpc-recorder');
      const replaced: Record<string, unknown> = keep ? { ...(await original()) } : {};
      for (const name of names) replaced[name] = (...args: unknown[]) => recorded(name)(...args);
      return replaced;
    }
);
vi.mock('../service', mod({ ControlService: [] }));
vi.mock('../repository', mod({ D1ControlRepository: [] }));
vi.mock('../tenant-disaster-recovery', mod({ TenantDisasterRecoveryService: [] }));
vi.mock(
  '../signing-key-candidate-verifier',
  mod({ SigningKeyCandidateVerifier: [], D1SigningKeyVerificationRepository: [] })
);
vi.mock(
  '../lookup-hmac-candidate-verifier',
  mod({ LookupHmacCandidateVerifier: [], D1LookupHmacCandidateVerificationRepository: [] })
);
vi.mock('../release-migration-rollout-reconciler', mod({ ReleaseMigrationRolloutReconciler: [] }));
vi.mock('../worker-binding-reconciler', mod({ WorkerBindingReconciler: [] }));
vi.mock('../worker-binding-repository', mod({ D1WorkerBindingRepository: [] }));
vi.mock('../service-site-binding-reconciler', mod({ ServiceSiteBindingReconciler: [] }));
vi.mock('../service-site-binding-repository', mod({ D1ServiceSiteBindingRepository: [] }));
vi.mock('../plugin-resource-binding-reconciler', mod({ PluginResourceBindingReconciler: [] }));
vi.mock('../worker-inventory-reconciler', mod({ WorkerInventoryReconciler: [] }));
vi.mock('../read-replication', mod({ ReadReplicationService: [] }));
vi.mock(
  '../bootstrap-handoff',
  mod({ BootstrapHandoffVerifier: [], D1BootstrapHandoffRepository: [] })
);
vi.mock(
  '../tenant-placement-migration-reconciler',
  mod({ TenantPlacementMigrationReconciler: [] })
);
vi.mock('../plugin-resource-reconciler', mod({ PluginResourceReconciler: [] }));
vi.mock('../plugin-resource-migration-reconciler', mod({ PluginResourceMigrationReconciler: [] }));
vi.mock('../plugin-resource-cleanup', mod({ PluginResourceCleanupService: [] }));
vi.mock('../shard-cleanup', mod({ ShardCleanupService: ['fromEnv'] }));
vi.mock('../shard-cleanup-repository', mod({ D1ShardCleanupRepository: [] }));
vi.mock('../lookup-registry-publisher', mod({ LookupRegistryPublisher: [] }));
vi.mock('../lookup-hmac-key-state-publisher', mod({ LookupHmacKeyStatePublisher: [] }));
vi.mock('../plugin-runner-registry-publisher', mod({ PluginRunnerRegistryPublisher: [] }));
vi.mock('../account-scale-out-forecast', mod({ AccountScaleOutForecastService: [] }));
vi.mock('../lookup-scale-out-forecast', mod({ LookupScaleOutForecastService: [] }));
vi.mock('../service-binding-invocation-budget', mod({ BoundedServiceBindingInvocationBudget: [] }));
vi.mock('../r2-bucket-metrics', fnMod(['scanControlR2BucketMetrics']));
vi.mock(
  '../plugin-resource-operator-handoff',
  fnMod(['handoffPluginResourceOperationsToSetup'], false)
);
vi.mock('../control-api-clients', fnMod(['createControlApiClients'], false));
vi.mock('@authrim/ar-lib-core/control-plane', async (original) => {
  const { fn: recorded, partial } = await import('./support/control-rpc-recorder');
  return {
    ...partial(await original(), {
      ApiMigrationEngine: [],
      MigrationReleaseArtifactReader: [],
      R2ReleaseArtifactStore: [],
    }),
    cloudflareMigrationExecutor: (...args: unknown[]) =>
      recorded('cloudflareMigrationExecutor')(...args),
  };
});

useWiringEnvironment();
const prime = (): void => primeScheduledDefaults();

describe('scheduled: failure reporting', () => {
  it('runs without error when every task succeeds', async () => {
    prime();
    await expect(runScheduled(READY_ENV).run()).resolves.toBeUndefined();
  });

  it('reports every failing task by name, sorted and de-duplicated', async () => {
    prime();
    fn('ControlService.reconcilePending').mockRejectedValue(new Error('boom'));
    fn('ShardCleanupService.reconcile').mockRejectedValue('not an error');
    fn('SigningKeyCandidateVerifier.reconcile').mockRejectedValue(
      new Error('control_scheduled_x_failed')
    );
    await expect(runScheduled(READY_ENV).run()).rejects.toThrow(
      /^control_scheduled_reconciliation_failed:control_scheduled_pending_operation_handoff_failed,control_scheduled_shard_cleanup_failed,control_scheduled_signing_key_candidate_verification_failed$/u
    );
  });

  it('hides provider error text behind the stable task code', async () => {
    prime();
    fn('scanControlR2BucketMetrics').mockRejectedValue(new Error('SECRET connection string'));
    const error = await runScheduled(READY_ENV)
      .run()
      .catch((reason: Error) => reason);
    expect((error as Error).message).toBe(
      'control_scheduled_reconciliation_failed:control_scheduled_r2_bucket_metrics_scan_failed'
    );
  });

  it.each([
    ['tenant_disaster_recovery_drain', 'TenantDisasterRecoveryService.reconcileDrain'],
    ['lookup_hmac_candidate_verification', 'LookupHmacCandidateVerifier.reconcile'],
    ['release_migration_rollout', 'ReleaseMigrationRolloutReconciler.reconcile'],
    ['worker_binding_reconciliation', 'WorkerBindingReconciler.reconcile'],
    ['service_site_binding_reconciliation', 'ServiceSiteBindingReconciler.reconcile'],
    ['plugin_binding_reconciliation', 'PluginResourceBindingReconciler.reconcile'],
    ['low_watermark_replenishment', 'ControlService.replenishLowWatermark'],
    ['worker_inventory_reconciliation', 'WorkerInventoryReconciler.reconcile'],
    ['read_replication_reconciliation', 'ReadReplicationService.reconcile'],
    ['read_replication_drift', 'ReadReplicationService.reconcileDrift'],
    ['bootstrap_handoff_verification', 'BootstrapHandoffVerifier.reconcile'],
    ['tenant_placement_migration', 'TenantPlacementMigrationReconciler.reconcile'],
    ['plugin_resource_reconciliation', 'PluginResourceReconciler.reconcile'],
    ['plugin_resource_migration', 'PluginResourceMigrationReconciler.reconcile'],
    ['plugin_resource_cleanup', 'PluginResourceCleanupService.reconcile'],
    ['account_scale_out_forecast_reconciliation', 'AccountScaleOutForecastService.observe'],
    [
      'lookup_scale_out_forecast_reconciliation',
      'LookupScaleOutForecastService.reconcileProvisioningOperations',
    ],
  ])('names %s when %s fails', async (name, key) => {
    prime();
    fn(key).mockRejectedValue(new Error('x'));
    await expect(
      runScheduled({ ...READY_ENV, TENANT_RUNTIME_REGISTRY: {} as never }).run()
    ).rejects.toThrow(
      new RegExp(`^control_scheduled_reconciliation_failed:control_scheduled_${name}_failed$`, 'u')
    );
  });

  it.each([
    ['lookup_registry_publication', 'LookupRegistryPublisher.reconcile'],
    ['lookup_hmac_key_state_publication', 'LookupHmacKeyStatePublisher.reconcile'],
    ['plugin_runner_registry_publication', 'PluginRunnerRegistryPublisher.reconcile'],
  ])('names %s when its publisher fails', async (name, key) => {
    prime();
    fn(key).mockRejectedValue(new Error('x'));
    await expect(
      runScheduled({ ...READY_ENV, TENANT_RUNTIME_REGISTRY: {} as never }).run()
    ).rejects.toThrow(
      new RegExp(`^control_scheduled_reconciliation_failed:control_scheduled_${name}_failed$`, 'u')
    );
  });

  it('names the binding smoke follow-up as part of worker binding reconciliation', async () => {
    prime();
    fn('TenantDisasterRecoveryService.reconcileBindingSmoke').mockRejectedValue(new Error('x'));
    await expect(runScheduled(READY_ENV).run()).rejects.toThrow(
      /:control_scheduled_worker_binding_reconciliation_failed$/u
    );
  });

  it('reports the handoff tasks of the unavailable path by name', async () => {
    prime();
    fn('handoffPluginResourceOperationsToSetup').mockRejectedValue(new Error('x'));
    fn('TenantDisasterRecoveryService.handoffBindingSmokeToSetup').mockRejectedValue(
      new Error('x')
    );
    await expect(runScheduled({}).run()).rejects.toThrow(
      /^control_scheduled_reconciliation_failed:control_scheduled_plugin_resource_operator_handoff_failed,control_scheduled_tenant_disaster_recovery_binding_handoff_failed$/u
    );
  });
});

describe('scheduled: mode selection', () => {
  const automaticTasks = [
    'WorkerInventoryReconciler.reconcile',
    'ReadReplicationService.reconcile',
    'ReadReplicationService.reconcileDrift',
    'BootstrapHandoffVerifier.reconcile',
    'TenantPlacementMigrationReconciler.reconcile',
    'PluginResourceReconciler.reconcile',
    'PluginResourceMigrationReconciler.reconcile',
    'PluginResourceCleanupService.reconcile',
    'ShardCleanupService.reconcile',
    'ControlService.replenishLowWatermark',
    'LookupScaleOutForecastService.reconcileProvisioningOperations',
    'AccountScaleOutForecastService.observe',
  ];
  const alwaysTasks = [
    'SigningKeyCandidateVerifier.reconcile',
    'LookupHmacCandidateVerifier.reconcile',
    'TenantDisasterRecoveryService.reconcileDrain',
    'ControlService.reconcilePending',
    'ReleaseMigrationRolloutReconciler.reconcile',
    'WorkerBindingReconciler.reconcile',
    'TenantDisasterRecoveryService.reconcileBindingSmoke',
    'ServiceSiteBindingReconciler.reconcile',
    'PluginResourceBindingReconciler.reconcile',
    'scanControlR2BucketMetrics',
  ];

  it('runs the always-on tasks and the automatic tasks when provisioning is ready', async () => {
    prime();
    await runScheduled(READY_ENV).run();
    for (const key of [...alwaysTasks, ...automaticTasks])
      expect(fn(key), key).toHaveBeenCalledTimes(1);
    expect(fn('handoffPluginResourceOperationsToSetup')).not.toHaveBeenCalled();
    expect(fn('TenantDisasterRecoveryService.handoffBindingSmokeToSetup')).not.toHaveBeenCalled();
  });

  it.each([
    ['automatic provisioning off', { ...READY_ENV, AUTHRIM_AUTOMATIC_PROVISIONING: 'false' }, true],
    ['missing d1 token', { ...READY_ENV, CLOUDFLARE_D1_API_TOKEN: undefined }, true],
    ['blank d1 token', { ...READY_ENV, CLOUDFLARE_D1_API_TOKEN: '  ' }, true],
    ['missing workers token', { ...READY_ENV, CLOUDFLARE_WORKERS_API_TOKEN: undefined }, true],
    ['blank workers token', { ...READY_ENV, CLOUDFLARE_WORKERS_API_TOKEN: ' ' }, true],
    ['identical tokens', { ...READY_ENV, CLOUDFLARE_WORKERS_API_TOKEN: 'd1-token' }, true],
    ['no ready provisioning', READY_ENV, false],
  ])('falls back to operator handoff with %s', async (_name, env, hasReady) => {
    prime();
    fn('D1ControlRepository.hasReadyAutomaticProvisioning').mockResolvedValue(hasReady);
    await runScheduled(env as Partial<ControlEnv>).run();
    for (const key of automaticTasks.filter(
      (key) => key !== 'ControlService.replenishLowWatermark'
    )) {
      expect(fn(key), key).not.toHaveBeenCalled();
    }
    expect(fn('ControlService.replenishLowWatermark')).not.toHaveBeenCalled();
    expect(fn('handoffPluginResourceOperationsToSetup')).toHaveBeenCalledTimes(1);
    expect(fn('handoffPluginResourceOperationsToSetup').mock.calls[0]).toEqual([
      must(constructionsOf('D1ControlRepository')[0]).args[0],
      1_700_000_000,
    ]);
    expect(fn('TenantDisasterRecoveryService.handoffBindingSmokeToSetup')).toHaveBeenCalledTimes(1);
    expect(fn('ControlService.reconcilePending')).toHaveBeenCalledTimes(1);
  });

  it('does not even ask for ready provisioning when credentials are unusable', async () => {
    prime();
    await runScheduled({ ...READY_ENV, CLOUDFLARE_D1_API_TOKEN: undefined }).run();
    expect(fn('D1ControlRepository.hasReadyAutomaticProvisioning')).not.toHaveBeenCalled();
    expect(fn('D1ControlRepository.resumeAutomaticBootstrapOperations')).not.toHaveBeenCalled();
  });

  it('propagates a failure from the readiness probe instead of swallowing it', async () => {
    prime();
    fn('D1ControlRepository.hasReadyAutomaticProvisioning').mockRejectedValue(new Error('db down'));
    await expect(runScheduled(READY_ENV).run()).rejects.toThrow(/^db down$/u);
  });

  it('publishes the runtime registries only when the registry binding exists', async () => {
    prime();
    await runScheduled(READY_ENV).run();
    expect(fn('LookupRegistryPublisher.reconcile')).not.toHaveBeenCalled();
    const { env, run } = runScheduled({ ...READY_ENV, TENANT_RUNTIME_REGISTRY: {} as never });
    await run();
    for (const cls of [
      'LookupRegistryPublisher',
      'LookupHmacKeyStatePublisher',
      'PluginRunnerRegistryPublisher',
    ]) {
      expect(fn(`${cls}.reconcile`), cls).toHaveBeenCalledTimes(1);
      expect(firstConstruction(cls).args[0]).toBe(env);
      expect(clockOf(firstConstruction(cls).args[1])).toBe(1_700_000_000);
    }
  });
});
