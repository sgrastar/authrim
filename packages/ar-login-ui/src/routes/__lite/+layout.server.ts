import type { LayoutServerLoad } from './$types';
import { getCachedAuthenticationMethodsForRequest } from '../../hooks.server';
import { getPlatformEnv } from '#lib/server/platform-env.js';
import { liteMessages } from '#lib/server/lite/messages.js';
import { environmentBannerData } from '#lib/environment-banner.js';
import { checkLiteLogoDataUri } from '@authrim/ar-lib-core/utils/lite-logo';

/** The frame every lite page shares: the tenant's name or logo, and the page language. */
export const load: LayoutServerLoad = async (event) => {
	const methods =
		event.locals.authenticationMethods ??
		(await getCachedAuthenticationMethodsForRequest(event, getPlatformEnv(event)).catch(
			() => null
		));
	// The answer this layout had to read itself (the plain sign-in entry skips the page bootstrap):
	// the response headers (noindex) are set after the load, from the same locals.
	if (methods && !event.locals.authenticationMethods) {
		event.locals.authenticationMethods = methods;
	}
	const { LL } = await liteMessages(event.locals.locale);
	const logo = methods?.ui.lite?.logo ?? null;
	return {
		// The root layout draws it (its own load has no answer when the bootstrap was skipped).
		environmentBanner: environmentBannerData(methods, event.locals.locale),
		brandName: methods?.ui.branding?.brandName || LL.app_title(),
		// Checked again before it is drawn: only a still PNG or WebP data: URI is inlined.
		logo: logo && checkLiteLogoDataUri(logo).ok ? logo : null,
		// For the lite error page (+error.svelte), which has no load of its own.
		errorText: {
			title: LL.error_title(),
			message: LL.error_temporarily_unavailable(),
			back: LL.common_backToLogin()
		}
	};
};
