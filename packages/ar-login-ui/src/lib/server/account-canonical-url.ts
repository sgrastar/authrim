import { env as dynamicEnv } from '$env/dynamic/public';
import type { RequestEvent } from '@sveltejs/kit';

function isLoopbackHost(hostname: string): boolean {
	return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function getValidUrl(candidate: unknown): string | undefined {
	const value = String(candidate || '').trim();
	if (!value || value === '__DISABLED__') {
		return undefined;
	}

	try {
		const url = new URL(value);
		return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

function getOriginalRequestHost(request: Request): string | undefined {
	const originalHost = request.headers.get('x-authrim-original-host')?.trim();
	if (!originalHost) {
		return undefined;
	}

	try {
		return new URL(`https://${originalHost}`).host;
	} catch {
		return undefined;
	}
}

function getRequestHost(event: RequestEvent): string {
	const host = event.request.headers.get('host')?.trim();
	if (host) {
		try {
			return new URL(`https://${host}`).host;
		} catch {
			// Fall through to event URL.
		}
	}

	return event.url.host;
}

function getPlatformEnv(event: RequestEvent): Record<string, unknown> | undefined {
	return (event.platform as { env?: Record<string, unknown> } | undefined)?.env;
}

function getConfiguredPublicApiOrigin(
	event: RequestEvent,
	platformEnv?: Record<string, unknown>
): string | undefined {
	const effectivePlatformEnv = platformEnv ?? getPlatformEnv(event);
	const candidates = [
		effectivePlatformEnv?.PUBLIC_AUTHRIM_ISSUER,
		dynamicEnv.PUBLIC_AUTHRIM_ISSUER,
		import.meta.env.PUBLIC_AUTHRIM_ISSUER,
		effectivePlatformEnv?.PUBLIC_API_BASE_URL,
		dynamicEnv.PUBLIC_API_BASE_URL,
		import.meta.env.PUBLIC_API_BASE_URL,
		typeof process !== 'undefined' ? process.env?.PUBLIC_AUTHRIM_ISSUER : undefined,
		typeof process !== 'undefined' ? process.env?.PUBLIC_API_BASE_URL : undefined
	];

	for (const candidate of candidates) {
		const url = getValidUrl(candidate);
		if (!url) {
			continue;
		}

		return new URL(url).origin;
	}

	return undefined;
}

function isAccountPagePath(pathname: string): boolean {
	return pathname === '/account' || pathname.startsWith('/account/');
}

export function getAccountPageCanonicalRedirectUrl(
	event: RequestEvent,
	platformEnv?: Record<string, unknown>
): string | null {
	if (!isAccountPagePath(event.url.pathname)) {
		return null;
	}
	const originalHost = getOriginalRequestHost(event.request);
	if (originalHost && originalHost.toLowerCase() !== event.url.host.toLowerCase()) {
		return null;
	}
	if (isLoopbackHost(event.url.hostname)) {
		return null;
	}

	const canonicalOrigin = getConfiguredPublicApiOrigin(event, platformEnv);
	if (!canonicalOrigin) {
		return null;
	}
	const canonicalUrl = new URL(canonicalOrigin);
	if (canonicalUrl.host.toLowerCase() === getRequestHost(event).toLowerCase()) {
		return null;
	}

	const target = new URL(event.url);
	target.protocol = canonicalUrl.protocol;
	target.host = canonicalUrl.host;
	return target.toString();
}
