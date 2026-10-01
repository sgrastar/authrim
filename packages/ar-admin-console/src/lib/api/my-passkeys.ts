/**
 * The signed-in administrator's own passkeys. Copied from the legacy Admin UI
 * (ar-admin-ui/src/lib/api/my-passkeys.ts); error text is resolved to message keys here.
 */

import type {
	PublicKeyCredentialCreationOptionsJSON,
	RegistrationResponseJSON
} from '@simplewebauthn/browser';
import { adminFetch } from '$lib/api/admin-request';
import type { MessageKey } from '$lib/i18n/i18n.svelte';

/** Authenticator vendor resolved from the AAGUID (from the Admin API). */
export interface PasskeyProvider {
	aaguid: string;
	name: string | null;
	icon_dark: string | null;
	icon_light: string | null;
	known: boolean;
}

// API Base URL - empty string for same-origin, or full URL for cross-origin
const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

/**
 * Error class for PassKey API errors
 */
export class PasskeyError extends Error {
	constructor(
		public code: string,
		message: string
	) {
		super(message);
		this.name = 'PasskeyError';
	}
}

/**
 * PassKey info (sanitized, without sensitive fields)
 */
export interface AdminPasskey {
	id: string;
	device_name: string | null;
	aaguid: string | null;
	provider: PasskeyProvider | null;
	created_at: number;
	last_used_at: number | null;
}

/**
 * PassKey list response
 */
export interface AdminPasskeyListResponse {
	passkeys: AdminPasskey[];
	total: number;
}

/**
 * PassKey registration options response
 */
export interface PasskeyOptionsResponse {
	options: PublicKeyCredentialCreationOptionsJSON;
	challenge_id: string;
}

/**
 * PassKey registration complete response
 */
export interface PasskeyCompleteResponse {
	success: boolean;
	passkey: AdminPasskey;
}

/**
 * My PassKey API
 */
export const myPasskeysAPI = {
	/**
	 * List own PassKeys
	 * GET /api/admin/me/passkeys
	 */
	async list(): Promise<AdminPasskeyListResponse> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/me/passkeys`, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new PasskeyError(
				error.error || 'list_failed',
				error.error_description || 'Failed to fetch passkeys'
			);
		}

		return response.json();
	},

	/**
	 * Get registration options (WebAuthn challenge)
	 * POST /api/admin/me/passkeys/options
	 */
	async getRegistrationOptions(rpId: string, deviceName?: string): Promise<PasskeyOptionsResponse> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/me/passkeys/options`, {
			method: 'POST',
			includeJsonContentType: true,
			credentials: 'include',
			body: JSON.stringify({
				rp_id: rpId,
				device_name: deviceName
			})
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new PasskeyError(
				error.error || 'options_failed',
				error.error_description || 'Failed to get registration options'
			);
		}

		return response.json();
	},

	/**
	 * Complete PassKey registration
	 * POST /api/admin/me/passkeys/complete
	 */
	async completeRegistration(
		challengeId: string,
		passkeyResponse: RegistrationResponseJSON,
		origin: string,
		deviceName?: string
	): Promise<PasskeyCompleteResponse> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/me/passkeys/complete`, {
			method: 'POST',
			includeJsonContentType: true,
			credentials: 'include',
			body: JSON.stringify({
				challenge_id: challengeId,
				passkey_response: passkeyResponse,
				origin,
				device_name: deviceName
			})
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new PasskeyError(
				error.error || 'registration_failed',
				error.error_description || 'Failed to complete passkey registration'
			);
		}

		return response.json();
	},

	/**
	 * Update PassKey device name
	 * PATCH /api/admin/me/passkeys/:id
	 */
	async updateDeviceName(
		id: string,
		deviceName: string
	): Promise<{ success: boolean; passkey: AdminPasskey }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/me/passkeys/${encodeURIComponent(id)}`,
			{
				method: 'PATCH',
				includeJsonContentType: true,
				credentials: 'include',
				body: JSON.stringify({ device_name: deviceName })
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new PasskeyError(
				error.error || 'update_failed',
				error.error_description || 'Failed to update passkey'
			);
		}

		return response.json();
	},

	/**
	 * Delete a PassKey
	 * DELETE /api/admin/me/passkeys/:id
	 */
	async delete(id: string): Promise<{ success: boolean; message: string }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/me/passkeys/${encodeURIComponent(id)}`,
			{
				method: 'DELETE',
				credentials: 'include'
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new PasskeyError(
				error.error || 'delete_failed',
				error.error_description || 'Failed to delete passkey'
			);
		}

		return response.json();
	}
};

/** Message key for a passkey management failure. */
export function passkeyErrorKey(error: unknown): MessageKey {
	if (error instanceof PasskeyError) {
		switch (error.code) {
			case 'credential_exists':
				return 'me.passkey.duplicate';
			case 'last_passkey':
				return 'me.passkey.last';
			case 'invalid_challenge':
			case 'verification_failed':
				return 'me.passkey.failed';
			default:
				return 'me.passkey.error';
		}
	}
	if (error instanceof Error) {
		if (error.name === 'NotAllowedError') return 'login.error.cancelled';
		if (error.name === 'NotSupportedError') return 'login.error.unsupported';
		if (error.name === 'SecurityError') return 'login.error.security';
		if (error.name === 'InvalidStateError') return 'me.passkey.duplicate';
	}
	return 'me.passkey.error';
}
