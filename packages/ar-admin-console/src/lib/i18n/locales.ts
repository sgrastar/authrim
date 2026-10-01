/**
 * Locale list shared by the server hooks and the client. Arabic is right-to-left; everything
 * direction-sensitive in the UI keys off `dir` on <html>, never off the locale directly.
 */
export const SUPPORTED_LOCALES = ['ja', 'en', 'de', 'ar'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

export const LOCALE_LABELS: Record<Locale, { short: string; native: string }> = {
	ja: { short: 'JA', native: '日本語' },
	en: { short: 'EN', native: 'English' },
	de: { short: 'DE', native: 'Deutsch' },
	ar: { short: 'AR', native: 'العربية' }
};

const RTL_LOCALES: ReadonlySet<Locale> = new Set<Locale>(['ar']);

export function isSupportedLocale(value: unknown): value is Locale {
	return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function resolveLocale(value: unknown): Locale {
	return isSupportedLocale(value) ? value : DEFAULT_LOCALE;
}

export function localeDir(locale: Locale): 'ltr' | 'rtl' {
	return RTL_LOCALES.has(locale) ? 'rtl' : 'ltr';
}

/** Cookie read by the server hook so the first HTML response already has lang/dir. */
export const LOCALE_COOKIE = 'preferredLanguage';
