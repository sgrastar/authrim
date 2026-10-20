/**
 * The identity-mapping category: the default Mapping Set of the platform and of a tenant
 * (`identity_mapping.oidc_default_set_id`). Settable at the platform and at a tenant, never at an
 * app; unset by default; no environment variable; and not read by the release of claims yet
 * (`in_development`). And the platform switch of the shadow comparison of its selection
 * (`identity_mapping.shadow_compare_enabled`).
 */
import { describe, expect, it } from 'vitest';
import {
  resolveEffectiveSettingsWithSources,
  resolvePlatformSettingsWithSources,
} from '../../../services/effective-settings';
import { readOidcDefaultSetSelection } from '../../../services/identity-mapping-set-reference';
import { createSettingsManager } from '../../../utils/settings-manager';
import {
  ALL_CATEGORY_META,
  CATEGORY_SCOPE_CONFIG,
  getCategoriesForScope,
  isCategoryAvailableAtScope,
  settingsParentScopes,
} from '../catalog';
import {
  IDENTITY_MAPPING_CATEGORY_META,
  IDENTITY_MAPPING_DEFAULTS,
  IDENTITY_MAPPING_NONE,
  IDENTITY_MAPPING_SET_ID_MAX_LENGTH,
  IDENTITY_MAPPING_SETTINGS_META,
  IDENTITY_MAPPING_SHADOW_COMPARE_KEY,
} from '../identity-mapping';

const KEY = 'identity_mapping.oidc_default_set_id';
const SHADOW_KEY = 'identity_mapping.shadow_compare_enabled';

function kv(documents: Record<string, unknown>): KVNamespace {
  return {
    get: async (key: string) => (key in documents ? JSON.stringify(documents[key]) : null),
  } as unknown as KVNamespace;
}

async function effective(
  documents: Record<string, unknown>,
  env: Record<string, string | undefined> = {},
  tenantId = 'acme'
) {
  const { values, sources } = await resolveEffectiveSettingsWithSources(
    { SETTINGS: kv(documents), ...env } as never,
    'identity-mapping',
    { tenantId }
  );
  return { value: values[KEY], source: sources[KEY] };
}

describe('the identity-mapping category', () => {
  it('is registered, settable at the platform and a tenant, and not at an app', () => {
    expect(ALL_CATEGORY_META['identity-mapping']).toBe(IDENTITY_MAPPING_CATEGORY_META);
    expect(CATEGORY_SCOPE_CONFIG['identity-mapping'].allowedScopes).toEqual(['platform', 'tenant']);
    expect(isCategoryAvailableAtScope('identity-mapping', 'platform')).toBe(true);
    expect(isCategoryAvailableAtScope('identity-mapping', 'tenant')).toBe(true);
    expect(isCategoryAvailableAtScope('identity-mapping', 'client')).toBe(false);
    expect(getCategoriesForScope('client')).not.toContain('identity-mapping');
    expect(getCategoriesForScope('platform')).toContain('identity-mapping');
  });

  it('inherits from the platform for a tenant, and from nothing for the platform', () => {
    expect(settingsParentScopes('identity-mapping', { type: 'tenant', id: 'acme' })).toEqual([
      { type: 'platform' },
    ]);
    expect(settingsParentScopes('identity-mapping', { type: 'platform' })).toEqual([]);
  });

  it('holds the default Mapping Set, unset by default, with no environment variable', () => {
    expect(Object.keys(IDENTITY_MAPPING_SETTINGS_META)).toEqual([KEY, SHADOW_KEY]);
    const meta = IDENTITY_MAPPING_SETTINGS_META[KEY];
    expect(meta.type).toBe('string');
    expect(meta.default).toBeNull();
    expect(IDENTITY_MAPPING_DEFAULTS[KEY]).toBeNull();
    expect(meta.envKey).toBeUndefined();
    // Not narrowed below the category: both the platform and a tenant can set it.
    expect(meta.scopes).toBeUndefined();
    // The release of claims does not read it yet.
    expect(meta.status).toBe('in_development');
    expect(meta.description).toMatch(/Unset means no default/);
    expect(meta.description).toMatch(/none means: do not use the platform default/);
  });

  it('holds the switch of the shadow comparison: a platform boolean, off by default, from the environment', () => {
    const meta = IDENTITY_MAPPING_SETTINGS_META[SHADOW_KEY];
    expect(IDENTITY_MAPPING_SHADOW_COMPARE_KEY).toBe(SHADOW_KEY);
    expect(meta.type).toBe('boolean');
    expect(meta.default).toBe(false);
    expect(IDENTITY_MAPPING_DEFAULTS[SHADOW_KEY]).toBe(false);
    expect(meta.envKey).toBe('IDENTITY_MAPPING_SHADOW_COMPARE');
    // The platform decides: a tenant cannot turn it on, and an app has no such category.
    expect(meta.scopes).toEqual(['platform']);
    // It is applied (the comparison runs), unlike the default it compares.
    expect(meta.status).toBeUndefined();
  });

  it('is off unless the platform saves true or the environment says true', async () => {
    const read = async (docs: Record<string, unknown>, env: Record<string, string> = {}) =>
      (
        await resolvePlatformSettingsWithSources(
          { SETTINGS: kv(docs), ...env } as never,
          'identity-mapping'
        )
      ).values[SHADOW_KEY];
    expect(await read({})).toBe(false);
    expect(await read({ 'settings:platform:identity-mapping': { [SHADOW_KEY]: true } })).toBe(true);
    expect(await read({}, { IDENTITY_MAPPING_SHADOW_COMPARE: 'true' })).toBe(true);
    expect(await read({}, { IDENTITY_MAPPING_SHADOW_COMPARE: 'false' })).toBe(false);
    // Saved wins over the environment.
    expect(
      await read(
        { 'settings:platform:identity-mapping': { [SHADOW_KEY]: false } },
        { IDENTITY_MAPPING_SHADOW_COMPARE: 'true' }
      )
    ).toBe(false);
  });

  it('gives its reserved value and the longest ID a name', () => {
    expect(IDENTITY_MAPPING_NONE).toBe('none');
    // What an app’s own choice holds (login-runtime-flow reads 200).
    expect(IDENTITY_MAPPING_SET_ID_MAX_LENGTH).toBe(200);
  });
});

describe('the default Mapping Set in effect', () => {
  it('is unset when nothing is saved: no default, no mapping', async () => {
    const { value, source } = await effective({});
    expect(value).toBeNull();
    expect(source).toBe('default');
    expect(readOidcDefaultSetSelection(value)).toEqual({ kind: 'unset' });
  });

  it('is not set from the environment, whatever is there', async () => {
    const { value } = await effective(
      {},
      {
        IDENTITY_MAPPING_OIDC_DEFAULT_SET_ID: 'from-env',
        OIDC_DEFAULT_SET_ID: 'from-env',
        IDENTITY_MAPPING_DEFAULT_SET_ID: 'from-env',
      }
    );
    expect(value).toBeNull();
  });

  it('gives a tenant the platform’s default as inherited', async () => {
    const result = await effective({
      'settings:platform:identity-mapping': { [KEY]: 'field_mapping_platform' },
    });
    expect(result).toEqual({ value: 'field_mapping_platform', source: 'platform' });
    expect(readOidcDefaultSetSelection(result.value)).toEqual({
      kind: 'set',
      setId: 'field_mapping_platform',
    });
  });

  it('lets a tenant override the platform’s default', async () => {
    const result = await effective({
      'settings:platform:identity-mapping': { [KEY]: 'field_mapping_platform' },
      'settings:tenant:acme:identity-mapping': { [KEY]: 'field_mapping_acme' },
    });
    expect(result).toEqual({ value: 'field_mapping_acme', source: 'kv' });
    // Another tenant still inherits.
    expect(
      await effective(
        {
          'settings:platform:identity-mapping': { [KEY]: 'field_mapping_platform' },
          'settings:tenant:acme:identity-mapping': { [KEY]: 'field_mapping_acme' },
        },
        {},
        'globex'
      )
    ).toEqual({ value: 'field_mapping_platform', source: 'platform' });
  });

  it('lets a tenant refuse the platform’s default with none, which is not unset', async () => {
    const result = await effective({
      'settings:platform:identity-mapping': { [KEY]: 'field_mapping_platform' },
      'settings:tenant:acme:identity-mapping': { [KEY]: 'none' },
    });
    expect(result).toEqual({ value: 'none', source: 'kv' });
    expect(readOidcDefaultSetSelection(result.value)).toEqual({ kind: 'none' });
  });

  it('reads a stored disabled marker back as a failure, not as unset: it must not fall through', async () => {
    // The settings reader turns the marker into false for every key (a save refuses it).
    const result = await effective({
      'settings:platform:identity-mapping': { [KEY]: 'field_mapping_platform' },
      'settings:tenant:acme:identity-mapping': { [KEY]: '__DISABLED__' },
    });
    expect(result.value).toBe(false);
    expect(result.source).toBe('kv');
    expect(readOidcDefaultSetSelection(result.value)).toEqual({ kind: 'invalid' });
  });

  it('ignores a value stored at an app: the category does not exist there', async () => {
    const { values } = await resolveEffectiveSettingsWithSources(
      {
        SETTINGS: kv({
          'settings:client:acme:app-1:identity-mapping': { [KEY]: 'field_mapping_app' },
        }),
      } as never,
      'identity-mapping',
      { tenantId: 'acme', clientId: 'app-1' }
    );
    expect(values[KEY]).toBeNull();
  });

  it('can be saved by a tenant and by the platform through the settings manager, but only as a string', () => {
    const manager = createSettingsManager({ env: {}, kv: null });
    manager.registerCategory(IDENTITY_MAPPING_CATEGORY_META);
    expect(manager.validate('identity-mapping', { [KEY]: 'field_mapping_1' }).valid).toBe(true);
    for (const value of [false, true, null, 1, {}, []]) {
      expect(manager.validate('identity-mapping', { [KEY]: value }).valid, String(value)).toBe(
        false
      );
    }
  });
});
