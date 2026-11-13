import { describe, expect, it, vi } from 'vitest';
import {
  environmentBannerNotice,
  environmentBannerText,
  environmentBannerTextLocalizationsProblem,
  environmentBannerTextProblem,
  readEnvironmentBanner,
} from '../environment-banner';
import { ALL_CATEGORY_META, CATEGORY_SCOPE_CONFIG } from '../../types/settings/catalog';
import { ENVIRONMENT_BANNER_SETTINGS_META } from '../../types/settings/environment-banner';
import { TENANT_SETTING_FIELD_POLICIES } from '../tenant-portability/settings-field-registry';

const DOC_KEY = 'settings:platform:environment-banner';

function kvWith(data: Record<string, string>) {
  const store = new Map(Object.entries(data));
  const get = vi.fn(async (key: string) => store.get(key) ?? null);
  const kv = { get, put: vi.fn(), delete: vi.fn(), list: vi.fn(), getWithMetadata: vi.fn() };
  return { kv: kv as unknown as KVNamespace, get };
}
const doc = (values: Record<string, unknown>) => ({ [DOC_KEY]: JSON.stringify(values) });

describe('the environment-banner category', () => {
  it('is registered, platform-only, off by default, with env keys', () => {
    expect(ALL_CATEGORY_META['environment-banner']).toBeDefined();
    expect(CATEGORY_SCOPE_CONFIG['environment-banner'].allowedScopes).toEqual(['platform']);
    const m = ENVIRONMENT_BANNER_SETTINGS_META;
    expect(m['environment_banner.enabled']).toMatchObject({
      default: false,
      envKey: 'ENVIRONMENT_BANNER_ENABLED',
    });
    expect(m['environment_banner.text']).toMatchObject({
      default: '',
      envKey: 'ENVIRONMENT_BANNER_TEXT',
    });
    expect(m['environment_banner.text_localizations'].default).toBe('{}');
    expect(m['environment_banner.noindex']).toMatchObject({
      default: false,
      envKey: 'ENVIRONMENT_BANNER_NOINDEX',
    });
    for (const meta of Object.values(m)) expect(meta.scopes).toEqual(['platform']);
  });

  it('is reviewed for tenant portability', () => {
    const keys = TENANT_SETTING_FIELD_POLICIES.filter(
      (policy) => policy.category === 'environment-banner'
    ).map((policy) => policy.key);
    expect(keys.sort()).toEqual(Object.keys(ENVIRONMENT_BANNER_SETTINGS_META).sort());
  });
});

describe('readEnvironmentBanner', () => {
  it('is off with nothing saved and no KV', async () => {
    expect(await readEnvironmentBanner({ SETTINGS: kvWith({}).kv })).toEqual({
      enabled: false,
      text: '',
      textLocalizations: {},
      noindex: false,
    });
    expect((await readEnvironmentBanner({})).enabled).toBe(false);
  });

  it('reads the environment, and lets a saved value win', async () => {
    const env = {
      SETTINGS: kvWith({}).kv,
      ENVIRONMENT_BANNER_ENABLED: 'true',
      ENVIRONMENT_BANNER_TEXT: 'Staging environment',
      ENVIRONMENT_BANNER_NOINDEX: 'true',
    };
    expect(await readEnvironmentBanner(env)).toMatchObject({
      enabled: true,
      text: 'Staging environment',
      noindex: true,
    });
    const saved = {
      ...env,
      SETTINGS: kvWith(
        doc({
          'environment_banner.enabled': false,
          'environment_banner.text': 'From KV',
          'environment_banner.text_localizations': '{"ja":"ステージング環境です"}',
        })
      ).kv,
    };
    expect(await readEnvironmentBanner(saved)).toEqual({
      enabled: false,
      text: 'From KV',
      textLocalizations: { ja: 'ステージング環境です' },
      noindex: true,
    });
  });

  it('is quiet (banner and noindex off) when the settings cannot be read', async () => {
    const { kv, get } = kvWith({});
    get.mockRejectedValue(new Error('kv down'));
    expect(
      await readEnvironmentBanner({
        SETTINGS: kv,
        ENVIRONMENT_BANNER_ENABLED: 'true',
        ENVIRONMENT_BANNER_NOINDEX: 'true',
      })
    ).toEqual({ enabled: false, text: '', textLocalizations: {}, noindex: false });
  });

  it('ignores an invalid saved text or map instead of showing it', async () => {
    const { kv } = kvWith(
      doc({
        'environment_banner.enabled': true,
        'environment_banner.text': 'x'.repeat(201),
        'environment_banner.text_localizations': '{bad',
      })
    );
    const banner = await readEnvironmentBanner({ SETTINGS: kv });
    expect(banner).toMatchObject({ enabled: true, text: '', textLocalizations: {} });
    expect(environmentBannerNotice(banner)).toBeNull();
  });
});

describe('environmentBannerText', () => {
  const banner = {
    enabled: true,
    text: 'Staging environment',
    textLocalizations: { ja: 'ステージング環境です', 'en-gb': 'Staging environment (GB)' },
  };
  it('prefers the exact tag, then the language, then the text', () => {
    expect(environmentBannerText(banner, 'ja')).toBe('ステージング環境です');
    expect(environmentBannerText(banner, 'ja-JP')).toBe('ステージング環境です');
    expect(environmentBannerText(banner, 'en-GB')).toBe('Staging environment (GB)');
    expect(environmentBannerText(banner, 'de')).toBe('Staging environment');
    expect(environmentBannerText(banner, undefined)).toBe('Staging environment');
  });
  it('is empty when there is nothing to show or the banner is off', () => {
    expect(environmentBannerText({ ...banner, text: '', textLocalizations: {} }, 'ja')).toBe('');
    expect(environmentBannerText({ ...banner, text: '' }, 'de')).toBe('');
    expect(environmentBannerText({ ...banner, enabled: false }, 'ja')).toBe('');
  });
  it('gives a notice only when enabled with some text', () => {
    expect(environmentBannerNotice({ ...banner, noindex: false })).toEqual({
      text: banner.text,
      textLocalizations: banner.textLocalizations,
    });
    expect(environmentBannerNotice({ ...banner, enabled: false, noindex: false })).toBeNull();
  });
});

describe('validation', () => {
  it('checks the text', () => {
    expect(environmentBannerTextProblem('')).toBeNull();
    expect(environmentBannerTextProblem('x'.repeat(200))).toBeNull();
    expect(environmentBannerTextProblem('x'.repeat(201))).not.toBeNull();
    expect(environmentBannerTextProblem('a\nb')).not.toBeNull();
    expect(environmentBannerTextProblem(' padded')).not.toBeNull();
    expect(environmentBannerTextProblem(5)).not.toBeNull();
  });
  it('checks the map (no language required)', () => {
    expect(environmentBannerTextLocalizationsProblem('{}')).toBeNull();
    expect(environmentBannerTextLocalizationsProblem('{"fr":"Environnement de test"}')).toBeNull();
    expect(environmentBannerTextLocalizationsProblem('nope')).not.toBeNull();
    expect(environmentBannerTextLocalizationsProblem('[]')).not.toBeNull();
    expect(environmentBannerTextLocalizationsProblem('{"FR!":"x"}')).not.toBeNull();
    expect(environmentBannerTextLocalizationsProblem('{"fr":""}')).not.toBeNull();
    expect(environmentBannerTextLocalizationsProblem('{"fr":"a\\u0007b"}')).not.toBeNull();
    const seventeen = Object.fromEntries(
      Array.from({ length: 17 }, (_, i) => [`l${String.fromCharCode(97 + i)}`, 'x'])
    );
    expect(environmentBannerTextLocalizationsProblem(JSON.stringify(seventeen))).not.toBeNull();
  });
});
