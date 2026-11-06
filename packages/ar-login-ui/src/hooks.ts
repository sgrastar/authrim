import type { Reroute } from '@sveltejs/kit/hooks';
import {
	isLiteModeAnswer,
	LITE_MODE_PROBE_URL,
	LITE_UNAVAILABLE_PATH,
	liteRouteForPath
} from '#lib/lite/routing.js';

/**
 * The lite Login UI: for a tenant in lite mode, the in-scope pages are served by the lite routes
 * (routes/__lite). The mode comes from the request's authentication methods answer, which
 * `handleFetch` reads for the probe URL (reroute itself sees no request).
 *
 * Only on the server: a browser never decides (the lite pages run without client JavaScript, and
 * a normal page already open is stopped on the server, lite-guard.ts).
 */
export const reroute: Reroute = async ({ url, fetch }) => {
	if (typeof window !== 'undefined') return undefined;
	const liteRoute = liteRouteForPath(url.pathname);
	if (!liteRoute) return undefined;
	let mode: string;
	try {
		mode = await (await fetch(LITE_MODE_PROBE_URL)).text();
	} catch {
		return undefined;
	}
	if (!isLiteModeAnswer(mode) || mode === 'off') return undefined;
	return mode === 'always' ? liteRoute : LITE_UNAVAILABLE_PATH;
};
