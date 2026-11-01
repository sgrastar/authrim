import { redirectExternal } from '$lib/server/external-redirect';
import type { PageServerLoad } from './$types';
import { getAccountPageCanonicalRedirectUrl } from '$lib/server/account-canonical-url';
import { loadAccountPageInitialData } from '$lib/server/account-page-initial-data';

export const load: PageServerLoad = async (event) => {
	const redirectUrl = getAccountPageCanonicalRedirectUrl(event);
	if (redirectUrl) {
		throw redirectExternal(302, redirectUrl);
	}

	event.setHeaders({ 'Cache-Control': 'private, no-store' });
	return {
		accountPageInitial:
			event.locals.accountPageInitial ??
			(await loadAccountPageInitialData(event.fetch, event.locals.locale))
	};
};
