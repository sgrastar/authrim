/**
 * The lite Login UI's browser binding: a random value in the `__Host-authrim_lite` cookie
 * (HttpOnly, Secure, SameSite=Lax, Path=/, no Domain) that ties a browser to its lite transactions.
 *
 * The cookie holds only this value. Each transaction is named by a hidden form field, so every
 * tab has its own and no tab overwrites another's state. ar-auth stores only its hash. When two
 * tabs make the first cookie at the same time, one tab's transaction no longer matches the cookie
 * and that tab starts again.
 */
import type { RequestEvent } from '@sveltejs/kit';

export const LITE_BINDING_COOKIE = '__Host-authrim_lite';
/** 32 random bytes, base64url without padding. */
export const LITE_BINDING_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const LITE_BINDING_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function randomBinding(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/gu, '-')
		.replace(/\//gu, '_')
		.replace(/=+$/u, '');
}

/** The request's browser binding, or null when it has none (or a malformed one). */
export function readBrowserBinding(event: RequestEvent): string | null {
	const value = event.cookies.get(LITE_BINDING_COOKIE);
	return value && LITE_BINDING_PATTERN.test(value) ? value : null;
}

/** The request's browser binding; a new one is made and set on the response when it has none. */
export function ensureBrowserBinding(event: RequestEvent): { binding: string; created: boolean } {
	const existing = readBrowserBinding(event);
	if (existing) return { binding: existing, created: false };
	const binding = randomBinding();
	event.cookies.set(LITE_BINDING_COOKIE, binding, {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: 'lax',
		maxAge: LITE_BINDING_MAX_AGE_SECONDS
	});
	return { binding, created: true };
}
