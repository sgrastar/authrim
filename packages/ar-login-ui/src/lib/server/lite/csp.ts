/**
 * The lite Login UI's Content Security Policy: nothing from outside, nothing inline that is not
 * listed by its hash. Every lite page carries its CSS (and, where a page needs one, a fixed
 * script) inline; their SHA-256 hashes are the only sources allowed.
 */

const encoder = new TextEncoder();
const hashCache = new Map<string, string>();

/** The CSP source for an inline element's exact text (`'sha256-…'`). */
export async function cspHashSource(text: string): Promise<string> {
	const cached = hashCache.get(text);
	if (cached) return cached;
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
	const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
	const source = `'sha256-${base64}'`;
	hashCache.set(text, source);
	return source;
}

export interface LiteCspInput {
	styleHashes: readonly string[];
	scriptHashes?: readonly string[];
	/** Where forms may post: `'self'` unless a relay posts to a verified destination. */
	formAction?: string;
}

export function buildLiteContentSecurityPolicy(input: LiteCspInput): string {
	const scripts = input.scriptHashes?.length ? input.scriptHashes.join(' ') : "'none'";
	return [
		"default-src 'none'",
		`style-src ${input.styleHashes.join(' ') || "'none'"}`,
		`script-src ${scripts}`,
		// The lite logo is inlined as a checked data: URI; nothing else is an image.
		'img-src data:',
		`form-action ${input.formAction ?? "'self'"}`,
		"base-uri 'none'",
		"object-src 'none'",
		"frame-ancestors 'none'",
		"connect-src 'none'"
	].join('; ');
}
