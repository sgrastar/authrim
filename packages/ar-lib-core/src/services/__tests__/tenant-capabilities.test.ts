/**
 * The platform's switches for what tenants may use: platform-only, on by default, readable from
 * the environment, and asked only through one helper that tells on / off / unknown apart.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DCR_CAPABILITY_DISABLED_BODY,
  dynamicClientRegistrationRefusal,
  getTenantCapabilityState,
  isTenantCapabilityEnabledAtRuntime,
  listDisabledTenantCapabilities,
  readTenantCapabilityStates,
} from '../tenant-capabilities';
import { ALL_CATEGORY_META, CATEGORY_SCOPE_CONFIG } from '../../types/settings/catalog';
import {
  TENANT_CAPABILITIES,
  TENANT_CAPABILITIES_SETTINGS_META,
  isTenantCapability,
  tenantCapabilitySettingKey,
} from '../../types/settings/tenant-capabilities';
import { TENANT_SETTING_FIELD_POLICIES } from '../tenant-portability/settings-field-registry';

const DOC_KEY = 'settings:platform:tenant-capabilities';

function kvWith(data: Record<string, string>) {
  const store = new Map(Object.entries(data));
  const get = vi.fn(async (key: string) => store.get(key) ?? null);
  const kv = { get, put: vi.fn(), delete: vi.fn(), list: vi.fn(), getWithMetadata: vi.fn() };
  return { kv: kv as unknown as KVNamespace, get };
}

const doc = (values: Record<string, unknown>) => ({ [DOC_KEY]: JSON.stringify(values) });

describe('the tenant-capabilities category', () => {
  it('is registered, platform-only and one boolean per capability, on by default', () => {
    expect(ALL_CATEGORY_META['tenant-capabilities']).toBeDefined();
    expect(CATEGORY_SCOPE_CONFIG['tenant-capabilities'].allowedScopes).toEqual(['platform']);
    expect(Object.keys(TENANT_CAPABILITIES_SETTINGS_META).sort()).toEqual(
      TENANT_CAPABILITIES.map(tenantCapabilitySettingKey).sort()
    );
    for (const capability of TENANT_CAPABILITIES) {
      const meta = TENANT_CAPABILITIES_SETTINGS_META[tenantCapabilitySettingKey(capability)];
      expect(meta.type).toBe('boolean');
      expect(meta.default).toBe(true);
      expect(meta.scopes).toEqual(['platform']);
      expect(meta.envKey).toBe(`TENANT_CAPABILITIES_${capability.toUpperCase()}`);
    }
  });

  it('is reviewed for tenant portability (a platform setting never travels in a backup)', () => {
    const keys = TENANT_SETTING_FIELD_POLICIES.filter(
      (policy) => policy.category === 'tenant-capabilities'
    ).map((policy) => policy.key);
    expect(keys.sort()).toEqual(TENANT_CAPABILITIES.map(tenantCapabilitySettingKey).sort());
  });

  it('names the capabilities clients see', () => {
    expect(TENANT_CAPABILITIES).toEqual([
      'webhooks',
      'dynamic_client_registration',
      'external_plugins',
      'bulk_jobs',
    ]);
    expect(isTenantCapability('webhooks')).toBe(true);
    expect(isTenantCapability('scim')).toBe(false);
    expect(isTenantCapability(undefined)).toBe(false);
  });
});

describe('reading the switches', () => {
  it('reads every capability as on when nothing is saved and nothing is set', async () => {
    const { kv } = kvWith({});
    expect(await readTenantCapabilityStates({ SETTINGS: kv })).toEqual({
      webhooks: 'on',
      dynamic_client_registration: 'on',
      external_plugins: 'on',
      bulk_jobs: 'on',
    });
    expect(await listDisabledTenantCapabilities({ SETTINGS: kv })).toEqual([]);
    // No KV at all: the defaults hold.
    expect(await getTenantCapabilityState({}, 'webhooks')).toBe('on');
  });

  it('reads a saved off, for that capability only', async () => {
    const { kv } = kvWith(doc({ 'tenant_capabilities.webhooks': false }));
    const env = { SETTINGS: kv };
    expect(await getTenantCapabilityState(env, 'webhooks')).toBe('off');
    expect(await getTenantCapabilityState(env, 'bulk_jobs')).toBe('on');
    expect(await listDisabledTenantCapabilities(env)).toEqual(['webhooks']);
  });

  it('lets a deployment default a capability off by environment variable, and a saved value win', async () => {
    const fromEnv = { SETTINGS: kvWith({}).kv, TENANT_CAPABILITIES_BULK_JOBS: 'false' };
    expect(await getTenantCapabilityState(fromEnv, 'bulk_jobs')).toBe('off');
    expect(await getTenantCapabilityState(fromEnv, 'webhooks')).toBe('on');
    const saved = {
      SETTINGS: kvWith(doc({ 'tenant_capabilities.bulk_jobs': true })).kv,
      TENANT_CAPABILITIES_BULK_JOBS: 'false',
    };
    expect(await getTenantCapabilityState(saved, 'bulk_jobs')).toBe('on');
  });

  it('is unknown (never on) when the settings cannot be read', async () => {
    const { kv, get } = kvWith({});
    get.mockRejectedValue(new Error('kv down'));
    const env = { SETTINGS: kv };
    expect(await readTenantCapabilityStates(env)).toBeNull();
    expect(await getTenantCapabilityState(env, 'webhooks')).toBe('unknown');
    expect(await listDisabledTenantCapabilities(env)).toBeNull();
  });

  it('is unknown when the stored document is not valid JSON', async () => {
    const { kv } = kvWith({ [DOC_KEY]: '{not json' });
    expect(await getTenantCapabilityState({ SETTINGS: kv }, 'webhooks')).toBe('unknown');
  });
});

describe('a runtime entry point', () => {
  it('runs while on, stops while off, and keeps running (with a warning) when unreadable', async () => {
    expect(await isTenantCapabilityEnabledAtRuntime({ SETTINGS: kvWith({}).kv }, 'webhooks')).toBe(
      true
    );
    const off = kvWith(doc({ 'tenant_capabilities.webhooks': false }));
    expect(await isTenantCapabilityEnabledAtRuntime({ SETTINGS: off.kv }, 'webhooks')).toBe(false);
    const down = kvWith({});
    down.get.mockRejectedValue(new Error('kv down'));
    expect(await isTenantCapabilityEnabledAtRuntime({ SETTINGS: down.kv }, 'webhooks')).toBe(true);
  });

  it('refuses dynamic client registration only while that capability is off', async () => {
    expect(await dynamicClientRegistrationRefusal({ SETTINGS: kvWith({}).kv })).toBeNull();
    const off = kvWith(doc({ 'tenant_capabilities.dynamic_client_registration': false }));
    expect(await dynamicClientRegistrationRefusal({ SETTINGS: off.kv })).toBe(
      DCR_CAPABILITY_DISABLED_BODY
    );
    const other = kvWith(doc({ 'tenant_capabilities.webhooks': false }));
    expect(await dynamicClientRegistrationRefusal({ SETTINGS: other.kv })).toBeNull();
    const down = kvWith({});
    down.get.mockRejectedValue(new Error('kv down'));
    expect(await dynamicClientRegistrationRefusal({ SETTINGS: down.kv })).toBeNull();
  });
});
