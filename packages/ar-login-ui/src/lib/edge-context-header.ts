/**
 * The internal header that carries the Router's edge context to the Login UI. Set only by the
 * Worker entry (src/edge-worker.ts), which removes a visitor's copy; read by
 * lib/server/edge-context.ts. Kept apart so the Worker entry imports nothing of SvelteKit.
 */
export const EDGE_CONTEXT_HEADER = 'x-authrim-edge-context';

/**
 * Set by the Worker entry when it loads. Only behind it is the header trustworthy: under
 * `vite dev` or `vite preview` no entry removes a visitor's copy, so the header is not read.
 */
const EDGE_ENTRY_MARK = Symbol.for('authrim.login-ui.edge-entry');

export function markEdgeEntry(): void {
	(globalThis as Record<symbol, unknown>)[EDGE_ENTRY_MARK] = true;
}

export function behindEdgeEntry(): boolean {
	return (globalThis as Record<symbol, unknown>)[EDGE_ENTRY_MARK] === true;
}
