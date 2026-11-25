import { describe, expect, it, vi } from 'vitest';
import { constructionsOf, fn, invoke, make, must } from './support/control-rpc-harness';
import { RESULT } from './support/rpc-wiring-table';
import { useWiringEnvironment } from './support/rpc-wiring-suite';

const logger = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  createLogger: () => ({ module: () => logger }),
}));
const recorder = vi.hoisted(() => () => import('./support/control-rpc-recorder'));
vi.mock('../repository', async (orig) =>
  (await recorder()).partial(await orig(), { D1ControlRepository: [] })
);
vi.mock('../control-api-clients', async () => {
  const { fn: recorded } = await recorder();
  return {
    createControlApiClients: (...args: unknown[]) => recorded('createControlApiClients')(...args),
  };
});
vi.mock('../storage-topology', async () => {
  const { fn: recorded } = await recorder();
  return {
    getControlStorageTopology: (...args: unknown[]) =>
      recorded('getControlStorageTopology')(...args),
  };
});
vi.mock('../runtime-registry-signer', async () => {
  const { fn: recorded } = await recorder();
  return {
    runtimeRegistrySignerMetadata: (...args: unknown[]) =>
      recorded('runtimeRegistrySignerMetadata')(...args),
    signRuntimeRegistryPayload: (...args: unknown[]) =>
      recorded('signRuntimeRegistryPayload')(...args),
  };
});

useWiringEnvironment();

const ROW = {
  finding_id: 'drift:env-1:actual_only:worker-a',
  environment_id: 'env-1',
  worker_script_name: 'worker-a',
  finding_kind: 'actual_only',
  severity: 'warning',
  review_state: 'unreviewed',
  notification_state: 'pending',
  first_observed_at: 10,
  last_observed_at: 20,
  resolved_at: null,
  notified_at: 30,
} as const;
const FINDING = {
  findingId: 'drift:env-1:actual_only:worker-a',
  environmentId: 'env-1',
  workerScriptName: 'worker-a',
  findingKind: 'actual_only',
  severity: 'warning',
  reviewState: 'unreviewed',
  notificationState: 'pending',
  firstObservedAt: 10,
  lastObservedAt: 20,
  resolvedAt: null,
  notifiedAt: 30,
};

describe('worker inventory drift listings', () => {
  it('projects pending findings into notifications without review fields', async () => {
    fn('D1ControlRepository.listPendingWorkerInventoryDriftFindings').mockResolvedValue([ROW]);
    const { control, env } = make();
    await expect(invoke(control, 'listPendingWorkerInventoryDriftFindings')).resolves.toEqual([
      {
        findingId: ROW.finding_id,
        environmentId: 'env-1',
        workerScriptName: 'worker-a',
        findingKind: 'actual_only',
        severity: 'warning',
        firstObservedAt: 10,
        lastObservedAt: 20,
      },
    ]);
    expect(
      fn('D1ControlRepository.listPendingWorkerInventoryDriftFindings')
    ).toHaveBeenCalledExactlyOnceWith('env-1', 100);
    expect(must(constructionsOf('D1ControlRepository')[0]).args).toEqual([env.CONTROL_DB]);
  });

  it('maps every column of the full finding listing', async () => {
    fn('D1ControlRepository.listWorkerInventoryDriftFindings').mockResolvedValue([ROW]);
    await expect(invoke(make().control, 'listWorkerInventoryDriftFindings')).resolves.toEqual([
      FINDING,
    ]);
    expect(
      fn('D1ControlRepository.listWorkerInventoryDriftFindings')
    ).toHaveBeenCalledExactlyOnceWith('env-1', 100);
  });

  it.each(['listPendingWorkerInventoryDriftFindings', 'listWorkerInventoryDriftFindings'])(
    '%s rejects other callers and returns an empty list for no rows',
    async (rpc) => {
      await expect(invoke(make({ caller: 'ar-lib-core' }).control, rpc)).rejects.toThrow(
        'control_rpc_caller_unauthorized'
      );
      fn(`D1ControlRepository.${rpc}`).mockResolvedValue([]);
      await expect(invoke(make().control, rpc)).resolves.toEqual([]);
    }
  );

  it('refuses findings whose worker name carries a bearer credential', async () => {
    fn('D1ControlRepository.listWorkerInventoryDriftFindings').mockResolvedValue([
      { ...ROW, worker_script_name: 'Bearer abc.def' },
    ]);
    await expect(invoke(make().control, 'listWorkerInventoryDriftFindings')).rejects.toThrow(
      /^control_internal_error$/u
    );
  });
});

describe('reviewWorkerInventoryDriftFinding', () => {
  const request = {
    findingId: ROW.finding_id,
    disposition: 'dismissed',
    reviewedBy: 'reviewer-1',
    idempotencyKey: 'idem-1',
  };

  it('reviews the finding and returns the projected row', async () => {
    fn('D1ControlRepository.reviewWorkerInventoryDriftFinding').mockResolvedValue({
      ...ROW,
      review_state: 'dismissed',
      resolved_at: 40,
    });
    await expect(
      invoke(make().control, 'reviewWorkerInventoryDriftFinding', request)
    ).resolves.toEqual({
      ...FINDING,
      reviewState: 'dismissed',
      resolvedAt: 40,
    });
    expect(
      fn('D1ControlRepository.reviewWorkerInventoryDriftFinding')
    ).toHaveBeenCalledExactlyOnceWith('env-1', request, 1_700_000_000);
  });

  it('accepts the reviewed disposition', async () => {
    fn('D1ControlRepository.reviewWorkerInventoryDriftFinding').mockResolvedValue(ROW);
    await invoke(make().control, 'reviewWorkerInventoryDriftFinding', {
      ...request,
      disposition: 'reviewed',
    });
    expect(fn('D1ControlRepository.reviewWorkerInventoryDriftFinding')).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ ...request, disposition: 'resolved' }],
    [{ ...request, reviewedBy: '' }],
    [{ ...request, reviewedBy: 'x'.repeat(201) }],
    [{ ...request, reviewedBy: 'a\u001fb' }],
    [{ ...request, reviewedBy: 5 }],
    [{ ...request, idempotencyKey: '-k' }],
    [{ ...request, idempotencyKey: 5 }],
    [{ ...request, idempotencyKey: `a${'b'.repeat(256)}` }],
    [{ ...request, extra: 1 }],
    [{ findingId: ROW.finding_id }],
    [{ ...request, findingId: 'drift:env-1:other:worker-a' }],
    [{ ...request, findingId: 'drift:env-2:actual_only:worker-a' }],
    [{ ...request, findingId: 'drift:env-1x:actual_only:worker-a' }],
    [{ ...request, findingId: 5 }],
    [{ ...request, findingId: `drift:env-1:actual_only:${'a'.repeat(500)}` }],
    [null],
  ])('rejects %j without touching the repository', async (bad) => {
    await expect(invoke(make().control, 'reviewWorkerInventoryDriftFinding', bad)).rejects.toThrow(
      /^invalid_worker_inventory_drift_(review|finding_ids)$/u
    );
    expect(fn('D1ControlRepository.reviewWorkerInventoryDriftFinding')).not.toHaveBeenCalled();
  });

  it('accepts the longest permitted reviewer and key', async () => {
    fn('D1ControlRepository.reviewWorkerInventoryDriftFinding').mockResolvedValue(ROW);
    const longest = {
      ...request,
      reviewedBy: 'x'.repeat(200),
      idempotencyKey: `a${'b'.repeat(255)}`,
    };
    await invoke(make().control, 'reviewWorkerInventoryDriftFinding', longest);
    expect(
      fn('D1ControlRepository.reviewWorkerInventoryDriftFinding')
    ).toHaveBeenCalledExactlyOnceWith('env-1', longest, 1_700_000_000);
  });
});

describe('acknowledgeWorkerInventoryDriftNotifications', () => {
  const id = (name: string) => `drift:env-1:actual_only:${name}`;

  it('acknowledges up to one hundred unique finding ids and returns nothing', async () => {
    const ids = Array.from({ length: 100 }, (_, index) => id(`w${index}`));
    fn('D1ControlRepository.acknowledgeWorkerInventoryDriftNotifications').mockResolvedValue(
      'ignored'
    );
    await expect(
      invoke(make().control, 'acknowledgeWorkerInventoryDriftNotifications', ids)
    ).resolves.toBeUndefined();
    expect(
      fn('D1ControlRepository.acknowledgeWorkerInventoryDriftNotifications')
    ).toHaveBeenCalledExactlyOnceWith('env-1', ids, 1_700_000_000);
  });

  it.each([
    [[]],
    [Array.from({ length: 101 }, (_, index) => id(`w${index}`))],
    ['not-an-array'],
    [[id('a'), id('a')]],
    [[5]],
    [['drift:env-1:other:a']],
    [['drift::actual_only:a']],
    [['drift:env-1:actual_only:']],
    [['drift:env-1:actual_only:a b']],
    [[`drift:env-1:actual_only:${'a'.repeat(512)}`]],
  ])('rejects %j', async (bad) => {
    await expect(
      invoke(make().control, 'acknowledgeWorkerInventoryDriftNotifications', bad)
    ).rejects.toThrow(/^invalid_worker_inventory_drift_finding_ids$/u);
    expect(
      fn('D1ControlRepository.acknowledgeWorkerInventoryDriftNotifications')
    ).not.toHaveBeenCalled();
  });

  it('accepts an id of exactly 512 characters', async () => {
    const prefix = 'drift:env-1:actual_only:';
    const longest = `${prefix}${'a'.repeat(512 - prefix.length)}`;
    await invoke(make().control, 'acknowledgeWorkerInventoryDriftNotifications', [longest]);
    expect(
      fn('D1ControlRepository.acknowledgeWorkerInventoryDriftNotifications')
    ).toHaveBeenCalledExactlyOnceWith('env-1', [longest], 1_700_000_000);
  });
});

describe('getStorageTopology logging', () => {
  it.each([
    [new TypeError('boom'), 'TypeError'],
    [Object.assign(new Error('boom'), { name: 'Bad-Name' }), 'NonErrorThrow'],
    ['plain', 'NonErrorThrow'],
  ])('warns once about the unavailable inventory (%s)', async (failure, errorType) => {
    logger.warn.mockClear();
    fn('createControlApiClients').mockReturnValue({
      d1: {
        listD1Databases: () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- the failure may be a non-Error value on purpose
          throw failure;
        },
      },
    });
    fn('getControlStorageTopology').mockResolvedValue(RESULT);
    await invoke(make().control, 'getStorageTopology');
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      'Cloudflare D1 inventory unavailable for storage topology',
      { action: 'get_storage_topology', errorType }
    );
  });

  it('names the action when the topology itself fails', async () => {
    logger.error.mockClear();
    fn('createControlApiClients').mockReturnValue({
      d1: { listD1Databases: () => Promise.resolve([]) },
    });
    fn('getControlStorageTopology').mockRejectedValue(new Error('db'));
    await expect(invoke(make().control, 'getStorageTopology')).rejects.toThrow(
      /^control_internal_error$/u
    );
    expect(logger.error.mock.calls[0]?.[1]).toMatchObject({ action: 'get_storage_topology' });
  });
});

describe('getStorageTopology', () => {
  it('passes the provider inventory to the topology builder', async () => {
    const databases = [{ id: 'db-1' }];
    fn('createControlApiClients').mockReturnValue({
      d1: { listD1Databases: () => Promise.resolve(databases) },
    });
    fn('getControlStorageTopology').mockResolvedValue(RESULT);
    const { control, env } = make();
    await expect(invoke(control, 'getStorageTopology')).resolves.toBe(RESULT);
    expect(fn('getControlStorageTopology')).toHaveBeenCalledExactlyOnceWith({
      database: env.CONTROL_DB,
      environmentId: 'env-1',
      generatedAt: 1_700_000_000,
      providerDatabases: databases,
    });
  });

  it.each([new Error('cloudflare down'), 'plain'])(
    'degrades to a null inventory when the provider lookup fails (%s)',
    async (failure) => {
      fn('createControlApiClients').mockReturnValue({
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the failure may be a non-Error value on purpose
        d1: { listD1Databases: () => Promise.reject(failure) },
      });
      fn('getControlStorageTopology').mockResolvedValue(RESULT);
      await expect(invoke(make().control, 'getStorageTopology')).resolves.toBe(RESULT);
      expect(fn('getControlStorageTopology').mock.calls[0]?.[0]).toMatchObject({
        providerDatabases: null,
      });
    }
  );

  it('degrades when client construction itself throws', async () => {
    fn('createControlApiClients').mockImplementation(() => {
      throw new Error('missing token');
    });
    fn('getControlStorageTopology').mockResolvedValue(RESULT);
    await expect(invoke(make().control, 'getStorageTopology')).resolves.toBe(RESULT);
    expect(fn('getControlStorageTopology').mock.calls[0]?.[0]).toMatchObject({
      providerDatabases: null,
    });
  });

  it('rejects other callers before any provider call', async () => {
    await expect(
      invoke(make({ caller: 'ar-plugin-runner' }).control, 'getStorageTopology')
    ).rejects.toThrow('control_rpc_caller_unauthorized');
    expect(fn('createControlApiClients')).not.toHaveBeenCalled();
    expect(fn('getControlStorageTopology')).not.toHaveBeenCalled();
  });
});

describe('runtime registry signer RPCs', () => {
  it('returns the signer metadata for authorized callers only', async () => {
    fn('runtimeRegistrySignerMetadata').mockReturnValue({ keyId: 'k1' });
    const { control, env } = make();
    await expect(invoke(control, 'getRuntimeRegistrySignerMetadata')).resolves.toEqual({
      keyId: 'k1',
    });
    expect(fn('runtimeRegistrySignerMetadata')).toHaveBeenCalledExactlyOnceWith(env);
    await expect(
      invoke(make({ audience: 'x' as never }).control, 'getRuntimeRegistrySignerMetadata')
    ).rejects.toThrow('control_rpc_caller_unauthorized');
  });

  it('signs payloads and only inspects the public descriptor fields', async () => {
    const signed = {
      keyId: 'k1',
      algorithm: 'EdDSA',
      type: 'JWT',
      signature: 'Bearer-looking-but-opaque',
    };
    fn('signRuntimeRegistryPayload').mockResolvedValue(signed);
    const { control, env } = make();
    await expect(invoke(control, 'signRuntimeRegistryPayload', { payload: 1 })).resolves.toBe(
      signed
    );
    expect(fn('signRuntimeRegistryPayload')).toHaveBeenCalledExactlyOnceWith(env, { payload: 1 });
    fn('signRuntimeRegistryPayload').mockResolvedValue({ ...signed, keyId: 'Bearer abc' });
    await expect(invoke(make().control, 'signRuntimeRegistryPayload', {})).rejects.toThrow(
      /^control_internal_error$/u
    );
    await expect(
      invoke(make({ caller: 'ar-lib-core' }).control, 'signRuntimeRegistryPayload', {})
    ).rejects.toThrow('control_rpc_caller_unauthorized');
  });
});
