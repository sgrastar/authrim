import { describe, expect, it, vi } from 'vitest';
import { fn, invoke, make } from './support/control-rpc-harness';
import { useWiringEnvironment } from './support/rpc-wiring-suite';

const recorder = vi.hoisted(() => () => import('./support/control-rpc-recorder'));
vi.mock('../service', async (orig) =>
  (await recorder()).partial(await orig(), { ControlService: [] })
);
vi.mock('../repository', async (orig) =>
  (await recorder()).partial(await orig(), { D1ControlRepository: [] })
);
vi.mock('../lookup-hmac-key-state', async (orig) =>
  (await recorder()).partial(await orig(), { LookupHmacKeyStateService: [] })
);
vi.mock('../lookup-hmac-key-state-publisher', async (orig) =>
  (await recorder()).partial(await orig(), { LookupHmacKeyStatePublisher: [] })
);
vi.mock('../lookup-registry-publisher', async (orig) =>
  (await recorder()).partial(await orig(), { LookupRegistryPublisher: [] })
);
vi.mock('../lookup-bucket-migration', async (orig) =>
  (await recorder()).partial(await orig(), { LookupBucketMigrationService: [] })
);
vi.mock('../lookup-hmac-candidate-verifier', async (orig) =>
  (await recorder()).partial(await orig(), { D1LookupHmacCandidateVerificationRepository: [] })
);
vi.mock('../lookup-scale-out-forecast', async (orig) =>
  (await recorder()).partial(await orig(), { LookupScaleOutForecastService: [] })
);
vi.mock('../read-replication', async (orig) =>
  (await recorder()).partial(await orig(), { ReadReplicationService: [] })
);
vi.mock('../service-site-binding', async (orig) =>
  (await recorder()).partial(await orig(), { ServiceSiteBindingService: [] })
);
vi.mock('../service-site-binding-reconciler', async (orig) =>
  (await recorder()).partial(await orig(), { ServiceSiteBindingReconciler: [] })
);
vi.mock('../service-site-binding-repository', async (orig) =>
  (await recorder()).partial(await orig(), { D1ServiceSiteBindingRepository: [] })
);
vi.mock('../control-api-clients', async () => {
  const { fn: recorded } = await recorder();
  return {
    createControlApiClients: (...args: unknown[]) => recorded('createControlApiClients')(...args),
  };
});

useWiringEnvironment();

const SNAPSHOT = { ownerId: 'owner-1', observedAt: 5, buckets: [] };
const REQUEST = { lookupCapacityDomainId: 'domain-a', want: 1 };
const VIEWS = [
  {
    lookupCapacityDomainId: 'domain-a',
    status: 'pending',
    requestedOperationId: 'old',
    lastErrorCode: null,
  },
  {
    lookupCapacityDomainId: 'domain-b',
    status: 'pending',
    requestedOperationId: 'other',
    lastErrorCode: 'keep',
  },
];
const OTHER = VIEWS[1];

function observe(capacityRequest: unknown): void {
  fn('LookupScaleOutForecastService.observe').mockResolvedValue({
    views: VIEWS,
    capacityRequest,
  });
}

const call = () => invoke(make().control, 'reconcileLookupScaleOut', SNAPSHOT);

describe('reconcileLookupScaleOut', () => {
  it('returns the views untouched when no capacity is requested', async () => {
    observe(null);
    await expect(call()).resolves.toBe(VIEWS);
    expect(fn('LookupScaleOutForecastService.observe')).toHaveBeenCalledExactlyOnceWith(
      'env-1',
      SNAPSHOT
    );
    expect(fn('ControlService.requestLookupScaleOutCapacity')).not.toHaveBeenCalled();
  });

  it.each([
    'invalid_lookup_domain',
    'control_d1_resource_limit',
    'control_environment_not_found',
    'control_lookup_capacity_domain_mismatch',
    'control_residency_partition_not_found',
    'control_resource_policy_not_found',
    'control_operation_idempotency_conflict',
  ])('blocks the domain for the terminal error %s', async (code) => {
    observe(REQUEST);
    fn('ControlService.requestLookupScaleOutCapacity').mockRejectedValue(new Error(code));
    await expect(call()).resolves.toEqual([
      { ...VIEWS[0], status: 'blocked', lastErrorCode: code },
      OTHER,
    ]);
    expect(fn('ControlService.requestLookupScaleOutCapacity')).toHaveBeenCalledExactlyOnceWith(
      REQUEST,
      'env-1'
    );
    expect(
      fn('LookupScaleOutForecastService.blockCapacityRequest')
    ).toHaveBeenCalledExactlyOnceWith('env-1', REQUEST, code);
    expect(fn('LookupScaleOutForecastService.recordCapacityRequestRetry')).not.toHaveBeenCalled();
  });

  it.each([
    new Error('control_d1_resource_limit_extra'),
    new Error('xinvalid_a'),
    new Error('control_other'),
    new Error(''),
    'invalid_string_throw',
  ])('retries the domain for the non terminal failure %s', async (failure) => {
    observe(REQUEST);
    fn('ControlService.requestLookupScaleOutCapacity').mockRejectedValue(failure);
    await expect(call()).resolves.toEqual([
      {
        ...VIEWS[0],
        status: 'provisioning',
        requestedOperationId: null,
        lastErrorCode: 'lookup_scale_out_capacity_request_retry',
      },
      OTHER,
    ]);
    expect(
      fn('LookupScaleOutForecastService.recordCapacityRequestRetry')
    ).toHaveBeenCalledExactlyOnceWith('env-1', REQUEST, 'lookup_scale_out_capacity_request_retry');
    expect(fn('LookupScaleOutForecastService.blockCapacityRequest')).not.toHaveBeenCalled();
  });

  it('keeps the domain provisioning while the operation is still pending', async () => {
    observe(REQUEST);
    fn('ControlService.requestLookupScaleOutCapacity').mockResolvedValue({ operation: null });
    await expect(call()).resolves.toEqual([
      {
        ...VIEWS[0],
        status: 'provisioning',
        lastErrorCode: 'lookup_scale_out_capacity_operation_pending',
      },
      OTHER,
    ]);
    expect(
      fn('LookupScaleOutForecastService.recordCapacityRequestRetry')
    ).toHaveBeenCalledExactlyOnceWith(
      'env-1',
      REQUEST,
      'lookup_scale_out_capacity_operation_pending'
    );
    expect(fn('LookupScaleOutForecastService.recordProvisioningOperation')).not.toHaveBeenCalled();
  });

  it.each([
    ['running', null, 'pending', null],
    ['blocked', 'op_error', 'blocked', 'op_error'],
    ['blocked', null, 'blocked', 'lookup_scale_out_capacity_operation_blocked'],
    ['canceled', 'cancel_error', 'blocked', 'cancel_error'],
    ['canceled', null, 'blocked', 'lookup_scale_out_capacity_operation_blocked'],
    ['succeeded', 'ignored', 'pending', null],
  ])('records an %s operation (error %s)', async (status, lastErrorCode, viewStatus, viewError) => {
    observe(REQUEST);
    fn('ControlService.requestLookupScaleOutCapacity').mockResolvedValue({
      operation: { operationId: 'op-9', status, lastErrorCode },
    });
    await expect(call()).resolves.toEqual([
      { ...VIEWS[0], status: viewStatus, requestedOperationId: 'op-9', lastErrorCode: viewError },
      OTHER,
    ]);
    expect(
      fn('LookupScaleOutForecastService.recordProvisioningOperation')
    ).toHaveBeenCalledExactlyOnceWith('env-1', REQUEST, 'op-9', status, lastErrorCode);
    expect(fn('LookupScaleOutForecastService.recordCapacityRequestRetry')).not.toHaveBeenCalled();
  });

  it('rejects callers other than ar-management before observing', async () => {
    await expect(
      invoke(make({ caller: 'ar-plugin-runner' }).control, 'reconcileLookupScaleOut', SNAPSHOT)
    ).rejects.toThrow('control_rpc_caller_unauthorized');
    expect(fn('LookupScaleOutForecastService.observe')).not.toHaveBeenCalled();
  });

  it('refuses views that carry secret material', async () => {
    fn('LookupScaleOutForecastService.observe').mockResolvedValue({
      views: [{ private_key: 'x' }],
      capacityRequest: null,
    });
    await expect(call()).rejects.toThrow(/^control_internal_error$/u);
  });

  it.each([
    [
      'a terminal failure',
      () =>
        fn('ControlService.requestLookupScaleOutCapacity').mockRejectedValue(
          new Error('invalid_x')
        ),
    ],
    [
      'a transient failure',
      () => fn('ControlService.requestLookupScaleOutCapacity').mockRejectedValue(new Error('x')),
    ],
    [
      'a pending operation',
      () =>
        fn('ControlService.requestLookupScaleOutCapacity').mockResolvedValue({ operation: null }),
    ],
    [
      'a recorded operation',
      () =>
        fn('ControlService.requestLookupScaleOutCapacity').mockResolvedValue({
          operation: { operationId: 'op', status: 'running', lastErrorCode: null },
        }),
    ],
  ])('refuses secret material in the views after %s', async (_name, arrange) => {
    fn('LookupScaleOutForecastService.observe').mockResolvedValue({
      views: [{ lookupCapacityDomainId: 'domain-a', status: 'pending', private_key: 'x' }],
      capacityRequest: REQUEST,
    });
    arrange();
    await expect(call()).rejects.toThrow(/^control_internal_error$/u);
  });
});
