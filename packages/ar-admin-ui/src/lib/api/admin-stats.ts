/**
 * Admin Statistics API Client
 *
 * Provides API calls for dashboard statistics:
 * - Dashboard overview stats
 * - Recent activity
 */

// API Base URL - empty string for same-origin, or full URL for cross-origin
const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

/**
 * Get session ID from localStorage for Safari ITP compatibility
 */
function getSessionId(): string | null {
	if (typeof localStorage !== 'undefined') {
		return localStorage.getItem('sessionId');
	}
	return null;
}

/**
 * Build headers with session ID for Safari ITP compatibility
 */
function buildHeaders(): Record<string, string> {
	const headers: Record<string, string> = {};
	const sessionId = getSessionId();
	if (sessionId && sessionId !== 'session-from-cookie') {
		headers['X-Session-Id'] = sessionId;
	}
	return headers;
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
		const response = await fetch(`${API_BASE_URL}/api/admin/stats`, {
			credentials: 'include',
			headers: buildHeaders()
		});

		if (!response.ok) {
			throw new Error('Failed to fetch dashboard statistics');
		}

		return response.json();
	}
};
