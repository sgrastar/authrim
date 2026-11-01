// The Worker environment that adapter-cloudflare serves as `cloudflare:workers`. Only what the
// UI reads is declared; the bindings themselves are untyped here, as `event.platform.env` was.
declare module 'cloudflare:workers' {
	export const env: Record<string, unknown>;
}
