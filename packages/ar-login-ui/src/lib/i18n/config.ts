import {
	LOGIN_UI_LOCALES,
	isLoginUILocale,
	normalizeLoginUILocale,
	type LoginUILocale
} from './locales';
import {
	parseConfiguredPrimaryLoginUILocales,
	resolveEffectivePrimaryLoginUILocales
} from '@authrim/ar-lib-core/types/login-ui-languages';

export interface LoginUILanguageConfig {
	supportedLocales: LoginUILocale[];
	defaultLocale: LoginUILocale;
	primaryLocales: LoginUILocale[];
	showEnglishLanguageNames: boolean;
}

export function normalizeLoginUILanguageConfig(
	supportedLocales: readonly string[] | null | undefined,
	defaultLocale: string | null | undefined,
	primaryLocales?: readonly string[] | null,
	showEnglishLanguageNames?: boolean | null
): LoginUILanguageConfig {
	const supported = (supportedLocales ?? [])
		.filter(isLoginUILocale)
		.filter((locale, index, locales) => locales.indexOf(locale) === index);
	const safeSupported = supported.length > 0 ? supported : [...LOGIN_UI_LOCALES];
	const normalizedDefault = normalizeLoginUILocale(defaultLocale);
	const configuredPrimaryLocales = parseConfiguredPrimaryLoginUILocales(primaryLocales);

	return {
		supportedLocales: safeSupported,
		defaultLocale:
			normalizedDefault && safeSupported.includes(normalizedDefault)
				? normalizedDefault
				: safeSupported.includes('en')
					? 'en'
					: (safeSupported[0] ?? 'en'),
		primaryLocales: resolveEffectivePrimaryLoginUILocales(safeSupported, configuredPrimaryLocales),
		showEnglishLanguageNames: showEnglishLanguageNames === true
	};
}

export function resolveEnabledLoginUILocale(
	value: string | null | undefined,
	config: LoginUILanguageConfig
): LoginUILocale | null {
	const locale = normalizeLoginUILocale(value);
	return locale && config.supportedLocales.includes(locale) ? locale : null;
}

export function resolveEnabledLoginUILocalePreferenceList(
	value: string | null | undefined,
	config: LoginUILanguageConfig
): LoginUILocale | null {
	if (!value) return null;

	for (const candidate of value.trim().split(/\s+/u).slice(0, 32)) {
		const locale = resolveEnabledLoginUILocale(candidate, config);
		if (locale) return locale;
	}

	return null;
}

export function getLoginUILanguageConfig(
	ui:
		| {
				supportedLocales?: readonly string[];
				defaultLocale?: string;
				primaryLocales?: readonly string[];
				showEnglishLanguageNames?: boolean;
		  }
		| null
		| undefined
): LoginUILanguageConfig {
	return normalizeLoginUILanguageConfig(
		ui?.supportedLocales,
		ui?.defaultLocale,
		ui?.primaryLocales,
		ui?.showEnglishLanguageNames
	);
}
