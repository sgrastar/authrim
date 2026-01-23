/**
 * Admin Users Management API Client
 *
 * Provides API calls for managing Admin users (stored in DB_ADMIN).
 * These are separate from EndUser management.
 */

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

/**
 * Admin user entity
 */
export interface AdminUser {
	id: string;
	tenant_id: string;
	email: string;
	email_verified: boolean;
	name: string | null;
	is_active: boolean;
	status: 'active' | 'suspended' | 'locked';
	mfa_enabled: boolean;
	mfa_method: 'totp' | 'passkey' | 'both' | null;
	last_login_at: number | null;
	last_login_ip: string | null;
	failed_login_count: number;
	created_by: string | null;
	created_at: number;
	updated_at: number;
}

/**
 * Admin user with roles (for detail view)
 */
export interface AdminUserDetail extends AdminUser {
	roles: AdminRoleAssignment[];
	passkey_count: number;
}

/**
 * Admin role assignment
 */
export interface AdminRoleAssignment {
	id: string;
	name: string;
	display_name: string | null;
	assigned_at: number;
	expires_at: number | null;
}

/**
 * Pagination info
 */
export interface Pagination {
	page: number;
	limit: number;
	total: number;
	totalPages: number;
}

/**
 * Admin user list response
 */
export interface AdminUserListResponse {
	items: AdminUser[];
	total: number;
	page: number;
	limit: number;
	totalPages: number;
}

/**
 * Admin user list parameters
 */
export interface AdminUserListParams {
	page?: number;
	limit?: number;
	email?: string;
	status?: 'active' | 'suspended' | 'locked';
	mfa_enabled?: boolean;
}

/**
 * Create admin user input
 */
export interface CreateAdminUserInput {
	email: string;
	name?: string;
	password?: string;
	mfa_enabled?: boolean;
}

/**
 * Update admin user input
 */
export interface UpdateAdminUserInput {
	email?: string;
	name?: string;
	status?: 'active' | 'suspended';
	mfa_enabled?: boolean;
}

/**
 * Assign role input
 */
export interface AssignRoleInput {
	role_id: string;
	expires_at?: number;
}

/**
 * Admin Users Management API
 */
export const adminAdminsAPI = {
	/**
	 * List admin users with pagination and filtering
	 * GET /api/admin/admins
	 */
	async list(params?: AdminUserListParams): Promise<AdminUserListResponse> {
		const searchParams = new URLSearchParams();

		if (params?.page) searchParams.set('page', String(params.page));
		if (params?.limit) searchParams.set('limit', String(params.limit));
		if (params?.email) searchParams.set('email', params.email);
		if (params?.status) searchParams.set('status', params.status);
		if (params?.mfa_enabled !== undefined)
			searchParams.set('mfa_enabled', String(params.mfa_enabled));

		const queryString = searchParams.toString();
		const url = `${API_BASE_URL}/api/admin/admins${queryString ? `?${queryString}` : ''}`;

		const response = await fetch(url, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to fetch admin users');
		}

		return response.json();
	},

	/**
	 * Get admin user details
	 * GET /api/admin/admins/:id
	 */
	async get(id: string): Promise<AdminUserDetail> {
		const response = await fetch(`${API_BASE_URL}/api/admin/admins/${encodeURIComponent(id)}`, {
			credentials: 'include'
		});

		if (!response.ok) {
			if (response.status === 404) {
				throw new Error('Admin user not found');
			}
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to fetch admin user');
		}

		return response.json();
	},

	/**
	 * Create a new admin user
	 * POST /api/admin/admins
	 */
	async create(data: CreateAdminUserInput): Promise<AdminUser> {
		const response = await fetch(`${API_BASE_URL}/api/admin/admins`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(data)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to create admin user');
		}

		return response.json();
	},

	/**
	 * Update an admin user
	 * PATCH /api/admin/admins/:id
	 */
	async update(id: string, data: UpdateAdminUserInput): Promise<AdminUser> {
		const response = await fetch(`${API_BASE_URL}/api/admin/admins/${encodeURIComponent(id)}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(data)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to update admin user');
		}

		return response.json();
	},

	/**
	 * Delete an admin user (soft delete)
	 * DELETE /api/admin/admins/:id
	 */
	async delete(id: string): Promise<{ success: boolean; message: string }> {
		const response = await fetch(`${API_BASE_URL}/api/admin/admins/${encodeURIComponent(id)}`, {
			method: 'DELETE',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to delete admin user');
		}

		return response.json();
	},

	/**
	 * Suspend an admin user
	 * POST /api/admin/admins/:id/suspend
	 */
	async suspend(id: string): Promise<{ success: boolean; message: string }> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/admins/${encodeURIComponent(id)}/suspend`,
			{
				method: 'POST',
				credentials: 'include'
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to suspend admin user');
		}

		return response.json();
	},

	/**
	 * Activate an admin user
	 * POST /api/admin/admins/:id/activate
	 */
	async activate(id: string): Promise<{ success: boolean; message: string }> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/admins/${encodeURIComponent(id)}/activate`,
			{
				method: 'POST',
				credentials: 'include'
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to activate admin user');
		}

		return response.json();
	},

	/**
	 * Unlock an admin user
	 * POST /api/admin/admins/:id/unlock
	 */
	async unlock(id: string): Promise<{ success: boolean; message: string }> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/admins/${encodeURIComponent(id)}/unlock`,
			{
				method: 'POST',
				credentials: 'include'
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to unlock admin user');
		}

		return response.json();
	},

	/**
	 * Assign a role to an admin user
	 * POST /api/admin/admins/:id/roles
	 */
	async assignRole(id: string, data: AssignRoleInput): Promise<{ id: string }> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/admins/${encodeURIComponent(id)}/roles`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify(data)
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to assign role');
		}

		return response.json();
	},

	/**
	 * Remove a role from an admin user
	 * DELETE /api/admin/admins/:id/roles/:roleId
	 */
	async removeRole(id: string, roleId: string): Promise<{ success: boolean; message: string }> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/admins/${encodeURIComponent(id)}/roles/${encodeURIComponent(roleId)}`,
			{
				method: 'DELETE',
				credentials: 'include'
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to remove role');
		}

		return response.json();
	}
};
