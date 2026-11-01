// Vitest has no Worker environment. adapter-cloudflare's stand-in for `cloudflare:workers` throws
// here, so tests resolve the module to this empty one; a test that needs bindings passes them as
// `event.platform.env` (see getPlatformEnv in lib/server/platform-env.ts).
export const env: Record<string, unknown> = {};
