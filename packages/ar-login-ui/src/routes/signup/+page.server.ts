import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { fetchDiscoveryConfig, getDiscoveryRequestHeaders } from '../../lib/discovery-entry';

export const load: PageServerLoad = async (event) => {
	const discoveryHeaders = getDiscoveryRequestHeaders(event);
	const config = await fetchDiscoveryConfig(event.fetch, discoveryHeaders).catch(() => null);
	if (!config) {
		return {};
	}

	if (!config.single_tenant_mode && config.is_common_entry_host) {
		throw redirect(303, '/discover');
	}

	return {};
};
