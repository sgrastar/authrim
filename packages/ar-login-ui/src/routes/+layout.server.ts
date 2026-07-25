import type { LayoutServerLoad } from './$types';
import { fetchDiscoveryConfig, getDiscoveryRequestHeaders } from '../lib/discovery-entry';
import { getLoginUILanguageConfig, resolveEnabledLoginUILocale } from '$lib/i18n/config';

export const load: LayoutServerLoad = async (event) => {
	// Get language preference from cookie
	const languageConfig = getLoginUILanguageConfig(event.locals.authenticationMethods?.ui);
	const requestedLanguage = resolveEnabledLoginUILocale(
		event.url?.searchParams.get('lang'),
		languageConfig
	);
	const preferredLanguage =
		requestedLanguage ??
		resolveEnabledLoginUILocale(event.cookies.get('preferredLanguage'), languageConfig) ??
		resolveEnabledLoginUILocale(event.locals.locale, languageConfig) ??
		languageConfig.defaultLocale;
	if (requestedLanguage) {
		event.cookies.set('preferredLanguage', preferredLanguage, {
			path: '/',
			maxAge: 60 * 60 * 24 * 365,
			httpOnly: false,
			sameSite: 'lax',
			secure: event.url?.protocol === 'https:'
		});
	}
	const emailVerificationProtocolEnabled = event.locals.emailVerificationProtocolEnabled === true;
	if (
		event.route.id === '/login' ||
		event.route.id === '/account' ||
		event.route.id?.startsWith('/account/')
	) {
		return {
			preferredLanguage,
			shouldLoadTenantBranding: true,
			emailVerificationProtocolEnabled,
			authenticationMethods: event.locals.authenticationMethods ?? null
		};
	}

	const discoveryHeaders = getDiscoveryRequestHeaders(event);
	const discoveryConfig = await fetchDiscoveryConfig(event.fetch, discoveryHeaders).catch(
		() => null
	);
	const shouldLoadTenantBranding = discoveryConfig
		? discoveryConfig.single_tenant_mode || !discoveryConfig.is_common_entry_host
		: true;

	return {
		preferredLanguage,
		shouldLoadTenantBranding,
		emailVerificationProtocolEnabled,
		authenticationMethods: shouldLoadTenantBranding
			? (event.locals.authenticationMethods ?? null)
			: null
	};
};
