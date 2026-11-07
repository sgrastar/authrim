/**
 * Leaving the lite Login UI for another site after a lite form was posted (an external sign-in
 * start, the return to the application, a SAML POST binding). A 303 to another origin after a
 * form post runs into `form-action`, so the action answers a small page instead:
 * - GET: a meta refresh to the destination, with a link;
 * - POST: a form of the fields the backend gave, sent by a fixed script (allowed by its hash),
 *   with a button for a browser without scripts. That page's `form-action` names only the
 *   destination's origin.
 * The destination is decided and checked by the server before it reaches here; this still
 * refuses anything that is not an absolute http(s) URL.
 */

export type LiteRelayTarget =
	| { method: 'get'; url: string }
	| { method: 'post'; action: string; fields: ReadonlyArray<readonly [string, string]> };

/** The fixed auto-submit script of a POST relay (its exact text is hashed into the CSP). */
export const LITE_RELAY_SUBMIT_SCRIPT = 'document.forms[0].submit();';

export function isRelayUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			(url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
		);
	} catch {
		return false;
	}
}

/** The origin a POST relay may send its form to, or null when the target is not acceptable. */
export function relayFormActionOrigin(target: LiteRelayTarget): string | null {
	if (target.method !== 'post' || !isRelayUrl(target.action)) return null;
	return new URL(target.action).origin;
}
