import type { APIError } from '$lib/api/client';

export interface LoginUiErrorMessages {
	unknown(): string;
	invalidRequest(): string;
	accessDenied(): string;
	unauthorizedClient(): string;
	unsupportedResponseType(): string;
	invalidScope(): string;
	serverError(): string;
	temporarilyUnavailable(): string;
	loginRequired(): string;
	emailCodeInvalid(): string;
	/** The authorization request is gone: what to tell the user is that it has expired. */
	requestExpired?(): string;
	/**
	 * Too many attempts: with the minutes until another attempt is allowed (rounded up), when the
	 * server said how long.
	 */
	rateLimited?(retryAfterMinutes: number | null): string;
}

const EMAIL_CODE_ERRORS = new Set(['email_code_invalid', 'email_code_expired']);

/** What the rate limits answer: `slow_down` (AR110001), the middleware's own, and older names. */
const RATE_LIMIT_ERRORS = new Set([
	'slow_down',
	'rate_limit_exceeded',
	'rate_limited',
	'too_many_requests'
]);

/** The longest wait shown, in seconds: a value past it is not one the server sends. */
const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;

/** The minutes until another attempt, from the `retry_after` (seconds) of a rate-limit error. */
export function retryAfterMinutes(error: Pick<APIError, 'retry_after'>): number | null {
	const seconds = error.retry_after;
	if (
		typeof seconds !== 'number' ||
		!Number.isFinite(seconds) ||
		seconds <= 0 ||
		seconds > MAX_RETRY_AFTER_SECONDS
	) {
		return null;
	}
	return Math.ceil(seconds / 60);
}

/**
 * The message for a rate-limit error (null for any other error), for screens that show their own
 * message for the rest.
 */
export function messageForRateLimitError(
	error: APIError | null | undefined,
	rateLimited: (retryAfterMinutes: number | null) => string
): string | null {
	return error && RATE_LIMIT_ERRORS.has(error.error) ? rateLimited(retryAfterMinutes(error)) : null;
}

const INVALID_AUTH_REQUEST_ERRORS = new Set([
	'auth_code_invalid',
	'auth_code_expired',
	'pkce_mismatch',
	'challenge_expired',
	'challenge_invalid',
	'dpop_nonce_required',
	'dpop_replay_rejected',
	'token_binding_failed'
]);

export function messageForApiError(
	error: APIError | null | undefined,
	messages: LoginUiErrorMessages
): string {
	if (!error) {
		return messages.unknown();
	}

	if (EMAIL_CODE_ERRORS.has(error.error)) {
		return messages.emailCodeInvalid();
	}
	if (INVALID_AUTH_REQUEST_ERRORS.has(error.error)) {
		return messages.invalidRequest();
	}
	const rateLimitMessage = messages.rateLimited
		? messageForRateLimitError(error, messages.rateLimited)
		: null;
	if (rateLimitMessage !== null) {
		return rateLimitMessage;
	}

	switch (error.error) {
		case 'invalid_request':
			return messages.invalidRequest();
		case 'access_denied':
			return messages.accessDenied();
		case 'unauthorized_client':
		case 'invalid_client':
		case 'configuration_error':
			return messages.unauthorizedClient();
		case 'unsupported_response_type':
			return messages.unsupportedResponseType();
		case 'invalid_scope':
			return messages.invalidScope();
		case 'server_error':
			return messages.serverError();
		case 'temporarily_unavailable':
			return messages.temporarilyUnavailable();
		case 'authorization_request_expired':
			return (messages.requestExpired ?? messages.invalidRequest)();
		case 'login_required':
		case 'authentication_required':
			return messages.loginRequired();
		default:
			return messages.unknown();
	}
}
