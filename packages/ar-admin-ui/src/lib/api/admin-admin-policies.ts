import { adminFetch } from '$lib/api/admin-request';
/**
 * Admin Policies API Client (for Admin Operators)
 *
 * Provides API calls for Admin Policies (combined RBAC/ABAC/ReBAC):
 * - Policy CRUD operations
 * - Policy simulation and evaluation
 */

// API Base URL - empty string for same-origin, or full URL for cross-origin
const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

/**
 * Policy conditions structure
 */
export interface AdminPolicyConditions {
	roles?: string[];
	attributes?: Record<
		string,
		{
			equals?: string | number | boolean;
			not_equals?: string | number | boolean;
			contains?: string;
			in?: (string | number)[];
			gte?: number;
			lte?: number;
			gt?: number;
			lt?: number;
		}
	>;
	relationships?: Record<
		string,
		{
			target_type?: string;
			permission_level?: string;
		}
	>;
	condition_type?: 'all' | 'any';
}

/**
 * Admin Policy
 */
export interface AdminPolicy {
	id: string;
	tenant_id: string;
	name: string;
	display_name: string | null;
	description: string | null;
	effect: 'allow' | 'deny';
	priority: number;
	resource_pattern: string;
	actions: string[];
	conditions: AdminPolicyConditions;
	is_active: boolean;
	is_system: boolean;
	created_at: number;
	updated_at: number;
}

/**
 * Admin Policy Create Input
 */
export interface AdminPolicyCreateInput {
	name: string;
	display_name?: string;
	description?: string;
	effect?: 'allow' | 'deny';
	priority?: number;
	resource_pattern: string;
	actions?: string[];
	conditions?: AdminPolicyConditions;
}

/**
 * Admin Policy Update Input
 */
export interface AdminPolicyUpdateInput {
	display_name?: string;
	description?: string;
	effect?: 'allow' | 'deny';
	priority?: number;
	resource_pattern?: string;
	actions?: string[];
	conditions?: AdminPolicyConditions;
}

/**
 * Policy Simulation Input
 */
export interface PolicySimulationInput {
	resource: string;
	action: string;
	admin_user_context: {
		roles?: string[];
		attributes?: Record<string, string | number | boolean>;
		relationships?: Array<{ type: string; target: string }>;
	};
}

/**
 * Policy Simulation Result
 */
export interface PolicySimulationResult {
	resource: string;
	action: string;
	decision: 'allow' | 'deny' | 'no_match';
	evaluations: Array<{
		policy_id: string;
		policy_name: string;
		matched: boolean;
		effect: 'allow' | 'deny';
		priority: number;
		condition_results: Record<string, boolean>;
	}>;
	total_policies_evaluated: number;
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
 * Admin Policies API
 */
export const adminAdminPoliciesAPI = {
	/**
	 * List all Admin policies
	 * GET /api/admin/admin-policies
	 */
	async listPolicies(params?: {
		active_only?: boolean;
		resource?: string;
		limit?: number;
		offset?: number;
	}): Promise<ListResponse<AdminPolicy>> {
		const queryParams = new URLSearchParams();
		if (params?.active_only) queryParams.set('active_only', 'true');
		if (params?.resource) queryParams.set('resource', params.resource);
		if (params?.limit) queryParams.set('limit', params.limit.toString());
		if (params?.offset) queryParams.set('offset', params.offset.toString());

		const url = `${API_BASE_URL}/api/admin/admin-policies${queryParams.toString() ? `?${queryParams}` : ''}`;
		const response = await adminFetch(url, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.message || 'Failed to list policies');
		}

		return response.json();
	},

	/**
	 * Get Admin policy by ID
	 * GET /api/admin/admin-policies/:id
	 */
	async getPolicy(id: string): Promise<AdminPolicy> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/admin-policies/${id}`, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.message || 'Failed to get policy');
		}

		return response.json();
	},

	/**
	 * Create new Admin policy
	 * POST /api/admin/admin-policies
	 */
	async createPolicy(input: AdminPolicyCreateInput): Promise<AdminPolicy> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/admin-policies`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			credentials: 'include',
			body: JSON.stringify(input)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.message || 'Failed to create policy');
		}

		return response.json();
	},

	/**
	 * Update Admin policy
	 * PATCH /api/admin/admin-policies/:id
	 */
	async updatePolicy(id: string, input: AdminPolicyUpdateInput): Promise<AdminPolicy> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/admin-policies/${id}`, {
			method: 'PATCH',
			headers: {
				'Content-Type': 'application/json'
			},
			credentials: 'include',
			body: JSON.stringify(input)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.message || 'Failed to update policy');
		}

		return response.json();
	},

	/**
	 * Activate Admin policy
	 * POST /api/admin/admin-policies/:id/activate
	 */
	async activatePolicy(id: string): Promise<AdminPolicy> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/admin-policies/${id}/activate`, {
			method: 'POST',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.message || 'Failed to activate policy');
		}

		return response.json();
	},

	/**
	 * Deactivate Admin policy
	 * POST /api/admin/admin-policies/:id/deactivate
	 */
	async deactivatePolicy(id: string): Promise<AdminPolicy> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/admin-policies/${id}/deactivate`, {
			method: 'POST',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.message || 'Failed to deactivate policy');
		}

		return response.json();
	},

	/**
	 * Delete Admin policy
	 * DELETE /api/admin/admin-policies/:id
	 */
	async deletePolicy(id: string): Promise<void> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/admin-policies/${id}`, {
			method: 'DELETE',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.message || 'Failed to delete policy');
		}
	},

	/**
	 * Simulate policy evaluation
	 * POST /api/admin/admin-policies/simulate
	 */
	async simulatePolicy(input: PolicySimulationInput): Promise<PolicySimulationResult> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/admin-policies/simulate`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			credentials: 'include',
			body: JSON.stringify(input)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.message || 'Failed to simulate policy');
		}

		return response.json();
	}
};
