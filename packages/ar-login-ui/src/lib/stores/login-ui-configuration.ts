import { getLocale, setLocale } from '$i18n/i18n-svelte';
import type { AuthenticationMethodsResponse } from '#lib/api/authentication-methods.js';
import { toDocumentDirection, toDocumentLanguage } from '#lib/i18n/locales.js';
import type { LoginUIStores } from './login-ui-context';
import { isValidImageUrl } from '#lib/utils/url-validation.js';

export function applyAuthenticationMethodsToLoginUI(
	authenticationMethods: AuthenticationMethodsResponse,
	stores: LoginUIStores
): void {
	if (!authenticationMethods.ui) return;

	const { brandingStore, languageStore, loginUIPageStore, themeStore } = stores;
	languageStore.setConfig(
		authenticationMethods.ui.supportedLocales,
		authenticationMethods.ui.defaultLocale,
		authenticationMethods.ui.primaryLocales,
		authenticationMethods.ui.showEnglishLanguageNames
	);
	if (!languageStore.isEnabled(getLocale())) {
		setLocale(languageStore.defaultLocale);
		if (typeof document !== 'undefined') {
			document.documentElement.lang = toDocumentLanguage(languageStore.defaultLocale);
			document.documentElement.dir = toDocumentDirection(languageStore.defaultLocale);
		}
	}
	themeStore.setTenantDefaults(
		authenticationMethods.ui.theme,
		authenticationMethods.ui.themeFixed === true
	);
	loginUIPageStore.setFromUIConfig(authenticationMethods.ui);
	brandingStore.set(
		authenticationMethods.ui.branding.brandName || '',
		authenticationMethods.ui.branding.logoUrl || null,
		authenticationMethods.ui.appearance?.darkImages?.logoUrl || null
	);

	if (typeof document === 'undefined') return;
	const faviconUrl = authenticationMethods.ui.branding.faviconUrl;
	if (faviconUrl && isValidImageUrl(faviconUrl)) {
		const faviconLink = document.querySelector<HTMLLinkElement>("link[rel='icon']");
		if (faviconLink) faviconLink.href = faviconUrl;
	}
}
