import { describe, expect, it } from 'vitest';
import { SettingsManager } from '../../../utils/settings-manager';
import {
  directoryConnectorSecretKeyOwnership,
  settingsKeyOwnership,
} from '../settings-key-ownership';

const context = {
  tenantId: 'tenant-a',
  clientIds: new Set(['client-a']),
  reviewedCategories: new Set(['security']),
};

describe('directory connector managed secret ownership', () => {
  const connectorContext = { tenantId: 'tenant-a', connectorIds: new Set(['campus']) };
  const managedKey = 'settings:tenant:tenant-a:directory-connector-secret:campus';

  it('distinguishes a managed secret from a normal category document', () => {
    expect(directoryConnectorSecretKeyOwnership(managedKey, connectorContext)).toEqual({
      kind: 'tenant_secret',
      tenantId: 'tenant-a',
      connectorId: 'campus',
    });
    expect(settingsKeyOwnership(managedKey, context)).toEqual({
      kind: 'unsupported',
      reason: 'key_shape',
    });
  });

  it('requires the referenced connector and separates a similarly named tenant', () => {
    expect(
      directoryConnectorSecretKeyOwnership(
        managedKey.replace(':campus', ':unknown'),
        connectorContext
      )
    ).toEqual({ kind: 'unsupported', reason: 'connector_reference' });
    expect(
      directoryConnectorSecretKeyOwnership(
        managedKey.replace('tenant-a:', 'tenant-ab:'),
        connectorContext
      )
    ).toEqual({ kind: 'foreign_tenant' });
  });

  it.each([
    'settings:tenant:tenant-a:directory-connector-secret',
    'settings:platform:tenant-a:directory-connector-secret:campus',
    'settings:tenant:tenant-a:directory-connector-secret:campus:extra',
    'settings:tenant:tenant-a:directory-connector-secret:campus%3Aother',
    `settings:tenant:tenant-a:directory-connector-secret:${'x'.repeat(65)}`,
  ])('does not infer secret ownership from a malformed key: %s', (key) => {
    expect(directoryConnectorSecretKeyOwnership(key, connectorContext)).toEqual({
      kind: 'unsupported',
      reason: 'key_shape',
    });
  });
});

describe('settings key ownership', () => {
  it.each([
    [
      'settings:tenant:tenant-a:security',
      { kind: 'tenant_override', tenantId: 'tenant-a', category: 'security' },
    ],
    [
      'settings:client:tenant-a:client-a:security',
      { kind: 'client_override', tenantId: 'tenant-a', clientId: 'client-a', category: 'security' },
    ],
    ['settings:platform:security', { kind: 'platform_dependency', category: 'security' }],
    ['settings:tenant:tenant-ab:security', { kind: 'foreign_tenant' }],
    ['settings:client:tenant-b:client-a:security', { kind: 'foreign_tenant' }],
    [
      'settings:client:tenant-a:unknown:security',
      { kind: 'unsupported', reason: 'client_reference' },
    ],
    ['settings:tenant:tenant-a:unreviewed', { kind: 'unsupported', reason: 'category' }],
    ['settings:platform:unreviewed', { kind: 'unsupported', reason: 'category' }],
  ])('classifies %s without broad prefix ownership', (key, expected) => {
    expect(settingsKeyOwnership(key, context)).toEqual(expected);
  });

  it.each([
    'settings:tenant:tenant-a:security:extra',
    'settings:tenant:tenant-a%3Aother:security',
    'settings:client:tenant-a:security',
    'settings:platform:tenant-a:security',
    'settings:admin:tenant-a:security',
    'settings:tenant:tenant-a:',
    'settings:tenant:tenant-a:security\n',
    `settings:tenant:${'a'.repeat(129)}:security`,
    'x'.repeat(4096),
  ])('blocks malformed or unknown scopes: %s', (key) => {
    expect(settingsKeyOwnership(key, context)).toEqual({
      kind: 'unsupported',
      reason: 'key_shape',
    });
  });

  it('rejects a delimiter-bearing requested tenant rather than widening its ownership', () => {
    expect(() =>
      settingsKeyOwnership('settings:tenant:a:b:security', { ...context, tenantId: 'a:b' })
    ).toThrow('backup_invalid_settings_tenant_id');
  });

  it('recognizes actual SettingsManager writes and keeps stored overrides separate from effective values', async () => {
    const records = new Map<string, string>();
    const kv = {
      get: async (key: string) => records.get(key) ?? null,
      put: async (key: string, value: string) => {
        records.set(key, value);
      },
    } as unknown as KVNamespace;
    const manager = new SettingsManager({
      env: { SETTING_ENABLED: 'false' },
      kv,
      strictReads: true,
    });
    manager.registerCategory({
      category: 'security',
      label: 'Security',
      description: 'Fixture',
      settings: {
        'security.enabled': {
          key: 'security.enabled',
          type: 'boolean',
          default: false,
          envKey: 'SETTING_ENABLED',
          label: 'Enabled',
          description: 'Fixture',
        },
      },
    });
    const scope = { type: 'client', tenantId: 'tenant-a', id: 'client-a' } as const;
    await manager.patch(
      'security',
      scope,
      {
        ifMatch: await manager.getVersion('security', scope),
        set: { 'security.enabled': true },
      },
      'fixture-admin'
    );
    const [key, stored] = [...records.entries()][0];
    expect(settingsKeyOwnership(key, context)).toMatchObject({
      kind: 'client_override',
      clientId: 'client-a',
    });
    expect(JSON.parse(stored)).toEqual({ 'security.enabled': true });
    // Verify code behavior, not the stale env>KV header comment: stored KV wins here.
    expect(await manager.get('security.enabled', scope)).toBe(true);
  });
});
