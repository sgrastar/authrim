import {
	LOGIN_UI_LANGUAGE_METADATA,
	LOGIN_UI_LOCALES as SHARED_LOGIN_UI_LOCALES,
	isLoginUILocale as isSharedLoginUILocale,
	type LoginUILocale
} from '@authrim/ar-lib-core/types/login-ui-languages';

export type { LoginUILocale };

export const LOGIN_UI_LOCALES = SHARED_LOGIN_UI_LOCALES;

export const LOGIN_UI_LOCALE_LABELS = Object.fromEntries(
	LOGIN_UI_LANGUAGE_METADATA.map(({ localeCode, nativeName }) => [localeCode, nativeName])
) as Record<LoginUILocale, string>;

const RTL_LOGIN_UI_LOCALES = new Set<LoginUILocale>(['ar']);

export function isLoginUILocale(value: string): value is LoginUILocale {
	return isSharedLoginUILocale(value);
}

export function normalizeLoginUILocale(value: string | null | undefined): LoginUILocale | null {
	if (!value) return null;
	const normalized = value.trim();
	if (isLoginUILocale(normalized)) return normalized;

	const lower = normalized.toLowerCase();
	if (
		lower === 'zh-cn' ||
		lower === 'zh-hans' ||
		lower.startsWith('zh-hans-') ||
		lower === 'zh-sg'
	) {
		return 'zh-CN';
	}
	if (
		lower === 'zh-tw' ||
		lower === 'zh-hant' ||
		lower.startsWith('zh-hant-') ||
		lower === 'zh-hk' ||
		lower === 'zh-mo'
	) {
		return 'zh-TW';
	}
	if (lower === 'zh') return 'zh-CN';

	const base = lower.split('-')[0];
	return base && isLoginUILocale(base) ? base : null;
}

export function toDocumentLanguage(locale: LoginUILocale): string {
	return locale;
}

export function toDocumentDirection(locale: LoginUILocale): 'ltr' | 'rtl' {
	return RTL_LOGIN_UI_LOCALES.has(locale) ? 'rtl' : 'ltr';
}
