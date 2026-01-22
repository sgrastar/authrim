/**
 * Admin SCIM Tokens API Client
 *
 * Provides methods for managing SCIM provisioning tokens through the Admin API.
 * SCIM tokens are used for System for Cross-domain Identity Management (RFC 7643/7644).
 */

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

/**
 * SCIM Token information (without the actual token value)
 */
export interface ScimToken {
	tokenHash: string;
	description: string;
	expiresInDays: number;
	enabled: boolean;
}

/**
 * SCIM Token list response
 */
export interface ScimTokenListResponse {
	tokens: ScimToken[];
	total: number;
}

/**
 * Parameters for creating a new SCIM token
 */
export interface CreateScimTokenInput {
	description?: string;
	expiresInDays?: number;
}

/**
 * Response when a new SCIM token is created
 * Note: The 'token' field is only available at creation time
 */
export interface CreateScimTokenResponse {
	token: string; // Plain text token (shown only once!)
	tokenHash: string;
	description: string;
	expiresInDays: number;
	message: string;
}

export const adminScimTokensAPI = {
	/**
	 * List all SCIM tokens
	 */
	async list(): Promise<ScimTokenListResponse> {
		const response = await fetch(`${API_BASE_URL}/api/admin/scim-tokens`, {
			credentials: 'include'
		});
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to fetch SCIM tokens');
		}
		return response.json();
	},

	/**
	 * Create a new SCIM token
	 *
	 * IMPORTANT: The returned token value is only available at creation time.
	 * Save it securely as it cannot be retrieved later.
	 */
	async create(params?: CreateScimTokenInput): Promise<CreateScimTokenResponse> {
		const response = await fetch(`${API_BASE_URL}/api/admin/scim-tokens`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(params || {})
		});
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to create SCIM token');
		}
		return response.json();
	},

	/**
	 * Revoke (delete) a SCIM token
	 */
	async revoke(tokenHash: string): Promise<{ message: string }> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/scim-tokens/${encodeURIComponent(tokenHash)}`,
			{
				method: 'DELETE',
				credentials: 'include'
			}
		);
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to revoke SCIM token');
		}
		return response.json();
	}
};
