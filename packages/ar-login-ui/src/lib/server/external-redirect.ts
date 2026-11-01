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
