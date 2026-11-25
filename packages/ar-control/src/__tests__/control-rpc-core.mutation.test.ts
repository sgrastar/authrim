import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fn, invoke, make } from './support/control-rpc-harness';
import { useWiringEnvironment } from './support/rpc-wiring-suite';

const recorder = vi.hoisted(() => () => import('./support/control-rpc-recorder'));
const logger = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  createLogger: () => ({ module: () => logger }),
}));
vi.mock('../service', async (orig) =>
  (await recorder()).partial(await orig(), { ControlService: [] })
);
vi.mock('../r2-bucket-metrics', async (orig) => {
  const { fn: recorded } = await recorder();
  return {
    ...(await orig<typeof import('../r2-bucket-metrics')>()),
    reportR2BucketMetrics: (...args: unknown[]) => recorded('reportR2BucketMetrics')(...args),
    getR2BucketMetricInventory: (...args: unknown[]) =>
      recorded('getR2BucketMetricInventory')(...args),
  };
});

useWiringEnvironment();
beforeEach(() => vi.clearAllMocks());

const exposedSamples = [
  'invalid_x',
  'backup_x',
  'directory_rewrite_x',
  'lookup_hmac_x',
  'lookup_scale_out_x',
  'read_replication_x',
  'service_site_x',
  'control_rpc_caller_unauthorized',
  'control_environment_not_found',
  'control_residency_partition_not_found',
  'control_resource_policy_not_found',
  'control_d1_resource_limit',
  'control_destructive_operations_disabled',
  'control_capacity_x',
  'control_operation_idempotency_conflict',
  'control_operation_retry_conflict',
  'control_operation_retry_not_retryable',
  'control_release_rollout_retry_conflict',
  'control_release_rollout_retry_not_retryable',
  'control_operation_cancel_conflict',
  'control_operation_cancel_not_allowed',
  'control_operation_restore_conflict',
  'control_operation_restore_not_allowed',
  'control_account_allocation_idempotency_conflict',
  'control_account_allocation_capacity_unavailable',
  'control_account_allocation_release_committed',
  'control_account_allocation_release_not_found',
  'control_worker_inventory_drift_review_conflict',
  'control_tenant_dr_x',
  'control_tenant_default_allocation_x',
  'control_tenant_placement_policy_x',
  'control_tenant_runtime_route_observation_x',
  'control_tenant_placement_migration_x',
  'control_tenant_region_shard_x',
  'control_tenant_shard_assignment_x',
  'control_shard_quarantine_x',
  'control_shard_cleanup_x',
  'control_lookup_bucket_x',
  'control_lookup_retention_x',
  'control_account_legal_hold_x',
  'control_plugin_x',
];
const hiddenSamples = [
  'xinvalid_x',
  'invalid_',
  'invalid_X',
  'invalid_x-y',
  'invalid_x\ninvalid_y',
  'invalid_x ',
  'backup_',
  'control_unknown',
  'control_',
  'control_capacity_',
  'control_capacity_X',
  'control_operation_retry_other',
  'control_operation_cancel_other',
  'control_release_rollout_retry_other',
  'control_account_allocation_release_other',
  'control_account_allocation_other',
  'control_tenant_dr_',
  'control_plugin_',
  'prefix control_plugin_x',
  'control_plugin_x suffix',
  'Control_plugin_x',
  'lookup_bucket_x',
  'plugin_x',
  'shard_cleanup_x',
  '',
];

const failWith = async (error: unknown, rpc = 'reconcilePending') => {
  fn('ControlService.reconcilePending').mockRejectedValue(error);
  return invoke(make().control, rpc).then(
    () => 'resolved',
    (reason: Error) => reason.message
  );
};

describe('exposed RPC error codes', () => {
  it.each(exposedSamples)('passes %s through unchanged', async (message) => {
    await expect(failWith(new Error(message))).resolves.toBe(message);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it.each(hiddenSamples)('masks %j and logs an incident id', async (message) => {
    await expect(failWith(new Error(message))).resolves.toBe('control_internal_error');
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('rethrows a fresh error instance for exposed codes', async () => {
    const original = new Error('invalid_x');
    original.stack = 'private stack';
    fn('ControlService.reconcilePending').mockRejectedValue(original);
    const thrown = await invoke(make().control, 'reconcilePending').catch(
      (reason: Error) => reason
    );
    expect(thrown).not.toBe(original);
    expect(thrown).toBeInstanceOf(Error);
  });

  it('does not expose messages of non Error values', async () => {
    await expect(failWith('invalid_x')).resolves.toBe('control_internal_error');
    await expect(failWith({ message: 'invalid_x' })).resolves.toBe('control_internal_error');
  });
});

describe('internal error logging', () => {
  it.each([
    [new TypeError('boom'), 'TypeError'],
    [new Error('boom'), 'Error'],
    [Object.assign(new Error('boom'), { name: 'My-Error' }), 'NonErrorThrow'],
    [Object.assign(new Error('boom'), { name: '1Error' }), 'NonErrorThrow'],
    [Object.assign(new Error('boom'), { name: '' }), 'NonErrorThrow'],
    [Object.assign(new Error('boom'), { name: `E${'a'.repeat(79)}` }), `E${'a'.repeat(79)}`],
    [Object.assign(new Error('boom'), { name: `E${'a'.repeat(80)}` }), 'NonErrorThrow'],
    ['plain string', 'NonErrorThrow'],
    [null, 'NonErrorThrow'],
  ])('logs %s as errorType %s without the message', async (failure, errorType) => {
    await failWith(failure);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [message, fields] = logger.error.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe('Control RPC failed');
    expect(fields).toEqual({
      action: 'unknown',
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u) as unknown,
      errorType,
    });
    expect(JSON.stringify(fields)).not.toContain('boom');
  });

  it('uses a fresh incident id per failure', async () => {
    await failWith(new Error('a'));
    await failWith(new Error('b'));
    const ids = logger.error.mock.calls.map((call) => (call[1] as { requestId: string }).requestId);
    expect(new Set(ids).size).toBe(2);
  });

  it('names the action for RPCs that declare one', async () => {
    fn('reportR2BucketMetrics').mockRejectedValue(new Error('db'));
    await expect(invoke(make().control, 'reportR2BucketMetrics', {})).rejects.toThrow(
      /^control_internal_error$/u
    );
    expect(logger.error.mock.calls.at(-1)?.[1]).toMatchObject({
      action: 'report_r2_bucket_metrics',
    });
  });
});

describe('caller authorization with missing props', () => {
  it.each([
    'reconcilePending',
    'getProvisioningAuthorityStatus',
    'getR2BucketMetrics',
    'getStorageTopology',
    'tenantBackupSnapshotBoundary',
    'acquireTenantBackupMutationPermit',
    'reportR2BucketMetrics',
  ])('%s rejects when the worker has no props', async (rpc) => {
    const control = make().control;
    (control as unknown as { ctx: { props: unknown } }).ctx.props = undefined;
    await expect(invoke(control, rpc, {})).rejects.toThrow(/^control_rpc_caller_unauthorized$/u);
  });
});

describe('R2 bucket metric RPCs', () => {
  it('reports metrics for the authorized owner and checks the result for secrets', async () => {
    fn('reportR2BucketMetrics').mockResolvedValue({ accepted: 1 });
    const { control, env } = make({ caller: 'ar-plugin-runner' });
    await expect(invoke(control, 'reportR2BucketMetrics', { buckets: [] })).resolves.toEqual({
      accepted: 1,
    });
    expect(fn('reportR2BucketMetrics')).toHaveBeenCalledExactlyOnceWith(
      env.CONTROL_DB,
      'env-1',
      'ar-plugin-runner',
      { buckets: [] }
    );
    fn('reportR2BucketMetrics').mockResolvedValue({ private_key: 'x' });
    await expect(invoke(make().control, 'reportR2BucketMetrics', {})).rejects.toThrow(
      /^control_internal_error$/u
    );
  });

  it.each([['ar-control'], ['ar-lib-core'], ['ar-auth']])(
    'refuses %s as a metric reporter',
    async (caller) => {
      await expect(
        invoke(make({ caller: caller as never }).control, 'reportR2BucketMetrics', {})
      ).rejects.toThrow('control_rpc_caller_unauthorized');
      expect(fn('reportR2BucketMetrics')).not.toHaveBeenCalled();
    }
  );

  it('returns the inventory only to ar-management and checks it for secrets', async () => {
    fn('getR2BucketMetricInventory').mockResolvedValue({ buckets: [] });
    const { control, env } = make();
    await expect(invoke(control, 'getR2BucketMetrics')).resolves.toEqual({ buckets: [] });
    expect(fn('getR2BucketMetricInventory')).toHaveBeenCalledExactlyOnceWith(
      env.CONTROL_DB,
      'env-1'
    );
    await expect(
      invoke(make({ caller: 'ar-plugin-runner' }).control, 'getR2BucketMetrics')
    ).rejects.toThrow('control_rpc_caller_unauthorized');
    fn('getR2BucketMetricInventory').mockResolvedValue({ private_key: 'x' });
    await expect(invoke(make().control, 'getR2BucketMetrics')).rejects.toThrow(
      /^control_internal_error$/u
    );
  });
});
