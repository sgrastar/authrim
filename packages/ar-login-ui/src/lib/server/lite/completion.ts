/**
 * Where a completed lite sign-in goes: the Flow's continuation (the `/authorize` confirmation, or
 * the SAML SSO endpoint), else the transaction's checked return target, else the sign-in's own
 * destination, else the home page. Only
 * a destination on the public origin is used; the result is an absolute URL for the relay page
 * (a 303 out of a form post, then on to the application, would run into `form-action`).
 */
import { runtimeSamlContinuationPath } from '#lib/authrim/flow-runtime-steps.js';

function sameOriginUrl(value: unknown, publicOrigin: string): string | null {
	if (typeof value !== 'string' || value.length === 0) return null;
	// eslint-disable-next-line no-control-regex -- a control character is what it refuses
	if (/[\\\u0000-\u001f\u007f]/u.test(value) || value.startsWith('//')) return null;
	try {
		const url = new URL(value, publicOrigin);
		// What the relay page draws (isRelayUrl): http(s) only, no user info. A `blob:` URL has
		// the same origin as its creator, so the origin alone is not enough.
		return url.origin === publicOrigin &&
			(url.protocol === 'https:' || url.protocol === 'http:') &&
			!url.username &&
			!url.password
			? url.toString()
			: null;
	} catch {
		return null;
	}
}

export function liteCompletionDestination(
	output: Record<string, unknown> | null,
	bound: {
		publicOrigin: string;
		returnTo: string | null;
		/** The sign-in's own destination (the direct session's `redirect_url`), checked too. */
		fallback?: string | null;
		samlRequestId?: string | null;
		samlSpEntityId?: string | null;
	}
): string {
	const continuation =
		output && typeof output.protocol_continuation === 'object' && output.protocol_continuation
			? (output.protocol_continuation as Record<string, unknown>)
			: undefined;
	return (
		sameOriginUrl(output?.redirect_url, bound.publicOrigin) ??
		sameOriginUrl(
			runtimeSamlContinuationPath(continuation, {
				samlRequestId: bound.samlRequestId ?? null,
				samlSpEntityId: bound.samlSpEntityId ?? null
			}),
			bound.publicOrigin
		) ??
		sameOriginUrl(bound.returnTo, bound.publicOrigin) ??
		sameOriginUrl(bound.fallback, bound.publicOrigin) ??
		new URL('/', bound.publicOrigin).toString()
	);
}
