import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getAccountPageCanonicalRedirectUrl } from '$lib/server/account-canonical-url';

export const load: PageServerLoad = (event) => {
	const redirectUrl = getAccountPageCanonicalRedirectUrl(event);
	if (redirectUrl) {
		throw redirect(302, redirectUrl);
	}

	return {};
};
