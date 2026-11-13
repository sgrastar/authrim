import type { LayoutServerLoad } from './$types';
import { environmentBannerData } from '#lib/environment-banner.js';

/**
 * The platform's environment banner, from the request's authentication methods answer. Without
 * one (the common entry host) there is no banner, and no extra fetch is made for it.
 */
export const load: LayoutServerLoad = ({ locals }) => ({
	environmentBanner: environmentBannerData(
		locals.authenticationMethods ?? locals.peekedAuthenticationMethods,
		locals.locale
	)
});
