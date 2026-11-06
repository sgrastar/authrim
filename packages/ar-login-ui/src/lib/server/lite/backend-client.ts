/**
 * The lite Login UI's calls to the backends during one form post: a cookie jar per request.
 *
 * A lite action can make several backend calls in a row (for example `direct/session`, then the
 * Flow `submit`); each one must see the cookies the previous one set, as a browser would. The jar
 * starts with the browser's cookies, takes in every `Set-Cookie` of every answer (read with
 * `getSetCookie()`: folding headers into an object would lose all but one), and at the end gives
 * the `Set-Cookie` values to pass on to the browser: only those whose attributes are safe to pass
 * on (no Domain, a Path, Secure on https, a `__Host-` cookie with Path=/), deletions included.
 *
 * The request carries the visitor's IP from the edge context as `CF-Connecting-IP` (what the
 * backends' rate limits read first) and `X-Forwarded-For`, and an Origin only when the caller
 * says the form post was verified, or for the few side-effect-free calls a page view makes
 * (PAGE_LOAD_ORIGIN_CALLS): the public origin, never one taken from the request.
 */

/**
 * The backend calls a page view (a GET) may make with the public origin: only what the normal
 * SPA's page load does, with no side effect beyond it (start or resume a Flow). Every other call
 * carries an Origin only from a verified form post. (Add an entry only with the page that needs
 * it.)
 */
const PAGE_LOAD_ORIGIN_CALLS: readonly RegExp[] = [/^\/api\/v1\/login\/interactions\/start$/u];

export function isPageLoadOriginCall(method: string, path: string): boolean {
	return method === 'POST' && PAGE_LOAD_ORIGIN_CALLS.some((pattern) => pattern.test(path));
}

export interface LiteBackendFetcher {
	fetch(input: string, init: RequestInit): Promise<Response>;
}

export interface LiteBackendClientOptions {
	/** The service binding to the backends (or the global fetch, for a plain URL). */
	fetcher: LiteBackendFetcher;
	/** The public origin the browser used; the backends are called for its host. */
	publicOrigin: string;
	/** The backend base URL whose host is replaced by the public origin's (as the API proxy does). */
	backendBaseUrl: string;
	/** The browser's `Cookie` header. */
	cookieHeader: string | null;
	clientIp: string | null;
	userAgent?: string | null;
	acceptLanguage?: string | null;
	/** Whether the form post's Origin was verified (the edge context). */
	originVerified: boolean;
	/**
	 * `page_load`: the client of a page view (a GET). It refuses, before any request, every call
	 * other than a GET or one of PAGE_LOAD_ORIGIN_CALLS. `form_post` (default): a verified post.
	 */
	mode?: 'page_load' | 'form_post';
}

export interface LiteBackendAnswer {
	status: number;
	headers: Headers;
	/** The parsed JSON body, or null when there is none (or it is not JSON). */
	json: unknown;
}

interface ParsedSetCookie {
	name: string;
	value: string;
	attributes: Map<string, string | true>;
	raw: string;
}

const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

interface JarCookie {
	name: string;
	value: string;
	/** The cookie's Path; the browser's own cookies count as `/` (it sent them to this page). */
	path: string;
}

function parseCookieHeader(header: string | null): JarCookie[] {
	const jar: JarCookie[] = [];
	for (const part of (header ?? '').split(';')) {
		const index = part.indexOf('=');
		if (index <= 0) continue;
		const name = part.slice(0, index).trim();
		if (COOKIE_NAME.test(name)) jar.push({ name, value: part.slice(index + 1).trim(), path: '/' });
	}
	return jar;
}

/** RFC 6265 §5.1.4 path-match: whether a cookie of `cookiePath` is sent for `requestPath`. */
export function pathMatches(cookiePath: string, requestPath: string): boolean {
	if (requestPath === cookiePath) return true;
	if (!requestPath.startsWith(cookiePath)) return false;
	return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

export function parseSetCookie(raw: string): ParsedSetCookie | null {
	const [pair = '', ...rest] = raw.split(';');
	const index = pair.indexOf('=');
	if (index <= 0) return null;
	const name = pair.slice(0, index).trim();
	if (!COOKIE_NAME.test(name)) return null;
	const attributes = new Map<string, string | true>();
	for (const attribute of rest) {
		const at = attribute.indexOf('=');
		const key = (at < 0 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
		if (!key) continue;
		attributes.set(key, at < 0 ? true : attribute.slice(at + 1).trim());
	}
	return { name, value: pair.slice(index + 1).trim(), attributes, raw };
}

/** Whether the cookie is a deletion. A valid Max-Age decides alone (RFC 6265 §5.3 step 3). */
function isDeletion(cookie: ParsedSetCookie, now: number): boolean {
	const maxAge = cookie.attributes.get('max-age');
	if (typeof maxAge === 'string' && /^-?\d+$/u.test(maxAge)) return Number(maxAge) <= 0;
	const expires = cookie.attributes.get('expires');
	if (typeof expires === 'string') {
		const at = Date.parse(expires);
		if (Number.isFinite(at) && at <= now) return true;
	}
	return false;
}

/**
 * Whether a backend cookie may be passed on to the browser: host-only (no Domain, so it cannot
 * reach a sibling host), with a Path, Secure on an https origin, and a `__Host-` or `__Secure-`
 * cookie with what its prefix requires.
 */
export function isForwardableSetCookie(cookie: ParsedSetCookie, publicOrigin: URL): boolean {
	if (cookie.attributes.has('domain')) return false;
	const path = cookie.attributes.get('path');
	if (typeof path !== 'string' || !path.startsWith('/')) return false;
	const secure = cookie.attributes.has('secure');
	if (publicOrigin.protocol === 'https:' && !secure) return false;
	if (cookie.name.startsWith('__Host-') && (!secure || path !== '/')) return false;
	if (cookie.name.startsWith('__Secure-') && !secure) return false;
	return true;
}

export function createLiteBackendClient(options: LiteBackendClientOptions) {
	const publicOrigin = new URL(options.publicOrigin);
	const jar = parseCookieHeader(options.cookieHeader);
	/** The Set-Cookie values to pass on, the last per name and path. */
	const forward = new Map<string, string>();
	const base = new URL(options.backendBaseUrl);
	base.protocol = publicOrigin.protocol;
	base.host = publicOrigin.host;

	/**
	 * Takes in an answer's cookies. Only a cookie that may be passed on to the browser changes the
	 * jar: one the browser would never store must not change what the next call sends either. A
	 * cookie is the pair of its name and Path; a deletion removes that pair only.
	 */
	function absorb(response: Response): void {
		const now = Date.now();
		for (const raw of response.headers.getSetCookie()) {
			const cookie = parseSetCookie(raw);
			if (!cookie || !isForwardableSetCookie(cookie, publicOrigin)) continue;
			const path = String(cookie.attributes.get('path'));
			// Every cookie of that name and Path goes (the browser can send the same name twice);
			// a new value takes their place as one cookie.
			const others = jar.filter((entry) => !(entry.name === cookie.name && entry.path === path));
			jar.length = 0;
			jar.push(...others);
			if (!isDeletion(cookie, now)) jar.push({ name: cookie.name, value: cookie.value, path });
			forward.set(`${cookie.name};${path}`, raw);
		}
	}

	function headersFor(json: boolean, requestPath: string, method: string): Headers {
		const headers = new Headers({ Accept: 'application/json' });
		if (json) headers.set('Content-Type', 'application/json');
		// As a browser sends them: those whose Path matches, the longer Path first.
		const cookie = jar
			.filter((entry) => pathMatches(entry.path, requestPath))
			.map((entry, index) => ({ entry, index }))
			.sort((a, b) => b.entry.path.length - a.entry.path.length || a.index - b.index)
			.map(({ entry }) => `${entry.name}=${entry.value}`)
			.join('; ');
		if (cookie) headers.set('Cookie', cookie);
		if (options.userAgent) headers.set('User-Agent', options.userAgent);
		if (options.acceptLanguage) headers.set('Accept-Language', options.acceptLanguage);
		if (options.clientIp) {
			headers.set('CF-Connecting-IP', options.clientIp);
			headers.set('X-Forwarded-For', options.clientIp);
		}
		// The public origin: after a verified form post, or for a page view's allowed calls.
		if (options.originVerified || isPageLoadOriginCall(method, requestPath)) {
			headers.set('Origin', publicOrigin.origin);
		}
		headers.set('Host', publicOrigin.host);
		headers.set('X-Forwarded-Host', publicOrigin.host);
		headers.set('X-Authrim-Forwarded-Host', publicOrigin.host);
		headers.set('X-Authrim-Original-Host', publicOrigin.host);
		headers.set('X-Forwarded-Proto', publicOrigin.protocol.replace(':', ''));
		headers.set('X-Authrim-Ui-Proxy', 'login-ui');
		return headers;
	}

	return {
		/** Calls a backend path with an optional JSON body; the answer's cookies go into the jar. */
		async request(
			path: string,
			init: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; json?: unknown } = {}
		): Promise<LiteBackendAnswer> {
			// A local path only: no scheme or host, no backslash (a URL parser reads `/\host` as
			// `//host`), no control character; and it must resolve to the public origin.
			// eslint-disable-next-line no-control-regex
			if (!/^\/(?!\/)[^\\\u0000-\u001f\u007f]*$/u.test(path)) throw new Error('lite_backend_path');
			const url = new URL(path, base);
			if (url.origin !== base.origin) throw new Error('lite_backend_path');
			const method = init.method ?? (init.json === undefined ? 'GET' : 'POST');
			// A page view makes no call with a side effect: those come from a verified form post.
			if (
				options.mode === 'page_load' &&
				method !== 'GET' &&
				!isPageLoadOriginCall(method, url.pathname)
			) {
				throw new Error('lite_backend_not_allowed_on_page_load');
			}
			const response = await options.fetcher.fetch(url.toString(), {
				method,
				headers: headersFor(init.json !== undefined, url.pathname, method),
				body: init.json === undefined ? undefined : JSON.stringify(init.json),
				redirect: 'manual'
			});
			absorb(response);
			const text = await response.text();
			let json: unknown = null;
			try {
				json = text ? (JSON.parse(text) as unknown) : null;
			} catch {
				json = null;
			}
			return { status: response.status, headers: response.headers, json };
		},
		/** The `Set-Cookie` values to put on the response to the browser. */
		setCookies(): string[] {
			return [...forward.values()];
		}
	};
}

export type LiteBackendClient = ReturnType<typeof createLiteBackendClient>;
