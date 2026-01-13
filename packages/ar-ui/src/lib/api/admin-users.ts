/**
 * Admin Users API Client
 *
 * Provides API calls for user management:
 * - List users with pagination, search, and filtering
 * - Get user details
 * - Create, update, delete users
 * - Suspend, lock users
 */

// API Base URL - empty string for same-origin, or full URL for cross-origin
const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

/**
 * User entity
 */
export interface User {
	id: string;
	tenant_id: string;
	email: string | null;
	name: string | null;
	given_name: string | null;
	family_name: string | null;
	nickname: string | null;
	preferred_username: string | null;
	picture: string | null;
	phone_number: string | null;
	email_verified: boolean;
	phone_number_verified: boolean;
	user_type: string;
	is_active: boolean;
	pii_partition: string;
	pii_status: string;
	created_at: number;
	updated_at: number;
	last_login_at: number | null;
	status: 'active' | 'suspended' | 'locked';
	suspended_at: number | null;
	suspended_until: number | null;
	locked_at: number | null;
	locked_until: number | null;
	passkeys?: Array<{
		id: string;
		device_name: string | null;
		created_at: number;
		last_used_at: number | null;
	}>;
}

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
 * User list response
 */
export interface UserListResponse {
	users: User[];
	pagination: Pagination;
}

/**
 * User list parameters
 */
export interface UserListParams {
	page?: number;
	limit?: number;
	search?: string;
	verified?: boolean;
	status?: 'active' | 'suspended' | 'locked';
}

/**
 * Create user input
 */
export interface CreateUserInput {
	email: string;
	name?: string;
	given_name?: string;
	family_name?: string;
	email_verified?: boolean;
}

/**
 * Update user input
 */
export interface UpdateUserInput {
	email?: string;
	name?: string;
	given_name?: string;
	family_name?: string;
	nickname?: string;
	preferred_username?: string;
	phone_number?: string;
	email_verified?: boolean;
	phone_number_verified?: boolean;
}

/**
 * Admin Users API
 */
export const adminUsersAPI = {
	/**
	 * List users with pagination, search, and filtering
	 * GET /api/admin/users
	 */
	async list(params?: UserListParams): Promise<UserListResponse> {
		const searchParams = new URLSearchParams();

		if (params?.page) searchParams.set('page', String(params.page));
		if (params?.limit) searchParams.set('limit', String(params.limit));
		if (params?.search) searchParams.set('search', params.search);
		if (params?.verified !== undefined) searchParams.set('verified', String(params.verified));
		if (params?.status) searchParams.set('status', params.status);

		const queryString = searchParams.toString();
		const url = `${API_BASE_URL}/api/admin/users${queryString ? `?${queryString}` : ''}`;

		const response = await fetch(url, {
			credentials: 'include'
		});

		if (!response.ok) {
			throw new Error('Failed to fetch users');
		}

		return response.json();
	},

	/**
	 * Get user details
	 * GET /api/admin/users/:id
	 */
	async get(id: string): Promise<User> {
		const response = await fetch(`${API_BASE_URL}/api/admin/users/${id}`, {
			credentials: 'include'
		});

		if (!response.ok) {
			if (response.status === 404) {
				throw new Error('User not found');
			}
			throw new Error('Failed to fetch user');
		}

		const data = await response.json();
		return data.user;
	},

	/**
	 * Create a new user
	 * POST /api/admin/users
	 */
	async create(data: CreateUserInput): Promise<User> {
		const response = await fetch(`${API_BASE_URL}/api/admin/users`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(data)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.error_description || error.error || 'Failed to create user');
		}

		const result = await response.json();
		return result.user;
	},

	/**
	 * Update a user
	 * PUT /api/admin/users/:id
	 */
	async update(id: string, data: UpdateUserInput): Promise<User> {
		const response = await fetch(`${API_BASE_URL}/api/admin/users/${id}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(data)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.error_description || error.error || 'Failed to update user');
		}

		const result = await response.json();
		return result.user;
	},

	/**
	 * Delete a user (soft delete)
	 * DELETE /api/admin/users/:id
	 */
	async delete(id: string): Promise<void> {
		const response = await fetch(`${API_BASE_URL}/api/admin/users/${id}`, {
			method: 'DELETE',
			credentials: 'include'
		});

		if (!response.ok) {
			throw new Error('Failed to delete user');
		}
	},

	/**
	 * Suspend a user
	 * POST /api/admin/users/:id/suspend
	 */
	async suspend(
		id: string,
		reasonCode: string = 'admin_action',
		options?: { durationHours?: number; reasonDetail?: string }
	): Promise<void> {
		const response = await fetch(`${API_BASE_URL}/api/admin/users/${id}/suspend`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify({
				reason_code: reasonCode,
				...(options?.durationHours && { duration_hours: options.durationHours }),
				...(options?.reasonDetail && { reason_detail: options.reasonDetail })
			})
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.error_description || error.error || 'Failed to suspend user');
		}
	},

	/**
	 * Lock a user account
	 * POST /api/admin/users/:id/lock
	 */
	async lock(
		id: string,
		reasonCode: string = 'admin_action',
		options?: { unlockAt?: string; reasonDetail?: string }
	): Promise<void> {
		const response = await fetch(`${API_BASE_URL}/api/admin/users/${id}/lock`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify({
				reason_code: reasonCode,
				...(options?.unlockAt && { unlock_at: options.unlockAt }),
				...(options?.reasonDetail && { reason_detail: options.reasonDetail })
			})
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.error_description || error.error || 'Failed to lock user');
		}
	},

	/**
	 * Activate (restore) a suspended or locked user
	 * POST /api/admin/users/:id/activate
	 */
	async activate(
		id: string,
		reasonCode: string = 'admin_action',
		options?: { reasonDetail?: string }
	): Promise<{ user_id: string; status: string; previous_status: string; effective_at: string }> {
		const response = await fetch(`${API_BASE_URL}/api/admin/users/${id}/activate`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify({
				reason_code: reasonCode,
				...(options?.reasonDetail && { reason_detail: options.reasonDetail })
			})
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.error_description || error.error || 'Failed to activate user');
		}

		return response.json();
	}
};
