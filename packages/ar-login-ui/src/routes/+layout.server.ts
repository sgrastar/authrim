import type { LayoutServerLoad } from './$types';
import { fetchDiscoveryConfig, getDiscoveryRequestHeaders } from '../lib/discovery-entry';
import { REMEMBERED_TENANT_COOKIE, readRememberedTenant } from '../lib/discovery-session';

export const load: LayoutServerLoad = async (event) => {
	// Get language preference from cookie
	const preferredLanguage = event.cookies.get('preferredLanguage') || 'en';
	const rememberedTenant = readRememberedTenant(event.cookies.get(REMEMBERED_TENANT_COOKIE));
	const discoveryHeaders = getDiscoveryRequestHeaders(event);
	const discoveryConfig = await fetchDiscoveryConfig(event.fetch, discoveryHeaders).catch(() => null);
	const shouldLoadTenantBranding =
		rememberedTenant !== null ||
		(discoveryConfig ? discoveryConfig.single_tenant_mode || !discoveryConfig.is_common_entry_host : true);

	return {
		preferredLanguage,
		shouldLoadTenantBranding
	};
};
