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
}

const EMAIL_CODE_ERRORS = new Set(['email_code_invalid', 'email_code_expired']);

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
		case 'login_required':
			return messages.loginRequired();
		default:
			return messages.unknown();
	}
}
