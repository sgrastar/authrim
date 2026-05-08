/**
 * SvelteKit Server Hooks
 *
 * Provides server-side middleware for:
 * - Same-origin proxying for UI Worker deployments
 * - Security headers (CSP, HSTS, COOP, CORP, etc.)
 * - CSRF protection via Origin/Referer header validation
 * - Accept-Language based locale detection
 */

import { env as dynamicEnv } from '$env/dynamic/public';
import type { Handle, RequestEvent } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { REMEMBERED_TENANT_COOKIE, getRememberedTenantHost } from '$lib/discovery-session';

interface ServiceBinding {
	fetch(request: Request): Promise<Response>;
}

function isValidProxyUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:';
	} catch {
		return false;
	}
}

function getValidProxyUrl(candidate: unknown): string | undefined {
	const value = String(candidate || '').trim();
	if (!value || value === '__DISABLED__' || !isValidProxyUrl(value)) {
		return undefined;
	}

	return value;
}

function getConfiguredApiBackendUrl(platformEnv?: Record<string, unknown>): string | undefined {
	const candidates = [
		platformEnv?.API_BACKEND_URL,
		platformEnv?.PUBLIC_API_PROXY_BACKEND_URL,
		dynamicEnv.PUBLIC_API_PROXY_BACKEND_URL,
		import.meta.env.PUBLIC_API_PROXY_BACKEND_URL,
		typeof process !== 'undefined' ? process.env?.API_BACKEND_URL : undefined,
		typeof process !== 'undefined' ? process.env?.PUBLIC_API_PROXY_BACKEND_URL : undefined
	];

	for (const candidate of candidates) {
		const url = getValidProxyUrl(candidate);
		if (url) {
			return url;
		}
	}

	return undefined;
}

function getConfiguredForwardedHost(platformEnv?: Record<string, unknown>): string | undefined {
	const candidates = [
		platformEnv?.PUBLIC_AUTHRIM_ISSUER,
		dynamicEnv.PUBLIC_AUTHRIM_ISSUER,
		import.meta.env.PUBLIC_AUTHRIM_ISSUER,
		platformEnv?.PUBLIC_API_BASE_URL,
		dynamicEnv.PUBLIC_API_BASE_URL,
		import.meta.env.PUBLIC_API_BASE_URL,
		platformEnv?.PUBLIC_API_PROXY_BACKEND_URL,
		dynamicEnv.PUBLIC_API_PROXY_BACKEND_URL,
		import.meta.env.PUBLIC_API_PROXY_BACKEND_URL,
		platformEnv?.API_BACKEND_URL,
		typeof process !== 'undefined' ? process.env?.PUBLIC_AUTHRIM_ISSUER : undefined,
		typeof process !== 'undefined' ? process.env?.PUBLIC_API_BASE_URL : undefined,
		typeof process !== 'undefined' ? process.env?.PUBLIC_API_PROXY_BACKEND_URL : undefined,
		typeof process !== 'undefined' ? process.env?.API_BACKEND_URL : undefined
	];

	for (const candidate of candidates) {
		const url = getValidProxyUrl(candidate);
		if (!url) {
			continue;
		}

		try {
			return new URL(url).host;
		} catch {
			// Ignore invalid values and continue.
		}
	}

	return undefined;
}

function shouldUseRequestHostAsForwardedHost(platformEnv?: Record<string, unknown>): boolean {
	const candidates = [
		platformEnv?.PUBLIC_API_BASE_URL,
		dynamicEnv.PUBLIC_API_BASE_URL,
		import.meta.env.PUBLIC_API_BASE_URL,
		typeof process !== 'undefined' ? process.env?.PUBLIC_API_BASE_URL : undefined
	];

	for (const candidate of candidates) {
		if (getValidProxyUrl(candidate)) {
			return false;
		}
	}

	return true;
}

function getOriginalRequestHost(event: RequestEvent): string | undefined {
	const originalHost = event.request.headers.get('x-authrim-original-host')?.trim();
	if (!originalHost) {
		return undefined;
	}

	try {
		return new URL(`https://${originalHost}`).host;
	} catch {
		return undefined;
	}
}

function getRememberedTenantRequestHost(event: RequestEvent): string | undefined {
	if (event.url.pathname === '/api/auth/discovery') {
		return undefined;
	}

	return getRememberedTenantHost(event.cookies.get(REMEMBERED_TENANT_COOKIE));
}

function getApiBackendUrl(platformEnv?: Record<string, unknown>): string {
	return getConfiguredApiBackendUrl(platformEnv) ?? 'http://localhost:8786';
}

function isDevelopmentRuntime(): boolean {
	if (import.meta.env.DEV) {
		return true;
	}

	if (typeof process !== 'undefined' && process.env?.NODE_ENV) {
		return process.env.NODE_ENV !== 'production';
	}

	return false;
}

function isProxyEnabled(platformEnv?: Record<string, unknown>): boolean {
	return getConfiguredApiBackendUrl(platformEnv) !== undefined || isDevelopmentRuntime();
}

function buildConnectSrc(platformEnv?: Record<string, unknown>): string {
	// When proxy is enabled, browser only requests to same-origin /api/* — 'self' is sufficient
	if (isProxyEnabled(platformEnv)) {
		return "connect-src 'self'";
	}
	// When proxy is disabled, add the API origin only if PUBLIC_API_BASE_URL is set to a full URL
	const apiBaseUrl =
		(platformEnv?.PUBLIC_API_BASE_URL as string | undefined)?.trim() ||
		dynamicEnv.PUBLIC_API_BASE_URL?.trim() ||
		import.meta.env.PUBLIC_API_BASE_URL?.trim();
	if (apiBaseUrl) {
		try {
			return `connect-src 'self' ${new URL(apiBaseUrl).origin}`;
		} catch {
			// Invalid URL, fall back to self only
		}
	}
	return "connect-src 'self'";
}

function shouldProxyPath(pathname: string): boolean {
	return (
		(pathname.startsWith('/api/') && pathname !== '/api/set-language') || pathname === '/logout'
	);
}

function getPlatformEnv(event: RequestEvent): Record<string, unknown> | undefined {
	return (event.platform as { env?: Record<string, unknown> } | undefined)?.env;
}

function buildProxyHeaders(
	event: RequestEvent,
	platformEnv: Record<string, unknown> | undefined,
	forwardedHost: string
): Headers {
	const allowedHeaders = [
		'accept',
		'accept-language',
		'content-type',
		'content-length',
		'authorization',
		'cookie',
		'origin',
		'referer',
		'user-agent',
		'x-request-id',
		'x-correlation-id',
		'x-session-id',
		'x-diagnostic-session-id'
	];

	const headers = new Headers();
	for (const headerName of allowedHeaders) {
		const value = event.request.headers.get(headerName);
		if (value) {
			headers.set(headerName, value);
		}
	}

	const clientIP = event.getClientAddress();
	if (clientIP) {
		headers.set('X-Forwarded-For', clientIP);
	}
	headers.set('X-Authrim-Forwarded-Host', forwardedHost);
	headers.set('X-Forwarded-Host', forwardedHost);
	headers.set('X-Forwarded-Proto', 'https');

	return headers;
}

function getForwardedHost(event: RequestEvent, platformEnv?: Record<string, unknown>): string {
	const originalHost = getOriginalRequestHost(event);
	if (originalHost) {
		return originalHost;
	}

	const rememberedTenantHost = getRememberedTenantRequestHost(event);
	if (rememberedTenantHost) {
		return rememberedTenantHost;
	}

	if (event.url.pathname === '/api/auth/discovery') {
		return event.url.host;
	}

	if (shouldUseRequestHostAsForwardedHost(platformEnv)) {
		return event.url.host;
	}

	return getConfiguredForwardedHost(platformEnv) ?? event.url.host;
}

async function readBody(event: RequestEvent): Promise<string | undefined> {
	if (event.request.method === 'GET' || event.request.method === 'HEAD') {
		return undefined;
	}

	const maxBodySize = 10 * 1024 * 1024;
	const contentLength = event.request.headers.get('content-length');
	if (contentLength && parseInt(contentLength, 10) > maxBodySize) {
		return '__TOO_LARGE__';
	}

	const body = await event.request.text();
	if (body.length > maxBodySize) {
		return '__TOO_LARGE__';
	}
	return body;
}

function buildProxyResponse(response: Response): Response {
	const responseHeaders = new Headers();
	response.headers.forEach((value, key) => {
		const lower = key.toLowerCase();
		if (
			lower === 'content-length' ||
			lower === 'transfer-encoding' ||
			lower === 'content-encoding'
		) {
			return;
		}
		responseHeaders.set(key, value);
	});

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: responseHeaders
	});
}

const apiProxyHandle: Handle = async ({ event, resolve }) => {
	const pathname = event.url.pathname;
	if (!shouldProxyPath(pathname)) {
		return resolve(event);
	}

	const platformEnv = getPlatformEnv(event);
	const apiBackendUrl = getApiBackendUrl(platformEnv);
	const forwardedHost = getForwardedHost(event, platformEnv);

	const body = await readBody(event);
	if (body === '__TOO_LARGE__') {
		return new Response('Request body too large', { status: 413 });
	}

	const upstreamUrl = new URL(event.url.pathname + event.url.search, apiBackendUrl);
	const proxyHeaders = buildProxyHeaders(event, platformEnv, forwardedHost);

	const requestInit: RequestInit = {
		method: event.request.method,
		headers: proxyHeaders,
		redirect: 'manual'
	};

	if (body !== undefined) {
		requestInit.body = body;
	}

	const apiBinding =
		(platformEnv?.AR_ROUTER as ServiceBinding | undefined) ??
		(platformEnv?.API_SERVICE as ServiceBinding | undefined) ??
		null;
	const response = apiBinding
		? await apiBinding.fetch(new Request(upstreamUrl.toString(), requestInit))
		: await fetch(new Request(upstreamUrl.toString(), requestInit));

	return buildProxyResponse(response);
};

const securityHeadersHandle: Handle = async ({ event, resolve }) => {
	const platformEnv = getPlatformEnv(event);
	const response = await resolve(event);
	const csp = [
		"default-src 'self'",
		"script-src 'self' 'unsafe-inline'",
		"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
		"font-src 'self' https://fonts.gstatic.com data:",
		buildConnectSrc(platformEnv),
		"img-src 'self' data: https:",
		"frame-ancestors 'none'"
	].join('; ');

	response.headers.set('Content-Security-Policy', csp);
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
	response.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
	response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
	response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
	return response;
};

function isSafeMethod(method: string): boolean {
	return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

function sameOrigin(a: URL, b: URL): boolean {
	return a.protocol === b.protocol && a.host === b.host;
}

const csrfHandle: Handle = async ({ event, resolve }) => {
	if (isSafeMethod(event.request.method)) {
		return resolve(event);
	}

	if (event.url.pathname.startsWith('/api/')) {
		return resolve(event);
	}

	const origin = event.request.headers.get('origin');
	if (origin) {
		try {
			if (!sameOrigin(new URL(origin), event.url)) {
				return new Response('Forbidden', { status: 403 });
			}
		} catch {
			return new Response('Forbidden', { status: 403 });
		}
	} else {
		const referer = event.request.headers.get('referer');
		if (referer) {
			try {
				if (!sameOrigin(new URL(referer), event.url)) {
					return new Response('Forbidden', { status: 403 });
				}
			} catch {
				return new Response('Forbidden', { status: 403 });
			}
		}
	}

	return resolve(event);
};

const localeHandle: Handle = async ({ event, resolve }) => {
	const supportedLocales = ['en', 'ja'];
	const cookieLocale = event.cookies.get('lang');
	if (cookieLocale && supportedLocales.includes(cookieLocale)) {
		event.locals.locale = cookieLocale;
		return resolve(event);
	}

	const acceptLanguage = event.request.headers.get('accept-language') || '';
	const candidates = acceptLanguage
		.split(',')
		.map((part) => part.split(';')[0]?.trim().toLowerCase())
		.filter(Boolean);

	for (const candidate of candidates) {
		const base = candidate.split('-')[0];
		if (base && supportedLocales.includes(base)) {
			event.locals.locale = base;
			return resolve(event);
		}
	}

	event.locals.locale = 'en';
	return resolve(event);
};

export const handle = sequence(apiProxyHandle, csrfHandle, localeHandle, securityHeadersHandle);
