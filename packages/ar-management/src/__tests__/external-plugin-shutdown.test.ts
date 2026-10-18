import type { Env } from '@authrim/ar-lib-core';
import { describe, expect, it, vi } from 'vitest';
import {
  disableTenantExternalPlugins,
  ExternalPluginShutdownError,
  patchTurnsExternalPluginsOff,
} from '../external-plugin-shutdown';
import { enqueueDynamicPluginResourceFinalization } from '../plugin-resource-finalization';

describe('patchTurnsExternalPluginsOff', () => {
  const never = async () => {
    throw new Error('the inherited value was not needed');
  };
  const none = { applied: [], cleared: [], disabled: [] };

  it.each([
    [
      'sets it to false',
      { set: { 'plugin.enabled': false } },
      { ...none, applied: ['plugin.enabled'] },
      true,
    ],
    ['disables it', {}, { ...none, disabled: ['plugin.enabled'] }, true],
    [
      'sets it to true',
      { set: { 'plugin.enabled': true } },
      { ...none, applied: ['plugin.enabled'] },
      false,
    ],
    ['touches no plugin setting', {}, none, false],
    [
      'names only another key',
      { set: { other: false } },
      { ...none, applied: ['other'], cleared: ['other'] },
      false,
    ],
    // What the settings manager refuses never counts, whatever the request said.
    ['asks for false but is refused', { set: { 'plugin.enabled': false } }, none, false],
    ['asks to disable but is refused', {}, none, false],
  ])('a PATCH that %s', async (_, patch, decision, expected) => {
    await expect(patchTurnsExternalPluginsOff(patch, decision, never)).resolves.toBe(expected);
  });

  it('turns it off by clearing only when what would be inherited is not on', async () => {
    const decision = { ...none, cleared: ['plugin.enabled'] };
    await expect(patchTurnsExternalPluginsOff({}, decision, async () => false)).resolves.toBe(true);
    await expect(patchTurnsExternalPluginsOff({}, decision, async () => undefined)).resolves.toBe(
      true
    );
    await expect(patchTurnsExternalPluginsOff({}, decision, async () => true)).resolves.toBe(false);
  });
});

describe('disableTenantExternalPlugins', () => {
  const installationId = `plugin-installation-v1-${'a'.repeat(64)}`;
  const approved = (pluginId: string) => ({
    pluginId,
    capabilityManifestDigest: 'c'.repeat(64),
    activeVersionDigest: 'a'.repeat(64),
    visibility: 'tenant' as const,
    capabilities: ['hook.account.lifecycle'],
    credentials: [],
    resources: [],
    updatedAt: 100,
  });

  function fixture(
    states: Record<string, 'enabled' | 'disabled' | 'absent'>,
    options: { preparation?: Record<string, string>; failOn?: string } = {}
  ) {
    const configure = vi.fn(
      async (input: { tenantId: string; pluginId: string; enabled: boolean }) => {
        if (input.pluginId === options.failOn) throw new Error('runner_down');
        return {
          installationId,
          tenantId: input.tenantId,
          pluginId: input.pluginId,
          state: input.enabled ? ('enabled' as const) : ('disabled' as const),
          configVersion: 2,
          pinnedVersionDigest: null,
        };
      }
    );
    const store = new Map<string, string>();
    const kv = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        store.delete(key);
      }),
    } as unknown as KVNamespace;
    const env = {
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      SETTINGS: kv,
      PLUGIN_RUNNER: {
        listApprovedDynamicPlugins: vi.fn(async () => Object.keys(states).map(approved)),
        getDynamicPluginInstallationStatus: vi.fn(
          async (input: { tenantId: string; pluginId: string }) => ({
            installationId,
            tenantId: input.tenantId,
            pluginId: input.pluginId,
            state: states[input.pluginId],
            configVersion: 1,
            configuredKeys: [],
            missingRequiredFields: [],
            pinnedVersionDigest: null,
          })
        ),
        configureDynamicPluginInstallation: configure,
      },
      CONTROL: {
        validatePluginDynamicWorkerDesiredState: vi.fn(
          async (input: { tenantId: string; pluginId: string; enabled: boolean }) => ({
            environmentId: 'test',
            tenantId: input.tenantId,
            pluginId: input.pluginId,
            installationId,
            capabilityManifestDigest: 'c'.repeat(64),
            enabled: input.enabled,
            bindings: [],
            resources: [],
          })
        ),
        syncPluginDynamicWorkerObservedState: vi.fn(async (input) => ({
          operationId: 'op_sync',
          environmentId: 'test',
          capabilityManifestDigest: 'c'.repeat(64),
          enabled: input.state === 'enabled',
          bindings: [],
          resources: [],
          bindingStatus: 'deleted' as const,
          ...input,
        })),
        getPluginDynamicWorkerResourcePreparation: vi.fn(
          async (input: { tenantId: string; pluginId: string }) => {
            const operationId = options.preparation?.[input.pluginId];
            return operationId
              ? {
                  environmentId: 'test',
                  tenantId: input.tenantId,
                  pluginId: input.pluginId,
                  installationId,
                  capabilityManifestDigest: 'c'.repeat(64),
                  enabled: true,
                  bindings: [],
                  resources: [],
                  operationId,
                  readiness: 'pending' as const,
                }
              : null;
          }
        ),
      },
    } as unknown as Env;
    return { env, configure, store };
  }

  it('does nothing without a plugin runner', async () => {
    await expect(disableTenantExternalPlugins({} as Env, 'tenant-a')).resolves.toEqual([]);
  });

  it('switches off the enabled external plugins of the tenant and leaves the others', async () => {
    const { env, configure } = fixture({ on: 'enabled', off: 'disabled', none: 'absent' });

    await expect(disableTenantExternalPlugins(env, 'tenant-a')).resolves.toEqual(['on']);

    expect(configure).toHaveBeenCalledTimes(1);
    expect(configure).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      pluginId: 'on',
      enabled: false,
    });
  });

  it('cancels the delayed activation of a plugin whose resources were still being prepared', async () => {
    const { env, configure, store } = fixture(
      { staged: 'disabled' },
      { preparation: { staged: 'op-staged' } }
    );
    await enqueueDynamicPluginResourceFinalization(
      env.SETTINGS!,
      { operationId: 'op-staged', tenantId: 'tenant-a', pluginId: 'staged' },
      100
    );
    expect(store.size).toBe(1);

    await expect(disableTenantExternalPlugins(env, 'tenant-a')).resolves.toEqual(['staged']);

    expect(configure).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      pluginId: 'staged',
      enabled: false,
    });
    expect(store.size).toBe(0);
  });

  it('throws when an installation cannot be switched off, naming the plugin that failed', async () => {
    const { env, configure } = fixture({ a: 'enabled', b: 'enabled' }, { failOn: 'a' });

    const error = await disableTenantExternalPlugins(env, 'tenant-a').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExternalPluginShutdownError);
    expect(error).toMatchObject({ stopped: [], failedPluginId: 'a' });
    expect(configure).toHaveBeenCalledTimes(1);
  });

  it('keeps the plugins it did switch off when a later one fails', async () => {
    const { env, configure } = fixture(
      { a: 'enabled', b: 'enabled', c: 'enabled' },
      { failOn: 'b' }
    );

    const error = await disableTenantExternalPlugins(env, 'tenant-a').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExternalPluginShutdownError);
    expect(error).toMatchObject({ stopped: ['a'], failedPluginId: 'b' });
    expect(configure.mock.calls.map(([input]) => input.pluginId)).toEqual(['a', 'b']);
  });

  it('throws when the approved plugins cannot be listed, with nothing stopped', async () => {
    const { env } = fixture({ a: 'enabled' });
    Object.assign(env.PLUGIN_RUNNER!, {
      listApprovedDynamicPlugins: vi.fn(async () => {
        throw new Error('runner_down');
      }),
    });

    const error = await disableTenantExternalPlugins(env, 'tenant-a').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExternalPluginShutdownError);
    expect(error).toMatchObject({ stopped: [], failedPluginId: null });
  });
});
