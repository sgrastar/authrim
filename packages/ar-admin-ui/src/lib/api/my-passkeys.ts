/**
 * My PassKey API Client
 *
 * API client for managing the current admin user's own PassKeys.
 */

import type {
	PublicKeyCredentialCreationOptionsJSON,
	RegistrationResponseJSON
} from '@simplewebauthn/browser';

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
		const response = await fetch(`${API_BASE_URL}/api/admin/me/passkeys`, {
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
		const response = await fetch(`${API_BASE_URL}/api/admin/me/passkeys/options`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
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
		const response = await fetch(`${API_BASE_URL}/api/admin/me/passkeys/complete`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
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
		const response = await fetch(
			`${API_BASE_URL}/api/admin/me/passkeys/${encodeURIComponent(id)}`,
			{
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
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
		const response = await fetch(
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

/**
 * Get user-friendly error message for PassKey errors
 */
export function getPasskeyErrorMessage(error: unknown): string {
	if (error instanceof PasskeyError) {
		switch (error.code) {
			case 'invalid_challenge':
				return 'Registration session expired. Please try again.';
			case 'verification_failed':
				return 'Passkey verification failed. Please try again.';
			case 'credential_exists':
				return 'This passkey is already registered.';
			case 'last_passkey':
				return 'Cannot delete the last passkey. You need at least one passkey to sign in.';
			case 'invalid_request':
				return error.message || 'Invalid request. Please check your input.';
			default:
				return error.message || 'An error occurred. Please try again.';
		}
	}

	// WebAuthn errors
	if (error instanceof Error) {
		if (error.name === 'NotAllowedError') {
			return 'Passkey registration was cancelled or timed out.';
		}
		if (error.name === 'NotSupportedError') {
			return 'Passkey registration is not supported on this device.';
		}
		if (error.name === 'SecurityError') {
			return 'Security error. Please ensure you are on a secure connection.';
		}
		if (error.name === 'InvalidStateError') {
			return 'This authenticator is already registered.';
		}
	}

	return 'An unexpected error occurred.';
}
