// The Worker environment that adapter-cloudflare serves as `cloudflare:workers`. Only what the
// UI reads is declared; the bindings themselves are untyped here, as `event.platform.env` was.
declare module 'cloudflare:workers' {
	export const env: Record<string, unknown>;
	/** The base of a named entrypoint (src/edge-worker.ts); the runtime sets `ctx` and `env`. */
	export abstract class WorkerEntrypoint {
		protected readonly ctx: unknown;
		protected readonly env: unknown;
		constructor(ctx: unknown, env: unknown);
	}
}
