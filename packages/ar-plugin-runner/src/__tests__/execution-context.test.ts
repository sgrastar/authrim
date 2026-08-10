import { describe, expect, it } from 'vitest';
import { parsePluginExecutionContext } from '../execution-context';

const base = {
  contractVersion: 1,
  tenantId: 'tenant-a',
  pluginInstallationId: 'installation-a',
  capability: 'notifier.send',
  requestId: 'scope:request-a',
};

describe('parsePluginExecutionContext', () => {
  it('accepts a notification shard scope without an account', () => {
    expect(
      parsePluginExecutionContext({
        ...base,
        executionScope: {
          bindingRef: 'TEST_TDB_DEFAULT_JP_0001_CORE',
          dataRole: 'tenant_core/default',
          residencyPartition: 'jp',
        },
      })
    ).toEqual({
      ...base,
      executionScope: {
        bindingRef: 'TEST_TDB_DEFAULT_JP_0001_CORE',
        dataRole: 'tenant_core/default',
        residencyPartition: 'jp',
      },
    });
  });

  it('accepts an exact account scope and rejects unknown or malformed account fields', () => {
    expect(
      parsePluginExecutionContext({
        ...base,
        executionScope: {
          accountId: 'account-a',
          bindingRef: 'TEST_TDB_USERS_JP_0001_CORE',
          dataRole: 'tenant_core/users',
          residencyPartition: 'jp',
        },
      }).executionScope?.accountId
    ).toBe('account-a');

    for (const executionScope of [
      {
        accountId: '',
        bindingRef: 'TEST_TDB_USERS_JP_0001_CORE',
        dataRole: 'tenant_core/users',
        residencyPartition: 'jp',
      },
      {
        bindingRef: 'TEST_TDB_DEFAULT_JP_0001_CORE',
        dataRole: 'tenant_core/default',
        residencyPartition: 'jp',
        unknown: true,
      },
    ]) {
      expect(() => parsePluginExecutionContext({ ...base, executionScope })).toThrow(
        'plugin_egress_context_invalid'
      );
    }
  });
});
