import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fn, invoke, make, resetRecorder } from './support/control-rpc-harness';
import { RESULT } from './support/rpc-wiring-table';

vi.mock('../service', async (orig) =>
  (await import('./support/control-rpc-recorder')).partial(await orig(), { ControlService: [] })
);
vi.mock('../repository', async (orig) =>
  (await import('./support/control-rpc-recorder')).partial(await orig(), {
    D1ControlRepository: [],
  })
);
vi.mock('../tenant-disaster-recovery', async (orig) =>
  (await import('./support/control-rpc-recorder')).partial(await orig(), {
    TenantDisasterRecoveryService: [],
  })
);
vi.mock('../tenant-placement-migration', async (orig) =>
  (await import('./support/control-rpc-recorder')).partial(await orig(), {
    TenantPlacementMigrationService: [],
  })
);
vi.mock('../tenant-placement-migration-reconciler', async (orig) =>
  (await import('./support/control-rpc-recorder')).partial(await orig(), {
    TenantPlacementMigrationReconciler: [],
  })
);
vi.mock('../shard-cleanup', async (orig) =>
  (await import('./support/control-rpc-recorder')).partial(await orig(), {
    ShardCleanupService: ['fromEnv'],
  })
);
vi.mock('../shard-cleanup-repository', async (orig) =>
  (await import('./support/control-rpc-recorder')).partial(await orig(), {
    D1ShardCleanupRepository: [],
  })
);
vi.mock('../plugin-dynamic-worker-desired-state', async (orig) =>
  (await import('./support/control-rpc-recorder')).partial(await orig(), {
    PluginDynamicWorkerDesiredStateService: [],
  })
);
vi.mock('../plugin-resource-cleanup', async (orig) =>
  (await import('./support/control-rpc-recorder')).partial(await orig(), {
    PluginResourceCleanupService: [],
  })
);
vi.mock('../control-api-clients', async () => {
  const { fn: recorded } = await import('./support/control-rpc-recorder');
  return {
    createControlApiClients: (...args: unknown[]) => recorded('createControlApiClients')(...args),
  };
});

const OP = 'op-1';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_123);
  resetRecorder();
});

describe('Control RPC wiring: input validation', () => {
  const noCall = async (rpc: string, input: unknown, code: string, call: string) => {
    await expect(invoke(make().control, rpc, input)).rejects.toThrow(new RegExp(`^${code}$`, 'u'));
    expect(fn(call)).not.toHaveBeenCalled();
  };
  const stamp = { requestedById: 'op', idempotencyKey: 'k1' };

  it('rejects malformed disaster recovery requests', async () => {
    const code = 'invalid_tenant_disaster_recovery_request';
    const start = { tenantId: 't', ...stamp, reasonCode: 'operator_disaster_recovery' };
    const call = 'TenantDisasterRecoveryService.start';
    await noCall('startTenantDisasterRecovery', { ...start, reasonCode: 'other' }, code, call);
    await noCall('startTenantDisasterRecovery', { ...start, extra: 1 }, code, call);
    await noCall('startTenantDisasterRecovery', { tenantId: 't' }, code, call);
    await noCall('startTenantDisasterRecovery', [start], code, call);
    await noCall('startTenantDisasterRecovery', null, code, call);
    await noCall('startTenantDisasterRecovery', 'x', code, call);
    await noCall('startTenantDisasterRecovery', { ...start, requestedById: '' }, code, call);
    await noCall(
      'startTenantDisasterRecovery',
      { ...start, requestedById: 'x'.repeat(201) },
      code,
      call
    );
    await noCall(
      'startTenantDisasterRecovery',
      { ...start, requestedById: 'a\u001fb' },
      code,
      call
    );
    await noCall(
      'startTenantDisasterRecovery',
      { ...start, tenantId: '-x' },
      'invalid_operation_id',
      call
    );
    await noCall(
      'startTenantDisasterRecovery',
      { ...start, idempotencyKey: 'a b' },
      'invalid_operation_id',
      call
    );
    await noCall(
      'requestTenantDisasterRecoveryReactivation',
      { operationId: OP, ...stamp, reasonCode: 'x' },
      code,
      'TenantDisasterRecoveryService.requestReactivation'
    );
    await noCall(
      'cancelTenantDisasterRecovery',
      { operationId: OP, ...stamp, reasonCode: 'x' },
      code,
      'TenantDisasterRecoveryService.cancel'
    );
    await noCall(
      'getTenantDisasterRecovery',
      'bad id',
      'invalid_operation_id',
      'TenantDisasterRecoveryService.get'
    );
    await noCall(
      'getTenantDisasterRecovery',
      5,
      'invalid_operation_id',
      'TenantDisasterRecoveryService.get'
    );
    await noCall(
      'getTenantDisasterRecovery',
      'a'.repeat(257),
      'invalid_operation_id',
      'TenantDisasterRecoveryService.get'
    );
  });

  it('accepts the maximum operator text and identifier lengths', async () => {
    fn('TenantDisasterRecoveryService.start').mockResolvedValue(RESULT);
    const start = {
      tenantId: `a${'b'.repeat(255)}`,
      requestedById: 'x'.repeat(200),
      idempotencyKey: 'k',
      reasonCode: 'operator_disaster_recovery',
    };
    await expect(invoke(make().control, 'startTenantDisasterRecovery', start)).resolves.toBe(
      RESULT
    );
    expect(fn('TenantDisasterRecoveryService.start')).toHaveBeenCalledWith('env-1', start);
    await expect(
      invoke(make().control, 'startTenantDisasterRecovery', { ...start, requestedById: 'x' })
    ).resolves.toBe(RESULT);
  });

  it('rejects malformed operation mutation requests before the repository', async () => {
    const retry = { operationId: OP, stepKey: 'create_d1', ...stamp, reasonCode: 'operator_retry' };
    const call = 'D1ControlRepository.retryProvisioningOperationStep';
    const code = 'invalid_operation_retry_request';
    await noCall('retryProvisioningOperationStep', { ...retry, stepKey: 'delete_all' }, code, call);
    await noCall('retryProvisioningOperationStep', { ...retry, reasonCode: 'x' }, code, call);
    await noCall('retryProvisioningOperationStep', { ...retry, requestedById: '' }, code, call);
    await noCall(
      'retryProvisioningOperationStep',
      { ...retry, requestedById: 'y'.repeat(201) },
      code,
      call
    );
    await noCall(
      'retryProvisioningOperationStep',
      { ...retry, requestedById: 'a\u0000' },
      code,
      call
    );
    await noCall('retryProvisioningOperationStep', { ...retry, idempotencyKey: '-k' }, code, call);
    await noCall('retryProvisioningOperationStep', { ...retry, idempotencyKey: 7 }, code, call);
    await noCall('retryProvisioningOperationStep', { ...retry, extra: 1 }, code, call);
    await noCall(
      'retryProvisioningOperationStep',
      { ...retry, operationId: '!' },
      'invalid_operation_id',
      call
    );
    for (const stepKey of ['create_d1', 'apply_migrations', 'reconcile_worker_bindings']) {
      fn(call).mockResolvedValueOnce(RESULT);
      await expect(
        invoke(make().control, 'retryProvisioningOperationStep', { ...retry, stepKey })
      ).resolves.toBe(RESULT);
    }

    const release = {
      operationId: OP,
      targetId: 't1',
      ...stamp,
      reasonCode: 'operator_retry_release_target',
    };
    const rcall = 'D1ControlRepository.retryReleaseMigrationRolloutTarget';
    const rcode = 'invalid_release_rollout_retry_request';
    await noCall(
      'retryReleaseMigrationRolloutTarget',
      { ...release, reasonCode: 'x' },
      rcode,
      rcall
    );
    await noCall(
      'retryReleaseMigrationRolloutTarget',
      { ...release, requestedById: '' },
      rcode,
      rcall
    );
    await noCall(
      'retryReleaseMigrationRolloutTarget',
      { ...release, requestedById: 'z'.repeat(201) },
      rcode,
      rcall
    );
    await noCall(
      'retryReleaseMigrationRolloutTarget',
      { ...release, requestedById: 'a\u001f' },
      rcode,
      rcall
    );
    await noCall(
      'retryReleaseMigrationRolloutTarget',
      { ...release, idempotencyKey: '' },
      rcode,
      rcall
    );
    await noCall(
      'retryReleaseMigrationRolloutTarget',
      { ...release, targetId: '' },
      'invalid_operation_id',
      rcall
    );
    await noCall('retryReleaseMigrationRolloutTarget', { operationId: OP }, rcode, rcall);

    const restore = { operationId: OP, ...stamp, reasonCode: 'operator_restore_previous_settings' };
    const scall = 'D1ControlRepository.restoreProvisioningOperationPreviousSettings';
    const scode = 'invalid_operation_restore_request';
    await noCall(
      'restoreProvisioningOperationPreviousSettings',
      { ...restore, reasonCode: 'x' },
      scode,
      scall
    );
    await noCall(
      'restoreProvisioningOperationPreviousSettings',
      { ...restore, requestedById: '' },
      scode,
      scall
    );
    await noCall(
      'restoreProvisioningOperationPreviousSettings',
      { ...restore, requestedById: 'z'.repeat(201) },
      scode,
      scall
    );
    await noCall(
      'restoreProvisioningOperationPreviousSettings',
      { ...restore, requestedById: 'a\u001f' },
      scode,
      scall
    );
    await noCall(
      'restoreProvisioningOperationPreviousSettings',
      { ...restore, idempotencyKey: '' },
      scode,
      scall
    );
    await noCall(
      'restoreProvisioningOperationPreviousSettings',
      { ...restore, operationId: '' },
      'invalid_operation_id',
      scall
    );

    const cancel = { operationId: OP, ...stamp, reasonCode: 'operator_cancel' };
    const ccall = 'D1ControlRepository.cancelProvisioningOperation';
    const ccode = 'invalid_operation_cancel_request';
    await noCall('cancelProvisioningOperation', { ...cancel, reasonCode: 'x' }, ccode, ccall);
    await noCall('cancelProvisioningOperation', { ...cancel, requestedById: '' }, ccode, ccall);
    await noCall(
      'cancelProvisioningOperation',
      { ...cancel, requestedById: 'z'.repeat(201) },
      ccode,
      ccall
    );
    await noCall(
      'cancelProvisioningOperation',
      { ...cancel, requestedById: 'a\u001f' },
      ccode,
      ccall
    );
    await noCall('cancelProvisioningOperation', { ...cancel, idempotencyKey: '' }, ccode, ccall);
    await noCall(
      'cancelProvisioningOperation',
      { ...cancel, operationId: '' },
      'invalid_operation_id',
      ccall
    );
  });

  it('validates account source page requests', async () => {
    const dcode = 'invalid_account_directory_source_page';
    const dcall = 'D1ControlRepository.listAccountDirectorySourceShards';
    await noCall('listAccountDirectorySourceShards', null, dcode, dcall);
    await noCall('listAccountDirectorySourceShards', [], dcode, dcall);
    await noCall('listAccountDirectorySourceShards', 'x', dcode, dcall);
    await noCall(
      'listAccountDirectorySourceShards',
      { afterShardId: undefined, limit: 1 },
      dcode,
      dcall
    );
    await noCall('listAccountDirectorySourceShards', { afterShardId: 5, limit: 1 }, dcode, dcall);
    await noCall(
      'listAccountDirectorySourceShards',
      { afterShardId: '-a', limit: 1 },
      dcode,
      dcall
    );
    await noCall(
      'listAccountDirectorySourceShards',
      { afterShardId: 'a'.repeat(129), limit: 1 },
      dcode,
      dcall
    );
    await noCall(
      'listAccountDirectorySourceShards',
      { afterShardId: null, limit: 0 },
      dcode,
      dcall
    );
    await noCall(
      'listAccountDirectorySourceShards',
      { afterShardId: null, limit: 101 },
      dcode,
      dcall
    );
    await noCall(
      'listAccountDirectorySourceShards',
      { afterShardId: null, limit: 1.5 },
      dcode,
      dcall
    );
    await noCall(
      'listAccountDirectorySourceShards',
      { afterShardId: null, limit: '5' },
      dcode,
      dcall
    );
    fn(dcall).mockResolvedValue(RESULT);
    await invoke(make().control, 'listAccountDirectorySourceShards', {
      afterShardId: 'a'.repeat(128),
      limit: 1,
    });
    expect(fn(dcall)).toHaveBeenLastCalledWith('env-1', 'a'.repeat(128), 1);

    const rcode = 'invalid_account_route_source_page';
    const rcall = 'D1ControlRepository.listAccountRouteSourceShards';
    await noCall('listAccountRouteSourceShards', null, rcode, rcall);
    await noCall('listAccountRouteSourceShards', [], rcode, rcall);
    await noCall(
      'listAccountRouteSourceShards',
      { dataRole: 'other', afterShardId: null, limit: 1 },
      rcode,
      rcall
    );
    await noCall(
      'listAccountRouteSourceShards',
      { dataRole: 'tenant_pii', afterShardId: null, limit: 1, extra: 1 },
      rcode,
      rcall
    );
    await noCall(
      'listAccountRouteSourceShards',
      { dataRole: 'tenant_pii', limit: 1 },
      dcode,
      rcall
    );
    await noCall(
      'listAccountRouteSourceShards',
      { dataRole: 'tenant_pii', afterShardId: null, limit: 0 },
      dcode,
      rcall
    );
    fn(rcall).mockResolvedValue(RESULT);
    await invoke(make().control, 'listAccountRouteSourceShards', {
      dataRole: 'tenant_core/users',
      afterShardId: 's',
      limit: 1,
    });
    expect(fn(rcall)).toHaveBeenLastCalledWith('env-1', 'tenant_core/users', 's', 1);
  });

  it('validates the verification request shape', async () => {
    const code = 'invalid_tenant_disaster_recovery_request';
    const call = 'TenantDisasterRecoveryService.get';
    const target = (shardId: string) => ({
      shardId,
      providerDatabaseId: 'db-1',
      shardGeneration: 1,
      bindingRef: 'BIND',
      releaseId: 'rel-1',
      manifestDigest: 'sha256:x',
    });
    const base = {
      operationId: OP,
      stage: 'binding_smoke',
      pinnedRouteGeneration: 2,
      targets: [target('s1')],
    };
    const bad = async (patch: Record<string, unknown>, expected = code) => {
      await expect(
        invoke(make().control, 'recordTenantDisasterRecoveryVerification', { ...base, ...patch })
      ).rejects.toThrow(new RegExp(`^${expected}$`, 'u'));
      expect(fn(call)).not.toHaveBeenCalled();
    };
    await bad({ stage: 'other' });
    await bad({ targets: [] });
    await bad({ targets: 'x' });
    await bad({ targets: Array.from({ length: 101 }, (_, i) => target(`s${i}`)) });
    await bad({ targets: [target('s1'), target('s1')] });
    await bad({ targets: [{ ...target('s1'), extra: 1 }] });
    await bad({ targets: [{ ...target('s1'), shardId: '-' }] }, 'invalid_operation_id');
    await bad({ operationId: '-' }, 'invalid_operation_id');
    await bad({ pinned: 1, pinnedRouteGeneration: undefined });
    fn(call).mockResolvedValue(null);
    await expect(
      invoke(make().control, 'recordTenantDisasterRecoveryVerification', base)
    ).rejects.toThrow(/^control_tenant_dr_operation_not_found$/u);
    expect(fn(call)).toHaveBeenCalledExactlyOnceWith('env-1', OP);
    expect(fn('TenantDisasterRecoveryService.recordVerification')).not.toHaveBeenCalled();
  });

  it('accepts exactly 100 verification targets', async () => {
    const targets = Array.from({ length: 100 }, (_, i) => ({
      shardId: `s${i}`,
      providerDatabaseId: 'db',
      shardGeneration: 1,
      bindingRef: 'B',
      releaseId: 'r',
      manifestDigest: 'd',
    }));
    fn('TenantDisasterRecoveryService.get').mockResolvedValue({
      environmentId: 'env-1',
      targets: [],
    });
    fn('TenantDisasterRecoveryService.recordVerification').mockResolvedValue(RESULT);
    await expect(
      invoke(make().control, 'recordTenantDisasterRecoveryVerification', {
        operationId: OP,
        stage: 'lookup_reprojection',
        pinnedRouteGeneration: 1,
        targets,
      })
    ).resolves.toBe(RESULT);
    expect(fn('TenantDisasterRecoveryService.recordVerification')).toHaveBeenCalledExactlyOnceWith(
      'env-1',
      { operationId: OP, stage: 'lookup_reprojection', pinnedRouteGeneration: 1, targets }
    );
  });

  it('rejects checkpoint, claim and observation payloads with extra or missing keys', async () => {
    const code = 'invalid_tenant_disaster_recovery_request';
    for (const rpc of [
      'observeTenantDisasterRecoveryDeny',
      'confirmTenantDisasterRecoveryRestore',
      'claimTenantDisasterRecoveryLookupReprojection',
      'claimNextTenantDisasterRecoveryLookupReprojection',
      'checkpointTenantDisasterRecoveryLookupReprojection',
      'completeTenantDisasterRecoveryLookupReprojection',
      'completeTenantDisasterRecoveryReactivation',
    ]) {
      await expect(invoke(make().control, rpc, { extra: 1 })).rejects.toThrow(
        new RegExp(`^${code}$`, 'u')
      );
      await expect(invoke(make().control, rpc, null)).rejects.toThrow(new RegExp(`^${code}$`, 'u'));
    }
    const restore = { operationId: OP, restoreReferenceDigest: 'd', restoredAt: 1, ...stamp };
    for (const patch of [{ requestedById: '' }, { idempotencyKey: '!' }, { operationId: '!' }]) {
      await expect(
        invoke(make().control, 'confirmTenantDisasterRecoveryRestore', { ...restore, ...patch })
      ).rejects.toThrow(/^(invalid_tenant_disaster_recovery_request|invalid_operation_id)$/u);
    }
    for (const rpc of [
      [
        'claimTenantDisasterRecoveryLookupReprojection',
        { operationId: '!', ownerId: 'o', registryDigest: 'd', lookupShardCount: 1 },
      ],
      [
        'claimTenantDisasterRecoveryLookupReprojection',
        { operationId: OP, ownerId: '!', registryDigest: 'd', lookupShardCount: 1 },
      ],
      [
        'claimNextTenantDisasterRecoveryLookupReprojection',
        { ownerId: '!', registryDigest: 'd', lookupShardCount: 1 },
      ],
      [
        'completeTenantDisasterRecoveryLookupReprojection',
        { operationId: '!', ownerId: 'o', fencingToken: 1, registryDigest: 'd' },
      ],
      [
        'completeTenantDisasterRecoveryLookupReprojection',
        { operationId: OP, ownerId: '!', fencingToken: 1, registryDigest: 'd' },
      ],
      [
        'completeTenantDisasterRecoveryReactivation',
        { operationId: '!', runtimeGeneration: 1, pinnedRouteGeneration: 1 },
      ],
      [
        'observeTenantDisasterRecoveryDeny',
        { operationId: '!', runtimeGeneration: 1, denyRegistryGeneration: 1 },
      ],
      [
        'requestTenantDisasterRecoveryReactivation',
        { operationId: '!', ...stamp, reasonCode: 'operator_reactivate_recovered_tenant' },
      ],
      [
        'requestTenantDisasterRecoveryReactivation',
        {
          operationId: OP,
          requestedById: '',
          idempotencyKey: 'k',
          reasonCode: 'operator_reactivate_recovered_tenant',
        },
      ],
      [
        'requestTenantDisasterRecoveryReactivation',
        {
          operationId: OP,
          requestedById: 'a',
          idempotencyKey: '!',
          reasonCode: 'operator_reactivate_recovered_tenant',
        },
      ],
      [
        'cancelTenantDisasterRecovery',
        { operationId: '!', ...stamp, reasonCode: 'operator_cancel_before_deny' },
      ],
      [
        'cancelTenantDisasterRecovery',
        {
          operationId: OP,
          requestedById: '',
          idempotencyKey: 'k',
          reasonCode: 'operator_cancel_before_deny',
        },
      ],
      [
        'cancelTenantDisasterRecovery',
        {
          operationId: OP,
          requestedById: 'a',
          idempotencyKey: '!',
          reasonCode: 'operator_cancel_before_deny',
        },
      ],
    ] as const) {
      await expect(invoke(make().control, rpc[0], rpc[1])).rejects.toThrow(
        /^(invalid_tenant_disaster_recovery_request|invalid_operation_id)$/u
      );
    }
    for (const method of ['observeDeny', 'confirmRestore', 'claimLookupReprojection', 'cancel']) {
      expect(fn(`TenantDisasterRecoveryService.${method}`)).not.toHaveBeenCalled();
    }
  });
});
