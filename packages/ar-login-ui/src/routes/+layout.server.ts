import type { LayoutServerLoad } from './$types';
import { fetchDiscoveryConfig, getDiscoveryRequestHeaders } from '../lib/discovery-entry';
import { normalizeLoginUILocale } from '$lib/i18n/locales';

export const load: LayoutServerLoad = async (event) => {
	// Get language preference from cookie
	const requestedLanguage = normalizeLoginUILocale(event.url?.searchParams.get('lang'));
	const preferredLanguage =
		requestedLanguage ??
		normalizeLoginUILocale(event.cookies.get('preferredLanguage')) ??
		event.locals.locale ??
		'en';
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
