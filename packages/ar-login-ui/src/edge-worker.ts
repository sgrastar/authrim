/**
 * The Login UI Worker's two ways in, around the SvelteKit Worker the adapter builds
 * (scripts/wrap-worker.mjs makes the deployed `_worker.js` from this after `vite build`).
 *
 * - The default `fetch` (the UI's own hostnames, workers.dev): any edge context header a request
 *   carries is removed, so nothing from outside can claim to have been checked by the Router.
 * - `LoginUiEdgeEntrypoint.handle(request, context)` (the Router's `LOGIN_UI_EDGE` binding): the
 *   Router checked the request at its public edge (the browser's Origin before it rewrote it, the
 *   visitor's IP, the public origin) and passes the result as RPC arguments; it is set on the
 *   request here, the only place it can come from.
 *
 * The Login UI reads the header only as written here (src/lib/server/edge-context.ts).
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { EDGE_CONTEXT_HEADER, markEdgeEntry } from './lib/edge-context-header';

interface KitWorker {
	fetch(request: Request, env: unknown, ctx: unknown): Response | Promise<Response>;
}

export interface RouterEdgeContext {
	originVerified?: unknown;
	clientIp?: unknown;
	publicOrigin?: unknown;
}

const MAX_CLIENT_IP_LENGTH = 64;
const MAX_ORIGIN_LENGTH = 256;

export function withoutEdgeContext(request: Request): Request {
	if (!request.headers.has(EDGE_CONTEXT_HEADER)) return request;
	const headers = new Headers(request.headers);
	headers.delete(EDGE_CONTEXT_HEADER);
	return new Request(request, { headers });
}

/** The header value for the Router's context; anything malformed is dropped, never passed on. */
export function edgeContextHeaderValue(context: RouterEdgeContext | null | undefined): string {
	// Null is the Router's answer for a safe method; anything else that is not a boolean is
	// unverified. The Login UI accepts an unsafe lite request only on `true`.
	const originVerified =
		typeof context?.originVerified === 'boolean' || context?.originVerified === null
			? context.originVerified
			: false;
	const clientIp =
		typeof context?.clientIp === 'string' && context.clientIp.length <= MAX_CLIENT_IP_LENGTH
			? context.clientIp
			: null;
	const publicOrigin =
		typeof context?.publicOrigin === 'string' && context.publicOrigin.length <= MAX_ORIGIN_LENGTH
			? context.publicOrigin
			: null;
	return JSON.stringify({ v: 1, originVerified, clientIp, publicOrigin });
}

export function withEdgeContext(
	request: Request,
	context: RouterEdgeContext | null | undefined
): Request {
	const headers = new Headers(request.headers);
	headers.set(EDGE_CONTEXT_HEADER, edgeContextHeaderValue(context));
	return new Request(request, { headers });
}

export function createLoginUiWorker(kit: KitWorker) {
	markEdgeEntry();
	const handler = {
		fetch(request: Request, env: unknown, ctx: unknown) {
			return kit.fetch(withoutEdgeContext(request), env, ctx);
		}
	};

	class LoginUiEdgeEntrypoint extends WorkerEntrypoint {
		/** The Router asks this before it relies on the entrypoint (ar-router login-ui-edge.ts). */
		ping(): string {
			return 'ok';
		}

		async handle(request: Request, context: RouterEdgeContext): Promise<Response> {
			return kit.fetch(withEdgeContext(request, context), this.env, this.ctx);
		}
	}

	return { handler, LoginUiEdgeEntrypoint };
}
