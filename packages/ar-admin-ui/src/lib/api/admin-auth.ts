/**
 * Admin Authentication API Client
 *
 * Provides API calls for Admin UI authentication:
 * - Passkey login (WebAuthn)
 * - Session status check
 * - Logout
 *
 * All endpoints use credentials: 'include' for cookie-based authentication.
 */

import type {
	PublicKeyCredentialRequestOptionsJSON,
	AuthenticationResponseJSON
} from '@simplewebauthn/browser';

// API Base URL - empty string for same-origin, or full URL for cross-origin
const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

/**
 * Error class for authentication errors
 */
export class AuthError extends Error {
	constructor(
		public code: string,
		message: string
	) {
		super(message);
		this.name = 'AuthError';
	}
}

/**
 * Session status response from /api/admin/sessions/me
 */
export interface SessionStatus {
	active: boolean;
	session_id: string;
	user_id: string;
	email?: string;
	name?: string;
	roles: string[];
	expires_at: number;
	created_at: number;
	last_login_at?: number | null;
}

/**
 * Login verification result
 */
export interface LoginResult {
	verified: boolean;
	sessionId: string;
	userId: string;
	user: {
		id: string;
		email: string | null;
		name: string | null;
		email_verified: boolean;
	};
}

/**
 * Admin Authentication API
 */
export const adminAuthAPI = {
	/**
	 * Get Passkey login options (WebAuthn challenge)
	 * POST /api/auth/passkeys/login/options
	 */
	async getLoginOptions(): Promise<{
		options: PublicKeyCredentialRequestOptionsJSON;
		challengeId: string;
	}> {
		const response = await fetch(`${API_BASE_URL}/api/auth/passkeys/login/options`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify({})
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new AuthError(
				error.error || 'login_options_failed',
				error.error_description || 'Failed to get login options'
			);
		}

		return response.json();
	},

	/**
	 * Verify Passkey login
	 * POST /api/auth/passkeys/login/verify
	 */
	async verifyLogin(
		challengeId: string,
		credential: AuthenticationResponseJSON
	): Promise<LoginResult> {
		const response = await fetch(`${API_BASE_URL}/api/auth/passkeys/login/verify`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify({ challengeId, credential })
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new AuthError(
				error.error || 'login_failed',
				error.error_description || 'Login verification failed'
			);
		}

		return response.json();
	},

	/**
	 * Check current session status
	 * GET /api/admin/sessions/me
	 *
	 * Returns:
	 * - SessionStatus if authenticated with admin role
	 * - null if not authenticated (401) or no admin role (403)
	 * - throws AuthError with 'forbidden' code if session exists but no admin role
	 */
	async checkSession(): Promise<SessionStatus | null> {
		const response = await fetch(`${API_BASE_URL}/api/admin/sessions/me`, {
			credentials: 'include'
		});

		if (response.status === 401) {
			// Not authenticated
			return null;
		}

		if (response.status === 403) {
			// Authenticated but no admin role
			const error = await response.json().catch(() => ({ error: 'forbidden' }));
			throw new AuthError(
				'forbidden',
				error.error_description || 'You do not have admin permissions'
			);
		}

		if (!response.ok) {
			// Other errors
			return null;
		}

		return response.json();
	},

	/**
	 * Logout
	 * POST /api/admin/logout
	 */
	async logout(): Promise<void> {
		await fetch(`${API_BASE_URL}/api/admin/logout`, {
			method: 'POST',
			credentials: 'include'
		});
		// Redirect to login page after logout
		window.location.href = '/admin/login';
	}
};

/**
 * Get user-friendly error message
 */
export function getAuthErrorMessage(error: unknown): string {
	if (error instanceof AuthError) {
		switch (error.code) {
			case 'forbidden':
				return 'You do not have permission to access this area.';
			case 'session_expired':
				return 'Your session has expired. Please log in again.';
			case 'invalid_token':
			case 'invalid_credentials':
				return 'Authentication failed. Please try again.';
			case 'auth_passkey_failed':
				return 'Passkey authentication failed. Please try again.';
			default:
				return error.message || 'An error occurred. Please try again.';
		}
	}

	// WebAuthn errors
	if (error instanceof Error) {
		if (error.name === 'NotAllowedError') {
			return 'Authentication was cancelled or timed out.';
		}
		if (error.name === 'NotSupportedError') {
			return 'Passkey authentication is not supported on this device.';
		}
		if (error.name === 'SecurityError') {
			return 'Security error. Please ensure you are on a secure connection.';
		}
	}

	return 'An unexpected error occurred.';
}
