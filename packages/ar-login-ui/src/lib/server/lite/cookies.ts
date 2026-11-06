/**
 * Puts the backend cookies a lite action collected (the cookie jar's `setCookies()`, already
 * checked as safe to pass on) on the action's response. SvelteKit sets cookies only through
 * `event.cookies`, so each is read back into its options; the value is passed on as it is.
 */
import type { RequestEvent } from '@sveltejs/kit';
import { parseSetCookie } from './backend-client';

export function forwardSetCookies(event: RequestEvent, setCookies: readonly string[]): void {
	for (const raw of setCookies) {
		const cookie = parseSetCookie(raw);
		if (!cookie) continue;
		const attribute = (name: string) => cookie.attributes.get(name);
		const sameSite = String(attribute('samesite') ?? '').toLowerCase();
		const maxAge = attribute('max-age');
		const expires = attribute('expires');
		event.cookies.set(cookie.name, cookie.value, {
			path: String(attribute('path') ?? '/'),
			secure: attribute('secure') !== undefined,
			httpOnly: attribute('httponly') !== undefined,
			sameSite: sameSite === 'strict' || sameSite === 'none' ? sameSite : 'lax',
			...(typeof maxAge === 'string' && /^-?\d+$/u.test(maxAge) ? { maxAge: Number(maxAge) } : {}),
			...(typeof expires === 'string' && Number.isFinite(Date.parse(expires))
				? { expires: new Date(expires) }
				: {}),
			encode: (value) => value
		});
	}
}
