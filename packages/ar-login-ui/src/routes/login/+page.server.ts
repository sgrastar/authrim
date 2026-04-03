import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

interface DiscoveryConfigResponse {
	config: {
		mode: 'tenant_only' | 'discovery_optional' | 'discovery_required';
		redirect_default_login_to_discovery: boolean;
	};
	single_tenant_mode: boolean;
	is_common_entry_host: boolean;
}

export const load: PageServerLoad = async (event) => {
	const challengeId = event.url.searchParams.get('challenge_id');
	if (challengeId) {
		return {};
	}

	const response = await event.fetch('/api/auth/discovery');
	if (!response.ok) {
		return {};
	}

	const config = (await response.json()) as DiscoveryConfigResponse;
	const shouldRedirect =
		!config.single_tenant_mode &&
		config.is_common_entry_host &&
		config.config.mode !== 'tenant_only' &&
		(config.config.mode === 'discovery_required' ||
			config.config.redirect_default_login_to_discovery);

	if (shouldRedirect) {
		throw redirect(303, '/discover');
	}

	return {};
};
