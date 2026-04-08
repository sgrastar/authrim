import { redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { fetchDiscoveryConfig, getDiscoveryRequestHeaders } from '../lib/discovery-entry';

export const load: PageServerLoad = async (event) => {
	const challengeId = event.url.searchParams.get('challenge_id');
	if (challengeId) {
		return {};
	}

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

export const actions: Actions = {
	resolve: async () => {
		throw redirect(303, '/discover');
	}
};
