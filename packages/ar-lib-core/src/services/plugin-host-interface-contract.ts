const SAFE_BINDING_NAME = /^[A-Z][A-Z0-9_]{0,127}$/u;

export const PLUGIN_HOST_INTERFACE_IDS = ['authrim.account_metadata.v1'] as const;

export type PluginHostInterfaceId = (typeof PLUGIN_HOST_INTERFACE_IDS)[number];

export interface PluginHostInterfaceBindingContract {
  name: string;
  interface: PluginHostInterfaceId;
  scope: 'tenant';
}

const HOST_INTERFACE_SET = new Set<string>(PLUGIN_HOST_INTERFACE_IDS);

export function isPluginHostInterfaceId(value: unknown): value is PluginHostInterfaceId {
  return typeof value === 'string' && HOST_INTERFACE_SET.has(value);
}

export function parsePluginHostInterfaceBindings(
  input: unknown,
  code = 'plugin_host_interface_contract_invalid'
): PluginHostInterfaceBindingContract[] {
  if (!Array.isArray(input) || input.length > 64) throw new Error(code);
  const names = new Set<string>();
  return input
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(code);
      const value = entry as Record<string, unknown>;
      if (
        Object.keys(value).sort().join(',') !== 'interface,name,scope' ||
        typeof value.name !== 'string' ||
        !SAFE_BINDING_NAME.test(value.name) ||
        !isPluginHostInterfaceId(value.interface) ||
        value.scope !== 'tenant' ||
        names.has(value.name)
      ) {
        throw new Error(code);
      }
      names.add(value.name);
      return {
        name: value.name,
        interface: value.interface,
        scope: 'tenant' as const,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}
