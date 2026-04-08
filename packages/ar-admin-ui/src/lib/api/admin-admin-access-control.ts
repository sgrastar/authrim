import { adminFetch } from '$lib/api/admin-request';
/**
 * Admin Access Control Hub API Client (for Admin Operators)
 *
 * Provides API calls for the Admin Access Control Hub:
 * - Aggregated statistics for Admin RBAC, ABAC, ReBAC, and Policies
 */

// API Base URL - empty string for same-origin, or full URL for cross-origin
const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

/**
 * Admin RBAC statistics
 */
export interface AdminRBACStats {
	total_roles: number;
	total_assignments: number;
}

/**
 * Admin ABAC statistics
 */
export interface AdminABACStats {
	total_attributes: number;
	active_attributes: number;
}

/**
 * Admin ReBAC statistics
 */
export interface AdminReBACStats {
	total_definitions: number;
	total_tuples: number;
}

/**
 * Admin Policy statistics
 */
export interface AdminPolicyStats {
	total_policies: number;
	active_policies: number;
}

/**
 * Admin Access Control Hub statistics response
 */
export interface AdminAccessControlStats {
	rbac: AdminRBACStats;
	abac: AdminABACStats;
	rebac: AdminReBACStats;
	policies: AdminPolicyStats;
}

/**
 * Admin Access Control Hub API (for Admin Operators)
 */
export const adminAdminAccessControlAPI = {
	/**
	 * Get aggregated admin access control statistics
	 * GET /api/admin/admin-access-control/stats
	 */
	async getStats(): Promise<AdminAccessControlStats> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/admin-access-control/stats`, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to fetch admin access control statistics');
		}

		return response.json();
	}
};
