/**
 * Admin Sessions API Client
 *
 * Provides API calls for session management:
 * - List sessions with filtering and pagination
 * - Get session details
 * - Revoke individual sessions
 * - Revoke all sessions for a user
 */

import { API_BASE_URL, adminFetch } from './admin-request';

/**
 * Pagination info
 */
export interface Pagination {
	page: number;
	limit: number;
	total: number;
	totalPages: number;
	hasNext: boolean;
	hasPrev: boolean;
}

/**
 * Session entity
 */
export interface Session {
	id: string;
	user_id: string;
	user_email: string | null;
	user_name: string | null;
	created_at: string;
	last_accessed_at: string;
	expires_at: string;
	ip_address: string | null;
	user_agent: string | null;
	is_active: boolean;
}

/**
 * Session list response
 */
export interface SessionListResponse {
	sessions: Session[];
	pagination: Pagination;
}

/**
 * Session list parameters
 */
export interface SessionListParams {
	page?: number;
	limit?: number;
	user_id?: string;
	status?: 'active' | 'expired';
}

/**
 * Session detail response
 */
export interface SessionDetailResponse {
	session: {
		id: string;
		userId: string;
		userEmail: string | null;
		userName: string | null;
		expiresAt: number;
		createdAt: number;
		isActive: boolean;
		source: 'memory' | 'database';
	};
}

/**
 * Revoke response
 */
export interface RevokeResponse {
	success: boolean;
	message: string;
	sessionId?: string;
	revokedCount?: number;
}

/**
 * Admin Sessions API
 */
export const adminSessionsAPI = {
	/**
	 * List sessions with filtering and pagination
	 * GET /api/admin/sessions
	 */
	async list(params?: SessionListParams): Promise<SessionListResponse> {
		const searchParams = new URLSearchParams();

		if (params?.page) searchParams.set('page', String(params.page));
		if (params?.limit) searchParams.set('limit', String(params.limit));
		if (params?.user_id) searchParams.set('user_id', params.user_id);
		if (params?.status) searchParams.set('status', params.status);

		const queryString = searchParams.toString();
		const url = `${API_BASE_URL}/api/admin/sessions${queryString ? `?${queryString}` : ''}`;

		const response = await adminFetch(url);

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.error_description || error.error || 'Failed to fetch sessions');
		}

		return response.json();
	},

	/**
	 * Get session details
	 * GET /api/admin/sessions/:id
	 */
	async get(id: string): Promise<SessionDetailResponse> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/sessions/${id}`);

		if (!response.ok) {
			if (response.status === 404) {
				throw new Error('Session not found');
			}
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.error_description || error.error || 'Failed to fetch session');
		}

		return response.json();
	},

	/**
	 * Revoke (delete) a session
	 * DELETE /api/admin/sessions/:id
	 */
	async revoke(id: string): Promise<RevokeResponse> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/sessions/${id}`, {
			method: 'DELETE'
		});

		if (!response.ok) {
			if (response.status === 404) {
				throw new Error('Session not found');
			}
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.error_description || error.error || 'Failed to revoke session');
		}

		return response.json();
	},

	/**
	 * Revoke all sessions for a user
	 * DELETE /api/admin/users/:id/sessions
	 */
	async revokeAllForUser(userId: string): Promise<RevokeResponse> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/users/${userId}/sessions`, {
			method: 'DELETE'
		});

		if (!response.ok) {
			if (response.status === 404) {
				throw new Error('User not found');
			}
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.error_description || error.error || 'Failed to revoke user sessions');
		}

		return response.json();
	}
};
