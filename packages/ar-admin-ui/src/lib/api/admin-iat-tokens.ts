/**
 * Admin IAT (Initial Access Tokens) API Client
 *
 * Provides methods for managing Initial Access Tokens through the Admin API.
 * IAT tokens are used for Dynamic Client Registration (RFC 7591).
 */

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

/**
 * IAT Token information (without the actual token value)
 */
export interface IatToken {
	tokenHash: string;
	description: string;
	createdAt: string;
	expiresAt: string | null;
	single_use: boolean;
}

/**
 * IAT Token list response
 */
export interface IatTokenListResponse {
	tokens: IatToken[];
	total: number;
}

/**
 * Parameters for creating a new IAT token
 */
export interface CreateIatTokenInput {
	description?: string;
	expiresInDays?: number;
	single_use?: boolean;
}

/**
 * Response when a new IAT token is created
 * Note: The 'token' field is only available at creation time
 */
export interface CreateIatTokenResponse {
	token: string; // Plain text token (shown only once!)
	tokenHash: string;
	description: string;
	expiresInDays: number;
	single_use: boolean;
	message: string;
}

export const adminIatTokensAPI = {
	/**
	 * List all IAT tokens
	 */
	async list(): Promise<IatTokenListResponse> {
		const response = await fetch(`${API_BASE_URL}/api/admin/iat-tokens`, {
			credentials: 'include'
		});
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to fetch IAT tokens');
		}
		return response.json();
	},

	/**
	 * Create a new IAT token
	 *
	 * IMPORTANT: The returned token value is only available at creation time.
	 * Save it securely as it cannot be retrieved later.
	 */
	async create(params?: CreateIatTokenInput): Promise<CreateIatTokenResponse> {
		const response = await fetch(`${API_BASE_URL}/api/admin/iat-tokens`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(params || {})
		});
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to create IAT token');
		}
		return response.json();
	},

	/**
	 * Revoke (delete) an IAT token
	 */
	async revoke(tokenHash: string): Promise<{ message: string }> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/iat-tokens/${encodeURIComponent(tokenHash)}`,
			{
				method: 'DELETE',
				credentials: 'include'
			}
		);
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to revoke IAT token');
		}
		return response.json();
	}
};
