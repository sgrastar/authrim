import {
	LOGIN_UI_LOCALES,
	isLoginUILocale,
	normalizeLoginUILocale,
	type LoginUILocale
} from './locales';

export interface LoginUILanguageConfig {
	supportedLocales: LoginUILocale[];
	defaultLocale: LoginUILocale;
}

export function normalizeLoginUILanguageConfig(
	supportedLocales: readonly string[] | null | undefined,
	defaultLocale: string | null | undefined
): LoginUILanguageConfig {
	const supported = (supportedLocales ?? [])
		.filter(isLoginUILocale)
		.filter((locale, index, locales) => locales.indexOf(locale) === index);
	const safeSupported = supported.length > 0 ? supported : [...LOGIN_UI_LOCALES];
	const normalizedDefault = normalizeLoginUILocale(defaultLocale);

	return {
		supportedLocales: safeSupported,
		defaultLocale:
			normalizedDefault && safeSupported.includes(normalizedDefault)
				? normalizedDefault
				: (safeSupported[0] ?? 'en')
	};
}

export function resolveEnabledLoginUILocale(
	value: string | null | undefined,
	config: LoginUILanguageConfig
): LoginUILocale | null {
	const locale = normalizeLoginUILocale(value);
	return locale && config.supportedLocales.includes(locale) ? locale : null;
}

export function getLoginUILanguageConfig(
	ui:
		| {
				supportedLocales?: readonly string[];
				defaultLocale?: string;
		  }
		| null
		| undefined
): LoginUILanguageConfig {
	return normalizeLoginUILanguageConfig(ui?.supportedLocales, ui?.defaultLocale);
}
