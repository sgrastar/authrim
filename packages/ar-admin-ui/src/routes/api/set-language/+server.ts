import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, cookies }) => {
	const { language } = await request.json();

	if (!language || !['en', 'ja'].includes(language)) {
		return json({ error: 'Invalid language' }, { status: 400 });
	}

	// Set cookie with server-side Set-Cookie header (not affected by Safari ITP)
	cookies.set('preferredLanguage', language, {
		path: '/',
		maxAge: 60 * 60 * 24 * 365, // 1 year
		httpOnly: false, // Allow JavaScript to read (for client-side language switching)
		sameSite: 'lax',
		secure: true // HTTPS only
	});

	return json({ success: true });
};
