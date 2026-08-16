import { describe, expect, it } from 'vitest';
import {
	LOGIN_UI_LOCALES,
	isLoginUILocale,
	normalizeLoginUILocale,
	toDocumentDirection,
	toDocumentLanguage
} from './locales';
import ar from '$i18n/ar';
import am from '$i18n/am';
import bn from '$i18n/bn';
import de from '$i18n/de';
import en from '$i18n/en';
import es from '$i18n/es';
import fr from '$i18n/fr';
import hi from '$i18n/hi';
import id from '$i18n/id';
import itTranslation from '$i18n/it';
import ja from '$i18n/ja';
import ko from '$i18n/ko';
import pl from '$i18n/pl';
import pt from '$i18n/pt';
import ru from '$i18n/ru';
import sw from '$i18n/sw';
import th from '$i18n/th';
import tr from '$i18n/tr';
import vi from '$i18n/vi';
import zhCN from '$i18n/zh-CN';
import zhTW from '$i18n/zh-TW';

describe('LoginUI locales', () => {
	it('matches the twenty-one locales supported by Screen localizations', () => {
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
			'id',
			'ar',
			'it',
			'th',
			'vi',
			'hi',
			'bn',
			'tr',
			'sw',
			'am',
			'pl'
		]);
	});

	it.each([
		['zh-CN', 'zh-CN'],
		['zh-Hans', 'zh-CN'],
		['zh-TW', 'zh-TW'],
		['zh-Hant', 'zh-TW'],
		['pt-BR', 'pt'],
		['KO-kr', 'ko'],
		['ar-SA', 'ar'],
		['it-IT', 'it'],
		['th-TH', 'th'],
		['vi-VN', 'vi'],
		['hi-IN', 'hi'],
		['bn-BD', 'bn'],
		['tr-TR', 'tr'],
		['sw-KE', 'sw'],
		['am-ET', 'am'],
		['pl-PL', 'pl'],
		['unknown', null]
	] as const)('normalizes browser locale %s to %s', (input, expected) => {
		expect(normalizeLoginUILocale(input)).toBe(expected);
	});

	it('validates storage values and emits valid document language tags', () => {
		expect(isLoginUILocale('zh-CN')).toBe(true);
		expect(isLoginUILocale('zh-Hans')).toBe(false);
		expect(toDocumentLanguage('zh-TW')).toBe('zh-TW');
		expect(toDocumentDirection('ar')).toBe('rtl');
		expect(toDocumentDirection('it')).toBe('ltr');
	});

	it('provides localized copy for every requested LoginUI surface', () => {
		for (const translation of [
			am,
			ar,
			bn,
			de,
			es,
			fr,
			hi,
			id,
			itTranslation,
			ko,
			pl,
			pt,
			ru,
			sw,
			th,
			tr,
			vi,
			zhCN,
			zhTW
		]) {
			expect(translation.landing_providerBadge).not.toBe(en.landing_providerBadge);
			expect(translation.login_title).not.toBe(en.login_title);
			expect(translation.register_title).not.toBe(en.register_title);
			expect(translation.discover_title).not.toBe(en.discover_title);
			expect(translation.account_profileTitle).not.toBe(en.account_profileTitle);
			expect(translation.runtime_screenUnavailable).not.toBe(en.runtime_screenUnavailable);
		}
	});

	it('links Authrim in the localized footer for every language', () => {
		for (const translation of [
			en,
			ar,
			am,
			bn,
			ja,
			de,
			es,
			fr,
			hi,
			id,
			itTranslation,
			ko,
			pl,
			pt,
			ru,
			sw,
			th,
			tr,
			vi,
			zhCN,
			zhTW
		]) {
			expect(translation.footer_stack).toContain('<a href="https://authrim.com/">Authrim</a>');
		}
	});

	it('defines every base translation key in every locale without an English fallback', () => {
		const expectedKeys = Object.keys(en).sort();
		for (const translation of [
			ar,
			am,
			bn,
			ja,
			de,
			es,
			fr,
			hi,
			id,
			itTranslation,
			ko,
			pl,
			pt,
			ru,
			sw,
			th,
			tr,
			vi,
			zhCN,
			zhTW
		]) {
			expect(Object.keys(translation).sort()).toEqual(expectedKeys);
		}
	});

	it('preserves every interpolation placeholder in every locale', () => {
		const placeholders = (value: string) =>
			[...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)(?::[^}]+)?\}/g)]
				.map((match) => match[1])
				.sort();

		for (const translation of [
			am,
			ar,
			bn,
			ja,
			de,
			es,
			fr,
			hi,
			id,
			itTranslation,
			ko,
			pl,
			pt,
			ru,
			sw,
			th,
			tr,
			vi,
			zhCN,
			zhTW
		]) {
			for (const key of Object.keys(en) as (keyof typeof en)[]) {
				expect(placeholders(translation[key]), key).toEqual(placeholders(en[key]));
			}
		}
	});

	it('localizes required-field validation in every non-English locale', () => {
		for (const translation of [
			ar,
			ja,
			de,
			es,
			fr,
			id,
			itTranslation,
			ko,
			pt,
			ru,
			th,
			vi,
			zhCN,
			zhTW
		]) {
			expect(translation.common_requiredField).not.toBe(en.common_requiredField);
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

		for (const translation of [
			am,
			ar,
			bn,
			en,
			ja,
			de,
			es,
			fr,
			hi,
			id,
			itTranslation,
			ko,
			pl,
			pt,
			ru,
			sw,
			th,
			tr,
			vi,
			zhCN,
			zhTW
		]) {
			for (const key of buttonKeys) {
				const maximumLength = key === 'login_totpContinue' ? 38 : 42;
				expect(Array.from(translation[key]).length, key).toBeLessThanOrEqual(maximumLength);
			}
		}
	});

	it('localizes every end-user error surface in the six newly added locales', () => {
		const errorKeys = [
			'common_requiredField',
			'account_saveFailed',
			'account_loadFailed',
			'account_actionFailed',
			'login_totpCodeInvalid',
			'login_totpStartFailed',
			'login_errorEmailRequired',
			'login_errorEmailInvalid',
			'login_errorDirectoryInvalidCredentials',
			'login_errorDirectoryUnavailable',
			'login_errorDirectoryUnmapped',
			'login_errorDirectoryFailed',
			'login_humanVerificationLoadFailed',
			'login_noMethodsAvailable',
			'login_methodsLoadFailed',
			'register_totpStartFailed',
			'register_noMethodsAvailable',
			'register_requiredFieldsMissing',
			'emailCode_errorInvalid',
			'error_invalid_request',
			'error_access_denied',
			'error_unauthorized_client',
			'error_unsupported_response_type',
			'error_invalid_scope',
			'error_server_error',
			'error_temporarily_unavailable',
			'error_login_required',
			'error_unknown',
			'device_errorInvalidCode',
			'device_errorVerifyFailed',
			'device_errorApproveFailed',
			'device_errorDenyFailed',
			'device_errorInvalidRedirect',
			'ciba_errorLoadPending',
			'ciba_errorGeneric',
			'ciba_errorApproveFailed',
			'ciba_errorDenyFailed',
			'callback_errorTitle',
			'callback_errorMissingCode',
			'login_extError_providerError_message',
			'login_extError_callbackFailed_message',
			'login_extError_default_message'
		] as const;

		for (const translation of [hi, bn, tr, sw, am, pl]) {
			for (const key of errorKeys) {
				expect(translation[key], key).not.toBe(en[key]);
			}
		}
	});

	it('keeps Passkey terminology recognizable in the six newly added locales', () => {
		for (const translation of [hi, bn, tr, sw, am, pl]) {
			expect(translation.login_signInWithPasskey.toLocaleLowerCase()).toContain('passkey');
		}
	});
});
