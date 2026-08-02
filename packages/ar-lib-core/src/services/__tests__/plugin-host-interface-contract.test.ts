import { describe, expect, it } from 'vitest';
import {
  isPluginHostInterfaceId,
  parsePluginHostInterfaceBindings,
} from '../plugin-host-interface-contract';

describe('plugin host interface contract', () => {
  it('accepts and sorts the versioned catalog binding', () => {
    expect(isPluginHostInterfaceId('authrim.account_metadata.v1')).toBe(true);
    expect(
      parsePluginHostInterfaceBindings([
        {
          name: 'ACCOUNT_METADATA',
          interface: 'authrim.account_metadata.v1',
          scope: 'tenant',
        },
      ])
    ).toEqual([
      {
        name: 'ACCOUNT_METADATA',
        interface: 'authrim.account_metadata.v1',
        scope: 'tenant',
      },
    ]);
  });

  it.each([
    [{ name: 'ACCOUNT_METADATA', interface: 'authrim.account_metadata.v2', scope: 'tenant' }],
    [{ name: 'DB', interface: 'authrim.account_metadata.v1', scope: 'platform' }],
    [
      { name: 'DUPLICATE', interface: 'authrim.account_metadata.v1', scope: 'tenant' },
      { name: 'DUPLICATE', interface: 'authrim.account_metadata.v1', scope: 'tenant' },
    ],
    [{ name: 'lowercase', interface: 'authrim.account_metadata.v1', scope: 'tenant' }],
  ])('rejects unknown, cross-scope, duplicate, and malformed bindings', (bindings) => {
    expect(() => parsePluginHostInterfaceBindings(bindings)).toThrow(
      'plugin_host_interface_contract_invalid'
    );
  });
});
