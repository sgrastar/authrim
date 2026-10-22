/**
 * The institution category: the scopes and names of the institution a tenant stands for. Tenant
 * scope only, never inherited, no environment variable, and changeable only with platform
 * authority (the rule itself is enforced by the Settings API, see ar-management settings-v2).
 */
import { describe, expect, it } from 'vitest';
import { resolveEffectiveSettingsWithSources } from '../../../services/effective-settings';
import { bulkApplyKeyVerdict } from '../../../services/settings-bulk-apply-policy';
import { institutionFromSettings } from '../../../services/tenant-institution';
import { TENANT_SETTING_FIELD_POLICIES } from '../../../services/tenant-portability/settings-field-registry';
import {
  ALL_CATEGORY_META,
  CATEGORY_SCOPE_CONFIG,
  categoryTenantEditRequiresPlatformAuthority,
  getCategoriesForScope,
  settingsParentScopes,
} from '../catalog';
import {
  INSTITUTION_CATEGORY_META,
  INSTITUTION_DEFAULTS,
  INSTITUTION_SETTINGS_META,
} from '../institution';

const SCOPES = 'institution.scopes';
const NAMES = 'institution.display_names';

function kv(documents: Record<string, unknown>): KVNamespace {
  return {
    get: async (key: string) => (key in documents ? JSON.stringify(documents[key]) : null),
  } as unknown as KVNamespace;
}

async function effective(documents: Record<string, unknown>, env: Record<string, string> = {}) {
  const { values } = await resolveEffectiveSettingsWithSources(
    { SETTINGS: kv(documents), ...env } as never,
    'institution',
    { tenantId: 'acme' }
  );
  return values;
}

describe('the institution category', () => {
  it('is registered, set for a tenant, never for the platform or an app', () => {
    expect(ALL_CATEGORY_META.institution).toBe(INSTITUTION_CATEGORY_META);
    expect(CATEGORY_SCOPE_CONFIG.institution.allowedScopes).toEqual(['tenant']);
    expect(getCategoriesForScope('tenant')).toContain('institution');
    expect(getCategoriesForScope('platform')).not.toContain('institution');
    expect(getCategoriesForScope('client')).not.toContain('institution');
    for (const meta of Object.values(INSTITUTION_SETTINGS_META)) {
      expect(meta.scopes).toEqual(['tenant']);
    }
  });

  it('inherits nothing: a tenant’s scopes are its own', () => {
    expect(settingsParentScopes('institution', { type: 'tenant', id: 'acme' })).toEqual([]);
  });

  it('is the only category a tenant’s own administrators may read but not change', () => {
    const restricted = Object.keys(CATEGORY_SCOPE_CONFIG).filter((name) =>
      categoryTenantEditRequiresPlatformAuthority(name as keyof typeof CATEGORY_SCOPE_CONFIG)
    );
    expect(restricted).toEqual(['institution']);
  });

  it('holds the scopes and the names, empty by default, with no environment variable', () => {
    expect(Object.keys(INSTITUTION_SETTINGS_META)).toEqual([SCOPES, NAMES]);
    expect(INSTITUTION_DEFAULTS).toEqual({ [SCOPES]: '', [NAMES]: '{}' });
    for (const meta of Object.values(INSTITUTION_SETTINGS_META)) {
      expect(meta.type).toBe('string');
      expect(meta.envKey).toBeUndefined();
      // Read by the SAML IdP, so not "in development".
      expect(meta.status).toBeUndefined();
    }
    expect(INSTITUTION_SETTINGS_META[SCOPES].default).toBe('');
    expect(INSTITUTION_SETTINGS_META[NAMES].default).toBe('{}');
  });

  it('is reviewed for handling, as a value that belongs to one tenant', () => {
    const handling = Object.fromEntries(
      TENANT_SETTING_FIELD_POLICIES.filter((policy) => policy.category === 'institution').map(
        (policy) => [policy.key, policy.handling]
      )
    );
    expect(handling).toEqual({ [SCOPES]: 'url_or_asset', [NAMES]: 'structured' });
  });

  it('cannot be given to several tenants at once', () => {
    expect(bulkApplyKeyVerdict('institution', SCOPES)).toMatchObject({
      ok: false,
      reason: 'tenant_specific_url',
    });
    expect(bulkApplyKeyVerdict('institution', NAMES)).toMatchObject({
      ok: false,
      reason: 'structured_value',
    });
  });
});

describe('the institution in effect', () => {
  it('is nothing when nothing is saved', async () => {
    expect(institutionFromSettings(await effective({}))).toEqual({
      scopes: { state: 'unset' },
      displayNames: {},
    });
  });

  it('is what the tenant saved', async () => {
    const values = await effective({
      'settings:tenant:acme:institution': {
        [SCOPES]: 'example.ac.jp,med.example.ac.jp',
        [NAMES]: JSON.stringify({ ja: '例大学', en: 'Example University' }),
      },
    });
    expect(institutionFromSettings(values)).toEqual({
      scopes: {
        state: 'set',
        scopes: ['example.ac.jp', 'med.example.ac.jp'],
        defaultScope: 'example.ac.jp',
      },
      displayNames: { ja: '例大学', en: 'Example University' },
    });
  });

  it('is not set from the environment, whatever is there', async () => {
    const values = await effective(
      {},
      {
        INSTITUTION_SCOPES: 'example.ac.jp',
        INSTITUTION_SCOPE: 'example.ac.jp',
        INSTITUTION_DISPLAY_NAMES: '{"ja":"x","en":"y"}',
      }
    );
    expect(institutionFromSettings(values).scopes).toEqual({ state: 'unset' });
  });

  it('does not take another tenant’s scopes, nor a platform document, for the tenant’s own', async () => {
    const values = await effective({
      'settings:tenant:other:institution': { [SCOPES]: 'other.example' },
      'settings:platform:institution': { [SCOPES]: 'platform.example' },
    });
    expect(institutionFromSettings(values).scopes).toEqual({ state: 'unset' });
  });
});
