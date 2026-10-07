/**
 * What went wrong with a device code or CIBA decision, in the terms the person can act on, and the
 * translated message for it. The pages keep the state; this only reads the API error.
 */

import type { TranslationFunctions } from '$i18n/i18n-types';

/** Public error codes ar-async returns for a CIBA request that is gone or no longer pending. */
const CIBA_REQUEST_NOT_FOUND = 'AR060004';
const CIBA_REQUEST_NOT_PENDING = 'AR130003';

export type ApprovalFailure =
	/** Device code unknown, expired, malformed, or already decided: get a new code. */
	| 'invalid_code'
	/** CIBA request not found, expired, or already decided. */
	| 'request_gone'
	/** Made before the person withdrew the application's access: start again. */
	| 'consent_withdrawn'
	/** The server answered that it could not decide now (503): nothing changed, try again. */
	| 'retry'
	/**
	 * No answer arrived (network error or timeout). A decision may or may not have been saved, so
	 * the page has to check the current state before saying what happened.
	 */
	| 'unknown'
	/** Too many attempts from this browser. */
	| 'rate_limited'
	/** No signed-in session. */
	| 'login_required'
	| 'failed';

export interface ApprovalApiError {
	error?: string;
	error_code?: string;
	/** POST /api/devices/lookup: the state of a code that is no longer pending. */
	code_status?: string;
	/** POST /api/devices/lookup: whether the signed-in user is the one who approved the code. */
	decided_by_self?: boolean;
}

export function classifyApprovalFailure(
	error: ApprovalApiError | null | undefined
): ApprovalFailure {
	switch (error?.error) {
		case 'consent_withdrawn':
			return 'consent_withdrawn';
		case 'temporarily_unavailable':
			return 'retry';
		case 'network_error':
		case 'timeout':
			return 'unknown';
		case 'invalid_code':
		case 'expired_token':
			return 'invalid_code';
		case 'slow_down':
		case 'rate_limit_exceeded':
			return 'rate_limited';
		case 'authentication_required':
		case 'login_required':
			return 'login_required';
	}
	if (
		error?.error_code === CIBA_REQUEST_NOT_FOUND ||
		error?.error_code === CIBA_REQUEST_NOT_PENDING
	) {
		return 'request_gone';
	}
	return 'failed';
}

/**
 * The message for a failed device code lookup or decision. `fallback` names the step that failed
 * (look up, approve, deny) for errors the person cannot act on beyond trying again later.
 */
export function deviceApprovalErrorMessage(
	LL: TranslationFunctions,
	error: ApprovalApiError | null | undefined,
	fallback: string
): string {
	switch (classifyApprovalFailure(error)) {
		case 'invalid_code':
		case 'request_gone':
			return LL.device_errorInvalidOrExpiredCode();
		case 'consent_withdrawn':
			return LL.device_errorConsentWithdrawn();
		case 'retry':
		case 'unknown':
			// Looking a code up changes nothing; a decision without an answer is re-checked by the
			// page (see device-decision.ts) before this message is used.
			return LL.device_errorTryAgain();
		case 'rate_limited':
			return LL.device_errorTooManyAttempts();
		case 'login_required':
			return LL.error_login_required();
		case 'failed':
			return fallback;
	}
}

/** The message for a failed CIBA approval or denial. */
export function cibaApprovalErrorMessage(
	LL: TranslationFunctions,
	error: ApprovalApiError | null | undefined,
	fallback: string
): string {
	switch (classifyApprovalFailure(error)) {
		case 'request_gone':
		case 'invalid_code':
			return LL.ciba_errorRequestGone();
		case 'consent_withdrawn':
			return LL.ciba_errorConsentWithdrawn();
		case 'retry':
			return LL.ciba_errorTryAgain();
		case 'unknown':
			return LL.ciba_errorOutcomeUnknown();
		case 'rate_limited':
			return LL.ciba_errorTooManyAttempts();
		case 'login_required':
			return LL.error_login_required();
		case 'failed':
			return fallback;
	}
}
