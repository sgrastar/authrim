import { afterEach, describe, expect, it } from 'vitest';
import {
  createTranslator,
  getAvailableLocales,
  getBaseTranslations,
  getLocale,
  getSupportedLocales,
  getTranslationsForWeb,
  getTranslationsSync,
  initI18n,
  loadTranslations,
  setLocale,
  t,
} from '../i18n/index.js';
import {
  detectBrowserLocale,
  detectSystemLocale,
  getLocaleFromQuery,
  isValidLocale,
  normalizeLocale,
} from '../i18n/detector.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('setup i18n locale contracts', () => {
  it.each([
    ['ja_JP.UTF-8', 'ja'],
    ['en-US', 'en'],
    ['zh_CN', 'zh-CN'],
    ['zh-HK', 'zh-TW'],
    ['zh-SG', 'zh-CN'],
    ['de-DE', 'de'],
    ['', null],
    ['xx-YY', null],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeLocale(input)).toBe(expected);
  });

  it('recognizes only supported locale codes', () => {
    expect(isValidLocale('ja')).toBe(true);
    expect(isValidLocale('zh-TW')).toBe(true);
    expect(isValidLocale('en-US')).toBe(false);
  });

  it('detects system locale by documented precedence and skips C/POSIX', () => {
    process.env.AUTHRIM_LANG = 'ja';
    process.env.LC_ALL = 'de_DE';
    expect(detectSystemLocale()).toBe('ja');
    process.env.AUTHRIM_LANG = 'invalid';
    expect(detectSystemLocale()).toBe('de');
    delete process.env.AUTHRIM_LANG;
    process.env.LC_ALL = 'C';
    process.env.LC_MESSAGES = 'POSIX';
    process.env.LANG = 'zh_TW.UTF-8';
    expect(detectSystemLocale()).toBe('zh-TW');
    process.env.LANG = 'invalid';
    expect(detectSystemLocale()).toBe('en');
  });

  it.each([
    ['ja,en-US;q=0.9', 'ja'],
    ['xx;q=1,de;q=0.7,en;q=0.8', 'en'],
    ['zh-HK;q=0.5,fr;q=0.9', 'fr'],
    ['', 'en'],
    [null, 'en'],
  ])('detects browser locale from %s', (header, expected) => {
    expect(detectBrowserLocale(header)).toBe(expected);
  });

  it('reads locale from query objects and URLSearchParams', () => {
    expect(getLocaleFromQuery({ lang: 'ja_JP' })).toBe('ja');
    expect(getLocaleFromQuery(new URLSearchParams('lang=zh-HK'))).toBe('zh-TW');
    expect(getLocaleFromQuery({ lang: 'invalid' })).toBeNull();
    expect(getLocaleFromQuery({})).toBeNull();
  });

  it('loads and caches translation files and exposes English fallback', async () => {
    const en = await getBaseTranslations();
    expect(en['banner.title']).toBe('Authrim Setup');
    expect(await loadTranslations('en')).toBe(en);
    const ja = await loadTranslations('ja');
    expect(getTranslationsSync('ja')).toBe(ja);
    expect(getTranslationsSync('ru')).toBeNull();
  });

  it('initializes, switches, validates, and reports locale inventories', async () => {
    await initI18n('ja_JP');
    expect(getLocale()).toBe('ja');
    await setLocale('de');
    expect(getLocale()).toBe('de');
    await expect(setLocale('invalid' as never)).rejects.toThrow('Invalid locale');
    await initI18n('invalid');
    expect(getLocale()).toBe('de');
    expect(getSupportedLocales().length).toBeGreaterThanOrEqual(getAvailableLocales().length);
    expect(getAvailableLocales().map((locale) => locale.code)).toContain('id');
  });

  it('translates with interpolation, English fallback, and missing-key preservation', async () => {
    await initI18n('ja');
    expect(t('language.selected', { language: '日本語' })).toContain('日本語');
    expect(t('missing.translation.key')).toBe('missing.translation.key');
    const translateGerman = createTranslator('de');
    expect(translateGerman('banner.title')).toBeTruthy();
    expect(translateGerman('language.selected', { language: 'Deutsch' })).toContain('Deutsch');
    expect(translateGerman('missing.translation.key')).toBe('missing.translation.key');
    expect(createTranslator('ru')('banner.title')).toBe('banner.title');
  });

  it('merges locale translations over English for web injection', async () => {
    await loadTranslations('en');
    await loadTranslations('fr');
    const french = getTranslationsForWeb('fr');
    expect(french['banner.title']).toBeTruthy();
    expect(Object.keys(french).length).toBeGreaterThan(100);
    expect(getTranslationsForWeb('ru')['banner.title']).toBe('Authrim Setup');
  });

  it('keeps every supported locale in exact key parity with English', async () => {
    const englishKeys = Object.keys(await loadTranslations('en')).sort();

    for (const locale of getSupportedLocales()) {
      const localeKeys = Object.keys(await loadTranslations(locale.code)).sort();
      expect(localeKeys, locale.code).toEqual(englishKeys);
    }
  });

  it('does not promise an unmeasured setup duration in the quick setup menu', async () => {
    for (const locale of getSupportedLocales()) {
      const translations = await loadTranslations(locale.code);
      expect(translations['menu.quick'], locale.code).not.toContain('5');
    }
  });

  it('does not retain translations for the removed OIDC profile selector', async () => {
    for (const locale of getSupportedLocales()) {
      const translations = await loadTranslations(locale.code);
      expect(
        Object.keys(translations).filter((key) => key.startsWith('profile.')),
        locale.code
      ).toEqual([]);
    }
  });

  it('localizes the complete CLI custom-setup domain flow', async () => {
    const keys = [
      'domain.configureBindingDesc',
      'domain.baseDomainDepthError',
      'domain.uiDomainDepthError',
      'domain.suggestedHost',
      'domain.uiRequiresOwnRoute',
      'tenant.domainSetupHint',
      'tenant.customDomainExamples',
      'tenant.idRules',
      'tenant.randomIdHint',
      'tenant.randomIdPrompt',
      'tenant.nakedDomainPrompt',
      'tenant.primaryTenantPrompt',
      'config.d1Routing',
      'config.placement',
      'config.provisioning',
      'common.comingSoon',
    ] as const;
    const english = await loadTranslations('en');

    for (const locale of getSupportedLocales()) {
      const translations = await loadTranslations(locale.code);
      for (const key of keys) {
        expect(translations[key], `${locale.code}:${key}`).toBeTruthy();
        if (locale.code !== 'en') {
          expect(translations[key], `${locale.code}:${key}`).not.toBe(english[key]);
        }
      }
    }
  });

  it('localizes the initial provisioning and completion flow', async () => {
    const keys = [
      'prereq.authenticated',
      'prereq.checkFailed',
      'config.uiEnvNoApi',
      'config.wranglerConfigsSaved',
      'config.wranglerConfigsPartial',
      'config.wranglerConfigsSyncing',
      'config.wranglerConfigsSynced',
      'config.wranglerConfigsSyncFailed',
      'deploy.initialProvisioningFailed',
      'complete.createdResources',
      'complete.generatedFiles',
      'complete.automaticStep1',
      'complete.automaticStep2',
      'complete.automaticStep2Detail',
      'complete.manualStep1',
      'complete.manualStep2',
      'complete.manualStep2Detail',
    ] as const;
    const english = await loadTranslations('en');

    for (const locale of getSupportedLocales()) {
      const translations = await loadTranslations(locale.code);
      for (const key of keys) {
        expect(translations[key], `${locale.code}:${key}`).toBeTruthy();
        if (locale.code !== 'en') {
          expect(translations[key], `${locale.code}:${key}`).not.toBe(english[key]);
        }
      }
    }
  });

  it('provides localized initial deployment recovery guidance for every supported locale', async () => {
    const keys = [
      'web.envDetail.initialDeployRecoveryTitle',
      'web.envDetail.initialDeployRecoveryDesc',
      'web.envDetail.initialDeployRecoveryAction',
      'web.envDetail.initialDeployRecoveryVerified',
      'web.envDetail.initialDeployRecoveryStageMigrations',
      'web.envDetail.initialDeployRecoveryStageControlPlane',
      'web.envDetail.initialDeployRecoveryStageWorkers',
      'web.envDetail.initialDeployRecoveryStageVerification',
      'web.envDetail.initialDeployRecoveryResources',
      'web.envDetail.initialDeployRecoverySchema',
      'web.envDetail.initialDeployRecoveryWorkers',
      'web.envDetail.initialDeployRecoveryRecreate',
      'web.envDetail.initialDeployRecoveryManifestChanged',
      'web.envDetail.initialDeployRecoveryBlocked',
      'web.envDetail.initialDeployRecoveryTokenRequired',
    ] as const;
    const english = await loadTranslations('en');

    for (const locale of getSupportedLocales()) {
      const translations = await loadTranslations(locale.code);
      for (const key of keys) {
        expect(translations[key], `${locale.code}:${key}`).toBeTruthy();
      }
      if (locale.code !== 'en') {
        expect(translations['web.envDetail.initialDeployRecoveryManifestChanged']).not.toBe(
          english['web.envDetail.initialDeployRecoveryManifestChanged']
        );
      }
    }
  });

  it('localizes the concurrent setup operation message for every supported locale', async () => {
    const english = await loadTranslations('en');

    for (const locale of getSupportedLocales()) {
      const translations = await loadTranslations(locale.code);
      expect(translations['web.status.operationInProgress'], locale.code).toBeTruthy();
      expect(translations['web.status.warning'], locale.code).toBeTruthy();
      if (locale.code !== 'en') {
        expect(translations['web.status.operationInProgress'], locale.code).not.toBe(
          english['web.status.operationInProgress']
        );
        expect(translations['web.status.warning'], locale.code).not.toBe(
          english['web.status.warning']
        );
      }
    }
  });
});
