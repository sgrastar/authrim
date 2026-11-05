/**
 * In-session passkey re-authentication for operations that need a fresh admin sign-in.
 *
 * The Admin API refuses such an operation with 403 and an error code ending in
 * `fresh_auth_required` (or `fresh_auth_required: true` in the body) once the session's last
 * passkey verification is older than the window. `withFreshAuth` asks for the passkey again and
 * repeats the operation once.
 */
import {
	startAuthentication,
	WebAuthnAbortService,
	type AuthenticationResponseJSON,
	type PublicKeyCredentialRequestOptionsJSON
} from '@simplewebauthn/browser';
import { adminFetch, API_BASE_URL } from '#lib/api/admin-request.js';
import { ApiError } from '#lib/api/api-error.js';

const PASSKEY_CEREMONY_TIMEOUT_MS = 120_000;

interface ReauthOptionsResponse {
	options: PublicKeyCredentialRequestOptionsJSON;
	challenge_id: string;
}

export interface ReauthResult {
	verified: true;
	authenticated_at: number;
}

/** POST JSON to the Admin API; a refusal becomes an ApiError with the body's code. */
export async function postJson<T>(path: string, body: unknown): Promise<T> {
	const response = await adminFetch(`${API_BASE_URL}${path}`, {
		method: 'POST',
		includeJsonContentType: true,
		body: JSON.stringify(body)
	});
	const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	if (!response.ok) {
		const code = typeof payload.error === 'string' ? payload.error : '';
		const message =
			typeof payload.error_description === 'string'
				? payload.error_description
				: `Re-authentication failed (${response.status})`;
		throw new ApiError(response.status, code, message, payload);
	}
	return payload as T;
}

/** The ceremony would otherwise wait on the browser prompt for as long as the user leaves it. */
export async function withCeremonyTimeout<T>(ceremony: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			ceremony,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					WebAuthnAbortService.cancelCeremony();
					reject(new ApiError(0, 'reauth_timeout', 'Passkey confirmation timed out'));
				}, PASSKEY_CEREMONY_TIMEOUT_MS);
			})
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Ask for one of the admin's own passkeys again and record it on the current session. */
export async function reauthenticateWithPasskey(): Promise<ReauthResult> {
	const { options, challenge_id } = await postJson<ReauthOptionsResponse>(
		'/api/admin/me/reauth/passkey/options',
		{ rp_id: window.location.hostname }
	);
	const credential: AuthenticationResponseJSON = await withCeremonyTimeout(
		startAuthentication({ optionsJSON: options })
	);
	return postJson<ReauthResult>('/api/admin/me/reauth/passkey/verify', {
		challenge_id,
		credential
	});
}

/** Whether a failed Admin API call asks for a fresh admin authentication. */
export function isFreshAuthRequired(error: unknown): boolean {
	if (!(error instanceof ApiError) || error.status !== 403) return false;
	return error.code.endsWith('fresh_auth_required') || error.body.fresh_auth_required === true;
}

/**
 * Run an operation; when it is refused for want of a fresh authentication, re-authenticate with
 * a passkey and run it once more. A second refusal is passed on as it is.
 */
export async function withFreshAuth<T>(
	operation: () => Promise<T>,
	reauthenticate: () => Promise<unknown> = reauthenticateWithPasskey
): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (!isFreshAuthRequired(error)) throw error;
	}
	await reauthenticate();
	return operation();
}
