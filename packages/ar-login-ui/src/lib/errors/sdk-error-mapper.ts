import type { APIError } from '$lib/api/client';

export interface LoginUiErrorMessages {
	unknown(): string;
	invalidRequest(): string;
	accessDenied(): string;
	serverError(): string;
	loginRequired(): string;
	emailCodeInvalid(): string;
}

const GENERIC_DIRECT_AUTH_ERRORS = new Set([
	'email_code_invalid',
	'email_code_expired',
	'auth_code_invalid',
	'auth_code_expired',
	'pkce_mismatch',
	'challenge_expired',
	'challenge_invalid',
	'dpop_nonce_required',
	'dpop_replay_rejected',
	'token_binding_failed'
]);

function getErrorDetailsCode(error: APIError): string {
	const code = error.error_details?.code;
	return typeof code === 'string' ? code : '';
}

function shouldExposeInvalidRequestDescription(error: APIError): boolean {
	const description = error.error_description?.trim();
	if (!description) return false;

	const detailsCode = getErrorDetailsCode(error);
	if (detailsCode.startsWith('DIRECT_SESSION_')) return true;

	return description.toLowerCase().includes('authorization challenge');
}

export function messageForApiError(
	error: APIError | null | undefined,
	messages: LoginUiErrorMessages
): string {
	if (!error) {
		return messages.unknown();
	}

	if (GENERIC_DIRECT_AUTH_ERRORS.has(error.error)) {
		return messages.emailCodeInvalid();
	}

	switch (error.error) {
		case 'invalid_request':
			if (shouldExposeInvalidRequestDescription(error)) {
				return error.error_description;
			}
			return messages.invalidRequest();
		case 'access_denied':
			return messages.accessDenied();
		case 'server_error':
		case 'temporarily_unavailable':
			return messages.serverError();
		case 'login_required':
			return messages.loginRequired();
		default:
			return error.error_description || messages.unknown();
	}
}
