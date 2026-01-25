/**
 * Admin UI Setup API Client
 *
 * Provides API calls for Admin UI passkey registration during initial setup.
 * These endpoints are called after the initial setup on Router.
 *
 * Flow:
 * 1. Verify setup token
 * 2. Get passkey registration options (with Admin UI's RP ID)
 * 3. Complete passkey registration
 */

import type {
	PublicKeyCredentialCreationOptionsJSON,
	RegistrationResponseJSON
} from '@simplewebauthn/browser';

// API Base URL - empty string for same-origin, or full URL for cross-origin
const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

/**
 * Error class for setup errors
 */
export class SetupError extends Error {
	constructor(
		public code: string,
		message: string
	) {
		super(message);
		this.name = 'SetupError';
	}
}

/**
 * Admin user info from setup token verification
 */
export interface SetupUserInfo {
	id: string;
	email: string;
	name: string | null;
}

/**
 * Admin Setup API
 */
export const adminSetupAPI = {
	/**
	 * Verify setup token and get admin user info
	 * POST /api/admin/setup-token/verify
	 */
	async verifyToken(token: string): Promise<{ valid: boolean; user: SetupUserInfo }> {
		const response = await fetch(`${API_BASE_URL}/api/admin/setup-token/verify`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ token })
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new SetupError(
				error.error || 'verification_failed',
				error.error_description || 'Failed to verify setup token'
			);
		}

		return response.json();
	},

	/**
	 * Get passkey registration options
	 * POST /api/admin/setup-token/passkey/options
	 */
	async getPasskeyOptions(
		token: string,
		rpId: string
	): Promise<{
		options: PublicKeyCredentialCreationOptionsJSON;
		challenge_id: string;
	}> {
		const response = await fetch(`${API_BASE_URL}/api/admin/setup-token/passkey/options`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ token, rp_id: rpId })
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new SetupError(
				error.error || 'options_failed',
				error.error_description || 'Failed to get passkey options'
			);
		}

		return response.json();
	},

	/**
	 * Complete passkey registration
	 * POST /api/admin/setup-token/passkey/complete
	 */
	async completePasskeyRegistration(
		token: string,
		challengeId: string,
		passkeyResponse: RegistrationResponseJSON,
		origin: string
	): Promise<{ success: boolean; user: SetupUserInfo }> {
		const response = await fetch(`${API_BASE_URL}/api/admin/setup-token/passkey/complete`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				token,
				challenge_id: challengeId,
				passkey_response: passkeyResponse,
				origin
			})
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new SetupError(
				error.error || 'registration_failed',
				error.error_description || 'Failed to complete passkey registration'
			);
		}

		return response.json();
	}
};

/**
 * Get user-friendly error message for setup errors
 */
export function getSetupErrorMessage(error: unknown): string {
	if (error instanceof SetupError) {
		switch (error.code) {
			case 'invalid_token':
				return 'Setup token not found. Please check the URL or request a new token.';
			case 'token_used':
				return 'This setup token has already been used.';
			case 'token_expired':
				return 'Setup token has expired. Please request a new token using the CLI.';
			case 'user_not_found':
				return 'Admin user not found. Please contact support.';
			case 'verification_failed':
				return 'Passkey verification failed. Please try again.';
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
	}

	return 'An unexpected error occurred.';
}
