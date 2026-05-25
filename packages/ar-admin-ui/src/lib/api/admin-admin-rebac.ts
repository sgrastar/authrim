import { adminFetch } from '$lib/api/admin-request';
/**
 * Admin ReBAC API Client (for Admin Operators)
 *
 * Provides API calls for Admin ReBAC (Relationship-Based Access Control):
 * - Relationship type definitions management
 * - Relationship instances (tuples) management
 */

// API Base URL - empty string for same-origin, or full URL for cross-origin
const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

/**
 * Admin ReBAC Definition
 */
export interface AdminRebacDefinition {
	id: string;
	tenant_id: string;
	relation_name: string;
	display_name: string | null;
	description: string | null;
	priority: number;
	is_system: boolean;
	created_at: number;
	updated_at: number;
}

/**
 * Admin ReBAC Definition Create Input
 */
export interface AdminRebacDefinitionCreateInput {
	relation_name: string;
	display_name?: string;
	description?: string;
	priority?: number;
}

/**
 * Admin ReBAC Definition Update Input
 */
export interface AdminRebacDefinitionUpdateInput {
	display_name?: string;
	description?: string;
	priority?: number;
}

/**
 * Admin Relationship (Tuple)
 */
export interface AdminRelationship {
	id: string;
	tenant_id: string;
	relationship_type: string;
	from_type: string | null;
	from_id: string;
	to_type: string | null;
	to_id: string;
	permission_level: 'full' | 'limited' | 'read_only' | null;
	is_transitive: boolean;
	expires_at: number | null;
	is_bidirectional: boolean;
	metadata: Record<string, unknown> | null;
	created_by: string | null;
	created_at: number;
	updated_at: number;
}

/**
 * Admin Relationship Create Input
 */
export interface AdminRelationshipCreateInput {
	relationship_type: string;
	from_type?: string;
	from_id: string;
	to_type?: string;
	to_id: string;
	permission_level?: 'full' | 'limited' | 'read_only';
	is_transitive?: boolean;
	expires_at?: number;
	is_bidirectional?: boolean;
	metadata?: Record<string, unknown>;
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
 * Admin ReBAC API
 */
export const adminAdminRebacAPI = {
	// =============================================================================
	// ReBAC Definition Endpoints
	// =============================================================================

	/**
	 * List all ReBAC relationship type definitions
	 * GET /api/admin/admin-rebac-definitions
	 */
	async listDefinitions(params?: {
		include_system?: boolean;
		limit?: number;
		offset?: number;
	}): Promise<ListResponse<AdminRebacDefinition>> {
		const queryParams = new URLSearchParams();
		if (params?.include_system !== false) queryParams.set('include_system', 'true');
		if (params?.limit) queryParams.set('limit', params.limit.toString());
		if (params?.offset) queryParams.set('offset', params.offset.toString());

		const url = `${API_BASE_URL}/api/admin/admin-rebac-definitions${queryParams.toString() ? `?${queryParams}` : ''}`;
		const response = await adminFetch(url, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.message || 'Failed to list definitions');
		}

		return response.json();
	},

	/**
	 * Get ReBAC definition by ID
	 * GET /api/admin/admin-rebac-definitions/:id
	 */
	async getDefinition(id: string): Promise<AdminRebacDefinition> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/admin-rebac-definitions/${id}`, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.message || 'Failed to get definition');
		}

		return response.json();
	},

	/**
	 * Create new ReBAC relationship type definition
	 * POST /api/admin/admin-rebac-definitions
	 */
	async createDefinition(input: AdminRebacDefinitionCreateInput): Promise<AdminRebacDefinition> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/admin-rebac-definitions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			credentials: 'include',
			body: JSON.stringify(input)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.message || 'Failed to create definition');
		}

		return response.json();
	},

	/**
	 * Update ReBAC definition
	 * PATCH /api/admin/admin-rebac-definitions/:id
	 */
	async updateDefinition(
		id: string,
		input: AdminRebacDefinitionUpdateInput
	): Promise<AdminRebacDefinition> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/admin-rebac-definitions/${id}`, {
			method: 'PATCH',
			headers: {
				'Content-Type': 'application/json'
			},
			credentials: 'include',
			body: JSON.stringify(input)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.message || 'Failed to update definition');
		}

		return response.json();
	},

	/**
	 * Delete ReBAC definition
	 * DELETE /api/admin/admin-rebac-definitions/:id
	 */
	async deleteDefinition(id: string): Promise<void> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/admin-rebac-definitions/${id}`, {
			method: 'DELETE',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.message || 'Failed to delete definition');
		}
	},

	// =============================================================================
	// Relationship Endpoints
	// =============================================================================

	/**
	 * List all Admin relationships
	 * GET /api/admin/admin-relationships
	 */
	async listRelationships(params?: {
		type?: string;
		limit?: number;
		offset?: number;
	}): Promise<ListResponse<AdminRelationship>> {
		const queryParams = new URLSearchParams();
		if (params?.type) queryParams.set('type', params.type);
		if (params?.limit) queryParams.set('limit', params.limit.toString());
		if (params?.offset) queryParams.set('offset', params.offset.toString());

		const url = `${API_BASE_URL}/api/admin/admin-relationships${queryParams.toString() ? `?${queryParams}` : ''}`;
		const response = await adminFetch(url, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.message || 'Failed to list relationships');
		}

		return response.json();
	},

	/**
	 * Get Admin relationship by ID
	 * GET /api/admin/admin-relationships/:id
	 */
	async getRelationship(id: string): Promise<AdminRelationship> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/admin-relationships/${id}`, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.message || 'Failed to get relationship');
		}

		return response.json();
	},

	/**
	 * Create new Admin relationship
	 * POST /api/admin/admin-relationships
	 */
	async createRelationship(input: AdminRelationshipCreateInput): Promise<AdminRelationship> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/admin-relationships`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			credentials: 'include',
			body: JSON.stringify(input)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.message || 'Failed to create relationship');
		}

		return response.json();
	},

	/**
	 * Delete Admin relationship
	 * DELETE /api/admin/admin-relationships/:id
	 */
	async deleteRelationship(id: string): Promise<void> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/admin-relationships/${id}`, {
			method: 'DELETE',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.message || 'Failed to delete relationship');
		}
	},

	/**
	 * Get all relationships for an Admin user
	 * GET /api/admin/admins/:userId/relationships
	 */
	async getRelationshipsByUser(
		userId: string,
		params?: {
			type?: string;
			direction?: 'from' | 'to' | 'both';
		}
	): Promise<ListResponse<AdminRelationship>> {
		const queryParams = new URLSearchParams();
		if (params?.type) queryParams.set('type', params.type);
		if (params?.direction) queryParams.set('direction', params.direction);

		const url = `${API_BASE_URL}/api/admin/admins/${userId}/relationships${queryParams.toString() ? `?${queryParams}` : ''}`;
		const response = await adminFetch(url, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.message || 'Failed to get user relationships');
		}

		return response.json();
	},

	/**
	 * Create relationship for an Admin user
	 * POST /api/admin/admins/:userId/relationships
	 */
	async createRelationshipForUser(
		userId: string,
		input: Omit<AdminRelationshipCreateInput, 'from_id'>
	): Promise<AdminRelationship> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/admins/${userId}/relationships`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			credentials: 'include',
			body: JSON.stringify(input)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.message || 'Failed to create relationship for user');
		}

		return response.json();
	},

	/**
	 * Delete specific relationship for an Admin user
	 * DELETE /api/admin/admins/:userId/relationships/:relationshipId
	 */
	async deleteRelationshipForUser(userId: string, relationshipId: string): Promise<void> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/admins/${userId}/relationships/${relationshipId}`,
			{
				method: 'DELETE',
				credentials: 'include'
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.message || 'Failed to delete relationship for user');
		}
	}
};
