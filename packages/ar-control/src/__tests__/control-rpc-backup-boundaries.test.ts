import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ControlWorker from '../index';
import type { ControlEnv, ControlRpcProps } from '../types';

const mocks = vi.hoisted(() => ({
  permit: vi.fn(),
  checkpoint: vi.fn(),
  claimNext: vi.fn(),
  reactivate: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('../tenant-backup-mutation-permits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tenant-backup-mutation-permits')>()),
  controlTenantMutationPermit: mocks.permit,
}));
vi.mock('../tenant-disaster-recovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tenant-disaster-recovery')>()),
  TenantDisasterRecoveryService: class {
    checkpointLookupReprojection = mocks.checkpoint;
    claimNextLookupReprojection = mocks.claimNext;
    requestReactivation = mocks.reactivate;
    cancel = mocks.cancel;
  },
}));

const NOW = 1_800_000_000_000;
const checkpoint = {
  operationId: 'dr-1',
  ownerId: 'worker-1',
  fencingToken: 4,
  registryDigest: 'a'.repeat(64),
  lookupShardCount: 2,
  stage: 'account_id',
  nextStage: 'email_exact',
  targetIndex: 1,
  afterCreatedAt: 100,
  afterId: 'account-1',
  afterRowId: 3,
  projectedRowsDelta: 8,
  verifiedRowsDelta: 0,
};

function worker(props: Partial<Omit<ControlRpcProps, 'audience'>> & { audience?: string } = {}) {
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

afterEach(() => vi.useRealTimers());

describe('Control backup permit and disaster recovery RPC boundaries', () => {
  it('lets the internal log writer acquire only a tenant mutation permit', async () => {
    const { control, env } = worker({ caller: 'ar-lib-core' });
    const request = { tenantId: 'tenant-a', permitId: 'permit-1' };
    const result = { admitted: true };
    mocks.permit.mockResolvedValue(result);

    await expect(control.acquireTenantBackupMutationPermit(request)).resolves.toBe(result);
    expect(mocks.permit).toHaveBeenCalledExactlyOnceWith({
      database: env.CONTROL_DB,
      environmentId: 'test',
      caller: 'ar-lib-core',
      request,
      action: 'acquire',
      now: NOW,
    });
  });

  it('completes a tenant permit without changing its caller or environment', async () => {
    const { control, env } = worker({ caller: 'ar-lib-core' });
    const request = { tenantId: 'tenant-a', permitId: 'permit-1' };
    mocks.permit.mockResolvedValue(undefined);

    await expect(control.completeTenantBackupMutationPermit(request)).resolves.toBeUndefined();
    expect(mocks.permit).toHaveBeenCalledExactlyOnceWith({
      database: env.CONTROL_DB,
      environmentId: 'test',
      caller: 'ar-lib-core',
      request,
      action: 'complete',
      now: NOW,
    });
  });

  it('admits an environment permit for Management with an explicit environment scope', async () => {
    const { control, env } = worker();
    const request = { operationId: 'backup-1' };
    const result = { admitted: true };
    mocks.permit.mockResolvedValue(result);

    await expect(control.acquireEnvironmentBackupMutationPermit(request)).resolves.toBe(result);
    expect(mocks.permit).toHaveBeenCalledExactlyOnceWith({
      database: env.CONTROL_DB,
      environmentId: 'test',
      caller: 'ar-management',
      request,
      scope: 'environment',
      action: 'acquire',
      now: NOW,
    });
  });

  it('completes an environment permit in the same scope', async () => {
    const { control, env } = worker();
    const request = { operationId: 'backup-1' };
    mocks.permit.mockResolvedValue(undefined);

    await expect(control.completeEnvironmentBackupMutationPermit(request)).resolves.toBeUndefined();
    expect(mocks.permit).toHaveBeenCalledExactlyOnceWith({
      database: env.CONTROL_DB,
      environmentId: 'test',
      caller: 'ar-management',
      request,
      scope: 'environment',
      action: 'complete',
      now: NOW,
    });
  });

  it('rejects the internal log writer from environment-wide backup admission', async () => {
    await expect(
      worker({ caller: 'ar-lib-core' }).control.acquireEnvironmentBackupMutationPermit({})
    ).rejects.toThrow('control_rpc_caller_unauthorized');
    expect(mocks.permit).not.toHaveBeenCalled();
  });

  it('rejects an invalid RPC audience before any permit call', async () => {
    await expect(
      worker({ audience: 'wrong-audience' }).control.acquireTenantBackupMutationPermit({})
    ).rejects.toThrow('control_rpc_caller_unauthorized');
    expect(mocks.permit).not.toHaveBeenCalled();
  });

  it('fails closed when an acquire call has no admission result', async () => {
    mocks.permit.mockResolvedValue(null);

    await expect(worker().control.acquireTenantBackupMutationPermit({})).rejects.toThrow(
      'control_internal_error'
    );
    expect(mocks.permit).toHaveBeenCalledOnce();
  });

  it('masks a private permit storage error', async () => {
    mocks.permit.mockRejectedValue(new Error('tenant database and token details'));

    await expect(worker().control.acquireTenantBackupMutationPermit({})).rejects.toThrow(
      'control_internal_error'
    );
  });

  it('passes an exact lookup checkpoint to the DR service in the caller environment', async () => {
    const result = { operationId: 'dr-1', status: 'reprojecting' };
    mocks.checkpoint.mockResolvedValue(result);

    await expect(
      worker().control.checkpointTenantDisasterRecoveryLookupReprojection(checkpoint)
    ).resolves.toBe(result);
    expect(mocks.checkpoint).toHaveBeenCalledExactlyOnceWith('test', checkpoint);
  });

  it('rejects a caller-supplied tenant on lookup checkpoint before service access', async () => {
    await expect(
      worker().control.checkpointTenantDisasterRecoveryLookupReprojection({
        ...checkpoint,
        tenantId: 'tenant-b',
      })
    ).rejects.toThrow('invalid_tenant_disaster_recovery_request');
    expect(mocks.checkpoint).not.toHaveBeenCalled();
  });

  it('rejects an operation ID on claim-next, which must select its own work', async () => {
    await expect(
      worker().control.claimNextTenantDisasterRecoveryLookupReprojection({
        ownerId: 'worker-1',
        registryDigest: 'a'.repeat(64),
        lookupShardCount: 2,
        operationId: 'dr-other',
      })
    ).rejects.toThrow('invalid_tenant_disaster_recovery_request');
    expect(mocks.claimNext).not.toHaveBeenCalled();
  });

  it('rejects reactivation without the exact operator reason', async () => {
    await expect(
      worker().control.requestTenantDisasterRecoveryReactivation({
        operationId: 'dr-1',
        requestedById: 'admin-1',
        reasonCode: 'operator_retry',
        idempotencyKey: 'reactivate-1',
      })
    ).rejects.toThrow('invalid_tenant_disaster_recovery_request');
    expect(mocks.reactivate).not.toHaveBeenCalled();
  });

  it('delegates an authorized reactivation request to the DR service', async () => {
    const request = {
      operationId: 'dr-1',
      requestedById: 'admin-1',
      reasonCode: 'operator_reactivate_recovered_tenant',
      idempotencyKey: 'reactivate-1',
    };
    const result = { operationId: 'dr-1', status: 'reactivating' };
    mocks.reactivate.mockResolvedValue(result);

    await expect(worker().control.requestTenantDisasterRecoveryReactivation(request)).resolves.toBe(
      result
    );
    expect(mocks.reactivate).toHaveBeenCalledExactlyOnceWith('test', request);
  });

  it('rejects DR cancellation without the operator-only reason', async () => {
    await expect(
      worker().control.cancelTenantDisasterRecovery({
        operationId: 'dr-1',
        requestedById: 'admin-1',
        reasonCode: 'operator_cancel',
        idempotencyKey: 'cancel-1',
      })
    ).rejects.toThrow('invalid_tenant_disaster_recovery_request');
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
});
