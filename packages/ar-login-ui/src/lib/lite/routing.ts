/**
 * Which pages the lite Login UI serves, and where they live.
 *
 * The lite pages are under `routes/__lite/`, outside the `(main)` group, so they load none of the
 * normal Login UI's styles, stores or scripts. A request reaches them only through `reroute`
 * (src/hooks.ts): a direct request for `/__lite/...` is refused (lite-guard.ts).
 *
 * In scope (plan): sign-in, code entry, consent, error, sign-up (with invitations), account,
 * re-authentication, the external sign-in callback, signed out, and `/`. Not in scope: `/device`,
 * `/ciba` (the normal UI), `/discover`, and every path the Login UI proxies to the backends.
 */

/** The internal prefix of the lite routes; never a public path. */
export const LITE_ROUTE_PREFIX = '/__lite';

/** A URL `reroute` fetches; `handleFetch` answers it with the request's lite mode. */
export const LITE_MODE_PROBE_URL = 'https://authrim-lite-mode.invalid/mode';

/** The page shown while the tenant's lite policy cannot be read (503). */
export const LITE_UNAVAILABLE_PATH = `${LITE_ROUTE_PREFIX}/unavailable`;

const LITE_PAGE_PATHS: ReadonlyMap<string, string> = new Map([
	['/', '/home'],
	['/login', '/login'],
	['/verify-email-code', '/verify-email-code'],
	['/consent', '/consent'],
	['/error', '/error'],
	['/signup', '/signup'],
	['/invite', '/invite'],
	['/reauth', '/reauth'],
	['/callback', '/callback'],
	['/logged-out', '/logged-out'],
	['/logout-complete', '/logout-complete'],
	['/account', '/account']
]);

export type LiteModeAnswer = 'off' | 'always' | 'unknown';

export function isLiteModeAnswer(value: unknown): value is LiteModeAnswer {
	return value === 'off' || value === 'always' || value === 'unknown';
}

/**
 * A path as SvelteKit matches it to a route: decoded the way SvelteKit decodes it (`%25` stays),
 * without a trailing slash (SvelteKit serves `/login/` as `/login`). Every lite decision is made
 * on this form, so another spelling of the same page cannot be routed differently. A path that
 * cannot be decoded is returned as it is (SvelteKit refuses it).
 */
export function normalizeRoutePath(pathname: string): string {
	let decoded: string;
	try {
		decoded = pathname.split('%25').map(decodeURI).join('%25');
	} catch {
		return pathname;
	}
	return decoded.length > 1 ? decoded.replace(/\/+$/u, '') || '/' : decoded;
}

/**
 * The lite route a public path is served by, or null when the path is not a lite page (it stays
 * on the normal Login UI or the proxy).
 */
export function liteRouteForPath(pathname: string): string | null {
	const path = normalizeRoutePath(pathname);
	const page = LITE_PAGE_PATHS.get(path);
	if (page) return `${LITE_ROUTE_PREFIX}${page}`;
	if (path.startsWith('/account/')) return `${LITE_ROUTE_PREFIX}${path}`;
	return null;
}

/** Whether a public path names the internal lite routes (never served directly). */
export function isInternalLitePath(pathname: string): boolean {
	const path = normalizeRoutePath(pathname).toLowerCase();
	return path === LITE_ROUTE_PREFIX || path.startsWith(`${LITE_ROUTE_PREFIX}/`);
}
