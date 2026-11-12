/**
 * `/verify-email-code` in lite mode. The SPA comes here by its own navigation, its state in
 * sessionStorage; the lite UI asks for the code on the sign-in page itself (its transaction holds
 * the code sent). A request that lands here (a bookmark, an SPA page opened before the switch) goes
 * to the sign-in page for the same request: only the parameters that page reads go along (never
 * the address the SPA put in the query).
 */
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

const KEPT = [
	'challenge_id',
	'saml_request_id',
	'saml_login_nonce',
	'saml_sp_entity_id',
	'return_to'
] as const;

export const load: PageServerLoad = (event) => {
	const params = new URLSearchParams();
	for (const name of KEPT) {
		const value = event.url.searchParams.get(name);
		if (value) params.set(name, value);
	}
	const search = params.toString();
	redirect(303, `/login${search ? `?${search}` : ''}`);
};
