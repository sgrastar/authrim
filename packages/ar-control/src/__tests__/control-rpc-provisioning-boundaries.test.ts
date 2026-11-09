import { beforeEach, describe, expect, it, vi } from 'vitest';
import ControlWorker from '../index';
import type { ControlEnv, ControlRpcProps } from '../types';

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  requestCapacity: vi.fn(),
  reportMetrics: vi.fn(),
  getMetrics: vi.fn(),
  pluginPlan: vi.fn(),
  pluginPrepare: vi.fn(),
  beginRouteCutover: vi.fn(),
  getMigration: vi.fn(),
}));

vi.mock('../service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../service')>()),
  ControlService: class {
    previewCapacityProvisioning = mocks.preview;
    requestCapacityProvisioning = mocks.requestCapacity;
  },
}));
vi.mock('../r2-bucket-metrics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../r2-bucket-metrics')>()),
  reportR2BucketMetrics: mocks.reportMetrics,
  getR2BucketMetricInventory: mocks.getMetrics,
}));
vi.mock('../plugin-dynamic-worker-desired-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../plugin-dynamic-worker-desired-state')>()),
  PluginDynamicWorkerDesiredStateService: class {
    plan = mocks.pluginPlan;
    prepare = mocks.pluginPrepare;
  },
}));
vi.mock('../tenant-placement-migration', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tenant-placement-migration')>()),
  TenantPlacementMigrationService: class {
    beginRouteCutover = mocks.beginRouteCutover;
    get = mocks.getMigration;
  },
}));

function worker(props: Partial<ControlRpcProps> = {}) {
  const env = {
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    CONTROL_DB: {} as D1Database,
  } as ControlEnv;
  const control = new ControlWorker(
    {
      props: {
        caller: 'ar-management',
        audience: 'authrim-control-v1',
        environmentId: 'test',
        ...props,
      },
      waitUntil: vi.fn(),
    } as unknown as ConstructorParameters<typeof ControlWorker>[0],
    env
  );
  return { control, env };
}

beforeEach(() => vi.resetAllMocks());

describe('Control provisioning and plugin RPC authorization', () => {
  it.each([
    { caller: 'ar-plugin-runner' },
    { audience: 'another-audience' },
    { environmentId: '../other' },
  ])('rejects an unauthorized capacity preview before invoking the service: %j', async (props) => {
    await expect(
      worker(props as Partial<ControlRpcProps>).control.previewCapacityProvisioning({})
    ).rejects.toThrow('control_rpc_caller_unauthorized');
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it('passes a management capacity preview to the selected environment and masks internal failures', async () => {
    const { control } = worker();
    const input = { profile: 'recommended', scope: 'shared_pool', tenantId: null };
    const preview = { profile: 'recommended', scope: 'shared_pool', tenantId: null };
    mocks.preview
      .mockResolvedValueOnce(preview)
      .mockRejectedValueOnce(new Error('private SQL value'));

    await expect(control.previewCapacityProvisioning(input)).resolves.toBe(preview);
    expect(mocks.preview).toHaveBeenCalledExactlyOnceWith(input, 'test');
    await expect(control.previewCapacityProvisioning(input)).rejects.toThrow(
      'control_internal_error'
    );
  });

  it('allows only management to request capacity and preserves its environment context', async () => {
    const request = { scope: 'shared_pool' };
    mocks.requestCapacity.mockResolvedValue({ operationId: 'operation-a' });

    await expect(
      worker({ caller: 'ar-plugin-runner' }).control.requestCapacityProvisioning(request)
    ).rejects.toThrow('control_rpc_caller_unauthorized');
    expect(mocks.requestCapacity).not.toHaveBeenCalled();
    await expect(worker().control.requestCapacityProvisioning(request)).resolves.toEqual({
      operationId: 'operation-a',
    });
    expect(mocks.requestCapacity).toHaveBeenCalledExactlyOnceWith(request, 'test');
  });

  it('permits the plugin runner to report R2 metrics but not read all bucket metrics', async () => {
    const { control: reporter, env } = worker({ caller: 'ar-plugin-runner' });
    const input = { bucketName: 'plugin-bucket', count: 3 };
    mocks.reportMetrics.mockResolvedValue({ accepted: true });
    mocks.getMetrics.mockResolvedValue({ buckets: [] });

    await expect(reporter.reportR2BucketMetrics(input)).resolves.toEqual({ accepted: true });
    expect(mocks.reportMetrics).toHaveBeenCalledExactlyOnceWith(
      env.CONTROL_DB,
      'test',
      'ar-plugin-runner',
      input
    );
    await expect(reporter.getR2BucketMetrics()).rejects.toThrow('control_rpc_caller_unauthorized');
    expect(mocks.getMetrics).not.toHaveBeenCalled();
    await expect(worker().control.getR2BucketMetrics()).resolves.toEqual({ buckets: [] });
  });

  it('rejects unrelated metric reporters before writing R2 measurements', async () => {
    await expect(
      worker({ caller: 'ar-lib-core' }).control.reportR2BucketMetrics({ bucketName: 'forged' })
    ).rejects.toThrow('control_rpc_caller_unauthorized');
    expect(mocks.reportMetrics).not.toHaveBeenCalled();
  });

  it('prevents a plugin runner from preparing dynamic resources and delegates management planning', async () => {
    const input = { installationId: 'installation-a' };
    mocks.pluginPlan.mockResolvedValue({ planId: 'plan-a' });
    mocks.pluginPrepare.mockResolvedValue({ operationId: 'operation-a' });

    await expect(
      worker({ caller: 'ar-plugin-runner' }).control.preparePluginDynamicWorkerResources(input)
    ).rejects.toThrow('control_rpc_caller_unauthorized');
    expect(mocks.pluginPrepare).not.toHaveBeenCalled();

    const { control } = worker();
    await expect(control.validatePluginDynamicWorkerDesiredState(input)).resolves.toEqual({
      planId: 'plan-a',
    });
    await expect(control.preparePluginDynamicWorkerResources(input)).resolves.toEqual({
      operationId: 'operation-a',
    });
    expect(mocks.pluginPlan).toHaveBeenCalledExactlyOnceWith('test', input);
    expect(mocks.pluginPrepare).toHaveBeenCalledExactlyOnceWith('test', input);
  });
});

describe('Control tenant placement RPC input boundary', () => {
  it('rejects caller-controlled extra fields before starting route cutover', async () => {
    await expect(
      worker().control.beginTenantPlacementRouteCutover({
        operationId: 'operation-a',
        requestedById: 'admin-a',
        idempotencyKey: 'retry-a',
        tenantId: 'tenant-b',
      })
    ).rejects.toThrow('invalid_tenant_placement_migration_request');
    expect(mocks.beginRouteCutover).not.toHaveBeenCalled();
  });

  it('delegates a valid route cutover in the caller environment and masks storage details', async () => {
    const input = {
      operationId: 'operation-a',
      requestedById: 'admin-a',
      idempotencyKey: 'retry-a',
    };
    const result = { operationId: 'operation-a', status: 'route_cutover' };
    mocks.beginRouteCutover
      .mockResolvedValueOnce(result)
      .mockRejectedValueOnce(new Error('SQL key'));
    const { control } = worker();

    await expect(control.beginTenantPlacementRouteCutover(input)).resolves.toBe(result);
    expect(mocks.beginRouteCutover).toHaveBeenCalledExactlyOnceWith('test', input);
    await expect(control.beginTenantPlacementRouteCutover(input)).rejects.toThrow(
      'control_internal_error'
    );
  });

  it('rejects malformed operation identifiers before reading migration state', async () => {
    await expect(worker().control.getTenantPlacementMigration('../tenant-b')).rejects.toThrow(
      'invalid_operation_id'
    );
    expect(mocks.getMigration).not.toHaveBeenCalled();
    mocks.getMigration.mockResolvedValue({ operationId: 'operation-a' });
    await expect(worker().control.getTenantPlacementMigration('operation-a')).resolves.toEqual({
      operationId: 'operation-a',
    });
    expect(mocks.getMigration).toHaveBeenCalledExactlyOnceWith('test', 'operation-a');
  });
});
