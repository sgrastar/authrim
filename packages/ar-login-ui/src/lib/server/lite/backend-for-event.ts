/**
 * The lite backend client of a request: through the Router's service binding (as the Login UI's
 * API proxy calls the backends), for the public origin of the request's edge context, with the
 * visitor's IP from it. `page_load` for a page view (only the calls PAGE_LOAD_ORIGIN_CALLS
 * allows); `form_post` for a verified form post (the edge context said its Origin was ours).
 */
import type { RequestEvent } from '@sveltejs/kit';
import { getPlatformEnv } from '#lib/server/platform-env.js';
import { getConfiguredApiBackendUrl } from '../../../hooks.server';
import { createLiteBackendClient, type LiteBackendClient } from './backend-client';

interface ServiceBinding {
	fetch(input: string, init: RequestInit): Promise<Response>;
}

export function liteBackendForEvent(
	event: RequestEvent,
	mode: 'page_load' | 'form_post'
): LiteBackendClient | null {
	const edge = event.locals.edge;
	if (!edge) return null;
	const platformEnv = getPlatformEnv(event);
	const binding =
		(platformEnv?.AR_ROUTER as ServiceBinding | undefined) ??
		(platformEnv?.API_SERVICE as ServiceBinding | undefined);
	return createLiteBackendClient({
		fetcher: binding ?? { fetch: (input, init) => fetch(input, init) },
		publicOrigin: edge.publicOrigin,
		backendBaseUrl: getConfiguredApiBackendUrl(platformEnv) ?? 'http://localhost:8786',
		cookieHeader: event.request.headers.get('cookie'),
		clientIp: edge.clientIp,
		userAgent: event.request.headers.get('user-agent'),
		acceptLanguage: event.request.headers.get('accept-language'),
		// A form post's Origin was checked by the lite guard (edge context) before any action ran.
		originVerified: mode === 'form_post' && edge.originVerified === true,
		mode
	});
}
