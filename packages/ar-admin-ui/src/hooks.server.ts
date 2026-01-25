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
 * To disable the proxy (e.g., when using custom domains on same registrable domain):
 *   Set API_BACKEND_URL to empty string in ui.env
 */

import type { Handle } from '@sveltejs/kit';

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

/**
 * Get the backend API URL from environment variable
 * Reads from platform.env (Cloudflare) or process.env (Node.js)
 * Falls back to localhost for development
 */
function getApiBackendUrl(platformEnv?: Record<string, unknown>): string {
	// Check platform.env first (Cloudflare Pages)
	if (platformEnv?.API_BACKEND_URL) {
		const url = String(platformEnv.API_BACKEND_URL).trim();
		if (url !== '' && isValidProxyUrl(url)) {
			return url;
		}
	}

	// Check process.env (Node.js / development)
	if (typeof process !== 'undefined' && process.env?.API_BACKEND_URL) {
		const url = process.env.API_BACKEND_URL.trim();
		if (url !== '' && isValidProxyUrl(url)) {
			return url;
		}
	}

	// Fallback for development
	return 'http://localhost:8786';
}

/**
 * Check if API proxy is enabled
 * Proxy is disabled when API_BACKEND_URL is empty or not set
 */
function isProxyEnabled(platformEnv?: Record<string, unknown>): boolean {
	// Check platform.env first (Cloudflare Pages)
	if (platformEnv?.API_BACKEND_URL) {
		const url = String(platformEnv.API_BACKEND_URL);
		return url.trim() !== '';
	}

	// Check process.env (Node.js / development)
	if (typeof process !== 'undefined' && process.env?.API_BACKEND_URL) {
		return process.env.API_BACKEND_URL.trim() !== '';
	}

	// Default to enabled in development (localhost proxy)
	return true;
}

export const handle: Handle = async ({ event, resolve }) => {
	// Get platform environment (Cloudflare Pages provides this)
	const platformEnv = event.platform?.env as Record<string, unknown> | undefined;

	// Proxy /api/* requests to the backend API (if proxy is enabled)
	if (event.url.pathname.startsWith('/api/') && isProxyEnabled(platformEnv)) {
		const apiBackendUrl = getApiBackendUrl(platformEnv);
		const targetUrl = `${apiBackendUrl}${event.url.pathname}${event.url.search}`;

		// Security: Use allowlist for forwarded headers
		// Only forward headers that are necessary for the API
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
			'x-correlation-id'
		];

		const headers = new Headers();

		// Copy only allowed headers from the original request
		for (const headerName of allowedHeaders) {
			const value = event.request.headers.get(headerName);
			if (value) {
				headers.set(headerName, value);
			}
		}

		// Forward client IP for logging/rate limiting
		// Use the actual client IP from Cloudflare, not any spoofed header
		const clientIP = event.getClientAddress();
		if (clientIP) {
			headers.set('X-Forwarded-For', clientIP);
		}

		// Forward the original host for CORS validation if needed
		headers.set('X-Forwarded-Host', event.url.host);
		headers.set('X-Forwarded-Proto', 'https');

		try {
			// Security: Limit request body size (10MB max)
			const MAX_BODY_SIZE = 10 * 1024 * 1024;
			let body: string | undefined;

			if (event.request.method !== 'GET' && event.request.method !== 'HEAD') {
				const contentLength = event.request.headers.get('content-length');
				if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
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
				body = await event.request.text();

				// Double-check actual body size
				if (body.length > MAX_BODY_SIZE) {
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
			}

			// Make the proxied request with timeout
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

			const response = await fetch(targetUrl, {
				method: event.request.method,
				headers,
				body,
				signal: controller.signal
			});

			clearTimeout(timeoutId);

			// Create response headers, handling Set-Cookie specially
			const responseHeaders = new Headers();

			// Hop-by-hop headers to skip
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

			// Copy all headers from the backend response
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
		} catch (error) {
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
	}

	// For non-API requests, continue with normal SvelteKit handling
	return resolve(event);
};
