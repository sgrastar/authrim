import { describe, expect, it } from 'vitest';
import {
	SCREEN_LOCALIZATION_LANGUAGES,
	localizeDefaultScreenText,
	mergeLocalizedDefaultScreenText
} from './screen-localizations';

describe('screen localizations', () => {
	it('uses the same fifteen-language contract as Login UI', () => {
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
			'vi'
		]);
	});

	it.each([
		['ar', 'تسجيل الدخول باستخدام مفتاح المرور'],
		['it', 'Accedi con una passkey'],
		['th', 'เข้าสู่ระบบด้วย Passkey'],
		['vi', 'Đăng nhập bằng Passkey']
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
