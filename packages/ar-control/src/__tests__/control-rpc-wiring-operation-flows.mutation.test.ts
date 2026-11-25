import { describe, expect, it, vi } from 'vitest';
import { constructionsOf, fn, invoke, make, must } from './support/control-rpc-harness';
import { RESULT } from './support/rpc-wiring-table';
import { useWiringEnvironment } from './support/rpc-wiring-suite';

const recorder = vi.hoisted(() => () => import('./support/control-rpc-recorder'));
vi.mock('../service', async (orig) =>
  (await recorder()).partial(await orig(), { ControlService: [] })
);
vi.mock('../repository', async (orig) =>
  (await recorder()).partial(await orig(), { D1ControlRepository: [] })
);
vi.mock('../tenant-disaster-recovery', async (orig) =>
  (await recorder()).partial(await orig(), { TenantDisasterRecoveryService: [] })
);
vi.mock('../tenant-placement-migration', async (orig) =>
  (await recorder()).partial(await orig(), { TenantPlacementMigrationService: [] })
);
vi.mock('../tenant-placement-migration-reconciler', async (orig) =>
  (await recorder()).partial(await orig(), { TenantPlacementMigrationReconciler: [] })
);
vi.mock('../plugin-resource-cleanup', async (orig) =>
  (await recorder()).partial(await orig(), { PluginResourceCleanupService: [] })
);
vi.mock('@authrim/ar-lib-core/control-plane', async (orig) => {
  const { partial, fn: recorded } = await recorder();
  return {
    ...partial(await orig(), {
      ApiMigrationEngine: [],
      MigrationReleaseArtifactReader: [],
      R2ReleaseArtifactStore: [],
    }),
    cloudflareMigrationExecutor: (...args: unknown[]) =>
      recorded('cloudflareMigrationExecutor')(...args),
  };
});
vi.mock('../control-api-clients', async () => {
  const { fn: recorded } = await recorder();
  return {
    createControlApiClients: (...args: unknown[]) => recorded('createControlApiClients')(...args),
  };
});

useWiringEnvironment();

const STAMP = { requestedById: 'operator-1', idempotencyKey: 'idem-1' };
const CANCEL = { operationId: 'op-1', ...STAMP, reasonCode: 'operator_cancel' };

describe('cancelProvisioningOperation', () => {
  it('requests plugin resource cleanup only for plugin provisioning operations', async () => {
    const canceled = { operationKind: 'provision_plugin_resources' };
    fn('D1ControlRepository.cancelProvisioningOperation').mockResolvedValue(canceled);
    const { control, env } = make({}, { CONTROL_DESTRUCTIVE_OPERATIONS_ENABLED: 'true' });
    await expect(invoke(control, 'cancelProvisioningOperation', CANCEL)).resolves.toBe(canceled);
    expect(fn('D1ControlRepository.cancelProvisioningOperation')).toHaveBeenCalledExactlyOnceWith(
      CANCEL,
      'env-1',
      1_700_000_000
    );
    const [database, clients, now, destructive] = must(
      constructionsOf('PluginResourceCleanupService')[0]
    ).args;
    expect(database).toBe(env.CONTROL_DB);
    expect(clients).toEqual({ d1: { marker: 'd1' }, workers: { marker: 'workers' } });
    expect((now as () => number)()).toBe(1_700_000_000);
    expect(destructive).toBe(true);
    expect(
      fn('PluginResourceCleanupService.requestCanceledProvisioning')
    ).toHaveBeenCalledExactlyOnceWith('env-1', {
      sourceOperationId: 'op-1',
      requestedById: 'operator-1',
      idempotencyKey: 'idem-1',
    });
  });

  it.each([[undefined], ['false'], ['TRUE'], ['']])(
    'keeps destructive cleanup disabled unless the flag is exactly "true" (%s)',
    async (flag) => {
      fn('D1ControlRepository.cancelProvisioningOperation').mockResolvedValue({
        operationKind: 'provision_plugin_resources',
      });
      await invoke(
        make({}, { CONTROL_DESTRUCTIVE_OPERATIONS_ENABLED: flag as 'true' }).control,
        'cancelProvisioningOperation',
        CANCEL
      );
      expect(must(constructionsOf('PluginResourceCleanupService')[0]).args[3]).toBe(false);
    }
  );

  it('does not touch plugin cleanup for other operation kinds', async () => {
    const canceled = { operationKind: 'create_shard' };
    fn('D1ControlRepository.cancelProvisioningOperation').mockResolvedValue(canceled);
    await expect(invoke(make().control, 'cancelProvisioningOperation', CANCEL)).resolves.toBe(
      canceled
    );
    expect(constructionsOf('PluginResourceCleanupService')).toHaveLength(0);
  });

  it('surfaces a cleanup failure instead of returning the cancel result', async () => {
    fn('D1ControlRepository.cancelProvisioningOperation').mockResolvedValue({
      operationKind: 'provision_plugin_resources',
    });
    fn('PluginResourceCleanupService.requestCanceledProvisioning').mockRejectedValue(
      new Error('control_plugin_cleanup_conflict')
    );
    await expect(invoke(make().control, 'cancelProvisioningOperation', CANCEL)).rejects.toThrow(
      /^control_plugin_cleanup_conflict$/u
    );
  });
});

describe('plugin resource cleanup RPCs', () => {
  it.each([
    ['requestPluginResourceCleanup', 'request'],
    ['getPluginResourceCleanup', 'get'],
  ])('%s forwards the input and honours the destructive flag', async (rpc, method) => {
    fn(`PluginResourceCleanupService.${method}`).mockResolvedValue(RESULT);
    const { control, env } = make({}, { CONTROL_DESTRUCTIVE_OPERATIONS_ENABLED: 'true' });
    await expect(invoke(control, rpc, { plugin: 1 })).resolves.toBe(RESULT);
    expect(fn(`PluginResourceCleanupService.${method}`)).toHaveBeenCalledExactlyOnceWith('env-1', {
      plugin: 1,
    });
    const args = must(constructionsOf('PluginResourceCleanupService')[0]).args;
    expect(args[0]).toBe(env.CONTROL_DB);
    expect(args[1]).toEqual({ d1: { marker: 'd1' }, workers: { marker: 'workers' } });
    expect((args[2] as () => number)()).toBe(1_700_000_000);
    expect(args[3]).toBe(true);
  });

  it.each([
    ['requestPluginResourceCleanup', 'request'],
    ['getPluginResourceCleanup', 'get'],
  ])('%s returns null without a secret check and rejects strangers', async (rpc, method) => {
    fn(`PluginResourceCleanupService.${method}`).mockResolvedValue(null);
    const { control } = make();
    await expect(invoke(control, rpc, {})).resolves.toBeNull();
    expect(must(constructionsOf('PluginResourceCleanupService')[0]).args[3]).toBe(false);
    await expect(invoke(make({ caller: 'ar-lib-core' }).control, rpc, {})).rejects.toThrow(
      'control_rpc_caller_unauthorized'
    );
    fn(`PluginResourceCleanupService.${method}`).mockResolvedValue({ private_key: 'x' });
    await expect(invoke(make().control, rpc, {})).rejects.toThrow(/^control_internal_error$/u);
  });
});

describe('startTenantPlacementMigration', () => {
  const input = {
    tenantId: 'tenant-1',
    targetIsolationPolicy: 'tenant_exclusive',
    idempotencyKey: 'idem-1',
    requestedById: 'operator-1',
  };

  it('starts the migration and kicks the reconciler in the background', async () => {
    fn('TenantPlacementMigrationService.start').mockResolvedValue(RESULT);
    fn('TenantPlacementMigrationReconciler.reconcile').mockResolvedValue(undefined);
    const { control, env, waitUntil } = make();
    await expect(invoke(control, 'startTenantPlacementMigration', input)).resolves.toBe(RESULT);
    expect(fn('TenantPlacementMigrationService.start')).toHaveBeenCalledExactlyOnceWith(
      'env-1',
      input
    );
    const [database, now, options] = must(
      constructionsOf('TenantPlacementMigrationService')[0]
    ).args;
    expect(database).toBe(env.CONTROL_DB);
    expect((now as () => number)()).toBe(1_700_000_000);
    expect(options).toEqual({ sourceD1: { marker: 'd1' } });
    const [rdb, controlService, d1, rnow] = must(
      constructionsOf('TenantPlacementMigrationReconciler')[0]
    ).args;
    expect(rdb).toBe(env.CONTROL_DB);
    expect(controlService).toBeDefined();
    expect(d1).toEqual({ marker: 'd1' });
    expect((rnow as () => number)()).toBe(1_700_000_000);
    expect(fn('TenantPlacementMigrationReconciler.reconcile')).toHaveBeenCalledExactlyOnceWith();
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it('refuses a started migration whose result carries secret material', async () => {
    fn('TenantPlacementMigrationService.start').mockResolvedValue({ private_key: 'x' });
    fn('TenantPlacementMigrationReconciler.reconcile').mockResolvedValue(undefined);
    await expect(invoke(make().control, 'startTenantPlacementMigration', input)).rejects.toThrow(
      /^control_internal_error$/u
    );
  });

  it.each([
    [{ ...input, targetIsolationPolicy: 'shared' }],
    [{ ...input, extra: 1 }],
    [{ tenantId: 'tenant-1' }],
    [null],
    [[input]],
  ])('rejects %j before starting a migration or scheduling work', async (bad) => {
    const { control, waitUntil } = make();
    await expect(invoke(control, 'startTenantPlacementMigration', bad)).rejects.toThrow(
      /^invalid_tenant_placement_migration_request$/u
    );
    expect(fn('TenantPlacementMigrationService.start')).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it.each([
    'cancelTenantPlacementMigration',
    'beginTenantPlacementRouteCutover',
    'commitTenantPlacementMigration',
    'finalizeTenantPlacementMigrationCutover',
    'approveTenantPlacementMigrationPurge',
  ])('%s rejects extra or missing mutation fields', async (rpc) => {
    const mutation = { operationId: 'op-1', requestedById: 'u', idempotencyKey: 'k' };
    await expect(invoke(make().control, rpc, { ...mutation, extra: 1 })).rejects.toThrow(
      /^invalid_tenant_placement_migration_request$/u
    );
    await expect(invoke(make().control, rpc, { operationId: 'op-1' })).rejects.toThrow(
      /^invalid_tenant_placement_migration_request$/u
    );
    await expect(invoke(make().control, rpc, 'op-1')).rejects.toThrow(
      /^invalid_tenant_placement_migration_request$/u
    );
  });

  it.each([
    ['cancelTenantPlacementMigration', 'cancel', true],
    ['finalizeTenantPlacementMigrationCutover', 'finalizeCutover', true],
    ['beginTenantPlacementRouteCutover', 'beginRouteCutover', false],
    ['commitTenantPlacementMigration', 'commitCutover', false],
    ['approveTenantPlacementMigrationPurge', 'approvePurge', false],
  ])('%s builds the migration service %s the provider client', async (rpc, method, withClient) => {
    fn(`TenantPlacementMigrationService.${method}`).mockResolvedValue(RESULT);
    await invoke(make().control, rpc, {
      operationId: 'op-1',
      requestedById: 'u',
      idempotencyKey: 'k',
    });
    const args = must(constructionsOf('TenantPlacementMigrationService')[0]).args;
    expect(args).toHaveLength(withClient ? 3 : 2);
    if (withClient) expect(args[2]).toEqual({ sourceD1: { marker: 'd1' } });
  });

  it('rejects an invalid operation id lookup', async () => {
    await expect(invoke(make().control, 'getTenantPlacementMigration', '-bad')).rejects.toThrow(
      /^invalid_operation_id$/u
    );
    expect(fn('TenantPlacementMigrationService.get')).not.toHaveBeenCalled();
  });
});

describe('recordTenantDisasterRecoveryVerification migration stage', () => {
  const target = (id: string) => ({
    shardId: `shard-${id}`,
    providerDatabaseId: `db-${id}`,
    shardGeneration: 1,
    bindingRef: 'BIND',
    releaseId: `rel-${id}`,
    manifestDigest: `sha256:${id}`,
  });
  const request = (stage: string) => ({
    operationId: 'op-1',
    stage,
    pinnedRouteGeneration: 3,
    targets: [target('a')],
  });
  const recovery = {
    environmentId: 'env-1',
    targets: [
      {
        providerDatabaseId: 'db-a',
        migrationStreamId: 'stream-a',
        releaseId: 'rel-a',
        manifestDigest: 'dig-a',
      },
      {
        providerDatabaseId: 'db-b',
        migrationStreamId: 'stream-b',
        releaseId: 'rel-b',
        manifestDigest: 'dig-b',
      },
    ],
  };

  it('applies the pinned migrations to every recovery target before recording', async () => {
    const order: string[] = [];
    fn('TenantDisasterRecoveryService.get').mockResolvedValue(recovery);
    fn('ApiMigrationEngine.apply').mockImplementation(() => {
      order.push('apply');
      return Promise.resolve();
    });
    fn('TenantDisasterRecoveryService.recordVerification').mockImplementation(() => {
      order.push('record');
      return Promise.resolve(RESULT);
    });
    fn('cloudflareMigrationExecutor').mockReturnValue('executor');
    const migrationBucket = { marker: 'bucket' };
    const { control } = make({}, { MIGRATION_RELEASES: migrationBucket as unknown as R2Bucket });
    await expect(
      invoke(control, 'recordTenantDisasterRecoveryVerification', request('migration'))
    ).resolves.toBe(RESULT);
    expect(order).toEqual(['apply', 'apply', 'record']);
    expect(fn('TenantDisasterRecoveryService.get')).toHaveBeenCalledExactlyOnceWith(
      'env-1',
      'op-1'
    );
    expect(fn('ApiMigrationEngine.apply').mock.calls).toEqual([
      [
        {
          databaseId: 'db-a',
          pin: {
            environmentId: 'env-1',
            streamId: 'stream-a',
            releaseId: 'rel-a',
            manifestDigest: 'dig-a',
            manifestObjectKey: 'releases/rel-a/dig-a/manifest.json',
          },
        },
      ],
      [
        {
          databaseId: 'db-b',
          pin: {
            environmentId: 'env-1',
            streamId: 'stream-b',
            releaseId: 'rel-b',
            manifestDigest: 'dig-b',
            manifestObjectKey: 'releases/rel-b/dig-b/manifest.json',
          },
        },
      ],
    ]);
    expect(fn('TenantDisasterRecoveryService.recordVerification')).toHaveBeenCalledExactlyOnceWith(
      'env-1',
      request('migration')
    );
    expect(fn('cloudflareMigrationExecutor')).toHaveBeenCalledExactlyOnceWith({ marker: 'd1' });
    expect(must(constructionsOf('R2ReleaseArtifactStore')[0]).args).toEqual([migrationBucket]);
    const [reader, executor, now] = must(constructionsOf('ApiMigrationEngine')[0]).args;
    expect(reader).toBeDefined();
    expect(executor).toBe('executor');
    expect((now as () => number)()).toBe(1_700_000_000_123);
    expect(must(constructionsOf('MigrationReleaseArtifactReader')[0]).args).toHaveLength(1);
  });

  it.each(['lookup_reprojection', 'binding_smoke'])(
    'does not run migrations for the %s stage',
    async (stage) => {
      fn('TenantDisasterRecoveryService.get').mockResolvedValue(recovery);
      fn('TenantDisasterRecoveryService.recordVerification').mockResolvedValue(RESULT);
      await expect(
        invoke(make().control, 'recordTenantDisasterRecoveryVerification', request(stage))
      ).resolves.toBe(RESULT);
      expect(fn('ApiMigrationEngine.apply')).not.toHaveBeenCalled();
      expect(constructionsOf('ApiMigrationEngine')).toHaveLength(0);
    }
  );

  it('does not record when a migration fails', async () => {
    fn('TenantDisasterRecoveryService.get').mockResolvedValue(recovery);
    fn('ApiMigrationEngine.apply').mockRejectedValue(new Error('control_d1_resource_limit'));
    await expect(
      invoke(make().control, 'recordTenantDisasterRecoveryVerification', request('migration'))
    ).rejects.toThrow(/^control_d1_resource_limit$/u);
    expect(fn('TenantDisasterRecoveryService.recordVerification')).not.toHaveBeenCalled();
  });
});
