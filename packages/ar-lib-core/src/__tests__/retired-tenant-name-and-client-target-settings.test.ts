/**
 * Three settings were duplicates of the records that hold the value and are gone:
 * `tenant.name` (the tenant record, D1 `tenants.name`, is the name), and `client.default_audience`
 * and `client.default_resource` (the columns `oauth_clients.default_audience` /
 * `default_resource` are the app's target). Documents saved before that, and environment variables,
 * still hold them: they must read, save and resolve as before, and none of them is a setting any
 * more.
 */

import { describe, it, expect, vi } from 'vitest';
import { createSettingsManager } from '../utils/settings-manager';
import {
  TENANT_CATEGORY_META,
  TENANT_DEFAULTS,
  TENANT_SETTINGS_META,
} from '../types/settings/tenant';
import {
  CLIENT_CATEGORY_META,
  CLIENT_DEFAULTS,
  CLIENT_SETTINGS_META,
} from '../types/settings/client';
import { ALL_CATEGORY_META } from '../types/settings/catalog';
import { TENANT_SETTING_FIELD_POLICIES } from '../services/tenant-portability/settings-field-registry';
import { resolveEffectiveSettings } from '../services/effective-settings';

const RETIRED_TENANT = { 'tenant.name': 'Stale name' };
const RETIRED_CLIENT = {
  'client.default_audience': 'urn:example:api',
  'client.default_resource': 'https://api.example.com/',
};
const RETIRED_ENV_KEYS = ['TENANT_NAME', 'CLIENT_DEFAULT_AUDIENCE', 'CLIENT_DEFAULT_RESOURCE'];

function createMockKV(data: Record<string, string>): KVNamespace {
  const store = new Map<string, string>(Object.entries(data));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

const SAVED = {
  'settings:tenant:t1:tenant': JSON.stringify({
    ...RETIRED_TENANT,
    'tenant.logo_uri': 'https://cdn.example/logo.svg',
  }),
  'settings:client:t1:c1:client': JSON.stringify({ ...RETIRED_CLIENT, 'client.sso_enabled': true }),
};

describe('the retired tenant.name, client.default_audience and client.default_resource', () => {
  it('are no longer settings', () => {
    const keys = [...Object.keys(RETIRED_TENANT), ...Object.keys(RETIRED_CLIENT)];
    for (const key of keys) {
      expect(Object.keys(TENANT_SETTINGS_META)).not.toContain(key);
      expect(Object.keys(CLIENT_SETTINGS_META)).not.toContain(key);
      expect(Object.keys(TENANT_CATEGORY_META.settings)).not.toContain(key);
      expect(Object.keys(CLIENT_CATEGORY_META.settings)).not.toContain(key);
      expect(Object.keys(TENANT_DEFAULTS)).not.toContain(key);
      expect(Object.keys(CLIENT_DEFAULTS)).not.toContain(key);
      expect(TENANT_SETTING_FIELD_POLICIES.map((policy) => policy.key)).not.toContain(key);
      for (const meta of Object.values(ALL_CATEGORY_META)) {
        expect(Object.keys(meta.settings), key).not.toContain(key);
      }
    }
    const envKeys = Object.values(ALL_CATEGORY_META).flatMap((meta) =>
      Object.values(meta.settings).map((setting) => (setting as { envKey?: string }).envKey)
    );
    for (const envKey of RETIRED_ENV_KEYS) expect(envKeys).not.toContain(envKey);
  });

  it('in a saved document do not break reading, and are not returned', async () => {
    const manager = createSettingsManager({ env: {}, kv: createMockKV(SAVED), cacheTTL: 0 });
    manager.registerCategory(TENANT_CATEGORY_META);
    manager.registerCategory(CLIENT_CATEGORY_META);

    const tenant = await manager.getAll('tenant', { type: 'tenant', id: 't1' });
    expect(tenant.values['tenant.logo_uri']).toBe('https://cdn.example/logo.svg');
    expect(tenant.values).not.toHaveProperty('tenant.name');
    expect(tenant.sources).not.toHaveProperty('tenant.name');

    const client = await manager.getAll('client', { type: 'client', id: 'c1', tenantId: 't1' });
    expect(client.values['client.sso_enabled']).toBe(true);
    for (const key of Object.keys(RETIRED_CLIENT)) {
      expect(client.values).not.toHaveProperty(key);
      expect(client.sources).not.toHaveProperty(key);
    }
  });

  it('in a saved document do not break saving another setting', async () => {
    const manager = createSettingsManager({ env: {}, kv: createMockKV(SAVED), cacheTTL: 0 });
    manager.registerCategory(TENANT_CATEGORY_META);
    const before = await manager.getAll('tenant', { type: 'tenant', id: 't1' });

    const result = await manager.patch(
      'tenant',
      { type: 'tenant', id: 't1' },
      { ifMatch: before.version, set: { 'tenant.logo_uri': 'https://cdn.example/new.svg' } },
      'admin'
    );

    expect(result.applied).toEqual(['tenant.logo_uri']);
    expect(result.rejected).toEqual({});
  });

  it('are rejected as unknown keys when set again', async () => {
    const manager = createSettingsManager({ env: {}, kv: createMockKV({}), cacheTTL: 0 });
    manager.registerCategory(TENANT_CATEGORY_META);
    manager.registerCategory(CLIENT_CATEGORY_META);

    const tenant = await manager.getAll('tenant', { type: 'tenant', id: 't1' });
    const tenantResult = await manager.patch(
      'tenant',
      { type: 'tenant', id: 't1' },
      { ifMatch: tenant.version, set: RETIRED_TENANT },
      'admin'
    );
    expect(tenantResult.applied).toEqual([]);
    expect(tenantResult.rejected).toEqual({ 'tenant.name': 'Unknown setting key' });

    const scope = { type: 'client', id: 'c1', tenantId: 't1' } as const;
    const client = await manager.getAll('client', scope);
    const clientResult = await manager.patch(
      'client',
      scope,
      { ifMatch: client.version, set: RETIRED_CLIENT },
      'admin'
    );
    expect(clientResult.applied).toEqual([]);
    expect(Object.values(clientResult.rejected)).toEqual(Array(2).fill('Unknown setting key'));
  });

  it('are ignored by the runtime reader, stored in a document or set in the environment', async () => {
    const env = {
      SETTINGS: createMockKV(SAVED),
      TENANT_NAME: 'From env',
      CLIENT_DEFAULT_AUDIENCE: 'urn:old',
      CLIENT_DEFAULT_RESOURCE: 'https://old.example/',
    };

    const tenant = await resolveEffectiveSettings(env, 'tenant', { tenantId: 't1' });
    expect(tenant['tenant.logo_uri']).toBe('https://cdn.example/logo.svg');
    expect(tenant).not.toHaveProperty('tenant.name');

    const client = await resolveEffectiveSettings(env, 'client', {
      tenantId: 't1',
      clientId: 'c1',
    });
    expect(client['client.sso_enabled']).toBe(true);
    for (const key of Object.keys(RETIRED_CLIENT)) expect(client).not.toHaveProperty(key);
  });
});
