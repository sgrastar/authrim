import type { TranslationFunctions } from '$i18n/i18n-types';

/**
 * The message the error page shows for each `error` it is sent to with: authorization errors,
 * rate limits, and the RP-Initiated Logout checks (`/logout-error`, after the user is signed out)
 * that kept the user from being sent back to the app. Any other code shows the unknown error.
 */
const ERROR_PAGE_MESSAGES = {
	invalid_request: 'error_invalid_request',
	access_denied: 'error_access_denied',
	unauthorized_client: 'error_unauthorized_client',
	unsupported_response_type: 'error_unsupported_response_type',
	invalid_scope: 'error_invalid_scope',
	server_error: 'error_server_error',
	temporarily_unavailable: 'error_temporarily_unavailable',
	slow_down: 'error_rateLimited',
	rate_limit_exceeded: 'error_rateLimited',
	unregistered_post_logout_redirect_uri: 'error_unregisteredPostLogoutRedirectUri',
	invalid_id_token_hint: 'error_invalidIdTokenHint',
	id_token_hint_required: 'error_idTokenHintRequired'
} as const satisfies Record<string, keyof TranslationFunctions>;

export function errorPageMessage(LL: TranslationFunctions, code: string): string {
	const key = Object.hasOwn(ERROR_PAGE_MESSAGES, code)
		? ERROR_PAGE_MESSAGES[code as keyof typeof ERROR_PAGE_MESSAGES]
		: 'error_unknown';
	return LL[key]();
}
