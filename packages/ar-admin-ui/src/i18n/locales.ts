import type { Locales } from './i18n-types';

export const DEFAULT_LOCALE: Locales = 'en';

export const SUPPORTED_LOCALES = ['en', 'ja'] as const satisfies readonly Locales[];

export const LOCALE_LABELS: Record<Locales, { name: string; nativeName: string }> = {
	en: { name: 'English', nativeName: 'English' },
	ja: { name: 'Japanese', nativeName: '日本語' }
};

export function isSupportedLocale(value: unknown): value is Locales {
	return typeof value === 'string' && SUPPORTED_LOCALES.includes(value as Locales);
}

export function resolveLocale(value: unknown): Locales {
	return isSupportedLocale(value) ? value : DEFAULT_LOCALE;
}
