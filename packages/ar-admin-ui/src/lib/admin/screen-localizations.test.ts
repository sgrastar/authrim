import { describe, expect, it } from 'vitest';
import {
	SCREEN_LOCALIZATION_LANGUAGES,
	localizeDefaultScreenText,
	mergeLocalizedDefaultScreenText
} from './screen-localizations';

describe('screen localizations', () => {
	it('uses the same twenty-one-language contract as Login UI', () => {
		expect(SCREEN_LOCALIZATION_LANGUAGES).toEqual([
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
		['ar', 'تسجيل الدخول باستخدام مفتاح المرور'],
		['it', 'Accedi con una passkey'],
		['th', 'เข้าสู่ระบบด้วย Passkey'],
		['vi', 'Đăng nhập bằng Passkey'],
		['hi', 'Passkey से साइन इन करें'],
		['bn', 'Passkey দিয়ে সাইন ইন করুন'],
		['tr', 'Passkey ile giriş yap'],
		['sw', 'Ingia na Passkey'],
		['am', 'በPasskey ይግቡ'],
		['pl', 'Zaloguj się za pomocą Passkey']
	] as const)('localizes built-in screen copy in %s', (language, expected) => {
		expect(localizeDefaultScreenText('Sign in with Passkey', language)).toBe(expected);
	});

	it('updates recognized preset copy while preserving tenant-authored copy', () => {
		expect(
			mergeLocalizedDefaultScreenText('Passkeyでサインイン', 'Sign in with Passkey', 'ar')
		).toBe('تسجيل الدخول باستخدام مفتاح المرور');
		expect(
			mergeLocalizedDefaultScreenText('Custom sign-in copy', 'Sign in with Passkey', 'ar')
		).toBe('Custom sign-in copy');
	});
});
