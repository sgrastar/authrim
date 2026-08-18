import { describe, expect, it } from 'vitest';
import { LOGIN_UI_LOCALES } from './locales';
import { buildLoginUILanguageSelectorModel } from './language-selector';
import { LOGIN_UI_LANGUAGE_METADATA_BY_LOCALE } from '@authrim/ar-lib-core/types/login-ui-languages';

describe('Login UI language selector model', () => {
	it('uses one flat English-name-sorted list for 10 enabled languages', () => {
		const model = buildLoginUILanguageSelectorModel(
			['vi', 'tr', 'th', 'sw', 'es', 'ru', 'pt', 'pl', 'ko', 'ja'],
			['ja', 'ko'],
			false,
			'ja'
		);

		expect(model.grouped).toBe(false);
		expect(model.mainOptions).toEqual([]);
		expect(model.allLanguageOptions).toEqual([]);
		expect(model.flatOptions.map(({ locale }) => locale)).toEqual([
			'ja',
			'ko',
			'pl',
			'pt',
			'ru',
			'es',
			'sw',
			'th',
			'tr',
			'vi'
		]);
	});

	it('adds a non-primary current locale before the six primary languages', () => {
		const model = buildLoginUILanguageSelectorModel(
			LOGIN_UI_LOCALES,
			['en', 'zh-CN', 'hi', 'es', 'ar', 'fr'],
			false,
			'ja'
		);

		expect(model.grouped).toBe(true);
		expect(model.mainOptions.map(({ locale }) => locale)).toEqual([
			'ja',
			'en',
			'zh-CN',
			'hi',
			'es',
			'ar',
			'fr'
		]);
	});

	it('moves a primary current locale to the front without adding a duplicate', () => {
		const model = buildLoginUILanguageSelectorModel(
			LOGIN_UI_LOCALES,
			['en', 'zh-CN', 'hi', 'es', 'ar', 'fr'],
			false,
			'zh-CN'
		);

		expect(model.mainOptions.map(({ locale }) => locale)).toEqual([
			'zh-CN',
			'en',
			'hi',
			'es',
			'ar',
			'fr'
		]);
	});

	it('repeats every main language in one English-labelled all-languages group', () => {
		const model = buildLoginUILanguageSelectorModel(
			LOGIN_UI_LOCALES,
			['en', 'zh-CN', 'hi', 'es', 'ar', 'fr'],
			false,
			'ja'
		);

		expect(model.allLanguagesLabel).toBe('All languages');
		expect(model.allLanguageOptions.map(({ locale }) => locale)).toEqual(LOGIN_UI_LOCALES);
		for (const { locale } of model.mainOptions) {
			expect(model.allLanguageOptions.map((option) => option.locale)).toContain(locale);
		}
	});

	it('sorts all languages by English name', () => {
		const model = buildLoginUILanguageSelectorModel(LOGIN_UI_LOCALES, [], false, 'en');
		const names = model.allLanguageOptions.map(
			({ locale }) => LOGIN_UI_LANGUAGE_METADATA_BY_LOCALE[locale].englishName
		);

		expect(names).toEqual(
			[...names].sort((left, right) => left.localeCompare(right, 'en', { sensitivity: 'base' }))
		);
	});

	it('keeps both lists stable while toggling English names and avoids duplicate English', () => {
		const nativeOnly = buildLoginUILanguageSelectorModel(
			LOGIN_UI_LOCALES,
			['en', 'ja'],
			false,
			'ja'
		);
		const withEnglish = buildLoginUILanguageSelectorModel(
			LOGIN_UI_LOCALES,
			['en', 'ja'],
			true,
			'ja'
		);

		expect(withEnglish.mainOptions.map(({ locale }) => locale)).toEqual(
			nativeOnly.mainOptions.map(({ locale }) => locale)
		);
		expect(withEnglish.allLanguageOptions.map(({ locale }) => locale)).toEqual(
			nativeOnly.allLanguageOptions.map(({ locale }) => locale)
		);
		expect(withEnglish.mainOptions.find(({ locale }) => locale === 'en')?.label).toBe('English');
		expect(withEnglish.mainOptions.find(({ locale }) => locale === 'ja')?.label).toBe(
			'Japanese (日本語)'
		);
	});
});
