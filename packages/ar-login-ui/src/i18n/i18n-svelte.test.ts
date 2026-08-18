import { get } from 'svelte/store';
import { afterEach, describe, expect, it } from 'vitest';
import { LL, setLocale } from './i18n-svelte';
import type { Locales } from './i18n-types';
import { LOGIN_UI_LOCALES } from '$lib/i18n/locales';

const persistentSurfaceKeys = [
	'app_subtitle',
	'footer_stack',
	'language_switch',
	'language_region_east_asia',
	'language_region_south_southeast_asia',
	'language_region_europe',
	'language_region_middle_east_north_africa',
	'language_region_sub_saharan_africa',
	'theme_switchToLightMode',
	'theme_switchToDarkMode',
	'common_loading',
	'common_footerLinks',
	'login_createAccount',
	'register_alreadyHaveAccount'
] as const;

describe('i18n-svelte locale registration', () => {
	afterEach(() => {
		setLocale('en');
	});

	it.each(LOGIN_UI_LOCALES as Locales[])('registers persistent LoginUI copy for %s', (locale) => {
		setLocale(locale);
		const translations = get(LL);

		for (const key of persistentSurfaceKeys) {
			expect(translations[key](), `${locale}.${key}`).not.toBe('');
		}
	});

	it('uses the Authrim tagline without styling-dependent markup', () => {
		setLocale('en');
		expect(get(LL).app_subtitle()).toBe('Identity & Access at the edge of everywhere.');

		setLocale('ja');
		expect(get(LL).app_subtitle()).toBe('アイデンティティ＆アクセスをあらゆる場所で');
	});
});
