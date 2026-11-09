import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ControlWorker from '../index';
import type { ControlEnv, ControlRpcProps } from '../types';

const mocks = vi.hoisted(() => ({
  retryRelease: vi.fn(),
  retryProvisioning: vi.fn(),
  cancelProvisioning: vi.fn(),
  restoreProvisioning: vi.fn(),
  cleanupCanceledPlugin: vi.fn(),
  startRecovery: vi.fn(),
  getRecovery: vi.fn(),
  recordVerification: vi.fn(),
  applyMigration: vi.fn(),
  approveShardCleanup: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core/control-plane', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core/control-plane')>()),
  ApiMigrationEngine: class {
    apply = mocks.applyMigration;
  },
  MigrationReleaseArtifactReader: class {},
  R2ReleaseArtifactStore: class {},
  cloudflareMigrationExecutor: () => ({}),
}));

vi.mock('../repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../repository')>()),
  D1ControlRepository: class {
    retryReleaseMigrationRolloutTarget = mocks.retryRelease;
    retryProvisioningOperationStep = mocks.retryProvisioning;
    cancelProvisioningOperation = mocks.cancelProvisioning;
    restoreProvisioningOperationPreviousSettings = mocks.restoreProvisioning;
  },
}));
vi.mock('../plugin-resource-cleanup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../plugin-resource-cleanup')>()),
  PluginResourceCleanupService: class {
    requestCanceledProvisioning = mocks.cleanupCanceledPlugin;
  },
}));
vi.mock('../tenant-disaster-recovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tenant-disaster-recovery')>()),
  TenantDisasterRecoveryService: class {
    start = mocks.startRecovery;
    get = mocks.getRecovery;
    recordVerification = mocks.recordVerification;
  },
}));
vi.mock('../shard-cleanup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shard-cleanup')>()),
  ShardCleanupService: class {
    static fromEnv() {
      return { approveCleanup: mocks.approveShardCleanup };
    }
  },
}));
vi.mock('../control-api-clients', () => ({
  createControlApiClients: () => ({ d1: {}, workers: {} }),
}));

const NOW = 1_800_000_000_000;
const releaseRetry = {
  operationId: 'release-1',
  targetId: 'target-1',
  requestedById: 'admin-1',
  reasonCode: 'operator_retry_release_target',
  idempotencyKey: 'retry-1',
};
const provisioningCancel = {
  operationId: 'operation-1',
  requestedById: 'admin-1',
  reasonCode: 'operator_cancel',
  idempotencyKey: 'cancel-1',
};
const shardApproval = {
  quarantineOperationId: 'quarantine-1',
  requestedById: 'admin-1',
  reasonCode: 'operator_approve_cleanup',
  idempotencyKey: 'approve-1',
  confirmation: 'DELETE_RETIRED_TENANT_SHARD',
  exportMode: 'manual_verified',
  exportEvidenceId: 'evidence-1',
  deleteDatabase: true,
};

function worker(props: Partial<ControlRpcProps> = {}) {
  const env = {
    CONTROL_DB: {} as D1Database,
    AUTHRIM_ENVIRONMENT_NAME: 'test',
  } as ControlEnv;
  const control = new ControlWorker(
    {
      props: {
        caller: 'ar-management',
        audience: 'authrim-control-v1',
        environmentId: 'test',
        ...props,
      },
    } as ConstructorParameters<typeof ControlWorker>[0],
    env
  );
  return { control, env };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Control release and recovery RPC boundaries', () => {
  it('delegates an exact release target retry with the trusted environment and clock', async () => {
    const result = { operationId: 'release-1', status: 'queued' };
    mocks.retryRelease.mockResolvedValue(result);

    await expect(worker().control.retryReleaseMigrationRolloutTarget(releaseRetry)).resolves.toBe(
      result
    );
    expect(mocks.retryRelease).toHaveBeenCalledExactlyOnceWith(releaseRetry, 'test', NOW / 1000);
  });

  it.each([
    [
      'wrong reason',
      { ...releaseRetry, reasonCode: 'operator_retry' },
      'invalid_release_rollout_retry_request',
    ],
    ['path-like target', { ...releaseRetry, targetId: '../other' }, 'invalid_operation_id'],
    [
      'caller-supplied environment',
      { ...releaseRetry, environmentId: 'other' },
      'invalid_release_rollout_retry_request',
    ],
  ])('rejects a release retry with %s before storage access', async (_label, input, errorCode) => {
    await expect(worker().control.retryReleaseMigrationRolloutTarget(input)).rejects.toThrow(
      errorCode
    );
    expect(mocks.retryRelease).not.toHaveBeenCalled();
  });

  it('rejects a non-management release retry before storage access', async () => {
    await expect(
      worker({ caller: 'ar-lib-core' }).control.retryReleaseMigrationRolloutTarget(releaseRetry)
    ).rejects.toThrow('control_rpc_caller_unauthorized');
    expect(mocks.retryRelease).not.toHaveBeenCalled();
  });

  it('masks private repository errors on a release retry', async () => {
    mocks.retryRelease.mockRejectedValue(new Error('provider account and token details'));
    await expect(worker().control.retryReleaseMigrationRolloutTarget(releaseRetry)).rejects.toThrow(
      'control_internal_error'
    );
  });

  it('passes an approved provisioning retry to storage with the trusted clock', async () => {
    const request = {
      operationId: 'operation-1',
      stepKey: 'apply_migrations',
      requestedById: 'admin-1',
      reasonCode: 'operator_retry',
      idempotencyKey: 'retry-2',
    };
    const result = { operationId: 'operation-1', status: 'queued' };
    mocks.retryProvisioning.mockResolvedValue(result);

    await expect(worker().control.retryProvisioningOperationStep(request)).resolves.toBe(result);
    expect(mocks.retryProvisioning).toHaveBeenCalledExactlyOnceWith(request, 'test', NOW / 1000);
  });

  it('passes only the authorized restore reason to storage', async () => {
    const request = {
      operationId: 'operation-1',
      requestedById: 'admin-1',
      reasonCode: 'operator_restore_previous_settings',
      idempotencyKey: 'restore-1',
    };
    const result = { operationId: 'operation-1', status: 'queued' };
    mocks.restoreProvisioning.mockResolvedValue(result);

    await expect(
      worker().control.restoreProvisioningOperationPreviousSettings(request)
    ).resolves.toBe(result);
    expect(mocks.restoreProvisioning).toHaveBeenCalledExactlyOnceWith(request, 'test', NOW / 1000);
  });

  it('cancels a normal provisioning operation without requesting plugin cleanup', async () => {
    const result = { operationId: 'operation-1', operationKind: 'provision_shard' };
    mocks.cancelProvisioning.mockResolvedValue(result);

    await expect(worker().control.cancelProvisioningOperation(provisioningCancel)).resolves.toBe(
      result
    );
    expect(mocks.cancelProvisioning).toHaveBeenCalledExactlyOnceWith(
      provisioningCancel,
      'test',
      NOW / 1000
    );
    expect(mocks.cleanupCanceledPlugin).not.toHaveBeenCalled();
  });

  it('requests plugin cleanup only after a plugin provisioning cancellation succeeds', async () => {
    const result = { operationId: 'operation-1', operationKind: 'provision_plugin_resources' };
    mocks.cancelProvisioning.mockResolvedValue(result);
    mocks.cleanupCanceledPlugin.mockResolvedValue(undefined);

    await expect(worker().control.cancelProvisioningOperation(provisioningCancel)).resolves.toBe(
      result
    );
    expect(mocks.cleanupCanceledPlugin).toHaveBeenCalledExactlyOnceWith('test', {
      sourceOperationId: 'operation-1',
      requestedById: 'admin-1',
      idempotencyKey: 'cancel-1',
    });
  });

  it('does not request plugin cleanup when cancellation fails', async () => {
    mocks.cancelProvisioning.mockRejectedValue(new Error('control_operation_cancel_conflict'));

    await expect(worker().control.cancelProvisioningOperation(provisioningCancel)).rejects.toThrow(
      'control_operation_cancel_conflict'
    );
    expect(mocks.cleanupCanceledPlugin).not.toHaveBeenCalled();
  });

  it('rejects a caller-supplied environment on cancellation before storage access', async () => {
    await expect(
      worker().control.cancelProvisioningOperation({
        ...provisioningCancel,
        environmentId: 'other',
      })
    ).rejects.toThrow('invalid_operation_cancel_request');
    expect(mocks.cancelProvisioning).not.toHaveBeenCalled();
    expect(mocks.cleanupCanceledPlugin).not.toHaveBeenCalled();
  });

  it('rejects a disaster recovery start with the wrong operator reason', async () => {
    await expect(
      worker().control.startTenantDisasterRecovery({
        tenantId: 'tenant-a',
        requestedById: 'admin-1',
        reasonCode: 'operator_cancel',
        idempotencyKey: 'recovery-1',
      })
    ).rejects.toThrow('invalid_tenant_disaster_recovery_request');
    expect(mocks.startRecovery).not.toHaveBeenCalled();
  });

  it('delegates a valid disaster recovery start within the caller environment', async () => {
    const request = {
      tenantId: 'tenant-a',
      requestedById: 'admin-1',
      reasonCode: 'operator_disaster_recovery',
      idempotencyKey: 'recovery-1',
    };
    const result = { operationId: 'dr-1', status: 'queued' };
    mocks.startRecovery.mockResolvedValue(result);

    await expect(worker().control.startTenantDisasterRecovery(request)).resolves.toBe(result);
    expect(mocks.startRecovery).toHaveBeenCalledExactlyOnceWith('test', request);
  });

  it('does not record disaster recovery verification for a missing operation', async () => {
    mocks.getRecovery.mockResolvedValue(null);
    const request = {
      operationId: 'dr-1',
      stage: 'binding_smoke',
      pinnedRouteGeneration: 4,
      targets: [
        {
          shardId: 'shard-1',
          providerDatabaseId: 'db-1',
          shardGeneration: 2,
          bindingRef: 'TENANT_DB',
          releaseId: 'release-1',
          manifestDigest: 'a'.repeat(64),
        },
      ],
    };

    await expect(
      worker().control.recordTenantDisasterRecoveryVerification(request)
    ).rejects.toThrow('control_tenant_dr_operation_not_found');
    expect(mocks.getRecovery).toHaveBeenCalledExactlyOnceWith('test', 'dr-1');
    expect(mocks.recordVerification).not.toHaveBeenCalled();
  });

  it('records a non-migration verification only after loading the recovery', async () => {
    const request = {
      operationId: 'dr-1',
      stage: 'binding_smoke',
      pinnedRouteGeneration: 4,
      targets: [
        {
          shardId: 'shard-1',
          providerDatabaseId: 'db-1',
          shardGeneration: 2,
          bindingRef: 'TENANT_DB',
          releaseId: 'release-1',
          manifestDigest: 'a'.repeat(64),
        },
      ],
    };
    const result = { operationId: 'dr-1', status: 'verifying' };
    mocks.getRecovery.mockResolvedValue({ operationId: 'dr-1' });
    mocks.recordVerification.mockResolvedValue(result);

    await expect(worker().control.recordTenantDisasterRecoveryVerification(request)).resolves.toBe(
      result
    );
    expect(mocks.getRecovery).toHaveBeenCalledExactlyOnceWith('test', 'dr-1');
    expect(mocks.recordVerification).toHaveBeenCalledExactlyOnceWith('test', request);
  });

  it('applies every pinned migration target before recording migration verification', async () => {
    const request = {
      operationId: 'dr-1',
      stage: 'migration',
      pinnedRouteGeneration: 4,
      targets: [
        {
          shardId: 'shard-1',
          providerDatabaseId: 'db-1',
          shardGeneration: 2,
          bindingRef: 'TENANT_DB_1',
          releaseId: 'release-1',
          manifestDigest: 'a'.repeat(64),
        },
        {
          shardId: 'shard-2',
          providerDatabaseId: 'db-2',
          shardGeneration: 2,
          bindingRef: 'TENANT_DB_2',
          releaseId: 'release-1',
          manifestDigest: 'b'.repeat(64),
        },
      ],
    };
    const recovery = {
      environmentId: 'test',
      targets: request.targets.map((target) => ({
        providerDatabaseId: target.providerDatabaseId,
        migrationStreamId: 'core-d1',
        releaseId: target.releaseId,
        manifestDigest: target.manifestDigest,
      })),
    };
    const result = { operationId: 'dr-1', status: 'verifying' };
    mocks.getRecovery.mockResolvedValue(recovery);
    mocks.applyMigration.mockResolvedValue(undefined);
    mocks.recordVerification.mockResolvedValue(result);

    await expect(worker().control.recordTenantDisasterRecoveryVerification(request)).resolves.toBe(
      result
    );
    expect(mocks.applyMigration).toHaveBeenCalledTimes(2);
    expect(mocks.applyMigration).toHaveBeenNthCalledWith(1, {
      databaseId: 'db-1',
      pin: {
        environmentId: 'test',
        streamId: 'core-d1',
        releaseId: 'release-1',
        manifestDigest: 'a'.repeat(64),
        manifestObjectKey: `releases/release-1/${'a'.repeat(64)}/manifest.json`,
      },
    });
    expect(mocks.applyMigration).toHaveBeenNthCalledWith(2, {
      databaseId: 'db-2',
      pin: {
        environmentId: 'test',
        streamId: 'core-d1',
        releaseId: 'release-1',
        manifestDigest: 'b'.repeat(64),
        manifestObjectKey: `releases/release-1/${'b'.repeat(64)}/manifest.json`,
      },
    });
    expect(mocks.applyMigration.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.recordVerification.mock.invocationCallOrder[0]
    );
  });

  it('does not record migration verification after a pinned target fails', async () => {
    const request = {
      operationId: 'dr-1',
      stage: 'migration',
      pinnedRouteGeneration: 4,
      targets: [
        {
          shardId: 'shard-1',
          providerDatabaseId: 'db-1',
          shardGeneration: 2,
          bindingRef: 'TENANT_DB_1',
          releaseId: 'release-1',
          manifestDigest: 'a'.repeat(64),
        },
      ],
    };
    mocks.getRecovery.mockResolvedValue({
      environmentId: 'test',
      targets: [
        {
          providerDatabaseId: 'db-1',
          migrationStreamId: 'core-d1',
          releaseId: 'release-1',
          manifestDigest: 'a'.repeat(64),
        },
      ],
    });
    mocks.applyMigration.mockRejectedValue(new Error('private provider response'));

    await expect(
      worker().control.recordTenantDisasterRecoveryVerification(request)
    ).rejects.toThrow('control_internal_error');
    expect(mocks.recordVerification).not.toHaveBeenCalled();
  });

  it('rejects shard deletion without the exact destructive confirmation', async () => {
    await expect(
      worker().control.approveShardCleanup({ ...shardApproval, confirmation: 'DELETE_SHARD' })
    ).rejects.toThrow('invalid_shard_cleanup_approval_request');
    expect(mocks.approveShardCleanup).not.toHaveBeenCalled();
  });

  it('delegates an approved shard cleanup with the trusted environment', async () => {
    const result = { operationId: 'cleanup-1', status: 'queued' };
    mocks.approveShardCleanup.mockResolvedValue(result);

    await expect(worker().control.approveShardCleanup(shardApproval)).resolves.toBe(result);
    expect(mocks.approveShardCleanup).toHaveBeenCalledExactlyOnceWith('test', shardApproval);
  });
});
