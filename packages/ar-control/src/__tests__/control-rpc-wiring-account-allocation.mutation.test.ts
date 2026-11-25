import { describe, expect, it, vi } from 'vitest';
import { constructionsOf, fn, invoke, make, must } from './support/control-rpc-harness';
import type { ControlEnv } from '../types';
import { defineWiringSuite, useWiringEnvironment } from './support/rpc-wiring-suite';
import type { WiringRow } from './support/rpc-wiring-table';

const recorder = vi.hoisted(() => () => import('./support/control-rpc-recorder'));
vi.mock('../service', async (orig) =>
  (await recorder()).partial(await orig(), { ControlService: [] })
);
vi.mock('../repository', async (orig) =>
  (await recorder()).partial(await orig(), { D1ControlRepository: [] })
);
vi.mock('../account-allocation', async (orig) =>
  (await recorder()).partial(await orig(), {
    ControlAccountAllocationService: [],
    D1AccountAllocationRepository: [],
  })
);
vi.mock('../account-scale-out-forecast', async (orig) =>
  (await recorder()).partial(await orig(), { AccountScaleOutForecastService: [] })
);
vi.mock('../tenant-default-allocation', async (orig) =>
  (await recorder()).partial(await orig(), { TenantDefaultAllocationService: [] })
);

useWiringEnvironment();

const allocation = (method: string) => ({
  call: `ControlAccountAllocationService.${method}`,
  dbClasses: ['D1AccountAllocationRepository'],
  clock: { cls: 'ControlAccountAllocationService', index: 1 },
  noSecretCheck: true,
});
const defaults = (method: string) => ({
  call: `TenantDefaultAllocationService.${method}`,
  dbClasses: ['TenantDefaultAllocationService'],
  clock: { cls: 'TenantDefaultAllocationService', index: 1 },
  noSecretCheck: true,
});

const ROWS: readonly WiringRow[] = [
  {
    rpc: 'commitAccountRoute',
    input: { a: 1 },
    ...allocation('commit'),
    args: [{ a: 1 }, 'env-1'],
  },
  {
    rpc: 'releaseAccountRoute',
    input: { a: 2 },
    ...allocation('release'),
    args: [{ a: 2 }, 'env-1'],
  },
  {
    rpc: 'reserveTenantDefaultRoute',
    input: { a: 3 },
    ...defaults('reserve'),
    args: [{ a: 3 }, 'env-1'],
  },
  {
    rpc: 'commitTenantDefaultRoute',
    input: { a: 4 },
    ...defaults('mutate'),
    args: [{ a: 4 }, 'env-1', 'commit'],
  },
  {
    rpc: 'releaseTenantDefaultRoute',
    input: { a: 5 },
    ...defaults('mutate'),
    args: [{ a: 5 }, 'env-1', 'release'],
  },
];
defineWiringSuite('Control account and default route RPC', ROWS);

const READY: Partial<ControlEnv> = {
  AUTHRIM_AUTOMATIC_PROVISIONING: 'true',
  CLOUDFLARE_D1_API_TOKEN: ' d1-token ',
  CLOUDFLARE_WORKERS_API_TOKEN: 'workers-token',
};
const REQUEST_A = { id: 'request-a' };
const REQUEST_B = { id: 'request-b' };
const VIEWS = [{ view: 1 }];

async function allocateAndSettle(
  overrides: Parameters<typeof make>[1],
  rpc = 'allocateAccountRoute'
): Promise<{
  waitUntil: ReturnType<typeof make>['waitUntil'];
  env: ReturnType<typeof make>['env'];
}> {
  fn('ControlAccountAllocationService.allocate').mockResolvedValue({ tenantId: 'tenant-1' });
  fn('ControlAccountAllocationService.tryAllocate').mockResolvedValue({
    state: 'allocated',
    allocation: { tenantId: 'tenant-1' },
  });
  const { control, waitUntil, env } = make({}, overrides);
  await invoke(control, rpc, { account: 1 });
  expect(waitUntil).toHaveBeenCalledTimes(1);
  await must(waitUntil.mock.calls[0])[0];
  return { waitUntil, env };
}

describe('allocateAccountRoute', () => {
  it('returns the allocation and forwards the exact input', async () => {
    fn('ControlAccountAllocationService.allocate').mockResolvedValue({ tenantId: 'tenant-1' });
    fn('AccountScaleOutForecastService.observe').mockResolvedValue({
      capacityRequests: [],
      views: VIEWS,
    });
    const { control, env } = make();
    await expect(invoke(control, 'allocateAccountRoute', { account: 1 })).resolves.toEqual({
      tenantId: 'tenant-1',
    });
    expect(fn('ControlAccountAllocationService.allocate')).toHaveBeenCalledExactlyOnceWith(
      { account: 1 },
      'env-1'
    );
    expect(must(constructionsOf('D1AccountAllocationRepository')[0]).args).toEqual([
      env.CONTROL_DB,
    ]);
  });

  it('rejects unauthorized callers before allocating', async () => {
    await expect(
      invoke(make({ caller: 'ar-lib-core' }).control, 'allocateAccountRoute', {})
    ).rejects.toThrow('control_rpc_caller_unauthorized');
    await expect(
      invoke(make({ caller: 'ar-lib-core' }).control, 'tryAllocateAccountRoute', {})
    ).rejects.toThrow('control_rpc_caller_unauthorized');
    expect(fn('ControlAccountAllocationService.allocate')).not.toHaveBeenCalled();
    expect(fn('ControlAccountAllocationService.tryAllocate')).not.toHaveBeenCalled();
  });

  it('observes the forecast for the tenant and stops when no capacity is requested', async () => {
    fn('AccountScaleOutForecastService.observe').mockResolvedValue({
      capacityRequests: [],
      views: VIEWS,
    });
    const { env } = await allocateAndSettle(READY);
    expect(fn('AccountScaleOutForecastService.observe')).toHaveBeenCalledExactlyOnceWith(
      'env-1',
      'tenant-1'
    );
    const [database, now] = must(constructionsOf('AccountScaleOutForecastService')[0]).args;
    expect(database).toBe(env.CONTROL_DB);
    expect((now as () => number)()).toBe(1_700_000_000);
    expect(fn('D1ControlRepository.hasReadyAutomaticProvisioning')).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...READY, AUTHRIM_AUTOMATIC_PROVISIONING: 'false' }],
    [{ ...READY, CLOUDFLARE_D1_API_TOKEN: undefined }],
    [{ ...READY, CLOUDFLARE_D1_API_TOKEN: '   ' }],
    [{ ...READY, CLOUDFLARE_WORKERS_API_TOKEN: undefined }],
    [{ ...READY, CLOUDFLARE_WORKERS_API_TOKEN: '  ' }],
    [{ ...READY, CLOUDFLARE_WORKERS_API_TOKEN: ' d1-token' }],
  ])('does not request capacity without distinct provider credentials %j', async (overrides) => {
    fn('AccountScaleOutForecastService.observe').mockResolvedValue({
      capacityRequests: [REQUEST_A],
      views: VIEWS,
    });
    await allocateAndSettle(overrides as Partial<ControlEnv>);
    expect(fn('D1ControlRepository.hasReadyAutomaticProvisioning')).not.toHaveBeenCalled();
    expect(fn('ControlService.requestAccountScaleOutCapacity')).not.toHaveBeenCalled();
  });

  it('does not request capacity until automatic provisioning is ready', async () => {
    fn('AccountScaleOutForecastService.observe').mockResolvedValue({
      capacityRequests: [REQUEST_A],
      views: VIEWS,
    });
    fn('D1ControlRepository.hasReadyAutomaticProvisioning').mockResolvedValue(false);
    await allocateAndSettle(READY);
    expect(fn('D1ControlRepository.hasReadyAutomaticProvisioning')).toHaveBeenCalledTimes(1);
    expect(fn('ControlService.requestAccountScaleOutCapacity')).not.toHaveBeenCalled();
  });

  it('records each outcome of the capacity requests in order', async () => {
    fn('AccountScaleOutForecastService.observe').mockResolvedValue({
      capacityRequests: [REQUEST_A, REQUEST_B, { id: 'c' }, { id: 'd' }, { id: 'e' }],
      views: VIEWS,
    });
    fn('D1ControlRepository.hasReadyAutomaticProvisioning').mockResolvedValue(true);
    fn('ControlService.requestAccountScaleOutCapacity')
      .mockResolvedValueOnce({
        operation: { operationId: 'op-1', status: 'running', lastErrorCode: null },
      })
      .mockResolvedValueOnce({ operation: null })
      .mockRejectedValueOnce(new Error('control_d1_resource_limit'))
      .mockRejectedValueOnce(new Error('transient failure'))
      .mockRejectedValueOnce(new Error('invalid_account_scale_out'));
    const { env } = await allocateAndSettle(READY);
    expect(fn('ControlService.requestAccountScaleOutCapacity').mock.calls).toEqual([
      [REQUEST_A, 'env-1'],
      [REQUEST_B, 'env-1'],
      [{ id: 'c' }, 'env-1'],
      [{ id: 'd' }, 'env-1'],
      [{ id: 'e' }, 'env-1'],
    ]);
    expect(fn('AccountScaleOutForecastService.recordProvisioningOperation').mock.calls).toEqual([
      [
        {
          request: REQUEST_A,
          operationId: 'op-1',
          operationStatus: 'running',
          lastErrorCode: null,
        },
      ],
    ]);
    expect(fn('AccountScaleOutForecastService.recordCapacityRequestFailure').mock.calls).toEqual([
      [REQUEST_B, 'account_scale_out_capacity_operation_pending', false],
      [{ id: 'c' }, 'control_d1_resource_limit', true],
      [{ id: 'd' }, 'account_scale_out_capacity_request_retry', false],
      [{ id: 'e' }, 'invalid_account_scale_out', true],
    ]);
    const control = must(constructionsOf('ControlService')[0]).args[0] as {
      repository: unknown;
      env: unknown;
      now: () => number;
    };
    expect(control.now()).toBe(1_700_000_000);
    expect(control.env).toBe(env);
    expect(must(constructionsOf('D1ControlRepository').at(-1)).args).toEqual([env.CONTROL_DB]);
  });

  it.each([new Error('forecast store down'), 'plain string'])(
    'swallows a forecast failure (%s) so the allocation still succeeds',
    async (failure) => {
      fn('AccountScaleOutForecastService.observe').mockRejectedValue(failure);
      const { waitUntil } = await allocateAndSettle(READY);
      expect(waitUntil).toHaveBeenCalledTimes(1);
    }
  );
});

describe('tryAllocateAccountRoute', () => {
  it('reconciles the forecast only for a fresh allocation', async () => {
    fn('AccountScaleOutForecastService.observe').mockResolvedValue({
      capacityRequests: [],
      views: VIEWS,
    });
    await allocateAndSettle(READY, 'tryAllocateAccountRoute');
    expect(fn('ControlAccountAllocationService.tryAllocate')).toHaveBeenCalledExactlyOnceWith(
      { account: 1 },
      'env-1'
    );
    expect(fn('AccountScaleOutForecastService.observe')).toHaveBeenCalledExactlyOnceWith(
      'env-1',
      'tenant-1'
    );
    const allocator = must(constructionsOf('ControlAccountAllocationService')[0]);
    expect((allocator.args[1] as () => number)()).toBe(1_700_000_000);
    expect(allocator.args[0]).toBe(
      must(constructionsOf('D1AccountAllocationRepository')[0]).instance
    );
  });

  it.each(['busy', 'exists', 'capacity_unavailable'])(
    'does not reconcile the forecast when the state is %s',
    async (state) => {
      const attempt = { state };
      fn('ControlAccountAllocationService.tryAllocate').mockResolvedValue(attempt);
      const { control, waitUntil } = make();
      await expect(invoke(control, 'tryAllocateAccountRoute', {})).resolves.toBe(attempt);
      expect(waitUntil).not.toHaveBeenCalled();
      expect(fn('AccountScaleOutForecastService.observe')).not.toHaveBeenCalled();
    }
  );

  it('swallows a forecast failure after a fresh allocation', async () => {
    fn('AccountScaleOutForecastService.observe').mockRejectedValue(new Error('down'));
    const { waitUntil } = await allocateAndSettle(READY, 'tryAllocateAccountRoute');
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it('masks allocation failures', async () => {
    fn('ControlAccountAllocationService.tryAllocate').mockRejectedValue(new Error('db'));
    await expect(invoke(make().control, 'tryAllocateAccountRoute', {})).rejects.toThrow(
      /^control_internal_error$/u
    );
    fn('ControlAccountAllocationService.allocate').mockRejectedValue(
      new Error('control_account_allocation_capacity_unavailable')
    );
    await expect(invoke(make().control, 'allocateAccountRoute', {})).rejects.toThrow(
      /^control_account_allocation_capacity_unavailable$/u
    );
  });
});
