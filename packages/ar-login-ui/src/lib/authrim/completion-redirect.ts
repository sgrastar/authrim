import { isValidRedirectUrl } from '$lib/utils/url-validation';

/**
 * Where the browser goes when a Flow is complete: the continuation the server gave (the
 * authorization request, for an application) if it is a place the page may go, otherwise the
 * fallback (the tenant's usual destination).
 */
export function completionRedirect(
	output: { redirect_url?: string } | null | undefined,
	fallback: string
): string {
	return output?.redirect_url && isValidRedirectUrl(output.redirect_url)
		? output.redirect_url
		: fallback;
}
