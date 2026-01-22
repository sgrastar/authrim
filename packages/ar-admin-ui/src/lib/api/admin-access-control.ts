/**
 * Admin Access Control Hub API Client
 *
 * Provides API calls for the Access Control Hub:
 * - Aggregated statistics for RBAC, ABAC, ReBAC, and Policies
 */

// API Base URL - empty string for same-origin, or full URL for cross-origin
const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

/**
 * RBAC statistics
 */
export interface RBACStats {
	total_roles: number;
	total_assignments: number;
}

/**
 * ABAC statistics
 */
export interface ABACStats {
	total_attributes: number;
	active_attributes: number;
}

/**
 * ReBAC statistics
 */
export interface ReBACStats {
	total_definitions: number;
	total_tuples: number;
}

/**
 * Policy statistics
 */
export interface PolicyStats {
	total_policies: number;
	active_policies: number;
}

/**
 * Access Control Hub statistics response
 */
export interface AccessControlStats {
	rbac: RBACStats;
	abac: ABACStats;
	rebac: ReBACStats;
	policies: PolicyStats;
}

/**
 * Admin Access Control Hub API
 */
export const adminAccessControlAPI = {
	/**
	 * Get aggregated access control statistics
	 * GET /api/admin/access-control/stats
	 */
	async getStats(): Promise<AccessControlStats> {
		const response = await fetch(`${API_BASE_URL}/api/admin/access-control/stats`, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to fetch access control statistics');
		}

		return response.json();
	}
};
