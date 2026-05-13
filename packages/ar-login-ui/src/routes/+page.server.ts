import { redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	fetchDiscoveryConfig,
	getDiscoveryRequestHeaders,
	verifyLoginChallengeForCurrentTenant
} from '../lib/discovery-entry';

export const load: PageServerLoad = async (event) => {
	const challengeId = event.url.searchParams.get('challenge_id');
	const discoveryHeaders = getDiscoveryRequestHeaders(event);

	if (challengeId) {
		const challengeBelongsToCurrentTenant = await verifyLoginChallengeForCurrentTenant(
			event.fetch,
			challengeId,
			discoveryHeaders
		).catch(() => false);
		if (challengeBelongsToCurrentTenant) {
			return {};
		}
	}

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
