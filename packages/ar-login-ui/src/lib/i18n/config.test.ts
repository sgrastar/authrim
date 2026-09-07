import { describe, expect, it } from 'vitest';
import {
	getLoginUILanguageConfig,
	normalizeLoginUILanguageConfig,
	resolveEnabledLoginUILocale,
	resolveEnabledLoginUILocalePreferenceList
} from './config';

describe('Login UI language configuration', () => {
	it('uses all locales and English by default', () => {
		const config = getLoginUILanguageConfig(null);

		expect(config.supportedLocales).toHaveLength(21);
		expect(config.defaultLocale).toBe('en');
		expect(config.primaryLocales).toEqual(['en', 'zh-CN', 'hi', 'es', 'ar', 'fr']);
		expect(config.showEnglishLanguageNames).toBe(false);
	});

	it('accepts Arabic, Italian, Thai, and Vietnamese browser locales when enabled', () => {
		const config = normalizeLoginUILanguageConfig(['ar', 'it', 'th', 'vi'], 'ar');

		expect(resolveEnabledLoginUILocale('ar-SA', config)).toBe('ar');
		expect(resolveEnabledLoginUILocale('it-IT', config)).toBe('it');
		expect(resolveEnabledLoginUILocale('th-TH', config)).toBe('th');
		expect(resolveEnabledLoginUILocale('vi-VN', config)).toBe('vi');
	});

	it('keeps only unique supported locales and the configured default', () => {
		const config = normalizeLoginUILanguageConfig(['ja', 'fr', 'ja', 'invalid'], 'fr');

		expect(config).toEqual({
			supportedLocales: ['ja', 'fr'],
			defaultLocale: 'fr',
			primaryLocales: [],
			showEnglishLanguageNames: false
		});
	});

	it('falls back to the first enabled locale when the default is disabled', () => {
		const config = normalizeLoginUILanguageConfig(['ja', 'de'], 'en');

		expect(config.defaultLocale).toBe('ja');
	});

	it('rejects saved and browser locales that are not enabled', () => {
		const config = normalizeLoginUILanguageConfig(['en', 'fr'], 'en');

		expect(resolveEnabledLoginUILocale('fr-FR', config)).toBe('fr');
		expect(resolveEnabledLoginUILocale('ja-JP', config)).toBeNull();
	});

	it('uses the first enabled locale from an OIDC preference list', () => {
		const config = normalizeLoginUILanguageConfig(['en', 'ja', 'zh-TW'], 'en');

		expect(resolveEnabledLoginUILocalePreferenceList('fr-CA zh-Hant-TW ja', config)).toBe('zh-TW');
		expect(resolveEnabledLoginUILocalePreferenceList('fr-CA de-DE', config)).toBeNull();
	});

	it('keeps an explicit empty primary-language selection and English-name preference', () => {
		const config = normalizeLoginUILanguageConfig(undefined, 'en', [], true);

		expect(config.primaryLocales).toEqual([]);
		expect(config.showEnglishLanguageNames).toBe(true);
	});
});
