/**
 * Admin Roles Management API Client
 *
 * Provides API calls for managing Admin roles (stored in DB_ADMIN).
 * Includes role definitions and permission management.
 */

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

/**
 * Admin role entity
 */
export interface AdminRole {
	id: string;
	tenant_id: string;
	name: string;
	display_name: string | null;
	description: string | null;
	permissions: string[];
	hierarchy_level: number;
	role_type: 'system' | 'builtin' | 'custom';
	is_system: boolean;
	created_at: number;
	updated_at: number;
}

/**
 * Admin role with assignment info
 */
export interface AdminRoleDetail extends AdminRole {
	assigned_user_count: number;
	assigned_user_ids: string[];
}

/**
 * Permission definition
 */
export interface AdminPermission {
	key: string;
	description: string;
}

/**
 * Admin role list response
 */
export interface AdminRoleListResponse {
	items: AdminRole[];
	total: number;
}

/**
 * Permission list response
 */
export interface AdminPermissionListResponse {
	items: AdminPermission[];
	total: number;
}

/**
 * Create admin role input
 */
export interface CreateAdminRoleInput {
	name: string;
	display_name?: string;
	description?: string;
	permissions: string[];
	hierarchy_level?: number;
}

/**
 * Update admin role input
 */
export interface UpdateAdminRoleInput {
	display_name?: string;
	description?: string;
	permissions?: string[];
	hierarchy_level?: number;
}

/**
 * Admin Roles Management API
 */
export const adminAdminRolesAPI = {
	/**
	 * List all admin roles
	 * GET /api/admin/admin-roles
	 */
	async list(includeSystem: boolean = true): Promise<AdminRoleListResponse> {
		const params = new URLSearchParams();
		if (!includeSystem) params.set('include_system', 'false');

		const queryString = params.toString();
		const url = `${API_BASE_URL}/api/admin/admin-roles${queryString ? `?${queryString}` : ''}`;

		const response = await fetch(url, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to fetch admin roles');
		}

		return response.json();
	},

	/**
	 * Get admin role details
	 * GET /api/admin/admin-roles/:id
	 */
	async get(id: string): Promise<AdminRoleDetail> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/admin-roles/${encodeURIComponent(id)}`,
			{
				credentials: 'include'
			}
		);

		if (!response.ok) {
			if (response.status === 404) {
				throw new Error('Admin role not found');
			}
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to fetch admin role');
		}

		return response.json();
	},

	/**
	 * Create a new custom admin role
	 * POST /api/admin/admin-roles
	 */
	async create(data: CreateAdminRoleInput): Promise<AdminRole> {
		const response = await fetch(`${API_BASE_URL}/api/admin/admin-roles`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(data)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to create admin role');
		}

		return response.json();
	},

	/**
	 * Update an admin role
	 * PATCH /api/admin/admin-roles/:id
	 */
	async update(id: string, data: UpdateAdminRoleInput): Promise<AdminRole> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/admin-roles/${encodeURIComponent(id)}`,
			{
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify(data)
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to update admin role');
		}

		return response.json();
	},

	/**
	 * Delete an admin role
	 * DELETE /api/admin/admin-roles/:id
	 */
	async delete(id: string): Promise<{ success: boolean; message: string }> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/admin-roles/${encodeURIComponent(id)}`,
			{
				method: 'DELETE',
				credentials: 'include'
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to delete admin role');
		}

		return response.json();
	},

	/**
	 * List all available admin permissions
	 * GET /api/admin/admin-roles/permissions/list
	 */
	async listPermissions(): Promise<AdminPermissionListResponse> {
		const response = await fetch(`${API_BASE_URL}/api/admin/admin-roles/permissions/list`, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to fetch permissions');
		}

		return response.json();
	}
};

/**
 * Check if role can be edited
 */
export function canEditAdminRole(role: AdminRole): boolean {
	return role.role_type === 'custom' && !role.is_system;
}

/**
 * Check if role can be deleted
 */
export function canDeleteAdminRole(role: AdminRole | AdminRoleDetail): boolean {
	if (role.is_system || role.role_type !== 'custom') {
		return false;
	}
	if ('assigned_user_count' in role && role.assigned_user_count > 0) {
		return false;
	}
	return true;
}

/**
 * Get role type badge class
 */
export function getRoleTypeBadgeClass(roleType: string): string {
	switch (roleType) {
		case 'system':
			return 'badge badge-primary';
		case 'builtin':
			return 'badge badge-info';
		case 'custom':
			return 'badge badge-success';
		default:
			return 'badge badge-neutral';
	}
}
