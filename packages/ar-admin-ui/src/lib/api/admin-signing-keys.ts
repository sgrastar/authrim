/**
 * Admin Signing Keys API Client
 *
 * Provides API calls for JWT signing key management:
 * - Get signing keys status
 * - Normal rotation (24-hour overlap)
 * - Emergency rotation (immediate revocation)
 */

// API Base URL - empty string for same-origin, or full URL for cross-origin
const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

/**
 * Signing key status
 */
export type KeyStatus = 'active' | 'overlap' | 'revoked';

/**
 * Individual signing key info
 */
export interface SigningKeyInfo {
	kid: string;
	algorithm: string;
	status: KeyStatus;
	createdAt: string;
	revokedAt?: string;
	overlaps?: boolean;
}

/**
 * Signing keys status response
 */
export interface SigningKeysStatus {
	activeKeyId: string;
	keys: SigningKeyInfo[];
}

/**
 * Rotation result
 */
export interface RotationResult {
	success: boolean;
	message: string;
	revokedKeyId?: string;
	newKeyId?: string;
	warning?: string;
}

/**
 * Admin Signing Keys API
 */
export const adminSigningKeysAPI = {
	/**
	 * Get signing keys status
	 * GET /api/admin/signing-keys/status
	 */
	async getStatus(): Promise<SigningKeysStatus> {
		const response = await fetch(`${API_BASE_URL}/api/admin/signing-keys/status`, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.message || error.error || 'Failed to fetch signing keys status');
		}

		return response.json();
	},

	/**
	 * Normal key rotation (24-hour overlap period)
	 * POST /api/admin/signing-keys/rotate
	 *
	 * Creates a new signing key and marks the old key for revocation
	 * after a 24-hour overlap period. This allows existing tokens
	 * signed with the old key to remain valid during the transition.
	 */
	async rotate(): Promise<RotationResult> {
		const response = await fetch(`${API_BASE_URL}/api/admin/signing-keys/rotate`, {
			method: 'POST',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.message || error.error || 'Failed to rotate signing keys');
		}

		return response.json();
	},

	/**
	 * Emergency key rotation (immediate revocation)
	 * POST /api/admin/signing-keys/emergency-rotate
	 *
	 * Immediately revokes the current signing key and creates a new one.
	 * This should only be used in case of key compromise.
	 *
	 * WARNING: All existing tokens will become invalid immediately.
	 * JWKS cache on edge nodes may take up to 60 seconds to refresh.
	 *
	 * @param reason - Required reason for emergency rotation (min 10 characters)
	 */
	async emergencyRotate(reason: string): Promise<RotationResult> {
		if (!reason || reason.trim().length < 10) {
			throw new Error('Emergency rotation requires a reason of at least 10 characters');
		}

		const response = await fetch(`${API_BASE_URL}/api/admin/signing-keys/emergency-rotate`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			credentials: 'include',
			body: JSON.stringify({ reason: reason.trim() })
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.message || error.error || 'Failed to perform emergency rotation');
		}

		return response.json();
	}
};
