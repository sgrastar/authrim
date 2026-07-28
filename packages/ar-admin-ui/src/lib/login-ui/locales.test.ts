import { describe, expect, it } from 'vitest';
import {
	ALL_LOGIN_UI_LOCALES,
	DEFAULT_LOGIN_UI_FOOTER_TEXTS,
	DEFAULT_LOGIN_UI_PAGE_TITLES,
	DEFAULT_LOGIN_UI_TAGLINES,
	resolveEnabledLoginUILocales
} from './locales';

describe('Login UI locale settings', () => {
	it('returns only explicitly enabled locales in their configured order', () => {
		expect(resolveEnabledLoginUILocales('ja,en,fr,unsupported,ja')).toEqual(['ja', 'en', 'fr']);
	});

	it('expands an empty or legacy default list to every supported locale', () => {
		expect(resolveEnabledLoginUILocales('')).toEqual(ALL_LOGIN_UI_LOCALES);
		expect(resolveEnabledLoginUILocales('en,ja,zh-CN,zh-TW,es,pt,fr,de,ko,ru,id')).toEqual(
			ALL_LOGIN_UI_LOCALES
		);
	});

	it('provides localized theme text defaults for every supported locale', () => {
		for (const locale of ALL_LOGIN_UI_LOCALES) {
			expect(DEFAULT_LOGIN_UI_TAGLINES[locale]).not.toBe('');
			expect(DEFAULT_LOGIN_UI_FOOTER_TEXTS[locale]).toContain(
				'<a href="https://authrim.com/">Authrim</a>'
			);
			expect(DEFAULT_LOGIN_UI_PAGE_TITLES[locale].loginTitle).not.toBe('');
			expect(DEFAULT_LOGIN_UI_PAGE_TITLES[locale].registrationTitle).not.toBe('');
			expect(DEFAULT_LOGIN_UI_PAGE_TITLES[locale].accountTitle).not.toBe('');
		}
		expect(DEFAULT_LOGIN_UI_TAGLINES.en).toBe('Identity & Access at the edge of everywhere.');
		expect(DEFAULT_LOGIN_UI_FOOTER_TEXTS.en).toBe(
			'Powered by <a href="https://authrim.com/">Authrim</a>'
		);
		expect(DEFAULT_LOGIN_UI_FOOTER_TEXTS.ja).toBe(
			'Powered by <a href="https://authrim.com/">Authrim</a>'
		);
		expect(DEFAULT_LOGIN_UI_FOOTER_TEXTS.ko).toBe(
			'Powered by <a href="https://authrim.com/">Authrim</a>'
		);
		expect(DEFAULT_LOGIN_UI_PAGE_TITLES.ja).toEqual({
			loginTitle: 'おかえりなさい',
			registrationTitle: 'アカウント作成',
			accountTitle: 'アカウント'
		});
	});
});
