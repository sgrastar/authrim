import { describe, expect, it } from 'vitest';
import {
  LOGIN_UI_LANGUAGE_METADATA,
  LOGIN_UI_LANGUAGE_METADATA_BY_LOCALE,
  compareLoginUILanguagesBySpeakerCount,
  parseConfiguredPrimaryLoginUILocales,
  resolveEffectivePrimaryLoginUILocales,
  selectDefaultPrimaryLoginUILocales,
} from '../types/login-ui-languages';

describe('Login UI language metadata', () => {
  it('defines complete metadata for all 21 locales and separate Chinese script estimates', () => {
    expect(LOGIN_UI_LANGUAGE_METADATA).toHaveLength(21);
    for (const metadata of LOGIN_UI_LANGUAGE_METADATA) {
      expect(metadata.localeCode).not.toBe('');
      expect(metadata.englishName).not.toBe('');
      expect(metadata.nativeName).not.toBe('');
      expect(metadata.estimatedTotalSpeakers).toBeGreaterThan(0);
      expect(metadata.speakerCountEstimateYear).toBeGreaterThanOrEqual(2022);
      expect(metadata.speakerCountSource).not.toBe('');
      expect(metadata.regionGroup).not.toBe('');
    }
    expect(LOGIN_UI_LANGUAGE_METADATA_BY_LOCALE['zh-CN'].estimatedTotalSpeakers).not.toBe(
      LOGIN_UI_LANGUAGE_METADATA_BY_LOCALE['zh-TW'].estimatedTotalSpeakers
    );
  });

  it('selects the six enabled languages with the largest speaker estimates by default', () => {
    expect(
      selectDefaultPrimaryLoginUILocales(
        LOGIN_UI_LANGUAGE_METADATA.map(({ localeCode }) => localeCode)
      )
    ).toEqual(['en', 'zh-CN', 'hi', 'es', 'ar', 'fr']);
  });

  it('breaks equal speaker-count ties by English name', () => {
    const languages = [
      { englishName: 'Zulu', estimatedTotalSpeakers: 10 },
      { englishName: 'Arabic', estimatedTotalSpeakers: 10 },
    ];
    expect(
      languages.sort(compareLoginUILanguagesBySpeakerCount).map(({ englishName }) => englishName)
    ).toEqual(['Arabic', 'Zulu']);
  });

  it('distinguishes an explicit empty selection from an unset selection', () => {
    expect(parseConfiguredPrimaryLoginUILocales(null)).toBeNull();
    expect(parseConfiguredPrimaryLoginUILocales([])).toEqual([]);
    expect(parseConfiguredPrimaryLoginUILocales('[]')).toEqual([]);
  });

  it('ignores primary languages when fewer than 11 are enabled and filters disabled locales', () => {
    const tenLocales = LOGIN_UI_LANGUAGE_METADATA.slice(0, 10).map(({ localeCode }) => localeCode);
    expect(resolveEffectivePrimaryLoginUILocales(tenLocales, ['en'])).toEqual([]);

    const elevenLocales = LOGIN_UI_LANGUAGE_METADATA.slice(0, 11).map(
      ({ localeCode }) => localeCode
    );
    expect(resolveEffectivePrimaryLoginUILocales(elevenLocales, ['ja', 'en', 'ar'])).toEqual([
      'en',
      'ar',
    ]);
  });

  it('orders effective primary languages by speaker estimate', () => {
    expect(
      resolveEffectivePrimaryLoginUILocales(
        LOGIN_UI_LANGUAGE_METADATA.map(({ localeCode }) => localeCode),
        ['fr', 'ar', 'es', 'hi', 'zh-CN', 'en']
      )
    ).toEqual(['en', 'zh-CN', 'hi', 'es', 'ar', 'fr']);
  });
});
