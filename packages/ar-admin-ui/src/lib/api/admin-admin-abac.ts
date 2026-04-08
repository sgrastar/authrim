import { adminFetch } from '$lib/api/admin-request';
/**
 * Admin ABAC API Client (for Admin Operators)
 *
 * Provides API calls for Admin ABAC (Attribute-Based Access Control):
 * - Attribute definitions management
 * - Attribute value assignments to Admin users
 */

// API Base URL - empty string for same-origin, or full URL for cross-origin
const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

/**
 * Admin Attribute
 */
export interface AdminAttribute {
	id: string;
	tenant_id: string;
	name: string;
	display_name: string | null;
	description: string | null;
	attribute_type: 'string' | 'enum' | 'number' | 'boolean' | 'date' | 'array';
	allowed_values: string[] | null;
	min_value: number | null;
	max_value: number | null;
	regex_pattern: string | null;
	is_required: boolean;
	is_multi_valued: boolean;
	is_system: boolean;
	created_at: number;
	updated_at: number;
}

/**
 * Admin Attribute Value
 */
export interface AdminAttributeValue {
	id: string;
	tenant_id: string;
	admin_user_id: string;
	admin_attribute_id: string;
	value: string;
	value_index: number;
	source: string;
	expires_at: number | null;
	assigned_by: string | null;
	created_at: number;
	updated_at: number;
}

/**
 * Admin Attribute Create Input
 */
export interface AdminAttributeCreateInput {
	name: string;
	display_name?: string;
	description?: string;
	attribute_type?: 'string' | 'enum' | 'number' | 'boolean' | 'date' | 'array';
	allowed_values?: string[];
	min_value?: number;
	max_value?: number;
	regex_pattern?: string;
	is_required?: boolean;
	is_multi_valued?: boolean;
}

/**
 * Admin Attribute Update Input
 */
export interface AdminAttributeUpdateInput {
	display_name?: string;
	description?: string;
	allowed_values?: string[];
	min_value?: number;
	max_value?: number;
	regex_pattern?: string;
	is_required?: boolean;
	is_multi_valued?: boolean;
}

/**
 * Admin Attribute Value Set Input
 */
export interface AdminAttributeValueSetInput {
	value: string | number | boolean;
	value_index?: number;
	expires_at?: number;
}

/**
 * List response
 */
export interface ListResponse<T> {
	items: T[];
	total: number;
	limit?: number;
	offset?: number;
}

/**
 * Admin ABAC API
 */
export const adminAdminAbacAPI = {
	/**
	 * List all Admin attributes
	 * GET /api/admin/admin-attributes
	 */
	async listAttributes(params?: {
		include_system?: boolean;
		limit?: number;
		offset?: number;
	}): Promise<ListResponse<AdminAttribute>> {
		const queryParams = new URLSearchParams();
		if (params?.include_system) queryParams.set('include_system', 'true');
		if (params?.limit) queryParams.set('limit', params.limit.toString());
		if (params?.offset) queryParams.set('offset', params.offset.toString());

		const url = `${API_BASE_URL}/api/admin/admin-attributes${queryParams.toString() ? `?${queryParams}` : ''}`;
		const response = await adminFetch(url, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.message || 'Failed to list attributes');
		}

		return response.json();
	},

	/**
	 * Get Admin attribute by ID
	 * GET /api/admin/admin-attributes/:id
	 */
	async getAttribute(id: string): Promise<AdminAttribute> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/admin-attributes/${id}`, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.message || 'Failed to get attribute');
		}

		return response.json();
	},

	/**
	 * Create new Admin attribute
	 * POST /api/admin/admin-attributes
	 */
	async createAttribute(input: AdminAttributeCreateInput): Promise<AdminAttribute> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/admin-attributes`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			credentials: 'include',
			body: JSON.stringify(input)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.message || 'Failed to create attribute');
		}

		return response.json();
	},

	/**
	 * Update Admin attribute
	 * PATCH /api/admin/admin-attributes/:id
	 */
	async updateAttribute(id: string, input: AdminAttributeUpdateInput): Promise<AdminAttribute> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/admin-attributes/${id}`, {
			method: 'PATCH',
			headers: {
				'Content-Type': 'application/json'
			},
			credentials: 'include',
			body: JSON.stringify(input)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.message || 'Failed to update attribute');
		}

		return response.json();
	},

	/**
	 * Delete Admin attribute
	 * DELETE /api/admin/admin-attributes/:id
	 */
	async deleteAttribute(id: string): Promise<void> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/admin-attributes/${id}`, {
			method: 'DELETE',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.message || 'Failed to delete attribute');
		}
	},

	/**
	 * Get all attribute values for an Admin user
	 * GET /api/admin/admins/:userId/attributes
	 */
	async getAttributesByUser(userId: string): Promise<ListResponse<AdminAttributeValue>> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/admins/${userId}/attributes`, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.message || 'Failed to get user attributes');
		}

		return response.json();
	},

	/**
	 * Set attribute value for an Admin user
	 * PUT /api/admin/admins/:userId/attributes/:attributeId
	 */
	async setAttributeValue(
		userId: string,
		attributeId: string,
		input: AdminAttributeValueSetInput
	): Promise<AdminAttributeValue> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/admins/${userId}/attributes/${attributeId}`,
			{
				method: 'PUT',
				headers: {
					'Content-Type': 'application/json'
				},
				credentials: 'include',
				body: JSON.stringify(input)
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.message || 'Failed to set attribute value');
		}

		return response.json();
	},

	/**
	 * Delete attribute value for an Admin user
	 * DELETE /api/admin/admins/:userId/attributes/:attributeId
	 */
	async deleteAttributeValue(
		userId: string,
		attributeId: string,
		valueIndex?: number
	): Promise<void> {
		const queryParams = valueIndex !== undefined ? `?value_index=${valueIndex}` : '';
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/admins/${userId}/attributes/${attributeId}${queryParams}`,
			{
				method: 'DELETE',
				credentials: 'include'
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.message || 'Failed to delete attribute value');
		}
	}
};
