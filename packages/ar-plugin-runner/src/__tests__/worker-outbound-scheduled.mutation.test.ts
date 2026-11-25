import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PluginRunnerWorker, {
  createDynamicPluginHostInterfaces,
  PluginAccountMetadataAccess,
  PluginDynamicOutbound,
  RuntimeSmokeEntrypoint,
} from '../worker';
import { rejectOpaque, callsTo, log, must, outcomes, resetKit } from './helpers/mock-kit';

vi.mock('@authrim/ar-lib-core/services/tenant-portability/saml-dr-writer', () => ({
  runSamlDrCoveredOperation: (
    env: unknown,
    ctx: unknown,
    op: (env: unknown, ctx: unknown) => unknown
  ) => op(env, ctx),
  runSamlDrCoveredFetch: (
    env: unknown,
    ctx: unknown,
    op: (env: unknown, ctx: unknown) => unknown
  ) => op(env, ctx),
}));
vi.mock('../account-metadata', async () => {
  const kit = await import('./helpers/mock-kit');
  return {
    PluginAccountMetadataService: kit.mockClass('PluginAccountMetadataService', [
      'handle',
      'write',
    ]),
    isPluginAccountMetadataRequest: kit.mockFn('isPluginAccountMetadataRequest'),
  };
});
vi.mock('../outbound-gateway', async () => ({
  PluginOutboundGateway: (await import('./helpers/mock-kit')).mockClass('PluginOutboundGateway', [
    'fetch',
  ]),
}));
vi.mock('../resource-bindings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../resource-bindings')>()),
  PluginResourceControlService: (await import('./helpers/mock-kit')).mockClass(
    'PluginResourceControlService',
    ['reflectAndSmoke']
  ),
}));
vi.mock('../scheduler', async () => ({
  PluginRunnerScheduler: (await import('./helpers/mock-kit')).mockClass('PluginRunnerScheduler', [
    'run',
  ]),
}));
vi.mock('../r2-bucket-metrics', async () => ({
  scanAndReportPluginBundleMetrics: (await import('./helpers/mock-kit')).mockFn(
    'scanAndReportPluginBundleMetrics'
  ),
}));
vi.mock('../dynamic-worker-installations', async () => ({
  D1DynamicPluginInstallationStore: (await import('./helpers/mock-kit')).mockClass(
    'D1DynamicPluginInstallationStore',
    ['status', 'configure', 'credentialInputs']
  ),
}));
vi.mock('../config-store', async () => ({
  D1PluginConfigStore: (await import('./helpers/mock-kit')).mockClass('D1PluginConfigStore', [
    'replaceCredentials',
  ]),
}));
vi.mock('../encryption-keyring', async () => ({
  pluginEncryptionKeyringFromEnv: (await import('./helpers/mock-kit')).mockFn(
    'pluginEncryptionKeyringFromEnv'
  ),
}));

const DB = { id: 'plugin-runner-db' };
const CONTEXT = {
  contractVersion: 1,
  tenantId: 'tenant-a',
  pluginInstallationId: 'inst-a',
  capability: 'flow.evaluate',
  requestId: 'req-a',
} as const;
const env = (extra: Record<string, unknown> = {}) => ({
  AUTHRIM_ENVIRONMENT_NAME: 'test',
  PLUGIN_RUNNER_DB: DB,
  PLUGIN_MUTATION_HMAC_KEY: 'hmac-key',
  ...extra,
});

beforeEach(() => {
  resetKit();
});
afterEach(() => {
  vi.useRealTimers();
});

function outbound(e: Record<string, unknown> = env()) {
  return new PluginDynamicOutbound({ props: CONTEXT } as never, e as never);
}
const request = () => new Request('https://example.test/path', { method: 'PUT' });
const STATIC_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
function headersOf(response: Response): Record<string, string> {
  return Object.fromEntries([...response.headers.entries()].sort());
}

describe('PluginDynamicOutbound routing', () => {
  it('serves account metadata requests through the metadata service with a seconds clock', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_123_999);
    const incoming = request();
    outcomes.set('isPluginAccountMetadataRequest', true);
    const served = new Response('ok', { status: 201 });
    outcomes.set('PluginAccountMetadataService.handle', served);
    const e = env();
    await expect(outbound(e).fetch(incoming)).resolves.toBe(served);
    expect(callsTo('isPluginAccountMetadataRequest')).toEqual([[incoming]]);
    const [ctorEnv, hmac, now, context] = must(callsTo('PluginAccountMetadataService.new')[0]);
    expect(ctorEnv).toEqual(e);
    expect(hmac).toBe('hmac-key');
    expect((now as () => number)()).toBe(1_700_000_123);
    expect(context).toBe(CONTEXT);
    expect(callsTo('PluginAccountMetadataService.handle')).toEqual([[incoming]]);
    expect(callsTo('PluginOutboundGateway.new')).toEqual([]);
  });

  it('sends everything else through the egress gateway with the global fetch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_001_000);
    const incoming = request();
    outcomes.set('isPluginAccountMetadataRequest', false);
    const served = new Response('upstream', { status: 200 });
    outcomes.set('PluginOutboundGateway.fetch', served);
    await expect(outbound().fetch(incoming)).resolves.toBe(served);
    const [, fetcher, now, context] = must(callsTo('PluginOutboundGateway.new')[0]);
    expect(fetcher).toBe(fetch);
    expect((now as () => number)()).toBe(1_700_000_001);
    expect(context).toBe(CONTEXT);
    expect(callsTo('PluginOutboundGateway.fetch')).toEqual([[incoming]]);
    expect(callsTo('PluginAccountMetadataService.new')).toEqual([]);
  });

  it.each([
    ['plugin_data_method_denied', 405, { ...STATIC_HEADERS, allow: 'PUT' }],
    ['plugin_data_input_invalid', 400, STATIC_HEADERS],
    ['plugin_data_scope_denied', 403, STATIC_HEADERS],
    ['plugin_data_account_unavailable', 404, STATIC_HEADERS],
    ['plugin_data_version_conflict', 409, STATIC_HEADERS],
    ['plugin_data_idempotency_conflict', 409, STATIC_HEADERS],
    ['plugin_data_idempotency_key_unavailable', 503, STATIC_HEADERS],
    ['something else', 503, STATIC_HEADERS],
    ['', 503, STATIC_HEADERS],
  ])(
    'maps metadata failure %j to %i with fixed headers and no body',
    async (code, status, headers) => {
      outcomes.set('isPluginAccountMetadataRequest', true);
      outcomes.set('PluginAccountMetadataService.handle', new Error(code));
      const response = await outbound().fetch(request());
      expect(response.status).toBe(status);
      expect(headersOf(response)).toEqual(headers);
      expect(await response.text()).toBe('');
    }
  );

  it('maps a non-Error metadata failure to 503', async () => {
    outcomes.set('isPluginAccountMetadataRequest', true);
    outcomes.set('PluginAccountMetadataService.handle', () =>
      rejectOpaque('plugin_data_input_invalid')
    );
    const response = await outbound().fetch(request());
    expect(response.status).toBe(503);
    expect(headersOf(response)).toEqual(STATIC_HEADERS);
  });

  it.each([
    ['plugin_egress_rate_limited', 429],
    ['plugin_egress_request_too_large', 413],
    ['plugin_egress_host_denied', 403],
    ['plugin_egress_wildcard_requires_controlled_proxy', 403],
    ['plugin_egress_method_denied', 403],
    ['plugin_egress_upstream_failed', 502],
    ['', 502],
  ])('maps egress failure %j to %i with fixed headers and no body', async (code, status) => {
    outcomes.set('isPluginAccountMetadataRequest', false);
    outcomes.set('PluginOutboundGateway.fetch', new Error(code));
    const response = await outbound().fetch(request());
    expect(response.status).toBe(status);
    expect(headersOf(response)).toEqual(STATIC_HEADERS);
    expect(await response.text()).toBe('');
  });

  it('maps a non-Error egress failure to 502', async () => {
    outcomes.set('isPluginAccountMetadataRequest', false);
    outcomes.set('PluginOutboundGateway.fetch', () => rejectOpaque('plugin_egress_rate_limited'));
    expect((await outbound().fetch(request())).status).toBe(502);
  });
});

describe('PluginAccountMetadataAccess.write', () => {
  const access = () => new PluginAccountMetadataAccess({ props: CONTEXT } as never, env() as never);
  it('writes with the loopback context and returns the service result', async () => {
    const input = { operationId: 'op-1' };
    await expect(access().write(input)).resolves.toBe('PluginAccountMetadataService.write:result');
    expect(callsTo('PluginAccountMetadataService.new')).toEqual([[env()]]);
    expect(callsTo('PluginAccountMetadataService.write')).toEqual([[CONTEXT, input]]);
  });
  it.each([
    'plugin_data_input_invalid',
    'plugin_data_scope_denied',
    'plugin_data_account_unavailable',
    'plugin_data_version_conflict',
    'plugin_data_idempotency_conflict',
    'plugin_data_idempotency_key_unavailable',
  ])('exposes %s', async (code) => {
    const original = new Error(code);
    outcomes.set('PluginAccountMetadataService.write', original);
    const failure = await access()
      .write({})
      .catch((error: unknown) => error);
    expect((failure as Error).message).toBe(code);
    expect(failure).not.toBe(original);
  });
  it.each([
    'plugin_data_method_denied',
    'plugin_data_input_invalid_extra',
    'xplugin_data_input_invalid',
    'plugin_data_input_invalid\n',
    'sqlite failure',
  ])('masks %j', async (message) => {
    outcomes.set('PluginAccountMetadataService.write', new Error(message));
    await expect(access().write({})).rejects.toThrow(/^plugin_host_interface_unavailable$/u);
  });
  it('masks non-Error failures', async () => {
    outcomes.set('PluginAccountMetadataService.write', () =>
      rejectOpaque('plugin_data_input_invalid')
    );
    await expect(access().write({})).rejects.toThrow(/^plugin_host_interface_unavailable$/u);
  });
});

describe('RuntimeSmokeEntrypoint', () => {
  it('reflects resource bindings for the caller props', async () => {
    const props = { caller: 'x' };
    const e = env();
    await expect(
      new RuntimeSmokeEntrypoint({ props } as never, e as never).smokePluginResourceBindings({
        a: 1,
      })
    ).resolves.toBe('PluginResourceControlService.reflectAndSmoke:result');
    expect(callsTo('PluginResourceControlService.new')).toEqual([[e, props]]);
    expect(callsTo('PluginResourceControlService.reflectAndSmoke')).toEqual([[{ a: 1 }]]);
  });
});

describe('createDynamicPluginHostInterfaces', () => {
  const exports = () => ({
    PluginAccountMetadataAccess: vi.fn((o: unknown) => ({ kind: 'metadata', o })),
    PluginD1ResourceAccess: vi.fn((o: unknown) => ({ kind: 'd1', o })),
    PluginKvResourceAccess: vi.fn((o: unknown) => ({ kind: 'kv', o })),
    PluginR2ResourceAccess: vi.fn((o: unknown) => ({ kind: 'r2', o })),
  });
  const resource = (kind: string, binding: string) => ({
    logicalResourceId: `l-${binding}`,
    binding,
    hostBindingRef: `PRES_${binding}`,
    kind,
    access: 'read_only',
    ownershipFingerprint: 'f'.repeat(64),
  });
  it('binds the account metadata interface to a loopback stub with the egress context', () => {
    const ex = exports();
    const result = createDynamicPluginHostInterfaces(
      { exports: ex } as never,
      CONTEXT,
      [{ name: 'ACCOUNT_METADATA', interface: 'authrim.account_metadata.v1', scope: 'tenant' }],
      [],
      'plugin-a'
    );
    expect(result).toEqual({ ACCOUNT_METADATA: { kind: 'metadata', o: { props: CONTEXT } } });
    expect(ex.PluginAccountMetadataAccess).toHaveBeenCalledTimes(1);
    expect(ex.PluginD1ResourceAccess).not.toHaveBeenCalled();
  });
  it('routes each resource kind to its own loopback class with merged props', () => {
    const ex = exports();
    const resources = [
      resource('d1', 'DB'),
      resource('kv_namespace', 'KV'),
      resource('r2_bucket', 'R2'),
    ];
    const result = createDynamicPluginHostInterfaces(
      { exports: ex } as never,
      CONTEXT,
      [],
      resources as never,
      'plugin-a'
    );
    const props = (index: number) => ({
      props: {
        tenantId: 'tenant-a',
        pluginId: 'plugin-a',
        installationId: 'inst-a',
        ...resources[index],
      },
    });
    expect(result).toEqual({
      DB: { kind: 'd1', o: props(0) },
      KV: { kind: 'kv', o: props(1) },
      R2: { kind: 'r2', o: props(2) },
    });
    expect(ex.PluginD1ResourceAccess).toHaveBeenCalledTimes(1);
    expect(ex.PluginKvResourceAccess).toHaveBeenCalledTimes(1);
    expect(ex.PluginR2ResourceAccess).toHaveBeenCalledTimes(1);
    expect(ex.PluginAccountMetadataAccess).not.toHaveBeenCalled();
  });
  it('rejects a resource binding that collides with a host interface binding', () => {
    expect(() =>
      createDynamicPluginHostInterfaces(
        { exports: exports() } as never,
        CONTEXT,
        [{ name: 'SHARED', interface: 'authrim.account_metadata.v1', scope: 'tenant' }],
        [resource('d1', 'SHARED')] as never,
        'plugin-a'
      )
    ).toThrow(/^plugin_host_interface_binding_conflict$/u);
  });
  it('rejects two resources with the same binding name', () => {
    expect(() =>
      createDynamicPluginHostInterfaces(
        { exports: exports() } as never,
        CONTEXT,
        [],
        [resource('d1', 'SAME'), resource('kv_namespace', 'SAME')] as never,
        'plugin-a'
      )
    ).toThrow(/^plugin_host_interface_binding_conflict$/u);
  });
  it('treats inherited property names as free bindings', () => {
    const result = createDynamicPluginHostInterfaces(
      { exports: exports() } as never,
      CONTEXT,
      [],
      [resource('d1', 'toString')] as never,
      'plugin-a'
    );
    expect(Object.keys(result)).toEqual(['toString']);
  });
});

describe('PluginRunnerWorker.scheduled', () => {
  function scheduledWorker(e: Record<string, unknown>) {
    const ex = {
      PluginDynamicOutbound: vi.fn(() => 'outbound-fetcher'),
      PluginD1ResourceAccess: vi.fn(() => 'd1-stub'),
      PluginKvResourceAccess: vi.fn(() => 'kv-stub'),
      PluginR2ResourceAccess: vi.fn(() => 'r2-stub'),
    };
    return {
      ex,
      worker: new PluginRunnerWorker({ props: {}, exports: ex } as never, e as never),
    };
  }
  it('runs the scheduler and the bundle metrics scan with the environment and loopbacks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_555_500);
    const e = env();
    const { ex, worker } = scheduledWorker(e);
    await expect(worker.scheduled()).resolves.toBeUndefined();
    expect(log.map((entry) => entry.call)).toEqual([
      'PluginRunnerScheduler.new',
      'PluginRunnerScheduler.run',
      'scanAndReportPluginBundleMetrics',
    ]);
    expect(callsTo('scanAndReportPluginBundleMetrics')).toEqual([[e]]);
    const [schedulerEnv, now, outboundFactory, hostFactory] = must(
      callsTo('PluginRunnerScheduler.new')[0]
    );
    expect(schedulerEnv).toBe(e);
    expect((now as () => number)()).toBe(1_700_000_555);
    expect((outboundFactory as (c: unknown) => unknown)(CONTEXT)).toBe('outbound-fetcher');
    expect(ex.PluginDynamicOutbound).toHaveBeenCalledWith({ props: CONTEXT });
    const hosted = (
      hostFactory as (c: unknown, b: unknown[], r: unknown[], p: string) => Record<string, unknown>
    )(
      CONTEXT,
      [],
      [
        { binding: 'A', kind: 'd1' },
        { binding: 'B', kind: 'kv_namespace' },
        { binding: 'C', kind: 'r2_bucket' },
      ],
      'plugin-a'
    );
    expect(hosted).toEqual({ A: 'd1-stub', B: 'kv-stub', C: 'r2-stub' });
  });
  it('fails when the scheduler fails and DR export is off', async () => {
    outcomes.set('PluginRunnerScheduler.run', () => Promise.reject(new Error('scheduler down')));
    await expect(scheduledWorker(env()).worker.scheduled()).rejects.toThrow('scheduler down');
    outcomes.set('PluginRunnerScheduler.run', undefined);
    outcomes.set('scanAndReportPluginBundleMetrics', () => Promise.reject(new Error('scan down')));
    await expect(scheduledWorker(env()).worker.scheduled()).rejects.toThrow('scan down');
  });
  const deferredScan = () => {
    let release: () => void = () => undefined;
    outcomes.set(
      'scanAndReportPluginBundleMetrics',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    return { release: () => release() };
  };
  const flushMicrotasks = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };
  it.each(['false', '', 'TRUE', undefined])(
    'fails at once, without waiting for the scan, when ENABLE_SAML_DR_EXPORT=%j',
    async (flag) => {
      outcomes.set('PluginRunnerScheduler.run', () => Promise.reject(new Error('early')));
      const scan = deferredScan();
      // The scan never resolves until released below, so this only settles if nothing waits for it.
      await expect(
        scheduledWorker(env({ ENABLE_SAML_DR_EXPORT: flag })).worker.scheduled()
      ).rejects.toThrow('early');
      expect(callsTo('scanAndReportPluginBundleMetrics')).toHaveLength(1);
      scan.release();
    }
  );
  it('waits for every effect before failing when DR export is on', async () => {
    outcomes.set('PluginRunnerScheduler.run', () => Promise.reject(new Error('first failure')));
    const scan = deferredScan();
    let outcome: { status: 'pending' } | { status: 'rejected'; reason: unknown } = {
      status: 'pending',
    };
    const result = scheduledWorker(env({ ENABLE_SAML_DR_EXPORT: 'true' }))
      .worker.scheduled()
      .then(
        () => undefined,
        (reason: unknown) => {
          outcome = { status: 'rejected', reason };
        }
      );
    expect(callsTo('scanAndReportPluginBundleMetrics')).toHaveLength(1);
    await flushMicrotasks();
    expect(outcome).toEqual({ status: 'pending' });
    scan.release();
    await result;
    expect(outcome).toEqual({ status: 'rejected', reason: new Error('first failure') });
  });
  it('reports the scan failure when only the scan fails with DR export on', async () => {
    outcomes.set('scanAndReportPluginBundleMetrics', () =>
      Promise.reject(new Error('scan failure'))
    );
    await expect(
      scheduledWorker(env({ ENABLE_SAML_DR_EXPORT: 'true' })).worker.scheduled()
    ).rejects.toThrow('scan failure');
  });
  it('resolves when both effects succeed with DR export on', async () => {
    await expect(
      scheduledWorker(env({ ENABLE_SAML_DR_EXPORT: 'true' })).worker.scheduled()
    ).resolves.toBeUndefined();
  });
  it('does not treat a rejection reason of undefined as success', async () => {
    outcomes.set('PluginRunnerScheduler.run', () => rejectOpaque(undefined));
    await expect(
      scheduledWorker(env({ ENABLE_SAML_DR_EXPORT: 'true' })).worker.scheduled()
    ).rejects.toBeUndefined();
  });
});

describe('replaceDynamicPluginCredentials', () => {
  const INPUT = {
    operationId: 'op-1',
    tenantId: 'tenant-a',
    pluginId: 'plugin-a',
    expectedConfigVersion: 3,
    credentials: { apiKey: 'secret' },
  };
  const rpc = (caller = 'ar-management', e: Record<string, unknown> = env()) =>
    new PluginRunnerWorker(
      {
        props: { caller, environmentId: 'test', audience: 'authrim-plugin-runner-v1' },
        exports: {},
      } as never,
      e as never
    ) as unknown as { replaceDynamicPluginCredentials(input: unknown): Promise<unknown> };
  const statuses = (...values: unknown[]) => {
    const queue = [...values];
    outcomes.set('D1DynamicPluginInstallationStore.status', () => queue.shift());
  };
  const TARGET = { tenantId: 'tenant-a', pluginId: 'plugin-a' };

  it('replaces credentials mapped for the installation at the expected version', async () => {
    statuses({ state: 'enabled', configVersion: 3, installationId: 'inst-1' });
    outcomes.set('D1DynamicPluginInstallationStore.credentialInputs', {
      values: [{ name: 'API_KEY' }],
    });
    await expect(rpc().replaceDynamicPluginCredentials(INPUT)).resolves.toBe(
      'D1PluginConfigStore.replaceCredentials:result'
    );
    expect(log).toEqual([
      { call: 'D1DynamicPluginInstallationStore.new', args: [DB, 'test'] },
      { call: 'D1DynamicPluginInstallationStore.status', args: [TARGET] },
      {
        call: 'D1DynamicPluginInstallationStore.credentialInputs',
        args: [{ ...TARGET, credentials: { apiKey: 'secret' } }],
      },
      { call: 'pluginEncryptionKeyringFromEnv', args: [env()] },
      {
        call: 'D1PluginConfigStore.new',
        args: [DB, 'pluginEncryptionKeyringFromEnv:result', 'hmac-key'],
      },
      {
        call: 'D1PluginConfigStore.replaceCredentials',
        args: [
          {
            operationId: 'op-1',
            tenantId: 'tenant-a',
            installationId: 'inst-1',
            expectedConfigVersion: 3,
            credentials: [{ name: 'API_KEY' }],
          },
        ],
      },
    ]);
  });

  it('creates a disabled installation first when none exists, then uses its version', async () => {
    statuses(
      { state: 'absent', configVersion: 0, installationId: undefined },
      { state: 'disabled', configVersion: 3, installationId: 'inst-new' }
    );
    outcomes.set('D1DynamicPluginInstallationStore.credentialInputs', { values: [] });
    await rpc().replaceDynamicPluginCredentials(INPUT);
    expect(callsTo('D1DynamicPluginInstallationStore.status')).toEqual([[TARGET], [TARGET]]);
    expect(callsTo('D1DynamicPluginInstallationStore.configure')).toEqual([
      [{ ...TARGET, enabled: false }],
    ]);
    const order = log.map((entry) => entry.call);
    expect(order.indexOf('D1DynamicPluginInstallationStore.configure')).toBeGreaterThan(
      order.indexOf('D1DynamicPluginInstallationStore.status')
    );
    expect(must(callsTo('D1PluginConfigStore.replaceCredentials')[0])[0]).toMatchObject({
      installationId: 'inst-new',
      credentials: [],
    });
  });

  it('does not configure an existing installation', async () => {
    statuses({ state: 'disabled', configVersion: 3, installationId: 'inst-1' });
    outcomes.set('D1DynamicPluginInstallationStore.credentialInputs', { values: [] });
    await rpc().replaceDynamicPluginCredentials(INPUT);
    expect(callsTo('D1DynamicPluginInstallationStore.configure')).toEqual([]);
    expect(callsTo('D1DynamicPluginInstallationStore.status')).toHaveLength(1);
  });

  it.each([
    ['stale version', { state: 'enabled', configVersion: 4, installationId: 'inst-1' }],
    ['older version', { state: 'enabled', configVersion: 2, installationId: 'inst-1' }],
  ])('refuses a %s without mapping or writing', async (_label, status) => {
    statuses(status);
    await expect(rpc().replaceDynamicPluginCredentials(INPUT)).rejects.toThrow(
      /^plugin_dynamic_credentials_version_conflict$/u
    );
    expect(callsTo('D1DynamicPluginInstallationStore.credentialInputs')).toEqual([]);
    expect(callsTo('D1PluginConfigStore.new')).toEqual([]);
  });

  it('refuses when the freshly created installation is not at the expected version', async () => {
    statuses(
      { state: 'absent', configVersion: 3, installationId: undefined },
      { state: 'disabled', configVersion: 1, installationId: 'inst-new' }
    );
    await expect(rpc().replaceDynamicPluginCredentials(INPUT)).rejects.toThrow(
      /^plugin_dynamic_credentials_version_conflict$/u
    );
    expect(callsTo('D1PluginConfigStore.replaceCredentials')).toEqual([]);
  });

  it('is limited to Management', async () => {
    for (const caller of ['ar-auth', 'ar-bridge', 'ar-policy', 'ar-saml']) {
      await expect(rpc(caller).replaceDynamicPluginCredentials(INPUT)).rejects.toThrow(
        /^plugin_sync_caller_unauthorized$/u
      );
    }
    expect(log).toEqual([]);
  });

  it.each([
    ['zero version', { ...INPUT, expectedConfigVersion: 0 }],
    ['negative version', { ...INPUT, expectedConfigVersion: -1 }],
    ['fractional version', { ...INPUT, expectedConfigVersion: 1.5 }],
    ['string version', { ...INPUT, expectedConfigVersion: '3' }],
    ['null credentials', { ...INPUT, credentials: null }],
    ['array credentials', { ...INPUT, credentials: [] }],
    ['string credentials', { ...INPUT, credentials: 'x' }],
    ['numeric credentials', { ...INPUT, credentials: 1 }],
  ])('rejects %s with the credentials code before any store call', async (_label, input) => {
    await expect(rpc().replaceDynamicPluginCredentials(input)).rejects.toThrow(
      /^plugin_dynamic_credentials_input_invalid$/u
    );
    expect(log).toEqual([]);
  });

  it.each([
    ['null input', null],
    ['extra key', { ...INPUT, extra: 1 }],
    ['missing key', { ...INPUT, operationId: undefined }],
    ['unsafe operation', { ...INPUT, operationId: '' }],
    ['unsafe tenant', { ...INPUT, tenantId: '-a' }],
    ['unsafe plugin', { ...INPUT, pluginId: 'a b' }],
  ])('rejects %s with the sync code before any store call', async (_label, input) => {
    await expect(rpc().replaceDynamicPluginCredentials(input)).rejects.toThrow(
      /^plugin_sync_input_invalid$/u
    );
    expect(log).toEqual([]);
  });
});
