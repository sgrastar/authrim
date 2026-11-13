import type { AuthenticationMethodsResponse } from '#lib/api/authentication-methods.js';

/**
 * What a page needs of the platform's environment banner: the raw text and its languages (the
 * band picks the text of the language the page is in, and follows a language switch in the
 * browser), the language the server rendered in, and the noindex request.
 */
export interface EnvironmentBannerData {
	text: string;
	textLocalizations: Record<string, string>;
	noindex: boolean;
	/** The language the server rendered the page in. */
	locale?: string;
}

/**
 * From the authentication methods answer. Null when the answer carries no banner (or there is no
 * answer, as on the common entry host).
 */
export function environmentBannerData(
	methods: Pick<AuthenticationMethodsResponse, 'environmentBanner'> | null | undefined,
	locale: string | undefined
): EnvironmentBannerData | null {
	const banner = methods?.environmentBanner;
	if (!banner) return null;
	return {
		text: banner.text ?? '',
		textLocalizations: banner.textLocalizations ?? {},
		noindex: banner.noindex === true,
		locale
	};
}
