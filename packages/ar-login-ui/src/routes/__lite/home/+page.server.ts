/**
 * `/` in lite mode: the sign-in page for a visitor without a session (the request it came with
 * kept), else a short signed-in page with the way to the account page when the tenant offers one.
 * The organization finder (`/discover`) is not a lite page: a lite tenant's own host never needs it.
 */
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getCachedAuthenticationMethodsForRequest } from '../../../hooks.server';
import { getPlatformEnv } from '#lib/server/platform-env.js';
import { liteBackendForEvent } from '#lib/server/lite/backend-for-event.js';
import { liteMessages } from '#lib/server/lite/messages.js';

const CHALLENGE = /^[A-Za-z0-9._~-]{1,512}$/u;

export const load: PageServerLoad = async (event) => {
	const challengeId = event.url.searchParams.get('challenge_id');
	if (challengeId && CHALLENGE.test(challengeId)) {
		redirect(303, `/login?challenge_id=${encodeURIComponent(challengeId)}`);
	}
	const backend = liteBackendForEvent(event, 'page_load');
	let active = false;
	let email: string | null = null;
	if (backend && event.cookies.get('authrim_session')) {
		// The session with its profile (the address the page says the person is signed in as).
		const status = await backend.request('/api/sessions/status').catch(() => null);
		const json = status?.json as
			| { active?: unknown; user_id?: unknown; email?: unknown }
			| null
			| undefined;
		active =
			status?.status === 200 &&
			json?.active === true &&
			typeof json.user_id === 'string' &&
			json.user_id.length > 0;
		email =
			typeof json?.email === 'string' && json.email.length > 0 && json.email.length <= 320
				? json.email
				: null;
	}
	if (!active) redirect(303, '/login');
	const methods =
		event.locals.authenticationMethods ??
		(await getCachedAuthenticationMethodsForRequest(event, getPlatformEnv(event)).catch(
			() => null
		));
	const selfService = methods?.ui.selfService;
	const path = selfService?.accountPagePath;
	const { LL } = await liteMessages(event.locals.locale);
	return {
		title: LL.app_title(),
		signedIn: LL.landing_signedInAs(),
		email,
		accountHref:
			selfService?.accountPageEnabled === true
				? typeof path === 'string' && path.startsWith('/') && !path.startsWith('//')
					? path
					: '/account'
				: null,
		accountLabel: LL.account_title()
	};
};
