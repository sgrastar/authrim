/**
 * SvelteKit Server Hooks
 *
 * Provides server-side middleware for:
 * - Security headers (CSP, HSTS, COOP, CORP, etc.)
 * - CSRF protection via Origin/Referer header validation
 * - Accept-Language based locale detection
 */

import { PUBLIC_API_BASE_URL } from '$env/static/public';
import type { Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';

/**
 * Build connect-src directive with API origin if cross-origin
 */
function buildConnectSrc(): string {
	const apiBaseUrl = PUBLIC_API_BASE_URL;
	if (apiBaseUrl) {
		try {
			const apiOrigin = new URL(apiBaseUrl).origin;
			return `connect-src 'self' ${apiOrigin}`;
		} catch {
			// Invalid URL, fall back to self only
		}
	}
	return "connect-src 'self'";
}

/**
 * Security headers hook
 * Adds comprehensive security headers to all responses.
 */
const securityHeaders: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);

	// Content Security Policy
	// - 'unsafe-inline' required for SvelteKit style injection and inline scripts
	// - connect-src includes API origin for cross-origin API calls
	// - img-src allows HTTPS and data: URIs (QR codes, dynamic images)
	response.headers.set(
		'Content-Security-Policy',
		[
			"default-src 'self'",
			"script-src 'self' 'unsafe-inline'",
			"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
			"img-src 'self' https: data:",
			buildConnectSrc(),
			"font-src 'self' https://fonts.gstatic.com",
			"frame-ancestors 'self'",
			"base-uri 'self'",
			"form-action 'self'"
		].join('; ')
	);

	// Enforce HTTPS
	response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
	// Prevent clickjacking (SAMEORIGIN to match CSP frame-ancestors 'self')
	response.headers.set('X-Frame-Options', 'SAMEORIGIN');
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
				// Login UI is browser-only; legitimate browser requests always send
				// at least one of these headers on state-changing methods.
				return new Response('Forbidden: CSRF check failed', { status: 403 });
			}
		}
	}

	return resolve(event);
};

/**
 * Locale detection hook
 * Sets preferred language from Accept-Language header if no cookie preference exists.
 */
const localeDetection: Handle = async ({ event, resolve }) => {
	// Only set locale preference if not already set via cookie
	const cookieLocale = event.cookies.get('preferredLanguage');
	if (!cookieLocale) {
		const acceptLanguage = event.request.headers.get('accept-language') || '';
		// Simple detection: check if Japanese is preferred
		const preferJapanese = acceptLanguage.split(',').some((lang) => lang.trim().startsWith('ja'));

		if (preferJapanese) {
			// Set a transient cookie for the current session
			// httpOnly must be false to match /api/set-language endpoint,
			// otherwise the cookie cannot be overwritten by the language switcher
			event.cookies.set('preferredLanguage', 'ja', {
				path: '/',
				httpOnly: false,
				sameSite: 'lax',
				secure: event.url.protocol === 'https:',
				maxAge: 60 * 60 * 24 * 365 // 1 year
			});
		}
	}

	return resolve(event);
};

export const handle = sequence(securityHeaders, csrfProtection, localeDetection);
