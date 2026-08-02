import type { Env, StageDynamicPluginActivationInput } from '@authrim/ar-lib-core';
import { describe, expect, it, vi } from 'vitest';
import {
  cancelDynamicPluginResourceFinalization,
  enqueueDynamicPluginResourceFinalization,
  processDynamicPluginResourceFinalizations,
} from '../plugin-resource-finalization';

function rpcMethod<T extends object>(method: T): T {
  return new Proxy(method, {
    get(target, property, receiver) {
      if (property === 'bind') {
        throw new Error('The RPC receiver does not implement the method "bind".');
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

function kv() {
  const store = new Map<string, string>();
  return {
    store,
    binding: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        store.delete(key);
      }),
      list: vi.fn(async ({ prefix, limit }: { prefix: string; limit: number }) => ({
        keys: [...store.keys()]
          .filter((key) => key.startsWith(prefix))
          .slice(0, limit)
          .map((name) => ({ name })),
        list_complete: true,
        cacheStatus: null,
      })),
    } as unknown as KVNamespace,
  };
}

function env(settings: KVNamespace, readiness: 'pending' | 'ready', operationId = 'op-plugin-a') {
  const resource = {
    schemaVersion: 1 as const,
    logicalResourceId: 'cache',
    binding: 'PLUGIN_CACHE',
    kind: 'kv_namespace' as const,
    scope: 'tenant' as const,
    access: 'read_write' as const,
    lifecycleMode: 'managed' as const,
    allowExisting: true,
    migrationStream: null,
    providerResourceId: readiness === 'ready' ? 'namespace-a' : null,
    providerName: readiness === 'ready' ? 'namespace-a-name' : null,
  };
  const plan = {
    environmentId: 'test',
    tenantId: 'tenant-a',
    pluginId: 'plugin-a',
    installationId: 'installation-a',
    capabilityManifestDigest: 'a'.repeat(64),
    enabled: true,
    bindings: [],
    resources: [resource],
  };
  const getPreparation = vi.fn(async () => ({
    ...plan,
    operationId,
    readiness,
  }));
  const validate = vi.fn(async () => plan);
  const prepare = vi.fn(async () => ({ ...plan, operationId, readiness }));
  const configure = vi.fn(async () => ({
    installationId: 'installation-a',
    tenantId: 'tenant-a',
    pluginId: 'plugin-a',
    state: 'enabled' as const,
    configVersion: 1,
    pinnedVersionDigest: 'b'.repeat(64),
  }));
  const getStatus = vi.fn(async () => ({
    installationId: 'installation-a',
    tenantId: 'tenant-a',
    pluginId: 'plugin-a',
    state: 'disabled' as const,
    configVersion: 1,
    pinnedVersionDigest: null,
  }));
  const stage = vi.fn(async (input: StageDynamicPluginActivationInput) => ({
    installationId: 'installation-a',
    tenantId: input.tenantId,
    pluginId: input.pluginId,
    activationRequestId: input.activationRequestId,
    state: 'pending' as const,
  }));
  const sync = vi.fn(async () => ({
    ...plan,
    operationId: 'op-sync-a',
    state: 'enabled' as const,
    configVersion: 1,
    pinnedVersionDigest: 'b'.repeat(64),
    bindingStatus: 'active' as const,
  }));
  return {
    value: {
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      SETTINGS: settings,
      CONTROL: {
        getPluginDynamicWorkerResourcePreparation: getPreparation,
        validatePluginDynamicWorkerDesiredState: validate,
        preparePluginDynamicWorkerResources: prepare,
        syncPluginDynamicWorkerObservedState: sync,
      },
      PLUGIN_RUNNER: {
        configureDynamicPluginInstallation: configure,
        getDynamicPluginInstallationStatus: getStatus,
        stageDynamicPluginActivation: stage,
      },
    } as unknown as Env,
    getPreparation,
    stage,
    configure,
    sync,
  };
}

describe('dynamic plugin resource finalization', () => {
  it('removes only the exact tenant and plugin finalization job on disable', async () => {
    const store = kv();
    await enqueueDynamicPluginResourceFinalization(
      store.binding,
      { operationId: 'op-plugin-a', tenantId: 'tenant-a', pluginId: 'plugin-a' },
      100
    );

    await expect(
      cancelDynamicPluginResourceFinalization(store.binding, {
        operationId: 'op-plugin-a',
        tenantId: 'tenant-b',
        pluginId: 'plugin-a',
      })
    ).rejects.toThrow('plugin_resource_finalization_cancel_mismatch');
    expect(store.store.size).toBe(1);

    await cancelDynamicPluginResourceFinalization(store.binding, {
      operationId: 'op-plugin-a',
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
    });
    expect(store.store.size).toBe(0);
  });

  it('keeps a pending operation queued without touching Runner', async () => {
    const store = kv();
    await enqueueDynamicPluginResourceFinalization(
      store.binding,
      { operationId: 'op-plugin-a', tenantId: 'tenant-a', pluginId: 'plugin-a' },
      100
    );
    const target = env(store.binding, 'pending');

    await expect(processDynamicPluginResourceFinalizations(target.value)).resolves.toEqual({
      inspected: 1,
      finalized: 0,
      pending: 1,
      failed: 0,
    });
    expect(target.configure).not.toHaveBeenCalled();
    expect(store.store.size).toBe(1);
  });

  it('enables Runner and deletes the job only after exact Control readiness', async () => {
    const store = kv();
    await enqueueDynamicPluginResourceFinalization(
      store.binding,
      { operationId: 'op-plugin-a', tenantId: 'tenant-a', pluginId: 'plugin-a' },
      100
    );
    const target = env(store.binding, 'ready');
    const binding = target.value.CONTROL;
    if (!binding) throw new Error('test_control_binding_missing');
    binding.getPluginDynamicWorkerResourcePreparation = rpcMethod(target.getPreparation);

    await expect(processDynamicPluginResourceFinalizations(target.value)).resolves.toEqual({
      inspected: 1,
      finalized: 1,
      pending: 0,
      failed: 0,
    });
    expect(target.configure).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      enabled: true,
      activationRequestId: 'op-plugin-a',
    });
    expect(target.sync).toHaveBeenCalledTimes(1);
    expect(store.store.size).toBe(0);
  });

  it('fails closed on an operation mismatch and stores only a redacted code', async () => {
    const store = kv();
    await enqueueDynamicPluginResourceFinalization(
      store.binding,
      { operationId: 'op-plugin-a', tenantId: 'tenant-a', pluginId: 'plugin-a' },
      100
    );
    const target = env(store.binding, 'ready', 'op-other');

    await expect(processDynamicPluginResourceFinalizations(target.value)).resolves.toEqual({
      inspected: 1,
      finalized: 0,
      pending: 0,
      failed: 1,
    });
    expect(target.configure).not.toHaveBeenCalled();
    const serialized = [...store.store.values()][0] ?? '';
    expect(JSON.parse(serialized)).toMatchObject({
      attemptCount: 1,
      lastErrorCode: 'plugin_resource_finalization_operation_mismatch',
    });
    expect(serialized).not.toMatch(/token|secret|credential/iu);
  });

  it('does not persist an unexpected secret-shaped exception message', async () => {
    const store = kv();
    await enqueueDynamicPluginResourceFinalization(
      store.binding,
      { operationId: 'op-plugin-a', tenantId: 'tenant-a', pluginId: 'plugin-a' },
      100
    );
    const target = env(store.binding, 'ready');
    target.getPreparation.mockRejectedValueOnce(new Error('sk_live_unexpected_secret_value'));

    await expect(processDynamicPluginResourceFinalizations(target.value)).resolves.toMatchObject({
      failed: 1,
    });

    const serialized = [...store.store.values()][0] ?? '';
    expect(JSON.parse(serialized)).toMatchObject({
      attemptCount: 1,
      lastErrorCode: 'plugin_resource_finalization_failed',
    });
    expect(serialized).not.toContain('sk_live_unexpected_secret_value');
  });
});
