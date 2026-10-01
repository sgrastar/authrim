import { describe, expect, it, vi } from 'vitest';
import {
  applySystemSettingsOverrides,
  readSystemSettingsOverrides,
  systemSettingsFieldValues,
} from '../system-settings-overrides';
import { getTenantSystemSettings } from '../tenant-settings';
import { getConformanceConfig, getConformanceConfigSource } from '../conformance-config';
import { readLegacySettings } from '../../services/legacy-settings';
import { resolveEffectiveSettings } from '../../services/effective-settings';

function kv(values: Record<string, unknown>): KVNamespace {
  return {
    get: vi.fn(async (key: string) =>
      key in values
        ? typeof values[key] === 'string'
          ? (values[key] as string)
          : JSON.stringify(values[key])
        : null
    ),
  } as unknown as KVNamespace;
}

describe('readSystemSettingsOverrides', () => {
  it('takes the nearest scope that sets each value: client, then tenant, then platform', async () => {
    const store = kv({
      'settings:client:acme:app:security': { 'security.fapi_enabled': true },
      'settings:tenant:acme:security': {
        'security.fapi_enabled': false,
        'security.fapi_allow_public_clients': true,
      },
      'settings:tenant:acme:feature-flags': { 'feature.enable_client_credentials': '__DISABLED__' },
      'settings:platform:feature-flags': {
        'feature.enable_client_credentials': true,
        'feature.conformance_enabled': true,
      },
    });

    await expect(
      readSystemSettingsOverrides(store, { tenantId: 'acme', clientId: 'app' })
    ).resolves.toEqual({
      'security.fapi_enabled': true,
      'security.fapi_allow_public_clients': true,
      'feature.enable_client_credentials': false,
      'feature.conformance_enabled': true,
    });
    await expect(readSystemSettingsOverrides(store, { tenantId: null })).resolves.toEqual({
      'feature.enable_client_credentials': true,
      'feature.conformance_enabled': true,
    });
  });

  it('refuses a settings document that is not an object', async () => {
    await expect(
      readSystemSettingsOverrides(kv({ 'settings:tenant:bad:security': '[]' }), { tenantId: 'bad' })
    ).rejects.toThrow('not an object');
  });
});

describe('applySystemSettingsOverrides', () => {
  it('writes values at their paths without touching the rest of the document', () => {
    const document = {
      fapi: { enabled: false, messageSigning: { requireJarm: true } },
      oidc: { tokenExchange: { enabled: false, maxResourceParams: 5 } },
    };

    const result = applySystemSettingsOverrides(document, {
      'security.fapi_enabled': true,
      'security.require_signed_request_object': true,
      'tokens.exchange_enabled': true,
      'oauth.https_request_uri_allowed_domains': ' A.example , b.example ',
    });

    expect(result).toEqual({
      fapi: {
        enabled: true,
        messageSigning: { requireJarm: true, requireSignedRequestObject: true },
      },
      oidc: {
        tokenExchange: { enabled: true, maxResourceParams: 5 },
        httpsRequestUri: { allowedDomains: ['a.example', 'b.example'] },
      },
    });
    // The original document is not changed.
    expect(document.fapi.enabled).toBe(false);
  });

  it('reads the document values back in Settings API form', () => {
    expect(
      systemSettingsFieldValues(
        {
          oidc: { httpsRequestUri: { enabled: true, allowedDomains: ['a.example', 'b.example'] } },
        },
        'oauth'
      )
    ).toEqual({
      'oauth.https_request_uri_enabled': true,
      'oauth.https_request_uri_allowed_domains': 'a.example,b.example',
    });
  });
});

describe('getTenantSystemSettings with Settings API values', () => {
  it('applies values set through the Settings API over the older document', async () => {
    const store = kv({
      system_settings: { fapi: { enabled: false, strictDPoP: true } },
      'settings:tenant:acme:security': { 'security.fapi_enabled': true },
    });

    await expect(getTenantSystemSettings(store, 'acme')).resolves.toEqual({
      fapi: { enabled: true, strictDPoP: true },
    });
    await expect(getTenantSystemSettings(store, 'other')).resolves.toEqual({
      fapi: { enabled: false, strictDPoP: true },
    });
  });

  it('fails closed when asked to, and otherwise keeps the older document', async () => {
    const store = kv({
      system_settings: { fapi: { enabled: false } },
      'settings:tenant:broken:security': 'not json',
    });

    await expect(getTenantSystemSettings(store, 'broken', { failOnError: true })).rejects.toThrow();
    await expect(getTenantSystemSettings(store, 'broken')).resolves.toEqual({
      fapi: { enabled: false },
    });
  });
});

describe('getConformanceConfig with Settings API values', () => {
  it('lets the platform value set through the Settings API win', async () => {
    const store = kv({
      system_settings: { conformance: { enabled: true, useBuiltinForms: true } },
      'settings:platform:feature-flags': { 'feature.conformance_enabled': false },
    });

    await expect(getConformanceConfig({ SETTINGS: store })).resolves.toEqual({
      enabled: false,
      useBuiltinForms: true,
    });
  });
  it('ignores conformance values stored for a tenant, which only the platform can set', async () => {
    const store = kv({
      'settings:tenant:acme:feature-flags': { 'feature.conformance_enabled': true },
      'settings:platform:feature-flags': { 'feature.conformance_enabled': false },
    });

    await expect(readSystemSettingsOverrides(store, { tenantId: 'acme' })).resolves.toEqual({
      'feature.conformance_enabled': false,
    });
  });

  it("shows a tenant the platform's conformance mode, not its certification profile's", async () => {
    const store = kv({
      system_settings: { conformance: { enabled: false, useBuiltinForms: true } },
      'settings:tenant:acme:certification-profile': {
        conformance: { enabled: true },
        fapi: { enabled: true },
      },
    });
    const env = { SETTINGS: store };

    const legacy = await readLegacySettings(env, 'feature-flags', {
      fresh: true,
      tenantId: 'acme',
    });
    expect(legacy['feature.conformance_enabled']).toBe(false);
    expect(legacy['feature.conformance_use_builtin_forms']).toBe(true);
    const values = await resolveEffectiveSettings(env, 'feature-flags', { tenantId: 'acme' });
    const runtime = await getConformanceConfig(env);
    expect(values['feature.conformance_enabled']).toBe(runtime.enabled);
    expect(values['feature.conformance_use_builtin_forms']).toBe(runtime.useBuiltinForms);
    // Tenant-settable values still come from the certification profile.
    await expect(
      readLegacySettings(env, 'security', { fresh: true, tenantId: 'acme' })
    ).resolves.toMatchObject({ 'security.fapi_enabled': true });
  });

  it('fails instead of reading as unset when the older document cannot be read', async () => {
    const env = { SETTINGS: kv({ system_settings: 'not json' }) };

    await expect(readLegacySettings(env, 'security', { fresh: true })).rejects.toThrow();
    await expect(
      readLegacySettings(env, 'feature-flags', { fresh: true, tenantId: 'acme' })
    ).rejects.toThrow();
    await expect(resolveEffectiveSettings(env, 'security', { tenantId: 'acme' })).rejects.toThrow();
  });

  it.each(['', '[]', '42', 'null'])(
    'treats a stored older document %j as unreadable, not as absent',
    async (stored) => {
      const platformEnabled = {
        'settings:platform:feature-flags': {
          'feature.conformance_enabled': true,
          'feature.conformance_use_builtin_forms': true,
        },
      };
      const globalBroken = { SETTINGS: kv({ system_settings: stored, ...platformEnabled }) };
      const tenantBroken = {
        SETTINGS: kv({ 'settings:tenant:acme:certification-profile': stored }),
      };

      await expect(readLegacySettings(globalBroken, 'security', { fresh: true })).rejects.toThrow();
      await expect(
        readLegacySettings(globalBroken, 'security', { fresh: true, tenantId: 'acme' })
      ).rejects.toThrow();
      await expect(
        readLegacySettings(tenantBroken, 'security', { fresh: true, tenantId: 'acme' })
      ).rejects.toThrow();
      await expect(
        getTenantSystemSettings(tenantBroken.SETTINGS, 'acme', { failOnError: true })
      ).rejects.toThrow();
      await expect(getConformanceConfig(globalBroken)).resolves.toEqual({
        enabled: false,
        useBuiltinForms: false,
      });
    }
  );

  it('reports the Settings API platform value as a KV source', async () => {
    const store = kv({
      'settings:platform:feature-flags': { 'feature.conformance_enabled': true },
    });

    await expect(
      getConformanceConfigSource({ SETTINGS: store, ENABLE_CONFORMANCE_MODE: 'false' })
    ).resolves.toBe('kv');
    await expect(
      getConformanceConfigSource({ SETTINGS: kv({}), ENABLE_CONFORMANCE_MODE: 'false' })
    ).resolves.toBe('env');
  });

  it('turns built-in forms on when the Settings API enables the mode while env has it off', async () => {
    const store = kv({
      'settings:platform:feature-flags': { 'feature.conformance_enabled': true },
    });

    await expect(
      getConformanceConfig({ SETTINGS: store, ENABLE_CONFORMANCE_MODE: 'false' })
    ).resolves.toEqual({ enabled: true, useBuiltinForms: true });
  });
});

describe('the fallback shown for a section present without the field', () => {
  it('uses the default runtime applies', () => {
    expect(systemSettingsFieldValues({ conformance: {} }, 'feature-flags')).toEqual({
      'feature.conformance_enabled': false,
      'feature.conformance_use_builtin_forms': true,
    });
    expect(systemSettingsFieldValues({}, 'feature-flags')).toEqual({});
  });
});
