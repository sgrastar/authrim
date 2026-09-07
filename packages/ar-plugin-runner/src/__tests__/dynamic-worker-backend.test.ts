import { describe, expect, it, vi } from 'vitest';
import { DynamicWorkerPluginBackend, type PluginOutboundFactory } from '../dynamic-worker-backend';

const codeTarget = {
  pluginId: 'plugin-a',
  scriptName: 'plugin-a',
  codeObjectKey: `plugins/plugin-a/${'a'.repeat(64)}.json`,
  codeSha256: 'a'.repeat(64),
  timeoutMs: 1_000,
  hostInterfaces: [],
  resources: [],
};

const code = {
  resolve: vi.fn(async () => ({
    compatibilityDate: '2026-07-30',
    mainModule: 'index.js',
    modules: { 'index.js': 'export default {}' },
    globalOutbound: null,
  })),
};

function loaderFor(fetch: (input: string, init?: { body?: string }) => Promise<Response>) {
  const get = vi.fn((_id: string, callback: () => Promise<unknown>) => {
    const loaded = callback();
    return {
      getEntrypoint: () => ({
        fetch: async (input: string, init?: { body?: string }) => {
          await loaded;
          return fetch(input, init);
        },
      }),
    };
  });
  return { loader: { get } as never, get };
}

const outbound = vi.fn<PluginOutboundFactory>((_scope) => ({ fetch: vi.fn() }) as never);

const invocation = {
  pluginInstallationId: 'plugin-installation-a',
  tenantId: 'tenant-a',
  capability: 'notifier.send',
  eventType: 'account.created',
  eventVersion: 1,
  idempotencyKey: 'plugin-event-a',
  payload: {
    tenantId: 'tenant-a',
    accountId: 'account-a',
    eventType: 'account.created',
    eventVersion: 1,
  },
};

describe('DynamicWorkerPluginBackend', () => {
  it('fails closed when the optional Worker Loader is unavailable', async () => {
    const backend = new DynamicWorkerPluginBackend(undefined, { resolve: vi.fn() }, code, outbound);

    await expect(
      backend.invoke({
        pluginInstallationId: 'installation-1',
        tenantId: 'tenant-a',
        capability: 'account.created',
        eventType: 'account.created',
        eventVersion: 1,
        idempotencyKey: 'event-1',
        payload: {
          tenantId: 'tenant-a',
          accountId: 'account-1',
          eventType: 'account.created',
          eventVersion: 1,
        },
      })
    ).rejects.toThrow('plugin_hook_provider_rejected');
  });

  it('dispatches a bounded reference-only request', async () => {
    const fetch = vi.fn(async (_input: string, _init?: { body?: string }) =>
      Promise.resolve(new Response(null, { status: 204 }))
    );
    const { loader, get } = loaderFor(fetch);
    const backend = new DynamicWorkerPluginBackend(
      loader,
      {
        resolve: vi.fn(async () => codeTarget),
      },
      code,
      outbound,
      {
        bindingRef: 'TEST_TDB_USERS_JP_0001_CORE',
        dataRole: 'tenant_core/users',
        residencyPartition: 'jp',
      }
    );

    await expect(backend.invoke(invocation)).resolves.toBeUndefined();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]?.[0]).toMatch(/^[a-f0-9]{64}$/u);
    expect(get.mock.calls[0]?.[1]).toEqual(expect.any(Function));
    const outboundScope = outbound.mock.calls[0]?.[0];
    expect(outboundScope?.requestId).toMatch(/^scope:[a-f0-9]{64}$/u);
    expect(outbound).toHaveBeenCalledWith({
      contractVersion: 1,
      tenantId: 'tenant-a',
      pluginInstallationId: 'plugin-installation-a',
      capability: 'notifier.send',
      requestId: outboundScope?.requestId,
      executionScope: {
        accountId: 'account-a',
        bindingRef: 'TEST_TDB_USERS_JP_0001_CORE',
        dataRole: 'tenant_core/users',
        residencyPartition: 'jp',
      },
    });
    const request = fetch.mock.calls[0];
    expect(request[0]).toBe('https://authrim.invalid/internal/plugin-hook');
    expect(JSON.parse(request[1]?.body ?? '')).toEqual(invocation);
  });

  it('injects only resolved versioned host interfaces into the Worker env', async () => {
    const { loader, get } = loaderFor(async () => new Response(null, { status: 204 }));
    const accountMetadata = { write: vi.fn() };
    const hostInterfaces = vi.fn(() => ({ ACCOUNT_METADATA: accountMetadata }));
    const backend = new DynamicWorkerPluginBackend(
      loader,
      {
        resolve: async () => ({
          ...codeTarget,
          hostInterfaces: [
            {
              name: 'ACCOUNT_METADATA',
              interface: 'authrim.account_metadata.v1',
              scope: 'tenant',
            },
          ],
        }),
      },
      code,
      outbound,
      undefined,
      hostInterfaces
    );

    await backend.invoke(invocation);

    const loaded = await get.mock.calls[0]?.[1]();
    expect(hostInterfaces).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a' }),
      [
        {
          name: 'ACCOUNT_METADATA',
          interface: 'authrim.account_metadata.v1',
          scope: 'tenant',
        },
      ],
      [],
      'plugin-a'
    );
    expect(loaded).toEqual(expect.objectContaining({ env: { ACCOUNT_METADATA: accountMetadata } }));
  });

  it('fails closed when an approved host interface cannot be resolved', async () => {
    const { loader } = loaderFor(async () => new Response(null, { status: 204 }));
    const backend = new DynamicWorkerPluginBackend(
      loader,
      {
        resolve: async () => ({
          ...codeTarget,
          hostInterfaces: [
            {
              name: 'ACCOUNT_METADATA',
              interface: 'authrim.account_metadata.v1',
              scope: 'tenant',
            },
          ],
        }),
      },
      code,
      outbound
    );

    await expect(backend.invoke(invocation)).rejects.toThrow('plugin_hook_transient_failure');
  });

  it('rejects a plugin bundle that attempts to provide its own env', async () => {
    const { loader } = loaderFor(async () => new Response(null, { status: 204 }));
    const backend = new DynamicWorkerPluginBackend(
      loader,
      { resolve: async () => codeTarget },
      { resolve: async () => ({ ...(await code.resolve()), env: { DB: {} } }) },
      outbound
    );

    await expect(backend.invoke(invocation)).rejects.toThrow('plugin_hook_transient_failure');
  });

  it('classifies retryable and permanent plugin responses', async () => {
    const invoke = (status: number) => {
      const { loader } = loaderFor(async () => new Response(null, { status }));
      return new DynamicWorkerPluginBackend(
        loader,
        { resolve: async () => codeTarget },
        code,
        outbound
      ).invoke(invocation);
    };

    await expect(invoke(503)).rejects.toThrow('plugin_hook_transient_failure');
    await expect(invoke(400)).rejects.toThrow('plugin_hook_rejected');
    await expect(invoke(401)).rejects.toThrow('plugin_hook_provider_rejected');
  });

  it('classifies installation storage failure as retryable', async () => {
    const backend = new DynamicWorkerPluginBackend(
      { get: vi.fn() } as never,
      { resolve: async () => Promise.reject(new Error('d1_unavailable')) },
      code,
      outbound
    );

    await expect(backend.invoke(invocation)).rejects.toThrow('plugin_hook_transient_failure');
  });

  it('reuses the code identity within one account scope and separates another account', async () => {
    const { loader, get } = loaderFor(async () => new Response(null, { status: 204 }));
    const backend = new DynamicWorkerPluginBackend(
      loader,
      { resolve: async () => codeTarget },
      code,
      outbound,
      {
        bindingRef: 'TEST_TDB_USERS_JP_0001_CORE',
        dataRole: 'tenant_core/users',
        residencyPartition: 'jp',
      }
    );

    await backend.invoke(invocation);
    await backend.invoke({ ...invocation, idempotencyKey: 'plugin-event-b' });
    await backend.invoke({
      ...invocation,
      idempotencyKey: 'plugin-event-c',
      payload: { ...invocation.payload, accountId: 'account-b' },
    });

    expect(get.mock.calls[0]?.[0]).toBe(get.mock.calls[1]?.[0]);
    expect(get.mock.calls[2]?.[0]).not.toBe(get.mock.calls[0]?.[0]);
  });
});
