import type {
  ConfigureDynamicPluginInstallationInput,
  ControlPluginDynamicWorkerDesiredStatePlan,
  ControlPluginDynamicWorkerDesiredStateRequest,
  ControlPluginDynamicWorkerObservedStateRequest,
  ControlPluginDynamicWorkerResourcePreparation,
  Env,
  StageDynamicPluginActivationInput,
} from '@authrim/ar-lib-core';
import { describe, expect, it, vi } from 'vitest';
import {
  configureDynamicPluginWithControl,
  getDynamicPluginResourcePreparationForDisable,
  getDynamicPluginResourceProvisioning,
} from '../plugin-dynamic-worker-control';

const installationId = `plugin-installation-v1-${'a'.repeat(64)}`;
const versionDigest = 'b'.repeat(64);

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

function fixture(overrides: Partial<Env> = {}) {
  const validate = vi.fn(
    async (
      input: ControlPluginDynamicWorkerDesiredStateRequest
    ): Promise<ControlPluginDynamicWorkerDesiredStatePlan> => ({
      environmentId: 'test',
      tenantId: input.tenantId,
      pluginId: input.pluginId,
      installationId,
      capabilityManifestDigest: 'c'.repeat(64),
      enabled: input.enabled,
      bindings: [
        {
          name: 'TENANT_PROFILE',
          interface: 'authrim.account_metadata.v1',
          scope: 'tenant' as const,
        },
      ],
      resources: [],
    })
  );
  const configure = vi.fn(async (input: ConfigureDynamicPluginInstallationInput) => ({
    installationId,
    tenantId: input.tenantId,
    pluginId: input.pluginId,
    state: input.enabled ? ('enabled' as const) : ('disabled' as const),
    configVersion: 2,
    pinnedVersionDigest: input.enabled ? versionDigest : null,
  }));
  const getStatus = vi.fn(async (input: { tenantId: string; pluginId: string }) => ({
    installationId,
    tenantId: input.tenantId,
    pluginId: input.pluginId,
    state: 'disabled' as const,
    configVersion: 1,
    pinnedVersionDigest: null,
  }));
  const stage = vi.fn(async (input: StageDynamicPluginActivationInput) => ({
    installationId,
    tenantId: input.tenantId,
    pluginId: input.pluginId,
    activationRequestId: input.activationRequestId,
    state: 'pending' as const,
  }));
  const prepare = vi.fn(
    async (
      input: ControlPluginDynamicWorkerDesiredStateRequest
    ): Promise<ControlPluginDynamicWorkerResourcePreparation> => ({
      environmentId: 'test',
      tenantId: input.tenantId,
      pluginId: input.pluginId,
      installationId,
      capabilityManifestDigest: 'c'.repeat(64),
      enabled: input.enabled,
      bindings: [],
      resources: (input.resourceSelections ?? []).map((selection) => ({
        schemaVersion: 1,
        logicalResourceId: selection.logicalResourceId,
        binding: 'PLUGIN_CACHE',
        kind: 'kv_namespace',
        scope: 'tenant',
        access: 'read_write',
        lifecycleMode: 'existing',
        allowExisting: true,
        migrationStream: null,
        providerResourceId: selection.providerResourceId,
        providerName: selection.providerName,
      })),
      operationId: 'op_plugin_resources_a',
      readiness: 'ready',
    })
  );
  const sync = vi.fn(async (input: ControlPluginDynamicWorkerObservedStateRequest) => ({
    operationId: 'op_plugin_sync_a',
    environmentId: 'test',
    tenantId: input.tenantId,
    pluginId: input.pluginId,
    installationId: input.installationId,
    capabilityManifestDigest: 'c'.repeat(64),
    enabled: input.state === 'enabled',
    bindings: [
      {
        name: 'TENANT_PROFILE',
        interface: 'authrim.account_metadata.v1' as const,
        scope: 'tenant' as const,
      },
    ],
    resources: [],
    state: input.state,
    configVersion: input.configVersion,
    pinnedVersionDigest: input.pinnedVersionDigest,
    bindingStatus: input.state === 'enabled' ? ('active' as const) : ('deleted' as const),
  }));
  const env = {
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    CONTROL: {
      validatePluginDynamicWorkerDesiredState: validate,
      preparePluginDynamicWorkerResources: prepare,
      syncPluginDynamicWorkerObservedState: sync,
    },
    PLUGIN_RUNNER: {
      configureDynamicPluginInstallation: configure,
      getDynamicPluginInstallationStatus: getStatus,
      stageDynamicPluginActivation: stage,
    },
    ...overrides,
  } as unknown as Env;
  return { env, validate, prepare, stage, configure, getStatus, sync };
}

describe('configureDynamicPluginWithControl', () => {
  it('allows disable preparation to proceed only when an inactive manifest blocks readback', async () => {
    const { env } = fixture();
    env.CONTROL!.getPluginDynamicWorkerResourcePreparation = vi
      .fn()
      .mockRejectedValueOnce(new Error('control_plugin_manifest_unavailable'))
      .mockRejectedValueOnce(new Error('control_plugin_resource_state_invalid'));

    await expect(
      getDynamicPluginResourcePreparationForDisable(env, {
        tenantId: 'tenant-a',
        pluginId: 'plugin-a',
      })
    ).resolves.toBeNull();
    await expect(
      getDynamicPluginResourcePreparationForDisable(env, {
        tenantId: 'tenant-a',
        pluginId: 'plugin-a',
      })
    ).rejects.toThrow('control_plugin_resource_state_invalid');
  });

  it('invokes Cloudflare RPC method proxies without accessing Function.bind', async () => {
    const { env, validate, configure, sync } = fixture();
    const getCleanup = vi.fn(async () => null);
    const getPreparation = vi.fn(async () => ({
      environmentId: 'test',
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      installationId,
      capabilityManifestDigest: 'c'.repeat(64),
      enabled: true,
      bindings: [],
      resources: [],
      operationId: 'op_plugin_resources_a',
      readiness: 'pending' as const,
    }));
    const binding = env.CONTROL;
    if (!binding) throw new Error('test_control_binding_missing');
    binding.validatePluginDynamicWorkerDesiredState = rpcMethod(validate);
    binding.syncPluginDynamicWorkerObservedState = rpcMethod(sync);
    binding.getPluginResourceCleanup = rpcMethod(getCleanup);
    binding.getPluginDynamicWorkerResourcePreparation = rpcMethod(getPreparation);

    await expect(
      getDynamicPluginResourceProvisioning(env, {
        tenantId: 'tenant-a',
        pluginId: 'plugin-a',
      })
    ).resolves.toMatchObject({ operationId: 'op_plugin_resources_a', state: 'pending' });
    await expect(
      configureDynamicPluginWithControl(env, {
        tenantId: 'tenant-a',
        pluginId: 'plugin-a',
        enabled: true,
      })
    ).resolves.toMatchObject({ controlState: { state: 'enabled' } });
    expect(configure).toHaveBeenCalledTimes(1);
  });

  it('restores a pending resource operation through the read-only Control status RPC', async () => {
    const { env, configure } = fixture();
    const getPreparation = vi.fn(async () => ({
      environmentId: 'test',
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      installationId,
      capabilityManifestDigest: 'c'.repeat(64),
      enabled: true,
      bindings: [],
      resources: [],
      operationId: 'op_plugin_resources_a',
      readiness: 'pending' as const,
    }));
    env.CONTROL!.getPluginDynamicWorkerResourcePreparation = getPreparation;

    await expect(
      getDynamicPluginResourceProvisioning(env, {
        tenantId: 'tenant-a',
        pluginId: 'plugin-a',
      })
    ).resolves.toEqual({
      operationId: 'op_plugin_resources_a',
      state: 'pending',
      kind: 'provisioning',
    });
    expect(getPreparation).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      enabled: true,
    });
    expect(configure).not.toHaveBeenCalled();
  });

  it('reports an active cleanup before stale provisioning state', async () => {
    const { env } = fixture();
    env.CONTROL!.getPluginResourceCleanup = vi.fn(async () => ({
      operationId: 'op_plugin_cleanup_a',
      environmentId: 'test',
      pluginInstallationId: installationId,
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      sourceOperationId: 'op_plugin_resources_a',
      lifecycleGeneration: 1,
      reason: 'uninstall' as const,
      state: 'quarantined' as const,
      drainNotBefore: 1900,
      managedResourceCount: 1,
      detachedResourceCount: 0,
      lastErrorCode: null,
      createdAt: 100,
      updatedAt: 100,
      completedAt: null,
    }));
    const getPreparation = vi.fn();
    env.CONTROL!.getPluginDynamicWorkerResourcePreparation = getPreparation;

    await expect(
      getDynamicPluginResourceProvisioning(env, {
        tenantId: 'tenant-a',
        pluginId: 'plugin-a',
      })
    ).resolves.toEqual({
      operationId: 'op_plugin_cleanup_a',
      state: 'pending',
      kind: 'cleanup',
    });
    expect(getPreparation).not.toHaveBeenCalled();
  });

  it('validates with Control before Runner mutation and reflects only the narrow result', async () => {
    const { env, validate, configure, sync } = fixture();

    const result = await configureDynamicPluginWithControl(env, {
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      enabled: true,
    });

    expect(validate).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      enabled: true,
    });
    expect(configure).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      enabled: true,
    });
    expect(sync).toHaveBeenCalledWith({
      installationId,
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      state: 'enabled',
      configVersion: 2,
      pinnedVersionDigest: versionDigest,
      resourceSelections: [],
    });
    expect(result.controlState.bindingStatus).toBe('active');
  });

  it('keeps existing provider resource identities on the Control side of the boundary', async () => {
    const { env, validate, configure, sync } = fixture();
    const selection = {
      logicalResourceId: 'plugin_cache',
      mode: 'existing' as const,
      providerResourceId: 'resource-a',
      providerName: 'existing-cache',
    };
    validate.mockResolvedValueOnce({
      environmentId: 'test',
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      installationId,
      capabilityManifestDigest: 'c'.repeat(64),
      enabled: true,
      bindings: [],
      resources: [
        {
          schemaVersion: 1,
          logicalResourceId: 'plugin_cache',
          binding: 'PLUGIN_CACHE',
          kind: 'kv_namespace',
          scope: 'tenant',
          access: 'read_write',
          lifecycleMode: 'existing',
          allowExisting: true,
          migrationStream: null,
          providerResourceId: 'resource-a',
          providerName: 'existing-cache',
        },
      ],
    });

    await configureDynamicPluginWithControl(env, {
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      enabled: true,
      resourceSelections: [selection],
    });

    expect(configure).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      enabled: true,
      activationRequestId: 'op_plugin_resources_a',
    });
    expect(JSON.stringify(configure.mock.calls)).not.toContain('resource-a');
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ resourceSelections: [selection] }));
  });

  it('does not mutate Runner while dedicated resources are still pending', async () => {
    const { env, validate, prepare, configure, sync } = fixture();
    const resource = {
      schemaVersion: 1 as const,
      logicalResourceId: 'plugin_cache',
      binding: 'PLUGIN_CACHE',
      kind: 'kv_namespace' as const,
      scope: 'tenant' as const,
      access: 'read_write' as const,
      lifecycleMode: 'managed' as const,
      allowExisting: true,
      migrationStream: null,
      providerResourceId: null,
      providerName: null,
    };
    validate.mockResolvedValueOnce({
      environmentId: 'test',
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      installationId,
      capabilityManifestDigest: 'c'.repeat(64),
      enabled: true,
      bindings: [],
      resources: [resource],
    });
    prepare.mockResolvedValueOnce({
      environmentId: 'test',
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      installationId,
      capabilityManifestDigest: 'c'.repeat(64),
      enabled: true,
      bindings: [],
      resources: [resource],
      operationId: 'op_plugin_resources_a',
      readiness: 'pending',
    });

    await expect(
      configureDynamicPluginWithControl(env, {
        tenantId: 'tenant-a',
        pluginId: 'plugin-a',
        enabled: true,
      })
    ).rejects.toMatchObject({
      message: 'dynamic_plugin_resources_not_ready',
      preparation: { operationId: 'op_plugin_resources_a', readiness: 'pending' },
    });
    expect(configure).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it('fails closed before Runner mutation when Control is unavailable', async () => {
    const { env, configure } = fixture({ CONTROL: undefined });

    await expect(
      configureDynamicPluginWithControl(env, {
        tenantId: 'tenant-a',
        pluginId: 'plugin-a',
        enabled: true,
      })
    ).rejects.toThrow('dynamic_plugin_control_unavailable');
    expect(configure).not.toHaveBeenCalled();
  });

  it('rejects a cross-environment Control plan before Runner mutation', async () => {
    const { env, validate, configure } = fixture();
    validate.mockResolvedValueOnce({
      environmentId: 'other',
      tenantId: 'tenant-a',
      pluginId: 'plugin-a',
      installationId,
      capabilityManifestDigest: 'c'.repeat(64),
      enabled: true,
      bindings: [],
      resources: [],
    });

    await expect(
      configureDynamicPluginWithControl(env, {
        tenantId: 'tenant-a',
        pluginId: 'plugin-a',
        enabled: true,
      })
    ).rejects.toThrow('dynamic_plugin_control_plan_mismatch');
    expect(configure).not.toHaveBeenCalled();
  });

  it('does not sync a wrong-tenant Runner result into Control', async () => {
    const { env, configure, sync } = fixture();
    configure.mockResolvedValueOnce({
      installationId,
      tenantId: 'tenant-b',
      pluginId: 'plugin-a',
      state: 'enabled',
      configVersion: 2,
      pinnedVersionDigest: versionDigest,
    });

    await expect(
      configureDynamicPluginWithControl(env, {
        tenantId: 'tenant-a',
        pluginId: 'plugin-a',
        enabled: true,
      })
    ).rejects.toThrow('dynamic_plugin_runner_result_mismatch');
    expect(sync).not.toHaveBeenCalled();
  });
});
