import { describe, expect, it } from 'vitest';
import {
	getLoginUILanguageConfig,
	normalizeLoginUILanguageConfig,
	resolveEnabledLoginUILocale
} from './config';

describe('Login UI language configuration', () => {
	it('uses all locales and English by default', () => {
		const config = getLoginUILanguageConfig(null);

		expect(config.supportedLocales).toHaveLength(11);
		expect(config.defaultLocale).toBe('en');
	});

	it('keeps only unique supported locales and the configured default', () => {
		const config = normalizeLoginUILanguageConfig(['ja', 'fr', 'ja', 'invalid'], 'fr');

		expect(config).toEqual({ supportedLocales: ['ja', 'fr'], defaultLocale: 'fr' });
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
});
