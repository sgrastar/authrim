/**
 * The identity-mapping category: the default Mapping Set of the platform and of a tenant
 * (`identity_mapping.oidc_default_set_id`). Settable at the platform and at a tenant, never at an
 * app; unset by default; no environment variable; and read by the release of claims (ID token,
 * UserInfo and the consent screen), so it is not `in_development`. The shadow comparison switch
 * that once sat beside it is retired (src/__tests__/retired-identity-mapping-shadow-setting.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { resolveEffectiveSettingsWithSources } from '../../../services/effective-settings';
import { resolveMappingSetReferenceLimits } from '../../../services/identity-mapping-reference-limits';
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
} from '../identity-mapping';

const KEY = 'identity_mapping.oidc_default_set_id';
/** The limits of the search for the places that name a Mapping Set: platform settings. */
const SCAN_KEYS = [
  'identity_mapping.reference_scan_tenant_limit',
  'identity_mapping.reference_scan_row_limit',
  'identity_mapping.reference_scan_concurrency',
  'identity_mapping.reference_display_limit',
] as const;

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
    expect(Object.keys(IDENTITY_MAPPING_SETTINGS_META)).toEqual([KEY, ...SCAN_KEYS]);
    const meta = IDENTITY_MAPPING_SETTINGS_META[KEY];
    expect(meta.type).toBe('string');
    expect(meta.default).toBeNull();
    expect(IDENTITY_MAPPING_DEFAULTS[KEY]).toBeNull();
    expect(meta.envKey).toBeUndefined();
    // Not narrowed below the category: both the platform and a tenant can set it.
    expect(meta.scopes).toBeUndefined();
    // The release of claims reads it.
    expect(meta.status).toBeUndefined();
    expect(meta.description).toMatch(/Unset means no default/);
    expect(meta.description).toMatch(/none means: do not use the platform default/);
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

describe('the limits of the search for the places that name a Mapping Set', () => {
  it('are platform settings with the limits the search always used as defaults, held in a range', () => {
    const expected = {
      'identity_mapping.reference_scan_tenant_limit': [200, 1, 1000],
      'identity_mapping.reference_scan_row_limit': [500, 10, 5000],
      'identity_mapping.reference_scan_concurrency': [8, 1, 16],
      'identity_mapping.reference_display_limit': [20, 1, 100],
    } as const;
    for (const key of SCAN_KEYS) {
      const meta = IDENTITY_MAPPING_SETTINGS_META[key];
      const [fallback, min, max] = expected[key];
      expect(meta.type, key).toBe('number');
      expect(meta.default, key).toBe(fallback);
      expect(IDENTITY_MAPPING_DEFAULTS[key], key).toBe(fallback);
      expect([meta.min, meta.max, meta.integer], key).toEqual([min, max, true]);
      expect(meta.scopes, key).toEqual(['platform']);
      expect(meta.envKey, key).toMatch(/^IDENTITY_MAPPING_REFERENCE_/);
      expect(meta.envNumber, key).toBe('strict-in-range');
    }
  });

  it('are saved by the platform within the range, and refused outside it or as anything but a whole number', () => {
    const manager = createSettingsManager({ env: {}, kv: null });
    manager.registerCategory(IDENTITY_MAPPING_CATEGORY_META);
    const key = SCAN_KEYS[0];
    expect(manager.validate('identity-mapping', { [key]: 1 }).valid).toBe(true);
    expect(manager.validate('identity-mapping', { [key]: 1000 }).valid).toBe(true);
    for (const value of [0, 1001, -5, 2.5, '8', null]) {
      expect(manager.validate('identity-mapping', { [key]: value }).valid, String(value)).toBe(
        false
      );
    }
  });

  it('are read for the platform from its saved value, else the environment, else the default', async () => {
    const read = async (documents: Record<string, unknown>, env: Record<string, string> = {}) =>
      resolveMappingSetReferenceLimits({ SETTINGS: kv(documents), ...env } as never);

    expect(await read({})).toEqual({
      tenantLimit: 200,
      rowLimit: 500,
      concurrency: 8,
      displayLimit: 20,
    });
    expect(
      await read(
        { 'settings:platform:identity-mapping': { [SCAN_KEYS[3]]: 5 } },
        {
          IDENTITY_MAPPING_REFERENCE_DISPLAY_LIMIT: '50',
          IDENTITY_MAPPING_REFERENCE_SCAN_ROW_LIMIT: '40',
        }
      )
    ).toMatchObject({ displayLimit: 5, rowLimit: 40 });
  });

  it('keep the default for a value outside the range, wherever it came from', async () => {
    const read = async (documents: Record<string, unknown>, env: Record<string, string> = {}) =>
      resolveMappingSetReferenceLimits({ SETTINGS: kv(documents), ...env } as never);

    const saved = await read({
      'settings:platform:identity-mapping': {
        [SCAN_KEYS[0]]: 100000,
        [SCAN_KEYS[1]]: 3,
        [SCAN_KEYS[2]]: 0,
        [SCAN_KEYS[3]]: 2.5,
      },
    });
    expect(saved).toEqual({ tenantLimit: 200, rowLimit: 500, concurrency: 8, displayLimit: 20 });
    const env = await read(
      {},
      {
        IDENTITY_MAPPING_REFERENCE_SCAN_TENANT_LIMIT: '0',
        IDENTITY_MAPPING_REFERENCE_SCAN_CONCURRENCY: 'many',
      }
    );
    expect(env).toEqual({ tenantLimit: 200, rowLimit: 500, concurrency: 8, displayLimit: 20 });
  });

  it('are not taken from a tenant’s document: a tenant cannot widen the search', async () => {
    const limits = await resolveMappingSetReferenceLimits({
      SETTINGS: kv({ 'settings:tenant:acme:identity-mapping': { [SCAN_KEYS[0]]: 999 } }),
    } as never);
    expect(limits.tenantLimit).toBe(200);
  });

  it('keep the defaults when the settings cannot be read', async () => {
    const limits = await resolveMappingSetReferenceLimits({
      SETTINGS: {
        get: async () => {
          throw new Error('kv down');
        },
      },
    } as never);
    expect(limits).toEqual({ tenantLimit: 200, rowLimit: 500, concurrency: 8, displayLimit: 20 });
  });
});
