/**
 * The one decision every Admin API surface shares: who may manage what a capability covers.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  carriesMetadataUrl,
  decideTenantCapabilityAccess,
  sameMetadataUrlValue,
  tenantCapabilityDisabledRefusal,
  tenantCapabilityRefusal,
  tenantCapabilityUnavailableRefusal,
} from '../tenant-capability-access';
import type { AdminAuthContext } from '../../types/admin';

const DOC_KEY = 'settings:platform:tenant-capabilities';

function env(value: boolean | 'down' | undefined) {
  const get = vi.fn(async (key: string) => {
    if (value === 'down') throw new Error('kv down');
    return key === DOC_KEY && typeof value === 'boolean'
      ? JSON.stringify({ 'tenant_capabilities.saml_metadata_url': value })
      : null;
  });
  return { SETTINGS: { get } as unknown as KVNamespace, get };
}

const tenantAdmin = {
  tenantScope: ['tenant-a'],
  roles: ['ar_tenant_admin'],
  permissions: ['admin:*'],
} as unknown as AdminAuthContext;
const platformAdmin = {
  tenantScope: ['*'],
  roles: ['ar_super_admin'],
  globalRoles: ['ar_super_admin'],
  permissions: ['admin:*'],
  globalPermissions: ['admin:*'],
} as unknown as AdminAuthContext;

describe('decideTenantCapabilityAccess', () => {
  it('lets global platform authority through whatever the state', () => {
    for (const state of ['on', 'off', 'unknown'] as const) {
      expect(decideTenantCapabilityAccess({ state, globalPlatformAuthority: true })).toBe('allow');
    }
  });

  it('refuses everyone else while off, and while unreadable', () => {
    expect(decideTenantCapabilityAccess({ state: 'off', globalPlatformAuthority: false })).toBe(
      'disabled'
    );
    expect(decideTenantCapabilityAccess({ state: 'unknown', globalPlatformAuthority: false })).toBe(
      'unavailable'
    );
    expect(decideTenantCapabilityAccess({ state: 'on', globalPlatformAuthority: false })).toBe(
      'allow'
    );
  });

  it('does not answer 503 to a caller the permission checks refused anyway', () => {
    expect(
      decideTenantCapabilityAccess({
        state: 'unknown',
        globalPlatformAuthority: false,
        permitted: false,
      })
    ).toBe('allow');
    expect(
      decideTenantCapabilityAccess({
        state: 'off',
        globalPlatformAuthority: false,
        permitted: false,
      })
    ).toBe('disabled');
  });
});

describe('tenantCapabilityRefusal', () => {
  it('refuses a tenant admin with 403 capability_disabled while off', async () => {
    expect(await tenantCapabilityRefusal(env(false), tenantAdmin, 'saml_metadata_url')).toEqual(
      tenantCapabilityDisabledRefusal('saml_metadata_url')
    );
    expect(tenantCapabilityDisabledRefusal('saml_metadata_url')).toMatchObject({
      status: 403,
      body: { error: 'capability_disabled', capability: 'saml_metadata_url' },
    });
  });

  it('refuses with 503 temporarily_unavailable when the switch cannot be read', async () => {
    expect(await tenantCapabilityRefusal(env('down'), tenantAdmin, 'saml_metadata_url')).toEqual(
      tenantCapabilityUnavailableRefusal('saml_metadata_url')
    );
    expect(tenantCapabilityUnavailableRefusal('saml_metadata_url').status).toBe(503);
  });

  it('allows while on, at the default, and without any caller context it refuses only while off', async () => {
    expect(await tenantCapabilityRefusal(env(true), tenantAdmin, 'saml_metadata_url')).toBeNull();
    expect(
      await tenantCapabilityRefusal(env(undefined), tenantAdmin, 'saml_metadata_url')
    ).toBeNull();
    expect(await tenantCapabilityRefusal(env(false), undefined, 'saml_metadata_url')).toMatchObject(
      { status: 403 }
    );
  });

  it('never reads the switch for a caller with global platform authority', async () => {
    const down = env('down');
    expect(await tenantCapabilityRefusal(down, platformAdmin, 'saml_metadata_url')).toBeNull();
    expect(down.get).not.toHaveBeenCalled();
    expect(
      await tenantCapabilityRefusal(env(false), platformAdmin, 'saml_metadata_url')
    ).toBeNull();
  });
});

describe('carriesMetadataUrl', () => {
  it('counts anything but undefined, null and a blank string', () => {
    for (const value of [undefined, null, '', '   ']) expect(carriesMetadataUrl(value)).toBe(false);
    for (const value of ['https://a.example', ['https://a.example'], {}, [], 0, 1, false, true]) {
      expect(carriesMetadataUrl(value)).toBe(true);
    }
  });

  it('compares strings by value and anything else by its JSON', () => {
    expect(sameMetadataUrlValue('a', 'a')).toBe(true);
    expect(sameMetadataUrlValue(['a'], ['a'])).toBe(true);
    expect(sameMetadataUrlValue(['a'], 'a')).toBe(false);
    expect(sameMetadataUrlValue(['a'], ['b'])).toBe(false);
  });
});
