import { beforeEach, describe, expect, it, vi } from 'vitest';
import ControlWorker from '../index';
import type { ControlEnv, ControlRpcProps } from '../types';

const mocks = vi.hoisted(() => ({
  runtimeTargets: vi.fn(),
  provisioningTargets: vi.fn(),
  ensureCapacity: vi.fn(),
  deletionInventory: vi.fn(),
  finalizeDeletion: vi.fn(),
  defaultReserve: vi.fn(),
  defaultMutate: vi.fn(),
  tryAllocate: vi.fn(),
  commitAccount: vi.fn(),
  releaseAccount: vi.fn(),
  listDirectory: vi.fn(),
  listRoutes: vi.fn(),
}));

vi.mock('../service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../service')>()),
  ControlService: class {
    getTenantRuntimeRouteTargets = mocks.runtimeTargets;
    getTenantProvisioningRouteTargets = mocks.provisioningTargets;
    ensureTenantShardCapacity = mocks.ensureCapacity;
    getTenantDeletionInventory = mocks.deletionInventory;
    finalizeTenantDeletionControlState = mocks.finalizeDeletion;
  },
}));
vi.mock('../repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../repository')>()),
  D1ControlRepository: class {
    listAccountDirectorySourceShards = mocks.listDirectory;
    listAccountRouteSourceShards = mocks.listRoutes;
  },
}));
vi.mock('../tenant-default-allocation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tenant-default-allocation')>()),
  TenantDefaultAllocationService: class {
    reserve = mocks.defaultReserve;
    mutate = mocks.defaultMutate;
  },
}));
vi.mock('../account-allocation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../account-allocation')>()),
  D1AccountAllocationRepository: class {},
  ControlAccountAllocationService: class {
    tryAllocate = mocks.tryAllocate;
    commit = mocks.commitAccount;
    release = mocks.releaseAccount;
  },
}));

function worker(props: Partial<ControlRpcProps> = {}) {
  const env = {
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    CONTROL_DB: {} as D1Database,
  } as ControlEnv;
  const waitUntil = vi.fn();
  const control = new ControlWorker(
    {
      props: {
        caller: 'ar-management',
        audience: 'authrim-control-v1',
        environmentId: 'test',
        ...props,
      },
      waitUntil,
    } as unknown as ConstructorParameters<typeof ControlWorker>[0],
    env
  );
  return { control, env, waitUntil };
}

beforeEach(() => vi.resetAllMocks());

describe('Control tenant route and deletion RPC boundaries', () => {
  it('rejects route target inspection by non-management callers without accessing the service', async () => {
    const control = worker({ caller: 'ar-plugin-runner' }).control;
    await expect(control.getTenantRuntimeRouteTargets({ tenantId: 'tenant-a' })).rejects.toThrow(
      'control_rpc_caller_unauthorized'
    );
    await expect(
      control.getTenantProvisioningRouteTargets({ tenantId: 'tenant-a' })
    ).rejects.toThrow('control_rpc_caller_unauthorized');
    expect(mocks.runtimeTargets).not.toHaveBeenCalled();
    expect(mocks.provisioningTargets).not.toHaveBeenCalled();
  });

  it('passes both route inspections to the selected environment and masks storage errors', async () => {
    const input = { tenantId: 'tenant-a', dataRole: 'tenant_core/users' };
    const runtime = [{ shardId: 'shard-a' }];
    const provisioning = [{ shardId: 'shard-b' }];
    mocks.runtimeTargets.mockResolvedValueOnce(runtime).mockRejectedValueOnce(new Error('DB row'));
    mocks.provisioningTargets.mockResolvedValue(provisioning);
    const { control } = worker();

    await expect(control.getTenantRuntimeRouteTargets(input)).resolves.toBe(runtime);
    await expect(control.getTenantProvisioningRouteTargets(input)).resolves.toBe(provisioning);
    expect(mocks.runtimeTargets).toHaveBeenCalledWith(input, 'test');
    expect(mocks.provisioningTargets).toHaveBeenCalledExactlyOnceWith(input, 'test');
    await expect(control.getTenantRuntimeRouteTargets(input)).rejects.toThrow(
      'control_internal_error'
    );
  });

  it('rejects shard capacity mutation by non-management callers before a write', async () => {
    await expect(
      worker({ caller: 'ar-lib-core' }).control.ensureTenantShardCapacity({ tenantId: 'tenant-a' })
    ).rejects.toThrow('control_rpc_caller_unauthorized');
    expect(mocks.ensureCapacity).not.toHaveBeenCalled();
  });

  it('keeps deletion inventory and finalization behind management authorization', async () => {
    const control = worker({ caller: 'ar-plugin-runner' }).control;
    await expect(control.getTenantDeletionInventory({ tenantId: 'tenant-a' })).rejects.toThrow(
      'control_rpc_caller_unauthorized'
    );
    await expect(
      control.finalizeTenantDeletionControlState({ tenantId: 'tenant-a' })
    ).rejects.toThrow('control_rpc_caller_unauthorized');
    expect(mocks.deletionInventory).not.toHaveBeenCalled();
    expect(mocks.finalizeDeletion).not.toHaveBeenCalled();
  });

  it('delegates tenant deletion reads and writes with the environment and hides backend detail', async () => {
    const input = { tenantId: 'tenant-a', idempotencyKey: 'delete-a' };
    const inventory = { tenantId: 'tenant-a', shards: [] };
    mocks.deletionInventory.mockResolvedValue(inventory);
    mocks.finalizeDeletion.mockResolvedValueOnce({ finalized: true });
    mocks.finalizeDeletion.mockRejectedValueOnce(new Error('private D1 row'));
    const { control } = worker();

    await expect(control.getTenantDeletionInventory(input)).resolves.toBe(inventory);
    await expect(control.finalizeTenantDeletionControlState(input)).resolves.toEqual({
      finalized: true,
    });
    expect(mocks.deletionInventory).toHaveBeenCalledExactlyOnceWith(input, 'test');
    expect(mocks.finalizeDeletion).toHaveBeenCalledWith(input, 'test');
    await expect(control.finalizeTenantDeletionControlState(input)).rejects.toThrow(
      'control_internal_error'
    );
  });
});

describe('Control route allocation RPC boundaries', () => {
  it('does not reserve a default route for another caller and forwards allowed state transitions', async () => {
    const input = { tenantId: 'tenant-a', idempotencyKey: 'reserve-a' };
    mocks.defaultReserve.mockResolvedValue({ state: 'reserved' });
    mocks.defaultMutate.mockImplementation(async (_input, _environmentId, action) => ({
      state: action === 'commit' ? 'committed' : 'released',
    }));

    await expect(
      worker({ caller: 'ar-plugin-runner' }).control.reserveTenantDefaultRoute(input)
    ).rejects.toThrow('control_rpc_caller_unauthorized');
    expect(mocks.defaultReserve).not.toHaveBeenCalled();
    const { control } = worker();
    await expect(control.reserveTenantDefaultRoute(input)).resolves.toEqual({ state: 'reserved' });
    await expect(control.commitTenantDefaultRoute(input)).resolves.toEqual({ state: 'committed' });
    await expect(control.releaseTenantDefaultRoute(input)).resolves.toEqual({ state: 'released' });
    expect(mocks.defaultReserve).toHaveBeenCalledExactlyOnceWith(input, 'test');
    expect(mocks.defaultMutate.mock.calls).toEqual([
      [input, 'test', 'commit'],
      [input, 'test', 'release'],
    ]);
  });

  it('does not schedule account scale-out when allocation remains pending', async () => {
    const input = { tenantId: 'tenant-a', accountIdBlindDigest: 'a'.repeat(64) };
    mocks.tryAllocate.mockResolvedValue({ state: 'pending', operationId: 'operation-a' });
    const { control, waitUntil } = worker();

    await expect(control.tryAllocateAccountRoute(input)).resolves.toEqual({
      state: 'pending',
      operationId: 'operation-a',
    });
    expect(mocks.tryAllocate).toHaveBeenCalledExactlyOnceWith(input, 'test');
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('rejects account route commitment by a non-management caller before storage access', async () => {
    await expect(
      worker({ caller: 'ar-plugin-runner' }).control.commitAccountRoute({ allocationId: 'a' })
    ).rejects.toThrow('control_rpc_caller_unauthorized');
    expect(mocks.commitAccount).not.toHaveBeenCalled();
  });

  it('forwards account route commitment and release in the caller environment', async () => {
    const input = { allocationId: 'allocation-a', idempotencyKey: 'retry-a' };
    mocks.commitAccount.mockResolvedValue({ state: 'committed' });
    mocks.releaseAccount.mockResolvedValue({ state: 'released' });
    const { control } = worker();

    await expect(control.commitAccountRoute(input)).resolves.toEqual({ state: 'committed' });
    await expect(control.releaseAccountRoute(input)).resolves.toEqual({ state: 'released' });
    expect(mocks.commitAccount).toHaveBeenCalledExactlyOnceWith(input, 'test');
    expect(mocks.releaseAccount).toHaveBeenCalledExactlyOnceWith(input, 'test');
  });
});

describe('Control account source page validation', () => {
  it.each([
    { afterShardId: '../another-tenant', limit: 10 },
    { afterShardId: null, limit: 101 },
    { afterShardId: null, limit: 0 },
  ])('rejects an invalid directory cursor before listing shards: %j', async (input) => {
    await expect(worker().control.listAccountDirectorySourceShards(input)).rejects.toThrow(
      'invalid_account_directory_source_page'
    );
    expect(mocks.listDirectory).not.toHaveBeenCalled();
  });

  it('passes a valid directory cursor and limit to the scoped repository', async () => {
    const rows = [{ shardId: 'shard-a' }];
    mocks.listDirectory.mockResolvedValue(rows);
    await expect(
      worker().control.listAccountDirectorySourceShards({ afterShardId: 'shard-0', limit: 10 })
    ).resolves.toBe(rows);
    expect(mocks.listDirectory).toHaveBeenCalledExactlyOnceWith('test', 'shard-0', 10);
  });

  it.each([
    { dataRole: 'tenant_core/default', afterShardId: null, limit: 10 },
    { dataRole: 'tenant_pii', afterShardId: null, limit: 10, tenantId: 'other' },
  ])('rejects invalid route source scope before listing shards: %j', async (input) => {
    await expect(worker().control.listAccountRouteSourceShards(input)).rejects.toThrow(
      'invalid_account_route_source_page'
    );
    expect(mocks.listRoutes).not.toHaveBeenCalled();
  });

  it('lists only the requested account data role and environment', async () => {
    mocks.listRoutes.mockResolvedValue([{ shardId: 'shard-a' }]);
    await expect(
      worker().control.listAccountRouteSourceShards({
        dataRole: 'tenant_pii',
        afterShardId: null,
        limit: 5,
      })
    ).resolves.toEqual([{ shardId: 'shard-a' }]);
    expect(mocks.listRoutes).toHaveBeenCalledExactlyOnceWith('test', 'tenant_pii', null, 5);
  });
});
