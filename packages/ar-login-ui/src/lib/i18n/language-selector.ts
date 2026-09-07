import {
	LOGIN_UI_LANGUAGE_GROUPING_THRESHOLD,
	getLoginUILanguageDisplayName,
	resolveEffectivePrimaryLoginUILocales,
	sortLoginUILocalesByEnglishName,
	type LoginUILocale
} from '@authrim/ar-lib-core/types/login-ui-languages';

export interface LoginUILanguageSelectorOption {
	locale: LoginUILocale;
	label: string;
}

export interface LoginUILanguageSelectorModel {
	grouped: boolean;
	flatOptions: LoginUILanguageSelectorOption[];
	mainOptions: LoginUILanguageSelectorOption[];
	allLanguageOptions: LoginUILanguageSelectorOption[];
	allLanguagesLabel: string;
}

export function buildLoginUILanguageSelectorModel(
	enabledLocales: readonly LoginUILocale[],
	configuredPrimaryLocales: readonly LoginUILocale[],
	showEnglishLanguageNames: boolean,
	currentLocale: LoginUILocale
): LoginUILanguageSelectorModel {
	const sortedEnabled = sortLoginUILocalesByEnglishName(enabledLocales);
	const toOption = (locale: LoginUILocale): LoginUILanguageSelectorOption => ({
		locale,
		label: getLoginUILanguageDisplayName(locale, showEnglishLanguageNames)
	});

	if (sortedEnabled.length < LOGIN_UI_LANGUAGE_GROUPING_THRESHOLD) {
		return {
			grouped: false,
			flatOptions: sortedEnabled.map(toOption),
			mainOptions: [],
			allLanguageOptions: [],
			allLanguagesLabel: 'All languages'
		};
	}

	const primaryLocales = resolveEffectivePrimaryLoginUILocales(sortedEnabled, [
		...configuredPrimaryLocales
	]);
	const mainLocales = sortedEnabled.includes(currentLocale)
		? [currentLocale, ...primaryLocales.filter((locale) => locale !== currentLocale)]
		: primaryLocales;

	return {
		grouped: true,
		flatOptions: [],
		mainOptions: mainLocales.map(toOption),
		allLanguageOptions: sortedEnabled.map(toOption),
		allLanguagesLabel: 'All languages'
	};
}
