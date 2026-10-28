/**
 * URL layout of the mock app: the console's own paths under a prefix (`/admin/users/all` is
 * `/mock/users/all`), so the navigation data stays the one source of truth for what exists.
 */
export const MOCK_BASE = '/mock';

/** The console path a mock URL stands for. Anything outside the mock app is the overview. */
export function mockToConsolePath(pathname: string): string {
	const path = pathname.replace(/\/+$/, '') || '/';
	if (path === MOCK_BASE) return '/admin';
	if (path.startsWith(`${MOCK_BASE}/`)) return `/admin${path.slice(MOCK_BASE.length)}`;
	return '/admin';
}

/**
 * The mock URL for a link the shell built (`/admin/...`, optionally with a query or hash).
 * Null for links that are not console links, which are left alone.
 */
export function consoleToMockHref(href: string, persona?: string): string | null {
	if (!/^\/admin(?=$|[/?#])/.test(href)) return null;
	return withPersona(`${MOCK_BASE}${href.slice('/admin'.length)}`, persona);
}

/** The persona a mock URL is viewed as when none is asked for. */
export const DEFAULT_PERSONA = 'platform';

/**
 * Keep the persona chosen with `?persona=` when moving inside the mock, so a page seen as a
 * viewer stays a viewer. The default persona adds nothing; a URL that names one keeps its own.
 */
export function withPersona(href: string, persona?: string): string {
	if (!persona || persona === DEFAULT_PERSONA) return href;
	const hashAt = href.indexOf('#');
	const hash = hashAt === -1 ? '' : href.slice(hashAt);
	const rest = hashAt === -1 ? href : href.slice(0, hashAt);
	const queryAt = rest.indexOf('?');
	const path = queryAt === -1 ? rest : rest.slice(0, queryAt);
	const query = new URLSearchParams(queryAt === -1 ? '' : rest.slice(queryAt + 1));
	if (!query.has('persona')) query.set('persona', persona);
	return `${path}?${query.toString()}${hash}`;
}
