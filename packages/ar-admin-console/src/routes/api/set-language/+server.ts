import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isSupportedLocale, LOCALE_COOKIE } from '$lib/i18n/locales';

export const POST: RequestHandler = async ({ request, cookies }) => {
	const body = (await request.json().catch(() => null)) as { language?: unknown } | null;
	if (!isSupportedLocale(body?.language)) {
		return json({ error: 'Invalid language' }, { status: 400 });
	}

	// Set server-side so Safari ITP does not cap the cookie lifetime.
	cookies.set(LOCALE_COOKIE, body.language, {
		path: '/',
		maxAge: 60 * 60 * 24 * 365,
		httpOnly: false,
		sameSite: 'lax',
		secure: true
	});

	return json({ success: true });
};
