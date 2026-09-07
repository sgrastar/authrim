import {
  parsePluginHostInterfaceBindings,
  type PluginHostInterfaceBindingContract,
  type PluginHostInterfaceId,
} from '@authrim/ar-lib-core/services/plugin-host-interface-contract';

export type PluginHostInterfaceStubRegistry = Record<PluginHostInterfaceId, () => unknown>;

export function resolvePluginHostInterfaceEnv(
  bindingsInput: unknown,
  registry: PluginHostInterfaceStubRegistry
): Record<string, unknown> {
  const bindings = parsePluginHostInterfaceBindings(
    bindingsInput,
    'plugin_host_interface_binding_invalid'
  );
  return Object.fromEntries(
    bindings.map((binding: PluginHostInterfaceBindingContract) => {
      const factory = registry[binding.interface];
      if (typeof factory !== 'function') throw new Error('plugin_host_interface_unavailable');
      const stub = factory();
      if (!stub) throw new Error('plugin_host_interface_unavailable');
      return [binding.name, stub];
    })
  );
}
