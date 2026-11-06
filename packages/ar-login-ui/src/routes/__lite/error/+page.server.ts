import type { PageServerLoad } from './$types';
import { liteMessages } from '#lib/server/lite/messages.js';

/** Error codes with their own message; anything else shows the generic one (never echoed raw). */
const KNOWN = new Set([
	'invalid_request',
	'access_denied',
	'unauthorized_client',
	'unsupported_response_type',
	'invalid_scope',
	'server_error',
	'temporarily_unavailable',
	'login_required'
]);

export const load: PageServerLoad = async (event) => {
	const { LL } = await liteMessages(event.locals.locale);
	const code = event.url.searchParams.get('error') ?? '';
	const known = KNOWN.has(code) ? code : null;
	const message = known
		? (LL as unknown as Record<string, () => string>)[`error_${known}`]()
		: LL.error_subtitle();
	return {
		title: LL.error_title(),
		message,
		codeLabel: LL.error_errorCode(),
		code: known,
		back: LL.common_backToLogin()
	};
};
