import { describe, expect, it, vi } from 'vitest';
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
const D1 = 'd1';
const WORKERS = 'workers';
const api = (key: 'd1' | 'workers') => ({ marker: key });

async function ready(overrides: Record<string, unknown> = {}) {
  prime();
  const scenario = runScheduled({ ...READY_ENV, ...overrides });
  await scenario.run();
  const repository = firstConstruction('D1ControlRepository');
  return { ...scenario, repository, db: scenario.env.CONTROL_DB };
}

describe('scheduled: collaborator construction (ready)', () => {
  it('wires the verifiers with repositories, env, clock and one shared invocation budget', async () => {
    const { env, db } = await ready();
    const budget = firstConstruction('BoundedServiceBindingInvocationBudget').instance;
    expect(constructionsOf('BoundedServiceBindingInvocationBudget')).toHaveLength(1);
    const signing = firstConstruction('SigningKeyCandidateVerifier');
    expect(signing.args[0]).toBe(firstConstruction('D1SigningKeyVerificationRepository').instance);
    expect(signing.args[1]).toBe(env);
    expect(clockOf(signing.args[2])).toBe(1_700_000_000);
    expect(signing.args[3]).toBe(budget);
    expect(firstConstruction('D1SigningKeyVerificationRepository').args).toEqual([db]);
    const hmac = firstConstruction('LookupHmacCandidateVerifier');
    expect(hmac.args[0]).toBe(
      firstConstruction('D1LookupHmacCandidateVerificationRepository').instance
    );
    expect(hmac.args[1]).toBe(env);
    expect(clockOf(hmac.args[2])).toBe(1_700_000_000);
    expect(hmac.args[3]).toBe(budget);
    expect(firstConstruction('D1LookupHmacCandidateVerificationRepository').args).toEqual([db]);
    expect(fn('scanControlR2BucketMetrics')).toHaveBeenCalledExactlyOnceWith(env);
    for (const construction of constructionsOf('TenantDisasterRecoveryService')) {
      expect(construction.args).toEqual([db]);
    }
    expect(constructionsOf('TenantDisasterRecoveryService')).toHaveLength(2);
  });

  it('builds the control service from the repository, env and clock', async () => {
    const { env, repository, db } = await ready();
    expect(repository.args).toEqual([db]);
    const [options] = firstConstruction('ControlService').args as [
      { repository: unknown; env: unknown; now: () => number },
    ];
    expect(options.repository).toBe(repository.instance);
    expect(options.env).toBe(env);
    expect(options.now()).toBe(1_700_000_000);
  });

  it('wires the reconcilers with the right clients, flags and budget', async () => {
    const { env, repository, db } = await ready();
    const budget = firstConstruction('BoundedServiceBindingInvocationBudget').instance;
    const worker = firstConstruction('WorkerBindingReconciler').args;
    expect(worker[0]).toBe(firstConstruction('D1WorkerBindingRepository').instance);
    expect(firstConstruction('D1WorkerBindingRepository').args).toEqual([db]);
    expect(worker[1]).toBe(repository.instance);
    expect(worker[2]).toMatchObject(api(WORKERS));
    expect(worker[3]).toBe(env);
    expect(clockOf(worker[4])).toBe(1_700_000_000);
    expect(worker[5]).toBe(true);
    expect(worker[6]).toBe(budget);

    const site = firstConstruction('ServiceSiteBindingReconciler').args;
    expect(site[0]).toBe(firstConstruction('D1ServiceSiteBindingRepository').instance);
    expect(firstConstruction('D1ServiceSiteBindingRepository').args).toEqual([db]);
    expect(site[1]).toMatchObject(api(WORKERS));
    expect(clockOf(site[2])).toBe(1_700_000_000);
    expect(site[3]).toBe(true);
    expect(site).toHaveLength(4);

    const plugin = firstConstruction('PluginResourceBindingReconciler').args;
    expect(plugin[0]).toBe(db);
    expect(plugin[1]).toMatchObject(api(WORKERS));
    expect(plugin[2]).toBe(env);
    expect(clockOf(plugin[3])).toBe(1_700_000_000);
    expect(plugin[4]).toBe(true);
    expect(plugin[5]).toBe(budget);

    const inventory = firstConstruction('WorkerInventoryReconciler').args;
    expect(inventory[0]).toBe(repository.instance);
    expect(inventory[1]).toMatchObject(api(WORKERS));
    expect(clockOf(inventory[2])).toBe(1_700_000_000);
  });

  it('wires the automatic-only reconcilers', async () => {
    const { env, db } = await ready();
    const replication = constructionsOf('ReadReplicationService');
    expect(replication).toHaveLength(2);
    for (const construction of replication) {
      expect(construction.args[0]).toBe(db);
      expect(construction.args[1]).toMatchObject(api(D1));
    }
    const placement = firstConstruction('TenantPlacementMigrationReconciler').args;
    expect(placement[0]).toBe(db);
    expect(placement[1]).toBe(firstConstruction('ControlService').instance);
    expect(placement[2]).toMatchObject(api(D1));
    expect(clockOf(placement[3])).toBe(1_700_000_000);

    const clients: unknown = fn('createControlApiClients').mock.results[0]?.value;
    const reconcile = firstConstruction('PluginResourceReconciler').args;
    expect(reconcile[0]).toBe(db);
    expect(reconcile[1]).toBe(clients);
    expect(clockOf(reconcile[2])).toBe(1_700_000_000);

    const migration = firstConstruction('PluginResourceMigrationReconciler').args;
    expect(migration[0]).toBe(db);
    expect(migration[1]).toBe(env.MIGRATION_RELEASES);
    expect(migration[2]).toMatchObject(api(D1));
    expect(clockOf(migration[3])).toBe(1_700_000_000);

    const cleanup = firstConstruction('PluginResourceCleanupService').args;
    expect(cleanup[0]).toBe(db);
    expect(cleanup[1]).toBe(clients);
    expect(clockOf(cleanup[2])).toBe(1_700_000_000);
    expect(cleanup[3]).toBe(false);

    const [factoryEnv, repository, d1, workers, now] = must(
      fn('ShardCleanupService.fromEnv').mock.calls[0]
    );
    expect(factoryEnv).toBe(env);
    expect(repository).toBe(firstConstruction('D1ShardCleanupRepository').instance);
    expect(firstConstruction('D1ShardCleanupRepository').args).toEqual([db]);
    expect(d1).toMatchObject(api(D1));
    expect(workers).toMatchObject(api(WORKERS));
    expect(clockOf(now)).toBe(1_700_000_000);
  });

  it('enables destructive plugin cleanup only for the exact flag', async () => {
    await ready({ CONTROL_DESTRUCTIVE_OPERATIONS_ENABLED: 'true' });
    expect(firstConstruction('PluginResourceCleanupService').args[3]).toBe(true);
  });

  it('delegates the bootstrap handoff probes to the provider clients', async () => {
    const { db } = await ready();
    const [repository, probes, now] = firstConstruction('BootstrapHandoffVerifier').args as [
      unknown,
      Record<string, (...args: unknown[]) => unknown>,
      () => number,
    ];
    expect(repository).toBe(firstConstruction('D1BootstrapHandoffRepository').instance);
    expect(firstConstruction('D1BootstrapHandoffRepository').args).toEqual([db]);
    expect(now()).toBe(1_700_000_000);
    expect(Object.keys(probes).sort()).toEqual([
      'getD1Database',
      'getWorkerSettings',
      'listWorkerDeployments',
      'queryD1Batch',
    ]);
    fn('d1.getD1Database').mockReturnValue('database');
    fn('d1.queryD1Batch').mockReturnValue('batch');
    fn('workers.getWorkerSettings').mockReturnValue('settings');
    fn('workers.listWorkerDeployments').mockReturnValue('deployments');
    expect(probes.getD1Database?.('db-1')).toBe('database');
    expect(fn('d1.getD1Database')).toHaveBeenCalledExactlyOnceWith('db-1');
    expect(probes.queryD1Batch?.('db-2', ['q'])).toBe('batch');
    expect(fn('d1.queryD1Batch')).toHaveBeenCalledExactlyOnceWith('db-2', ['q']);
    expect(probes.getWorkerSettings?.('script-1')).toBe('settings');
    expect(fn('workers.getWorkerSettings')).toHaveBeenCalledExactlyOnceWith('script-1');
    expect(probes.listWorkerDeployments?.('script-2')).toBe('deployments');
    expect(fn('workers.listWorkerDeployments')).toHaveBeenCalledExactlyOnceWith('script-2');
  });

  it('passes the release engine and probes to the rollout reconciler', async () => {
    const { env, db } = await ready();
    const reader = firstConstruction('MigrationReleaseArtifactReader');
    expect(firstConstruction('R2ReleaseArtifactStore').args).toEqual([env.MIGRATION_RELEASES]);
    expect(reader.args).toEqual([firstConstruction('R2ReleaseArtifactStore').instance]);
    expect(fn('cloudflareMigrationExecutor')).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining(api(D1))
    );
    const engine = firstConstruction('ApiMigrationEngine');
    expect(engine.args[0]).toBe(reader.instance);
    expect(engine.args[1]).toBe('executor');
    expect(clockOf(engine.args[2])).toBe(1_700_000_000_123);
    const rollout = firstConstruction('ReleaseMigrationRolloutReconciler').args;
    expect(rollout[0]).toBe(db);
    expect(rollout[1]).toBe(engine.instance);
    expect(clockOf(rollout[2])).toBe(1_700_000_000);
    expect(rollout[3]).toEqual({ executorAvailable: true, artifactProbe: reader.instance });
  });

  it('runs the rollout without an engine when no d1 token is configured', async () => {
    prime();
    await runScheduled({ ...READY_ENV, CLOUDFLARE_D1_API_TOKEN: undefined }).run();
    expect(constructionsOf('ApiMigrationEngine')).toHaveLength(0);
    const rollout = firstConstruction('ReleaseMigrationRolloutReconciler').args;
    expect(rollout[1]).toBeNull();
    expect(rollout[3]).toEqual({
      executorAvailable: false,
      artifactProbe: firstConstruction('MigrationReleaseArtifactReader').instance,
    });
  });
});

describe('scheduled: fallback construction', () => {
  it('tells reconcilers provider mutation is unavailable when provisioning is not ready', async () => {
    prime();
    await runScheduled({ ...READY_ENV, AUTHRIM_AUTOMATIC_PROVISIONING: 'false' }).run();
    expect(firstConstruction('WorkerBindingReconciler').args[5]).toBe(false);
    expect(firstConstruction('ServiceSiteBindingReconciler').args[3]).toBe(false);
    expect(firstConstruction('PluginResourceBindingReconciler').args[4]).toBe(false);
    expect(constructionsOf('WorkerInventoryReconciler')).toHaveLength(0);
  });
});

describe('scheduled: bootstrap resume and plugin handoff', () => {
  it('resumes automatic bootstrap operations for the named environment', async () => {
    await ready();
    expect(
      fn('D1ControlRepository.resumeAutomaticBootstrapOperations')
    ).toHaveBeenCalledExactlyOnceWith('env-1', 1_700_000_000);
  });

  it('skips the resume when the environment has no name', async () => {
    await ready({ AUTHRIM_ENVIRONMENT_NAME: undefined });
    expect(fn('D1ControlRepository.resumeAutomaticBootstrapOperations')).not.toHaveBeenCalled();
    expect(fn('AccountScaleOutForecastService.observe')).not.toHaveBeenCalled();
  });

  it('observes the account forecast for the whole environment', async () => {
    await ready();
    expect(fn('AccountScaleOutForecastService.observe')).toHaveBeenCalledExactlyOnceWith(
      'env-1',
      undefined
    );
  });

  it.each([
    [{ CLOUDFLARE_KV_API_TOKEN: undefined }, ['kv_namespace']],
    [{ CLOUDFLARE_KV_API_TOKEN: '   ' }, ['kv_namespace']],
    [{ CLOUDFLARE_R2_API_TOKEN: undefined }, ['r2_bucket']],
    [{ CLOUDFLARE_R2_API_TOKEN: ' ' }, ['r2_bucket']],
    [
      { CLOUDFLARE_KV_API_TOKEN: undefined, CLOUDFLARE_R2_API_TOKEN: undefined },
      ['kv_namespace', 'r2_bucket'],
    ],
  ])('hands %j to setup as %j', async (overrides, kinds) => {
    const { db } = await ready(overrides);
    expect(fn('handoffPluginResourceOperationsToSetup')).toHaveBeenCalledExactlyOnceWith(
      db,
      1_700_000_000,
      { resourceKinds: kinds }
    );
  });

  it('does not hand anything off when both optional tokens are present', async () => {
    await ready();
    expect(fn('handoffPluginResourceOperationsToSetup')).not.toHaveBeenCalled();
  });
});

describe('scheduled: lookup scale-out capacity requests', () => {
  const request = (id: string) => ({ id, environmentId: `env-${id}` });
  const configure = (requests: unknown[]) =>
    fn('LookupScaleOutForecastService.reconcileProvisioningOperations').mockResolvedValue({
      capacityRequests: requests,
    });

  it('records every outcome against the request environment', async () => {
    prime();
    configure([request('a'), request('b'), request('c'), request('d'), request('e')]);
    fn('ControlService.requestLookupScaleOutCapacity')
      .mockResolvedValueOnce({
        operation: { operationId: 'op-1', status: 'running', lastErrorCode: 'e1' },
      })
      .mockResolvedValueOnce({ operation: null })
      .mockRejectedValueOnce(new Error('control_lookup_capacity_domain_mismatch'))
      .mockRejectedValueOnce(new Error('transient'))
      .mockRejectedValueOnce(new Error('invalid_lookup_x'));
    await runScheduled(READY_ENV).run();
    expect(fn('ControlService.requestLookupScaleOutCapacity').mock.calls).toEqual(
      ['a', 'b', 'c', 'd', 'e'].map((id) => [request(id), `env-${id}`])
    );
    expect(fn('LookupScaleOutForecastService.recordProvisioningOperation').mock.calls).toEqual([
      ['env-a', request('a'), 'op-1', 'running', 'e1'],
    ]);
    expect(fn('LookupScaleOutForecastService.recordCapacityRequestRetry').mock.calls).toEqual([
      ['env-b', request('b'), 'lookup_scale_out_capacity_operation_pending'],
      ['env-d', request('d'), 'lookup_scale_out_capacity_request_retry'],
    ]);
    expect(fn('LookupScaleOutForecastService.blockCapacityRequest').mock.calls).toEqual([
      ['env-c', request('c'), 'control_lookup_capacity_domain_mismatch'],
      ['env-e', request('e'), 'invalid_lookup_x'],
    ]);
    const forecast = firstConstruction('LookupScaleOutForecastService');
    expect(forecast.args[0]).toBeDefined();
    expect(clockOf(forecast.args[1])).toBe(1_700_000_000);
  });

  it.each([
    'xinvalid_lookup_x',
    'invalid_',
    'invalid_UPPER',
    'control_d1_resource_limit_extra',
    'xcontrol_d1_resource_limit',
    'control_unknown',
    'control_lookup_capacity_domain_mismatch\n',
  ])('retries instead of blocking for the non terminal message %j', async (message) => {
    prime();
    configure([request('a')]);
    fn('ControlService.requestLookupScaleOutCapacity').mockRejectedValue(new Error(message));
    await runScheduled(READY_ENV).run();
    expect(fn('LookupScaleOutForecastService.blockCapacityRequest')).not.toHaveBeenCalled();
    expect(fn('LookupScaleOutForecastService.recordCapacityRequestRetry')).toHaveBeenCalledTimes(1);
  });

  it.each([
    'invalid_lookup_x',
    'control_d1_resource_limit',
    'control_environment_not_found',
    'control_lookup_capacity_domain_mismatch',
    'control_residency_partition_not_found',
    'control_resource_policy_not_found',
    'control_operation_idempotency_conflict',
  ])('blocks the request for the terminal message %s', async (message) => {
    prime();
    configure([request('a')]);
    fn('ControlService.requestLookupScaleOutCapacity').mockRejectedValue(new Error(message));
    await runScheduled(READY_ENV).run();
    expect(
      fn('LookupScaleOutForecastService.blockCapacityRequest')
    ).toHaveBeenCalledExactlyOnceWith('env-a', request('a'), message);
  });

  it('retries after a non error rejection', async () => {
    prime();
    configure([request('a')]);
    fn('ControlService.requestLookupScaleOutCapacity').mockRejectedValue('invalid_lookup_x');
    await runScheduled(READY_ENV).run();
    expect(fn('LookupScaleOutForecastService.blockCapacityRequest')).not.toHaveBeenCalled();
    expect(fn('LookupScaleOutForecastService.recordCapacityRequestRetry')).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no capacity is requested', async () => {
    prime();
    configure([]);
    await runScheduled(READY_ENV).run();
    expect(fn('ControlService.requestLookupScaleOutCapacity')).not.toHaveBeenCalled();
  });
});
