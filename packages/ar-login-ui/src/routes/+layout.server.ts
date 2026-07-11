import type { LayoutServerLoad } from './$types';
import { fetchDiscoveryConfig, getDiscoveryRequestHeaders } from '../lib/discovery-entry';

export const load: LayoutServerLoad = async (event) => {
	// Get language preference from cookie
	const preferredLanguage = event.cookies.get('preferredLanguage') || 'en';
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
