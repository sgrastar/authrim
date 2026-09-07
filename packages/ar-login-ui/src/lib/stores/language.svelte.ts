import { getLoginUILanguageConfig, type LoginUILanguageConfig } from '$lib/i18n/config';
import type { LoginUILocale } from '$lib/i18n/locales';

export function createLanguageStore() {
	let config = $state<LoginUILanguageConfig>(getLoginUILanguageConfig(null));

	return {
		get supportedLocales() {
			return config.supportedLocales;
		},
		get defaultLocale() {
			return config.defaultLocale;
		},
		get primaryLocales() {
			return config.primaryLocales;
		},
		get showEnglishLanguageNames() {
			return config.showEnglishLanguageNames;
		},
		isEnabled(locale: LoginUILocale) {
			return config.supportedLocales.includes(locale);
		},
		setConfig(
			supportedLocales: readonly string[] | undefined,
			defaultLocale: string | undefined,
			primaryLocales?: readonly string[],
			showEnglishLanguageNames?: boolean
		) {
			config = getLoginUILanguageConfig({
				supportedLocales,
				defaultLocale,
				primaryLocales,
				showEnglishLanguageNames
			});
		}
	};
}
