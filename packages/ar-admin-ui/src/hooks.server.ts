/**
 * SvelteKit Server Hooks for Safari ITP Compatibility
 *
 * This hook proxies /api/* requests to the backend API server.
 * By proxying through the same origin (pages.dev -> pages.dev),
 * Safari's ITP (Intelligent Tracking Prevention) won't block cookies.
 *
 * Without this proxy:
 *   Browser (pages.dev) -> API (workers.dev) = Cross-site, cookies blocked by Safari ITP
 *
 * With this proxy:
 *   Browser (pages.dev) -> SvelteKit Server (pages.dev) -> API (workers.dev) = Same-site, cookies work
 *
 * To disable the proxy (e.g., when using custom domains on the same site):
 *   Set API_BACKEND_URL to an empty or invalid value in the deployment env
 */

import { env as dynamicEnv } from '$env/dynamic/public';
import type { Handle, RequestEvent } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';

interface ServiceBinding {
	fetch(request: Request): Promise<Response>;
}

/**
 * Validate that a URL is safe to use as a proxy target
 * Only allows http:// and https:// URLs
 */
function isValidProxyUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		// Only allow http and https protocols
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			return false;
		}
		// Disallow localhost in production (unless explicitly intended)
		// Allow localhost only for development
		return true;
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

/**
 * Get the backend API URL from environment variable
 * Reads from platform.env (Cloudflare) or process.env (Node.js)
 * Falls back to localhost for development
 */
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
		platformEnv?.PUBLIC_API_BASE_URL,
		dynamicEnv.PUBLIC_API_BASE_URL,
		import.meta.env.PUBLIC_API_BASE_URL,
		platformEnv?.PUBLIC_API_PROXY_BACKEND_URL,
		dynamicEnv.PUBLIC_API_PROXY_BACKEND_URL,
		import.meta.env.PUBLIC_API_PROXY_BACKEND_URL,
		platformEnv?.API_BACKEND_URL,
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

function getApiPublicUrl(platformEnv?: Record<string, unknown>): string | undefined {
	const candidates = [
		platformEnv?.PUBLIC_AUTHRIM_ISSUER,
		dynamicEnv.PUBLIC_AUTHRIM_ISSUER,
		import.meta.env.PUBLIC_AUTHRIM_ISSUER
	];
	for (const candidate of candidates) {
		const url = getValidProxyUrl(candidate);
		if (url) return url;
	}
	return undefined;
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

/**
 * Check if API proxy is enabled
 * Proxy is enabled only when API_BACKEND_URL is a valid http(s) URL
 */
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
	const hopByHopHeaders = [
		'connection',
		'keep-alive',
		'proxy-authenticate',
		'proxy-authorization',
		'te',
		'trailers',
		'transfer-encoding',
		'upgrade'
	];

	response.headers.forEach((value, key) => {
		const lowerKey = key.toLowerCase();

		// Skip hop-by-hop headers
		if (hopByHopHeaders.includes(lowerKey)) {
			return;
		}

		// Handle Set-Cookie specially: remove Domain attribute
		// This allows the cookie to be set on the proxy's origin (pages.dev)
		// instead of the backend's origin (workers.dev)
		if (lowerKey === 'set-cookie') {
			// Remove Domain attribute from Set-Cookie
			// Format: name=value; Domain=xxx; Path=/; ...
			const modifiedCookie = value
				.split(';')
				.filter((part) => !part.trim().toLowerCase().startsWith('domain='))
				.join(';');
			responseHeaders.append(key, modifiedCookie);
		} else {
			responseHeaders.append(key, value);
		}
	});

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: responseHeaders
	});
}

function handleProxyError(error: unknown): Response {
	// Log error for debugging (Cloudflare logs)
	// Avoid logging sensitive details
	const errorType = error instanceof Error ? error.name : 'Unknown';
	console.error(`API proxy error: ${errorType}`);

	// Handle timeout specifically
	if (error instanceof Error && error.name === 'AbortError') {
		return new Response(
			JSON.stringify({
				error: 'gateway_timeout',
				error_description: 'Backend server did not respond in time'
			}),
			{
				status: 504,
				headers: { 'Content-Type': 'application/json' }
			}
		);
	}

	// Return a generic error response (don't leak internal details)
	return new Response(
		JSON.stringify({
			error: 'bad_gateway',
			error_description: 'Failed to connect to API server'
		}),
		{
			status: 502,
			headers: { 'Content-Type': 'application/json' }
		}
	);
}

const apiProxy: Handle = async ({ event, resolve }) => {
	// Get platform environment (Cloudflare Pages provides this)
	const platformEnv = getPlatformEnv(event);

	// Only proxy /api/* requests
	if (!event.url.pathname.startsWith('/api/')) {
		return resolve(event);
	}

	const arRouter = platformEnv?.AR_ROUTER as ServiceBinding | undefined;
	const proxyEnabled = arRouter !== undefined || isProxyEnabled(platformEnv);

	if (!proxyEnabled) {
		return resolve(event);
	}

	// Security: Limit request body size (10MB max)
	const body = await readBody(event);
	if (body === '__TOO_LARGE__') {
		return new Response(
			JSON.stringify({
				error: 'payload_too_large',
				error_description: 'Request body exceeds maximum allowed size'
			}),
			{
				status: 413,
				headers: { 'Content-Type': 'application/json' }
			}
		);
	}

	if (arRouter) {
		// === Service Binding path (Cloudflare Pages production) ===
		// AR_ROUTER binding routes internally — no workers.dev needed.
		const apiPublicUrl = getApiPublicUrl(platformEnv) ?? 'https://api-internal';
		const forwardedHost = new URL(apiPublicUrl).host;
		const targetUrl = `${apiPublicUrl}${event.url.pathname}${event.url.search}`;
		const headers = buildProxyHeaders(event, platformEnv, forwardedHost);

		try {
			const response = await Promise.race([
				arRouter.fetch(
					new Request(targetUrl, {
						method: event.request.method,
						headers,
						body
					})
				),
				new Promise<never>((_, reject) =>
					setTimeout(
						() => reject(Object.assign(new Error('Timeout'), { name: 'AbortError' })),
						30000
					)
				)
			]);
			return buildProxyResponse(response);
		} catch (error) {
			return handleProxyError(error);
		}
	} else {
		// === HTTP fetch path (local development / fallback) ===
		const apiBackendUrl = getApiBackendUrl(platformEnv);
		const targetUrl = `${apiBackendUrl}${event.url.pathname}${event.url.search}`;
		const forwardedHost = getConfiguredForwardedHost(platformEnv) ?? event.url.host;
		const headers = buildProxyHeaders(event, platformEnv, forwardedHost);

		// Make the proxied request with timeout
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

		try {
			const response = await fetch(targetUrl, {
				method: event.request.method,
				headers,
				body,
				signal: controller.signal
			});

			clearTimeout(timeoutId);
			return buildProxyResponse(response);
		} catch (error) {
			clearTimeout(timeoutId);
			return handleProxyError(error);
		}
	}
};

/**
 * Security headers hook
 * Adds comprehensive security headers to all responses.
 */
const securityHeaders: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	const platformEnv = getPlatformEnv(event);

	// Content Security Policy
	// - 'unsafe-inline' required for SvelteKit style injection and inline scripts
	// - connect-src includes API origin for cross-origin API calls
	// - img-src allows HTTPS and data: URIs (charts, dynamic images)
	response.headers.set(
		'Content-Security-Policy',
		[
			"default-src 'self'",
			"script-src 'self' 'unsafe-inline'",
			"style-src 'self' 'unsafe-inline'",
			"img-src 'self' https: data:",
			buildConnectSrc(platformEnv),
			"font-src 'self'",
			"frame-ancestors 'none'",
			"base-uri 'self'",
			"form-action 'self'"
		].join('; ')
	);

	// Enforce HTTPS
	response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
	// Prevent clickjacking — admin UI should never be embedded
	response.headers.set('X-Frame-Options', 'DENY');
	// Prevent MIME sniffing
	response.headers.set('X-Content-Type-Options', 'nosniff');
	// Referrer policy
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	// Legacy XSS filter (for older browsers)
	response.headers.set('X-XSS-Protection', '1; mode=block');
	// Restrict browser features
	response.headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
	// Cross-origin isolation
	response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
	response.headers.set('Cross-Origin-Resource-Policy', 'same-origin');

	return response;
};

/**
 * CSRF protection hook
 * Validates Origin or Referer header on state-changing requests (POST, PUT, DELETE, PATCH).
 * Falls back to Referer check when Origin header is absent.
 */
const csrfProtection: Handle = async ({ event, resolve }) => {
	const method = event.request.method;

	// Only check state-changing methods
	if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
		const origin = event.request.headers.get('origin');
		const requestOrigin = event.url.origin;

		if (origin) {
			// Primary: validate Origin header
			if (origin !== requestOrigin) {
				return new Response('Forbidden: CSRF check failed', { status: 403 });
			}
		} else {
			// Fallback: validate Referer header when Origin is absent
			const referer = event.request.headers.get('referer');
			if (referer) {
				try {
					const refererOrigin = new URL(referer).origin;
					if (refererOrigin !== requestOrigin) {
						return new Response('Forbidden: CSRF check failed', { status: 403 });
					}
				} catch {
					return new Response('Forbidden: CSRF check failed', { status: 403 });
				}
			} else {
				// Neither Origin nor Referer present — reject.
				// Admin UI is browser-only; legitimate browser requests always send
				// at least one of these headers on state-changing methods.
				return new Response('Forbidden: CSRF check failed', { status: 403 });
			}
		}
	}

	return resolve(event);
};

export const handle = sequence(apiProxy, securityHeaders, csrfProtection);
