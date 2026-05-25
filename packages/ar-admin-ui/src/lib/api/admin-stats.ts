import { adminFetch } from '$lib/api/admin-request';
/**
 * Admin Statistics API Client
 *
 * Provides API calls for dashboard statistics:
 * - Dashboard overview stats
 * - Recent activity
 */

// API Base URL - empty string for same-origin, or full URL for cross-origin
const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

function buildHeaders(): Record<string, string> {
	return {};
}

/**
 * Dashboard statistics response
 */
export interface DashboardStats {
	stats: {
		activeUsers: number;
		totalUsers: number;
		registeredClients: number;
		newUsersToday: number;
		loginsToday: number;
	};
	recentActivity: Array<{
		type: string;
		userId: string;
		email: string | null;
		name: string | null;
		timestamp: number;
	}>;
}

/**
 * Admin Statistics API
 */
export const adminStatsAPI = {
	/**
	 * Get dashboard statistics
	 * GET /api/admin/stats
	 */
	async getDashboardStats(): Promise<DashboardStats> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/stats`, {
			credentials: 'include',
			headers: buildHeaders()
		});

		if (!response.ok) {
			throw new Error('Failed to fetch dashboard statistics');
		}

		return response.json();
	}
};
