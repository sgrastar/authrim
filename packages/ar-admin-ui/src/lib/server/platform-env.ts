import type { RequestEvent } from '@sveltejs/kit';
import { env as workerEnv } from 'cloudflare:workers';

/**
 * The Worker's bindings and variables.
 *
 * adapter-cloudflare 8 no longer sets `event.platform`; the environment comes from
 * `cloudflare:workers` (under `vite dev` and Vitest the adapter serves it from a platform proxy).
 * `event.platform.env` still wins when something provides it, which is how the tests inject theirs.
 */
export function getPlatformEnv(event: RequestEvent): Record<string, unknown> | undefined {
	const injected = (event.platform as { env?: Record<string, unknown> } | undefined)?.env;
	return injected ?? workerEnv;
}
