import { redirect } from '@sveltejs/kit';

/**
 * Redirects to an absolute URL that can be another origin: the tenant's own login host, the
 * common discovery host, or this app's public host when the Worker sees an internal one.
 *
 * SvelteKit 3 refuses an external redirect unless it is opted into. Callers pass URLs built from
 * backend responses, configuration or the request's public URL, never a raw request parameter.
 * `javascript:` and `data:` locations stay refused by SvelteKit itself.
 */
export function redirectExternal(status: 301 | 302 | 303 | 307 | 308, location: string): never {
	redirect(status, location, { external: true });
}

/**
 * The redirect for a signed-in person who opens the sign-in page, to the destination the server
 * resolved: a path of this site as it is; an absolute http(s) URL (a trusted origin the tenant
 * configured) as an external redirect. Anything else is the home page.
 */
export function redirectSignedIn(destination: string): never {
	if (/^\/(?![/\\])/u.test(destination)) redirect(303, destination);
	let absolute: string | null = null;
	try {
		const url = new URL(destination);
		if (url.protocol === 'https:' || url.protocol === 'http:') absolute = url.toString();
	} catch {
		// Not a URL: the home page below.
	}
	if (absolute) redirectExternal(303, absolute);
	redirect(303, '/');
}
