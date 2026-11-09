import { describe, expect, it, vi } from 'vitest';
import { resolvePluginHostInterfaceEnv } from '../host-interfaces';
import type { PluginHostInterfaceStubRegistry } from '../host-interfaces';

const binding = {
  name: 'ACCOUNT_METADATA',
  interface: 'authrim.account_metadata.v1',
  scope: 'tenant',
};

describe('plugin host interface environment', () => {
  it('binds only declared host interfaces to their requested names', () => {
    const stub = { writeAccountMetadata: vi.fn() };
    const factory = vi.fn(() => stub);
    const registry: PluginHostInterfaceStubRegistry = {
      'authrim.account_metadata.v1': factory,
    };

    expect(resolvePluginHostInterfaceEnv([binding], registry)).toEqual({
      ACCOUNT_METADATA: stub,
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(resolvePluginHostInterfaceEnv([], registry)).toEqual({});
  });

  it('rejects malformed binding contracts before invoking a host factory', () => {
    const factory = vi.fn(() => ({}));
    const registry: PluginHostInterfaceStubRegistry = {
      'authrim.account_metadata.v1': factory,
    };

    for (const input of [
      null,
      [{ ...binding, name: 'account_metadata' }],
      [{ ...binding, scope: 'global' }],
      [{ ...binding, secret: 'unexpected' }],
      [binding, binding],
    ]) {
      expect(() => resolvePluginHostInterfaceEnv(input, registry)).toThrow(
        'plugin_host_interface_binding_invalid'
      );
    }
    expect(factory).not.toHaveBeenCalled();
  });

  it('fails closed when the declared host interface is unavailable', () => {
    expect(() =>
      resolvePluginHostInterfaceEnv([binding], {} as PluginHostInterfaceStubRegistry)
    ).toThrow('plugin_host_interface_unavailable');
    expect(() =>
      resolvePluginHostInterfaceEnv([binding], {
        'authrim.account_metadata.v1': () => null,
      })
    ).toThrow('plugin_host_interface_unavailable');
  });
});
