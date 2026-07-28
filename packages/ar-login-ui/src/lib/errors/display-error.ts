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
