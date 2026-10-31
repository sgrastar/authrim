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
import type { MessageKey } from '$lib/i18n/i18n.svelte';

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

/** Message key for a failure while completing the initial administrator setup. */
export function setupErrorKey(error: unknown): MessageKey {
	if (error instanceof SetupError) {
		switch (error.code) {
			case 'invalid_token':
				return 'setup.error.invalid';
			case 'token_used':
				return 'setup.error.used';
			case 'token_expired':
				return 'setup.error.expired';
			case 'user_not_found':
				return 'setup.error.userNotFound';
			case 'verification_failed':
				return 'setup.error.verification';
			default:
				return 'setup.error.generic';
		}
	}
	if (error instanceof Error) {
		if (error.name === 'NotAllowedError') return 'login.error.cancelled';
		if (error.name === 'NotSupportedError') return 'login.error.unsupported';
		if (error.name === 'SecurityError') return 'login.error.security';
	}
	return 'setup.error.generic';
}
