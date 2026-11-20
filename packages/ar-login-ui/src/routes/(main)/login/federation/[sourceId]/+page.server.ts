import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDiscoveryRequestHeaders } from '#lib/discovery-entry.js';

const SOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
/** What the sign-in screen already knows, handed on to the SAML start unchanged (bounded). */
export const FEDERATION_FORWARDED_PARAMS = [
	'return_url',
	'purpose',
	'invite_token',
	'runtime_interaction_id',
	'authorization_challenge_id',
	'human_verification_response',
	'cf_turnstile_response'
] as const;
const MAX_FORWARDED_VALUE_LENGTH = 2048;
const INITIAL_PAGE_SIZE = 20;

interface PickerResponse {
	sourceId: string;
	displayName: string;
	items: Array<{ entityId: string; displayName: string; logoUrl: string | null }>;
	truncated: boolean;
}

export const load: PageServerLoad = async (event) => {
	const sourceId = event.params.sourceId;
	if (!SOURCE_ID_PATTERN.test(sourceId)) throw error(404, 'Not found');

	const forwarded: Record<string, string> = {};
	for (const name of FEDERATION_FORWARDED_PARAMS) {
		const value = event.url.searchParams.get(name);
		if (value) forwarded[name] = value.slice(0, MAX_FORWARDED_VALUE_LENGTH);
	}

	const headers = getDiscoveryRequestHeaders(event);
	let response: Response;
	try {
		response = await event.fetch(
			`/saml/sp/federation/${encodeURIComponent(sourceId)}/idps?limit=${INITIAL_PAGE_SIZE}`,
			headers ? { headers } : undefined
		);
	} catch {
		return { sourceId, displayName: '', items: [], truncated: false, loadFailed: true, forwarded };
	}
	// A source that is not offered here (unknown, expired, or sending users to a Discovery
	// Service) is not a page.
	if (response.status === 404) throw error(404, 'Not found');
	if (!response.ok) {
		return { sourceId, displayName: '', items: [], truncated: false, loadFailed: true, forwarded };
	}
	const body = (await response.json()) as PickerResponse;
	return {
		sourceId,
		displayName: body.displayName,
		items: body.items,
		truncated: body.truncated,
		loadFailed: false,
		forwarded
	};
};
