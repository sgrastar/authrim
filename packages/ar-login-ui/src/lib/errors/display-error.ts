/**
 * A translated message that is safe to show to an end user.
 *
 * API, SDK, DOMException, and network error messages are developer-facing and may be
 * English-only or contain implementation details. Only messages explicitly wrapped by
 * this class may cross the LoginUI display boundary.
 */
export class LoginUiDisplayError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'LoginUiDisplayError';
	}
}

export function loginUiDisplayError(message: string): LoginUiDisplayError {
	return new LoginUiDisplayError(message);
}

export function messageForCaughtError(error: unknown, fallback: string): string {
	return error instanceof LoginUiDisplayError ? error.message : fallback;
}

const PUBLIC_ERROR_CODE = /^AR\d{6}$/u;
const PUBLIC_ERROR_ID =
	/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

export function appendApiSupportReference(
	message: string,
	label: string,
	error: { error_code?: string; error_id?: string } | null | undefined
): string {
	const errorCode = PUBLIC_ERROR_CODE.test(error?.error_code ?? '') ? error?.error_code : undefined;
	const errorId = PUBLIC_ERROR_ID.test(error?.error_id ?? '') ? error?.error_id : undefined;
	if (!errorCode) return message;
	return `${message} (${label}: ${errorCode}${errorId ? ` / ${errorId}` : ''})`;
}
