import type {
  ConfigureDynamicPluginInstallationInput,
  ControlPluginDynamicWorkerDesiredStatePlan,
  ControlPluginDynamicWorkerDesiredStateRequest,
  ControlPluginDynamicWorkerObservedStateRequest,
  ControlPluginDynamicWorkerResourcePreparation,
  Env,
  StageDynamicPluginActivationInput,
} from '@authrim/ar-lib-core';
import { generateVersion } from '@authrim/ar-lib-core';
import { describe, expect, it, vi } from 'vitest';
import { ExternalPluginGateUnavailableError } from '../external-plugin-gate-sync';
import {
  configureDynamicPluginWithControl,
  ExternalPluginExecutionNotAllowedError,
  getDynamicPluginResourcePreparationForDisable,
  getDynamicPluginResourceProvisioning,
} from '../plugin-dynamic-worker-control';

const installationId = `plugin-installation-v1-${'a'.repeat(64)}`;
const versionDigest = 'b'.repeat(64);

/** A DB_ADMIN whose canonical settings document of tenant-a/plugin is the given one. */
function canonicalDatabase(
  document: Record<string, unknown> | (() => Record<string, unknown>)
): D1Database {
  const statement = () => ({
    first: async () => {
      const data = typeof document === 'function' ? document() : document;
      return {
        tenant_id: 'tenant-a',
        scope_type: 'tenant',
        scope_id: 'tenant-a',
        category: 'plugin',
        document_json: JSON.stringify(data),
        version: generateVersion(data),
      };
    },
    all: async () => ({ results: [] }),
    run: async () => ({ success: true, meta: { changes: 0 } }),
  });
  const session = { prepare: () => ({ bind: statement, ...statement() }) };
  return { ...session, withSession: () => session } as unknown as D1Database;
}

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

function fixture(overrides: Partial<Env> & { PLUGIN_ENABLED?: string } = {}) {
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
  // The runner's gate, with its compare-and-swap on the generation: every close advances it, an
  // open must name the generation the opener read.
  const gate = { allowed: false, generation: 0 };
  const setGate = vi.fn(
    async (input: { tenantId: string; allowed: boolean; ifGeneration?: number }) => {
      if (input.allowed) {
        if (input.ifGeneration !== gate.generation) {
          throw new Error('plugin_dynamic_external_gate_generation_conflict');
        }
        if (!gate.allowed) {
          gate.allowed = true;
          gate.generation += 1;
        }
      } else {
        gate.allowed = false;
        gate.generation += 1;
      }
      return { tenantId: input.tenantId, allowed: gate.allowed, generation: gate.generation };
    }
  );
  const getGate = vi.fn(async (input: { tenantId: string }) => ({
    tenantId: input.tenantId,
    ...gate,
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
    // The tenant allows external plugin code (plugin.enabled), which switching one on requires.
    PLUGIN_ENABLED: 'true',
    CONTROL: {
      validatePluginDynamicWorkerDesiredState: validate,
      preparePluginDynamicWorkerResources: prepare,
      syncPluginDynamicWorkerObservedState: sync,
    },
    PLUGIN_RUNNER: {
      configureDynamicPluginInstallation: configure,
      getDynamicPluginInstallationStatus: getStatus,
      stageDynamicPluginActivation: stage,
      setTenantExternalGate: setGate,
      getTenantExternalGate: getGate,
    },
    ...overrides,
  } as unknown as Env;
  return { env, validate, prepare, stage, configure, getStatus, sync, setGate, getGate, gate };
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

  describe('the tenant permission for external plugin code (plugin.enabled)', () => {
    const enable = (env: Env) =>
      configureDynamicPluginWithControl(env, {
        tenantId: 'tenant-a',
        pluginId: 'plugin-a',
        enabled: true,
      });

    it.each([
      ['off (the environment variable)', { PLUGIN_ENABLED: 'false' }],
      ['not set at all', { PLUGIN_ENABLED: undefined }],
    ])(
      'refuses to switch a plugin on when it is %s, before any Control or Runner call',
      async (_, overrides) => {
        const { env, validate, prepare, stage, configure, sync } = fixture(overrides);

        await expect(enable(env)).rejects.toBeInstanceOf(ExternalPluginExecutionNotAllowedError);
        await expect(enable(env)).rejects.toThrow('external_plugin_execution_not_allowed');

        expect(validate).not.toHaveBeenCalled();
        expect(prepare).not.toHaveBeenCalled();
        expect(stage).not.toHaveBeenCalled();
        expect(configure).not.toHaveBeenCalled();
        expect(sync).not.toHaveBeenCalled();
      }
    );

    it('refuses when the tenant turned it off, even though the environment variable is on', async () => {
      const { env, configure } = fixture({
        SETTINGS: {
          get: async (key: string) =>
            key === 'settings:tenant:tenant-a:plugin'
              ? JSON.stringify({ 'plugin.enabled': false })
              : null,
        } as unknown as KVNamespace,
      });

      await expect(enable(env)).rejects.toBeInstanceOf(ExternalPluginExecutionNotAllowedError);
      expect(configure).not.toHaveBeenCalled();
    });

    it('allows it when the tenant turned it on, even though the environment variable is off', async () => {
      const { env, configure } = fixture({
        PLUGIN_ENABLED: 'false',
        SETTINGS: {
          get: async (key: string) =>
            key === 'settings:tenant:tenant-a:plugin'
              ? JSON.stringify({ 'plugin.enabled': true })
              : null,
        } as unknown as KVNamespace,
      });

      await expect(enable(env)).resolves.toMatchObject({ controlState: { state: 'enabled' } });
      expect(configure).toHaveBeenCalledTimes(1);
    });

    it('refuses when the setting cannot be read (fail-closed), as unavailable rather than denied', async () => {
      const { env, configure, setGate } = fixture({
        SETTINGS: {
          get: async () => {
            throw new Error('kv_unavailable');
          },
        } as unknown as KVNamespace,
      });

      await expect(enable(env)).rejects.toBeInstanceOf(ExternalPluginGateUnavailableError);
      expect(configure).not.toHaveBeenCalled();
      expect(setGate).not.toHaveBeenCalled();
    });

    it('opens the runner gate for the tenant just before the installation is switched on', async () => {
      const { env, configure, setGate } = fixture();
      const order: string[] = [];
      setGate.mockImplementation(async (input) => {
        order.push(`gate:${input.allowed}`);
        return { tenantId: input.tenantId, allowed: input.allowed, generation: 1 };
      });
      configure.mockImplementationOnce(async (input) => {
        order.push(`install:${input.enabled}`);
        return {
          installationId,
          tenantId: input.tenantId,
          pluginId: input.pluginId,
          state: 'enabled' as const,
          configVersion: 2,
          pinnedVersionDigest: versionDigest,
        };
      });

      await enable(env);

      expect(setGate).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
        allowed: true,
        ifGeneration: 0,
      });
      expect(order).toEqual(['gate:true', 'install:true']);
    });

    it('does not switch the installation on when the gate cannot be opened', async () => {
      const { env, configure, setGate, sync } = fixture();
      setGate.mockRejectedValue(new Error('plugin_sync_internal_error'));

      await expect(enable(env)).rejects.toBeInstanceOf(ExternalPluginGateUnavailableError);
      expect(configure).not.toHaveBeenCalled();
      expect(sync).not.toHaveBeenCalled();
    });

    it('does not switch the installation on when the runner cannot hold a gate', async () => {
      const { env, configure } = fixture();
      delete (env.PLUGIN_RUNNER as unknown as Record<string, unknown>).setTenantExternalGate;

      await expect(enable(env)).rejects.toBeInstanceOf(ExternalPluginGateUnavailableError);
      expect(configure).not.toHaveBeenCalled();
    });

    it('never opens the gate for a refused tenant', async () => {
      const { env, setGate } = fixture({ PLUGIN_ENABLED: 'false' });
      await expect(enable(env)).rejects.toBeInstanceOf(ExternalPluginExecutionNotAllowedError);
      expect(setGate).not.toHaveBeenCalled();
    });

    it('goes by the saved setting, not the KV copy that still says on', async () => {
      // The tenant turned it off: D1 (canonical) says off, but the KV projection is pending and
      // still holds the old "on". The enable must not reopen the gate from the stale copy.
      const saved = { 'plugin.enabled': false };
      const { env, configure, setGate } = fixture({
        SETTINGS: {
          get: async (key: string) =>
            key === 'settings:tenant:tenant-a:plugin'
              ? JSON.stringify({ 'plugin.enabled': true })
              : null,
        } as unknown as KVNamespace,
        DB_ADMIN: canonicalDatabase(saved),
      });

      await expect(enable(env)).rejects.toBeInstanceOf(ExternalPluginExecutionNotAllowedError);
      // The gate is put where the saved setting says (closed); it is never opened.
      expect(setGate.mock.calls.map(([input]) => input.allowed)).toEqual([false]);
      expect(configure).not.toHaveBeenCalled();
    });

    it('opens the gate when the saved setting is on, even before the KV copy catches up', async () => {
      const { env, configure, setGate } = fixture({
        PLUGIN_ENABLED: 'true',
        SETTINGS: {
          get: async (key: string) =>
            key === 'settings:tenant:tenant-a:plugin'
              ? JSON.stringify({ 'plugin.enabled': true })
              : null,
        } as unknown as KVNamespace,
        DB_ADMIN: canonicalDatabase({ 'plugin.enabled': true }),
      });

      await expect(enable(env)).resolves.toMatchObject({ controlState: { state: 'enabled' } });
      expect(setGate).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
        allowed: true,
        ifGeneration: 0,
      });
      expect(configure).toHaveBeenCalledTimes(1);
    });

    it('closes the gate and switches the installation back off when the setting was turned off during the enable', async () => {
      // Order: this enable checks "on", the turn-off closes the gate and switches installations
      // off, this enable then switches the installation on, the turn-off is saved.
      let saved: Record<string, unknown> = { 'plugin.enabled': true };
      const { env, configure, setGate } = fixture({
        DB_ADMIN: canonicalDatabase(() => saved),
      });
      configure.mockImplementationOnce(async (input) => {
        saved = { 'plugin.enabled': false };
        return {
          installationId,
          tenantId: input.tenantId,
          pluginId: input.pluginId,
          state: 'enabled' as const,
          configVersion: 2,
          pinnedVersionDigest: versionDigest,
        };
      });

      await expect(enable(env)).rejects.toBeInstanceOf(ExternalPluginExecutionNotAllowedError);

      expect(setGate.mock.calls.map(([input]) => input.allowed)).toEqual([true, false]);
      expect(configure).toHaveBeenLastCalledWith({
        tenantId: 'tenant-a',
        pluginId: 'plugin-a',
        enabled: false,
      });
    });

    it('cannot reopen the gate with an open decided before a turn-off that finished meanwhile', async () => {
      // This enable reads the gate (generation 0) and then the saved setting ("on"); before it
      // can open, a whole turn-off completes: gate closed (generation advances), installations
      // off, "off" saved, gate closed again. Its open must be refused, not applied.
      let saved: Record<string, unknown> = { 'plugin.enabled': true };
      let turnedOffMeanwhile = false;
      let gateRef: { allowed: boolean; generation: number } | undefined;
      const { env, configure, setGate, gate } = fixture({
        DB_ADMIN: canonicalDatabase(() => {
          const read = saved;
          if (!turnedOffMeanwhile) {
            turnedOffMeanwhile = true;
            saved = { 'plugin.enabled': false };
            gateRef!.allowed = false;
            gateRef!.generation += 2;
          }
          return read;
        }),
      });
      gateRef = gate;

      await expect(enable(env)).rejects.toBeInstanceOf(ExternalPluginExecutionNotAllowedError);

      expect(setGate.mock.calls.map(([input]) => input.allowed)).toEqual([true, false]);
      expect(setGate.mock.calls[0][0]).toMatchObject({ allowed: true, ifGeneration: 0 });
      expect(gate.allowed).toBe(false);
      expect(configure).not.toHaveBeenCalled();
    });

    it('closes the gate and switches the installation back off when Control fails after a turn-off finished', async () => {
      let saved: Record<string, unknown> = { 'plugin.enabled': true };
      const { env, configure, sync, gate } = fixture({ DB_ADMIN: canonicalDatabase(() => saved) });
      configure.mockImplementationOnce(async (input) => {
        saved = { 'plugin.enabled': false };
        return {
          installationId,
          tenantId: input.tenantId,
          pluginId: input.pluginId,
          state: 'enabled' as const,
          configVersion: 2,
          pinnedVersionDigest: versionDigest,
        };
      });
      sync.mockRejectedValueOnce(new Error('control_down'));

      await expect(enable(env)).rejects.toThrow('control_down');

      expect(gate.allowed).toBe(false);
      expect(configure).toHaveBeenLastCalledWith({
        tenantId: 'tenant-a',
        pluginId: 'plugin-a',
        enabled: false,
      });
    });

    it('leaves the gate alone when Control fails but the setting still says on', async () => {
      const { env, configure, sync, gate } = fixture();
      sync.mockRejectedValueOnce(new Error('control_down'));

      await expect(enable(env)).rejects.toThrow('control_down');

      // The setting allows external plugins, so the gate rightly stays open for the tenant's other
      // external plugins; only this enable failed.
      expect(gate.allowed).toBe(true);
      expect(configure).toHaveBeenCalledTimes(1);
    });

    it('decides again after a refused open and then opens from the new generation', async () => {
      // A close lands between the generation read and the open the first time only.
      const { env, setGate, gate } = fixture();
      const open = setGate.getMockImplementation()!;
      setGate.mockImplementationOnce(async (input) => {
        gate.generation += 1; // a close (and nothing else) came in
        return open(input);
      });

      await expect(enable(env)).resolves.toMatchObject({ controlState: { state: 'enabled' } });

      expect(setGate.mock.calls.map(([input]) => input.ifGeneration)).toEqual([0, 1]);
      expect(gate.allowed).toBe(true);
    });

    it('always lets a plugin be switched off', async () => {
      const { env, configure } = fixture({ PLUGIN_ENABLED: 'false' });

      await expect(
        configureDynamicPluginWithControl(env, {
          tenantId: 'tenant-a',
          pluginId: 'plugin-a',
          enabled: false,
        })
      ).resolves.toMatchObject({ controlState: { state: 'disabled' } });
      expect(configure).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
        pluginId: 'plugin-a',
        enabled: false,
      });
    });
  });
});
