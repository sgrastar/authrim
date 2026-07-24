import { describe, expect, it } from 'vitest';
import {
	LOGIN_UI_LOCALES,
	isLoginUILocale,
	normalizeLoginUILocale,
	toDocumentLanguage
} from './locales';
import de from '$i18n/de';
import en from '$i18n/en';
import es from '$i18n/es';
import fr from '$i18n/fr';
import id from '$i18n/id';
import ja from '$i18n/ja';
import ko from '$i18n/ko';
import pt from '$i18n/pt';
import ru from '$i18n/ru';
import zhCN from '$i18n/zh-CN';
import zhTW from '$i18n/zh-TW';

describe('LoginUI locales', () => {
	it('matches the eleven locales supported by Screen localizations', () => {
		expect(LOGIN_UI_LOCALES).toEqual([
			'en',
			'ja',
			'zh-CN',
			'zh-TW',
			'es',
			'pt',
			'fr',
			'de',
			'ko',
			'ru',
			'id'
		]);
	});

	it.each([
		['zh-CN', 'zh-CN'],
		['zh-Hans', 'zh-CN'],
		['zh-TW', 'zh-TW'],
		['zh-Hant', 'zh-TW'],
		['pt-BR', 'pt'],
		['KO-kr', 'ko'],
		['unknown', null]
	] as const)('normalizes browser locale %s to %s', (input, expected) => {
		expect(normalizeLoginUILocale(input)).toBe(expected);
	});

	it('validates storage values and emits valid document language tags', () => {
		expect(isLoginUILocale('zh-CN')).toBe(true);
		expect(isLoginUILocale('zh-Hans')).toBe(false);
		expect(toDocumentLanguage('zh-TW')).toBe('zh-TW');
	});

	it('provides localized copy for every requested LoginUI surface', () => {
		for (const translation of [de, es, fr, id, ko, pt, ru, zhCN, zhTW]) {
			expect(translation.landing_providerBadge).not.toBe(en.landing_providerBadge);
			expect(translation.login_title).not.toBe(en.login_title);
			expect(translation.register_title).not.toBe(en.register_title);
			expect(translation.discover_title).not.toBe(en.discover_title);
			expect(translation.account_profileTitle).not.toBe(en.account_profileTitle);
			expect(translation.runtime_screenUnavailable).not.toBe(en.runtime_screenUnavailable);
		}
	});

	it('defines every base translation key in every locale without an English fallback', () => {
		const expectedKeys = Object.keys(en).sort();
		for (const translation of [ja, de, es, fr, id, ko, pt, ru, zhCN, zhTW]) {
			expect(Object.keys(translation).sort()).toEqual(expectedKeys);
		}
	});

	it('preserves every interpolation placeholder in every locale', () => {
		const placeholders = (value: string) =>
			[...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)(?::[^}]+)?\}/g)]
				.map((match) => match[1])
				.sort();

		for (const translation of [ja, de, es, fr, id, ko, pt, ru, zhCN, zhTW]) {
			for (const key of Object.keys(en) as (keyof typeof en)[]) {
				expect(placeholders(translation[key]), key).toEqual(placeholders(en[key]));
			}
		}
	});

	it('keeps authentication button labels within the mobile copy budget', () => {
		const buttonKeys = [
			'login_signInWithPasskey',
			'login_sendCode',
			'login_totpContinue',
			'login_totpVerify',
			'register_createWithPasskey',
			'register_sendCode',
			'register_createWithTotp',
			'reauth_verifyWithPasskey',
			'reauth_verifyWithEmailCode',
			'reauth_verifyWithTotp',
			'account_reauthWithPasskey',
			'account_reauthWithEmailCode',
			'account_reauthWithTotp'
		] as const;

		for (const translation of [en, ja, de, es, fr, id, ko, pt, ru, zhCN, zhTW]) {
			for (const key of buttonKeys) {
				const maximumLength = key === 'login_totpContinue' ? 38 : 42;
				expect(Array.from(translation[key]).length, key).toBeLessThanOrEqual(maximumLength);
			}
		}
	});
});
