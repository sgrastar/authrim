export const LOGIN_UI_LOCALES = [
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
] as const;

export type LoginUILocale = (typeof LOGIN_UI_LOCALES)[number];

export const LOGIN_UI_LOCALE_LABELS: Record<LoginUILocale, string> = {
	en: 'English',
	ja: '日本語',
	'zh-CN': '简体中文',
	'zh-TW': '繁體中文',
	es: 'Español',
	pt: 'Português',
	fr: 'Français',
	de: 'Deutsch',
	ko: '한국어',
	ru: 'Русский',
	id: 'Bahasa Indonesia',
	ar: 'العربية',
	it: 'Italiano',
	th: 'ไทย',
	vi: 'Tiếng Việt',
	hi: 'हिन्दी',
	bn: 'বাংলা',
	tr: 'Türkçe',
	sw: 'Kiswahili',
	am: 'አማርኛ',
	pl: 'Polski'
};

const RTL_LOGIN_UI_LOCALES = new Set<LoginUILocale>(['ar']);

export function isLoginUILocale(value: string): value is LoginUILocale {
	return LOGIN_UI_LOCALES.includes(value as LoginUILocale);
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
