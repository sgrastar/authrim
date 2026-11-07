import type { RequestEvent } from '@sveltejs/kit';
import { behindEdgeEntry, EDGE_CONTEXT_HEADER } from '#lib/edge-context-header.js';

export { EDGE_CONTEXT_HEADER };

/**
 * What the Router checked at its public edge before it forwarded a request to the Login UI
 * (src/edge-worker.ts sets it from the Router's RPC arguments; the public entry removes any copy a
 * request brings, so it cannot be supplied from outside).
 *
 * - `originVerified`: for an unsafe method, whether the browser's Origin was the public origin
 *   (the Router rewrites Origin for SvelteKit, so the UI cannot see the original); null for a
 *   safe method.
 * - `clientIp`: the visitor's IP at the Router's edge.
 * - `publicOrigin`: the origin the browser used.
 *
 * A request without it reached the UI's own hostname: the UI checks the request itself.
 */
export interface EdgeContext {
	/** `router`: checked at the Router's edge; `direct`: the UI's own hostname. */
	source: 'router' | 'direct';
	originVerified: boolean | null;
	clientIp: string | null;
	publicOrigin: string;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function parseRouterContext(value: string): Omit<EdgeContext, 'source'> | null {
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>;
		if (parsed.v !== 1) return null;
		const originVerified =
			typeof parsed.originVerified === 'boolean' ? parsed.originVerified : null;
		const clientIp = typeof parsed.clientIp === 'string' ? parsed.clientIp : null;
		const publicOrigin = typeof parsed.publicOrigin === 'string' ? parsed.publicOrigin : null;
		if (!publicOrigin) return null;
		new URL(publicOrigin);
		return { originVerified, clientIp, publicOrigin };
	} catch {
		return null;
	}
}

function originOf(value: string | null): string | null {
	if (!value || value === 'null') return null;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
	} catch {
		return null;
	}
}

/**
 * The Router's check (ar-router/src/login-ui-edge.ts), made by the UI for a direct request: the
 * browser's Origin is the request's origin. A request without Origin is unverified (SvelteKit
 * refuses such a form POST before the hooks anyway).
 */
function directOriginVerified(request: Request, publicOrigin: string): boolean | null {
	if (SAFE_METHODS.has(request.method.toUpperCase())) return null;
	return originOf(request.headers.get('origin')) === publicOrigin;
}

/** The request's edge context: the Router's, or the UI's own check of a direct request. */
export function requestEdgeContext(event: RequestEvent): EdgeContext {
	// Without the Worker entry (`vite dev`, `vite preview`) nothing removes a visitor's copy of
	// the header: it is not read.
	const header = behindEdgeEntry() ? event.request.headers.get(EDGE_CONTEXT_HEADER) : null;
	if (header !== null) {
		const routed = parseRouterContext(header);
		// A malformed context from the trusted entry is treated as unverified, never as direct.
		return routed
			? { source: 'router', ...routed }
			: { source: 'router', originVerified: false, clientIp: null, publicOrigin: event.url.origin };
	}
	return {
		source: 'direct',
		originVerified: directOriginVerified(event.request, event.url.origin),
		clientIp: event.request.headers.get('cf-connecting-ip'),
		publicOrigin: event.url.origin
	};
}
