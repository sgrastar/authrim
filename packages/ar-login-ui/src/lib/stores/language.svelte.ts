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
		isEnabled(locale: LoginUILocale) {
			return config.supportedLocales.includes(locale);
		},
		setConfig(supportedLocales: readonly string[] | undefined, defaultLocale: string | undefined) {
			config = getLoginUILanguageConfig({ supportedLocales, defaultLocale });
		}
	};
}
