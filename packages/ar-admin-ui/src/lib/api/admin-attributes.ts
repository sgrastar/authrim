/**
 * Admin Attributes API Client
 *
 * Provides methods for managing user attributes (ABAC):
 * - List and search attributes
 * - Create/update/delete attributes
 * - View verification history
 * - Attribute statistics
 */

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

// =============================================================================
// Types
// =============================================================================

/**
 * Attribute source type
 */
export type AttributeSourceType = 'vc' | 'saml' | 'manual';

/**
 * User attribute
 */
export interface UserAttribute {
	id: string;
	tenant_id: string;
	user_id: string;
	attribute_name: string;
	attribute_value: string;
	source_type: AttributeSourceType;
	issuer_did: string | null;
	verification_id: string | null;
	verified_at: number;
	expires_at: number | null;
	// Joined from users table
	user_email?: string | null;
	user_name?: string | null;
}

/**
 * Attribute verification record
 */
export interface AttributeVerification {
	id: string;
	tenant_id: string;
	user_id: string;
	vp_request_id: string | null;
	issuer_did: string;
	credential_type: string;
	format: string;
	verification_result: 'verified' | 'failed' | 'expired';
	holder_binding_verified: boolean;
	issuer_trusted: boolean;
	status_valid: boolean;
	mapped_attribute_ids: string[];
	verified_at: string;
	expires_at: string | null;
}

/**
 * Attribute statistics
 */
export interface AttributeStats {
	total: number;
	active: number;
	expired: number;
	unique_users: number;
	by_source: Array<{ source_type: string; count: number }>;
	by_name: Array<{ attribute_name: string; count: number }>;
	verifications: Array<{ verification_result: string; count: number }>;
}

/**
 * Pagination info
 */
export interface PaginationInfo {
	page: number;
	limit: number;
	total: number;
	total_pages: number;
}

/**
 * Attributes list response
 */
export interface AttributesListResponse {
	attributes: UserAttribute[];
	pagination: PaginationInfo;
}

/**
 * User attributes response
 */
export interface UserAttributesResponse {
	user: {
		id: string;
		email: string;
		name: string | null;
	} | null;
	attributes: UserAttribute[];
}

/**
 * Verifications list response
 */
export interface VerificationsListResponse {
	verifications: AttributeVerification[];
	pagination: PaginationInfo;
}

/**
 * Attribute name count
 */
export interface AttributeNameCount {
	attribute_name: string;
	count: number;
}

// =============================================================================
// API Client
// =============================================================================

/**
 * Admin Attributes API client
 */
export const adminAttributesAPI = {
	// =========================================================================
	// Attribute Management
	// =========================================================================

	/**
	 * List all user attributes with filtering
	 */
	async listAttributes(params?: {
		page?: number;
		limit?: number;
		user_id?: string;
		attribute_name?: string;
		source_type?: AttributeSourceType;
		include_expired?: boolean;
		search?: string;
	}): Promise<AttributesListResponse> {
		const searchParams = new URLSearchParams();
		if (params?.page) searchParams.set('page', params.page.toString());
		if (params?.limit) searchParams.set('limit', params.limit.toString());
		if (params?.user_id) searchParams.set('user_id', params.user_id);
		if (params?.attribute_name) searchParams.set('attribute_name', params.attribute_name);
		if (params?.source_type) searchParams.set('source_type', params.source_type);
		if (params?.include_expired) searchParams.set('include_expired', 'true');
		if (params?.search) searchParams.set('search', params.search);

		const response = await fetch(`${API_BASE_URL}/api/admin/attributes?${searchParams}`, {
			method: 'GET',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to list attributes');
		}

		return response.json();
	},

	/**
	 * Get attributes for a specific user
	 */
	async getUserAttributes(
		userId: string,
		includeExpired?: boolean
	): Promise<UserAttributesResponse> {
		const searchParams = new URLSearchParams();
		if (includeExpired) searchParams.set('include_expired', 'true');

		const response = await fetch(
			`${API_BASE_URL}/api/admin/attributes/users/${userId}?${searchParams}`,
			{
				method: 'GET',
				credentials: 'include'
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to get user attributes');
		}

		return response.json();
	},

	/**
	 * Create/assign an attribute to a user
	 */
	async createAttribute(data: {
		user_id: string;
		attribute_name: string;
		attribute_value: string;
		expires_at?: number;
	}): Promise<{ attribute: UserAttribute }> {
		const response = await fetch(`${API_BASE_URL}/api/admin/attributes`, {
			method: 'POST',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(data)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to create attribute');
		}

		return response.json();
	},

	/**
	 * Update an attribute
	 */
	async updateAttribute(
		id: string,
		data: {
			attribute_value?: string;
			expires_at?: number | null;
		}
	): Promise<{ success: boolean }> {
		const response = await fetch(`${API_BASE_URL}/api/admin/attributes/${id}`, {
			method: 'PUT',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(data)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to update attribute');
		}

		return response.json();
	},

	/**
	 * Delete an attribute
	 */
	async deleteAttribute(id: string): Promise<{ success: boolean }> {
		const response = await fetch(`${API_BASE_URL}/api/admin/attributes/${id}`, {
			method: 'DELETE',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to delete attribute');
		}

		return response.json();
	},

	// =========================================================================
	// Verification History
	// =========================================================================

	/**
	 * List verification history
	 */
	async listVerifications(params?: {
		page?: number;
		limit?: number;
		user_id?: string;
		result?: 'verified' | 'failed' | 'expired';
	}): Promise<VerificationsListResponse> {
		const searchParams = new URLSearchParams();
		if (params?.page) searchParams.set('page', params.page.toString());
		if (params?.limit) searchParams.set('limit', params.limit.toString());
		if (params?.user_id) searchParams.set('user_id', params.user_id);
		if (params?.result) searchParams.set('result', params.result);

		const response = await fetch(
			`${API_BASE_URL}/api/admin/attributes/verifications?${searchParams}`,
			{
				method: 'GET',
				credentials: 'include'
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to list verifications');
		}

		return response.json();
	},

	// =========================================================================
	// Statistics and Utilities
	// =========================================================================

	/**
	 * Get attribute statistics
	 */
	async getStats(): Promise<AttributeStats> {
		const response = await fetch(`${API_BASE_URL}/api/admin/attributes/stats`, {
			method: 'GET',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to get attribute stats');
		}

		return response.json();
	},

	/**
	 * Get unique attribute names
	 */
	async getAttributeNames(): Promise<{ attribute_names: AttributeNameCount[] }> {
		const response = await fetch(`${API_BASE_URL}/api/admin/attributes/names`, {
			method: 'GET',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to get attribute names');
		}

		return response.json();
	},

	/**
	 * Delete all expired attributes
	 */
	async deleteExpiredAttributes(): Promise<{ success: boolean; deleted_count: number }> {
		const response = await fetch(`${API_BASE_URL}/api/admin/attributes/expired`, {
			method: 'DELETE',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to delete expired attributes');
		}

		return response.json();
	}
};

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get friendly label for source type
 */
export function getSourceTypeLabel(sourceType: AttributeSourceType): string {
	switch (sourceType) {
		case 'vc':
			return 'Verifiable Credential';
		case 'saml':
			return 'SAML IdP';
		case 'manual':
			return 'Manual';
		default:
			return sourceType;
	}
}

/**
 * Get badge color class for source type
 */
export function getSourceTypeColor(sourceType: AttributeSourceType): string {
	switch (sourceType) {
		case 'vc':
			return 'vc'; // green
		case 'saml':
			return 'saml'; // blue
		case 'manual':
			return 'manual'; // gray
		default:
			return 'default';
	}
}

/**
 * Check if attribute is expired
 */
export function isAttributeExpired(attribute: UserAttribute): boolean {
	if (!attribute.expires_at) return false;
	return attribute.expires_at * 1000 < Date.now();
}

/**
 * Format expiration status
 */
export function formatExpirationStatus(expiresAt: number | null): string {
	if (!expiresAt) return 'Never expires';
	const now = Date.now();
	const expiresAtMs = expiresAt * 1000;
	if (expiresAtMs < now) {
		return 'Expired';
	}
	const daysUntil = Math.ceil((expiresAtMs - now) / (1000 * 60 * 60 * 24));
	if (daysUntil <= 7) {
		return `Expires in ${daysUntil} day${daysUntil === 1 ? '' : 's'}`;
	}
	return new Date(expiresAtMs).toLocaleDateString();
}
