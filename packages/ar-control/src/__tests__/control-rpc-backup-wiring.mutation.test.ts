import { beforeEach, describe, expect, it, vi } from 'vitest';
import { constructionsOf, fn, invoke, make, must } from './support/control-rpc-harness';
import { RESULT } from './support/rpc-wiring-table';
import { useWiringEnvironment } from './support/rpc-wiring-suite';

const recorder = vi.hoisted(() => () => import('./support/control-rpc-recorder'));
const mocks = vi.hoisted(() => ({ gate: vi.fn() }));
vi.mock('../lookup-registry-publisher', async (orig) =>
  (await recorder()).partial(await orig(), { LookupRegistryPublisher: [] })
);
vi.mock('../lookup-hmac-key-state-publisher', async (orig) =>
  (await recorder()).partial(await orig(), { LookupHmacKeyStatePublisher: [] })
);
vi.mock('../plugin-runner-registry-publisher', async (orig) =>
  (await recorder()).partial(await orig(), { PluginRunnerRegistryPublisher: [] })
);
vi.mock('../saml-dr-mutation-entrypoint', async (orig) => ({
  ...(await orig<typeof import('../saml-dr-mutation-entrypoint')>()),
  runControlSamlDrOperation: mocks.gate,
}));
vi.mock('../tenant-backup-boundary', async () => {
  const { fn: recorded } = await recorder();
  return { controlTenantBackupBoundary: (...args: unknown[]) => recorded('boundary')(...args) };
});
vi.mock('../tenant-backup-mutation-permits', async () => {
  const { fn: recorded } = await recorder();
  return { controlTenantMutationPermit: (...args: unknown[]) => recorded('permit')(...args) };
});
vi.mock('../control-api-clients', async () => {
  const { fn: recorded } = await recorder();
  return {
    createControlApiClients: (...args: unknown[]) => recorded('createControlApiClients')(...args),
  };
});

useWiringEnvironment();
beforeEach(() => {
  mocks.gate.mockReset();
  mocks.gate.mockImplementation((env: unknown, operation: (env: unknown) => unknown) =>
    operation(env)
  );
});

const REQUEST = { tenantId: 'tenant-1' };
const NOW_MS = 1_700_000_000_123;

describe('tenant backup permits', () => {
  it('forwards tenant permits with the exact request, caller and clock', async () => {
    fn('permit').mockResolvedValue(RESULT);
    const { control, env } = make({ caller: 'ar-lib-core' });
    await expect(invoke(control, 'acquireTenantBackupMutationPermit', REQUEST)).resolves.toBe(
      RESULT
    );
    expect(fn('permit')).toHaveBeenCalledExactlyOnceWith({
      database: env.CONTROL_DB,
      environmentId: 'env-1',
      caller: 'ar-lib-core',
      request: REQUEST,
      action: 'acquire',
      now: NOW_MS,
    });
  });

  it('completes tenant permits without returning the permit result', async () => {
    fn('permit').mockResolvedValue(RESULT);
    const { control, env } = make();
    await expect(
      invoke(control, 'completeTenantBackupMutationPermit', REQUEST)
    ).resolves.toBeUndefined();
    expect(fn('permit')).toHaveBeenCalledExactlyOnceWith({
      database: env.CONTROL_DB,
      environmentId: 'env-1',
      caller: 'ar-management',
      request: REQUEST,
      action: 'complete',
      now: NOW_MS,
    });
  });

  it('forwards environment permits with environment scope', async () => {
    fn('permit').mockResolvedValue(RESULT);
    const { control, env } = make();
    await expect(invoke(control, 'acquireEnvironmentBackupMutationPermit', REQUEST)).resolves.toBe(
      RESULT
    );
    await expect(
      invoke(control, 'completeEnvironmentBackupMutationPermit', REQUEST)
    ).resolves.toBeUndefined();
    expect(fn('permit').mock.calls).toEqual([
      [
        {
          database: env.CONTROL_DB,
          environmentId: 'env-1',
          caller: 'ar-management',
          request: REQUEST,
          scope: 'environment',
          action: 'acquire',
          now: NOW_MS,
        },
      ],
      [
        {
          database: env.CONTROL_DB,
          environmentId: 'env-1',
          caller: 'ar-management',
          request: REQUEST,
          scope: 'environment',
          action: 'complete',
          now: NOW_MS,
        },
      ],
    ]);
  });

  it.each(['acquireTenantBackupMutationPermit', 'acquireEnvironmentBackupMutationPermit'])(
    '%s fails closed when no permit is returned',
    async (rpc) => {
      fn('permit').mockResolvedValue(null);
      await expect(invoke(make().control, rpc, REQUEST)).rejects.toThrow(
        /^control_internal_error$/u
      );
      fn('permit').mockResolvedValue(undefined);
      await expect(invoke(make().control, rpc, REQUEST)).rejects.toThrow(
        /^control_internal_error$/u
      );
    }
  );

  it('lets the log writer use tenant permits but never environment permits', async () => {
    fn('permit').mockResolvedValue(RESULT);
    const lib = make({ caller: 'ar-lib-core' }).control;
    await expect(invoke(lib, 'acquireTenantBackupMutationPermit', REQUEST)).resolves.toBe(RESULT);
    await expect(
      invoke(lib, 'completeTenantBackupMutationPermit', REQUEST)
    ).resolves.toBeUndefined();
    await expect(invoke(lib, 'acquireEnvironmentBackupMutationPermit', REQUEST)).rejects.toThrow(
      'control_rpc_caller_unauthorized'
    );
    await expect(invoke(lib, 'completeEnvironmentBackupMutationPermit', REQUEST)).rejects.toThrow(
      'control_rpc_caller_unauthorized'
    );
    const stranger = make({ caller: 'ar-plugin-runner' }).control;
    await expect(invoke(stranger, 'acquireTenantBackupMutationPermit', REQUEST)).rejects.toThrow(
      'control_rpc_caller_unauthorized'
    );
    await expect(invoke(stranger, 'completeTenantBackupMutationPermit', REQUEST)).rejects.toThrow(
      'control_rpc_caller_unauthorized'
    );
    expect(fn('permit')).toHaveBeenCalledTimes(2);
  });

  it('forwards the snapshot boundary request with the strict flag following SAML DR export', async () => {
    fn('boundary').mockResolvedValue(RESULT);
    const plain = make();
    await expect(invoke(plain.control, 'tenantBackupSnapshotBoundary', REQUEST)).resolves.toBe(
      RESULT
    );
    expect(fn('boundary')).toHaveBeenLastCalledWith({
      database: plain.env.CONTROL_DB,
      environmentId: 'env-1',
      caller: 'ar-management',
      request: REQUEST,
      strictIncompletePermits: false,
    });
    const strict = make({}, { ENABLE_SAML_DR_EXPORT: 'true' });
    await invoke(strict.control, 'tenantBackupSnapshotBoundary', REQUEST);
    expect(fn('boundary').mock.lastCall?.[0]).toMatchObject({ strictIncompletePermits: true });
    const off = make({}, { ENABLE_SAML_DR_EXPORT: 'false' });
    await invoke(off.control, 'tenantBackupSnapshotBoundary', REQUEST);
    expect(fn('boundary').mock.lastCall?.[0]).toMatchObject({ strictIncompletePermits: false });
    await expect(
      invoke(make({ caller: 'ar-lib-core' }).control, 'tenantBackupSnapshotBoundary', REQUEST)
    ).rejects.toThrow('control_rpc_caller_unauthorized');
  });
});

describe('publishTenantBackupRuntimeState', () => {
  const publish = () => {
    fn('LookupRegistryPublisher.publishEnvironment').mockResolvedValue({ registry: 1 });
    fn('LookupHmacKeyStatePublisher.publishEnvironment').mockResolvedValue({ hmac: 2 });
    fn('PluginRunnerRegistryPublisher.publishEnvironment').mockResolvedValue({ plugin: 3 });
  };

  it('publishes all three registries for the caller environment', async () => {
    publish();
    const { control, env, waitUntil } = make();
    await expect(invoke(control, 'publishTenantBackupRuntimeState')).resolves.toEqual({
      lookupRegistry: { registry: 1 },
      lookupHmacKeyState: { hmac: 2 },
      pluginRunnerRegistry: { plugin: 3 },
    });
    for (const cls of [
      'LookupRegistryPublisher',
      'LookupHmacKeyStatePublisher',
      'PluginRunnerRegistryPublisher',
    ]) {
      expect(fn(`${cls}.publishEnvironment`)).toHaveBeenCalledExactlyOnceWith('env-1');
      const [passedEnv, clock] = must(constructionsOf(cls)[0]).args;
      expect(passedEnv).toBe(env);
      expect((clock as () => number)()).toBe(1_700_000_000);
    }
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('registers the real publications with waitUntil even when one fails first', async () => {
    const lookup = new Promise<unknown>(() => undefined);
    const hmac = Promise.reject(new Error('r2 down'));
    hmac.catch(() => undefined);
    const plugin = new Promise<unknown>(() => undefined);
    fn('LookupRegistryPublisher.publishEnvironment').mockReturnValue(lookup);
    fn('LookupHmacKeyStatePublisher.publishEnvironment').mockReturnValue(hmac);
    fn('PluginRunnerRegistryPublisher.publishEnvironment').mockReturnValue(plugin);
    const { control, waitUntil } = make({}, { ENABLE_SAML_DR_EXPORT: 'true' });
    await expect(invoke(control, 'publishTenantBackupRuntimeState')).rejects.toThrow(
      /^control_internal_error$/u
    );
    const registered = waitUntil.mock.calls.map((call) => call[0] as unknown);
    expect(registered).toHaveLength(3);
    expect(registered[0]).toBe(lookup);
    expect(registered[1]).toBe(hmac);
    expect(registered[2]).toBe(plugin);
  });

  it('does not register the publications without SAML DR export', async () => {
    publish();
    const { control, waitUntil } = make();
    await invoke(control, 'publishTenantBackupRuntimeState');
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('refuses a publication that leaks secret material and rejects strangers', async () => {
    publish();
    fn('LookupHmacKeyStatePublisher.publishEnvironment').mockResolvedValue({ private_key: 'x' });
    await expect(invoke(make().control, 'publishTenantBackupRuntimeState')).rejects.toThrow(
      /^control_internal_error$/u
    );
    await expect(
      invoke(make({ caller: 'ar-lib-core' }).control, 'publishTenantBackupRuntimeState')
    ).rejects.toThrow('control_rpc_caller_unauthorized');
  });
});

describe('SAML DR covered mutations', () => {
  it('runs mutations through the covered writer gate without the flag too', async () => {
    fn('LookupRegistryPublisher.publishEnvironment').mockResolvedValue({});
    fn('LookupHmacKeyStatePublisher.publishEnvironment').mockResolvedValue({});
    fn('PluginRunnerRegistryPublisher.publishEnvironment').mockResolvedValue({});
    const { control, env } = make();
    await invoke(control, 'publishTenantBackupRuntimeState');
    expect(mocks.gate).toHaveBeenCalledTimes(1);
    expect(mocks.gate.mock.calls[0]?.[0]).toBe(env);
  });

  it('under the flag, binds mutations to the configured environment', async () => {
    fn('LookupRegistryPublisher.publishEnvironment').mockResolvedValue({});
    fn('LookupHmacKeyStatePublisher.publishEnvironment').mockResolvedValue({});
    fn('PluginRunnerRegistryPublisher.publishEnvironment').mockResolvedValue({});
    const overrides = {
      ENABLE_SAML_DR_EXPORT: 'true' as const,
      AUTHRIM_ENVIRONMENT_NAME: 'env-other',
    };
    await expect(
      invoke(make({}, overrides).control, 'publishTenantBackupRuntimeState')
    ).rejects.toThrow('control_rpc_caller_unauthorized');
    expect(mocks.gate).not.toHaveBeenCalled();
    await expect(
      invoke(make({}, { ENABLE_SAML_DR_EXPORT: 'true' }).control, 'publishTenantBackupRuntimeState')
    ).resolves.toBeDefined();
  });

  it('under the flag, refuses other callers before entering the gate', async () => {
    await expect(
      invoke(
        make({ caller: 'ar-lib-core' }, { ENABLE_SAML_DR_EXPORT: 'true' }).control,
        'reconcilePending'
      )
    ).rejects.toThrow('control_rpc_caller_unauthorized');
    expect(mocks.gate).not.toHaveBeenCalled();
  });
});
