/**
 * The server side of the lite Login UI's routing and protection (the routing itself is in
 * src/hooks.ts):
 * - `liteHandleFetch` answers the probe `reroute` fetches with the request's lite mode, from the
 *   tenant's authentication methods answer. A failed fetch reads as `off`: the normal Login UI
 *   is served as before, and the backends enforce lite mode themselves.
 * - `liteGuardHandle` (first in the handle sequence):
 *   - a direct request for `/__lite/...` is refused (404), judged on the path the browser asked
 *     for, never on the route it was sent to;
 *   - a data request a normal page sends (`__data.json`) that was sent to a lite route is refused
 *     (503) before anything runs: a page opened before the switch must not act on its own;
 *   - a lite POST must be urlencoded and within the size limit before its action runs;
 *   - every lite response is `private, no-store` and carries the lite CSP.
 */
import type { RequestEvent } from '@sveltejs/kit';
import type { Handle, HandleFetch } from '@sveltejs/kit/hooks';
import LITE_CSS from '#lib/lite/lite.css?raw';
import {
	isInternalLitePath,
	liteRouteForPath,
	LITE_MODE_PROBE_URL,
	LITE_ROUTE_PREFIX,
	type LiteModeAnswer
} from '#lib/lite/routing.js';
import { buildLiteContentSecurityPolicy, cspHashSource } from './csp';
import { isLiteFormContentType, liteFormDeclaredTooLarge } from './form';

type ModeReader = (event: RequestEvent) => Promise<LiteModeAnswer>;

export function isLiteRoute(event: RequestEvent): boolean {
	const id: string | null | undefined = event.route?.id;
	return id === LITE_ROUTE_PREFIX || Boolean(id?.startsWith(`${LITE_ROUTE_PREFIX}/`));
}

/**
 * How long a page waits for the lite mode before it is served by the normal Login UI. The mode
 * usually comes from the cached authentication methods answer; a slow or stuck fetch must not
 * hold every sign-in page (the backends enforce lite mode whatever the page is).
 */
export const LITE_MODE_PROBE_TIMEOUT_MS = 1000;

export function createLiteHandleFetch(
	readMode: ModeReader,
	timeoutMs: number = LITE_MODE_PROBE_TIMEOUT_MS
): HandleFetch {
	return async ({ event, request, fetch }) => {
		if (request.url !== LITE_MODE_PROBE_URL) return fetch(request);
		let mode: LiteModeAnswer;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			mode = await Promise.race([
				readMode(event),
				new Promise<LiteModeAnswer>((resolve) => {
					timer = setTimeout(() => resolve('off'), timeoutMs);
				})
			]);
		} catch {
			mode = 'off';
		} finally {
			clearTimeout(timer);
		}
		event.locals.loginUiLite = mode;
		return new Response(mode, { headers: { 'Cache-Control': 'no-store' } });
	};
}

function refuse(status: number, body: string): Response {
	return new Response(body, {
		status,
		headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' }
	});
}

/**
 * The lite CSP of a page: the lite stylesheet, plus what the page declared in
 * `event.locals.liteCsp` (the hash of a fixed script, the one destination a relay posts to).
 */
export async function litePageContentSecurityPolicy(
	extra: App.Locals['liteCsp'] = undefined
): Promise<string> {
	return buildLiteContentSecurityPolicy({
		styleHashes: [await cspHashSource(LITE_CSS)],
		scriptHashes: extra?.scriptHashes,
		formAction: extra?.formAction
	});
}

export const liteGuardHandle: Handle = async ({ event, resolve }) => {
	if (isInternalLitePath(event.url.pathname)) return refuse(404, 'Not Found');
	if (!isLiteRoute(event)) return resolve(event);
	// A lite route is reached only by rerouting an in-scope page: one whose requested path is not
	// such a page came here some other way, and is refused as a direct request.
	if (!liteRouteForPath(event.url.pathname)) return refuse(404, 'Not Found');

	if (event.isDataRequest) return refuse(503, 'Service Unavailable');
	if (event.request.method === 'POST') {
		if (!isLiteFormContentType(event.request.headers.get('content-type'))) {
			return refuse(415, 'Unsupported Media Type');
		}
		if (liteFormDeclaredTooLarge(event.request)) return refuse(413, 'Payload Too Large');
	}

	const response = await resolve(event);
	const headers = new Headers(response.headers);
	headers.set('Cache-Control', 'private, no-store');
	headers.set('Content-Security-Policy', await litePageContentSecurityPolicy(event.locals.liteCsp));
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
};
