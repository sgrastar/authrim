import { adminFetch } from '$lib/api/admin-request';
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

		const response = await adminFetch(url, {
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
		const response = await adminFetch(
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
		const response = await adminFetch(`${API_BASE_URL}/api/admin/admin-roles`, {
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
		const response = await adminFetch(
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
		const response = await adminFetch(
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
		const response = await adminFetch(`${API_BASE_URL}/api/admin/admin-roles/permissions/list`, {
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

/**
 * Admin Permission Category
 */
export interface AdminPermissionCategory {
	category: string;
	description: string;
	permissions: AdminPermission[];
}

/**
 * Admin Permission Definitions
 * Organized by category for UI display
 */
export const ADMIN_PERMISSION_DEFINITIONS: AdminPermissionCategory[] = [
	{
		category: 'Admin Users',
		description: 'Manage Admin Operators',
		permissions: [
			{ key: 'admin:admin_users:read', description: 'View Admin users' },
			{ key: 'admin:admin_users:write', description: 'Create and update Admin users' },
			{ key: 'admin:admin_users:delete', description: 'Delete Admin users' },
			{ key: 'admin:admin_users:*', description: 'Full Admin user management' }
		]
	},
	{
		category: 'Admin Roles',
		description: 'Manage Admin roles and permissions',
		permissions: [
			{ key: 'admin:admin_roles:read', description: 'View Admin roles' },
			{ key: 'admin:admin_roles:write', description: 'Create, update, and delete Admin roles' }
		]
	},
	{
		category: 'Admin Audit',
		description: 'View Admin audit logs',
		permissions: [
			{ key: 'admin:admin_audit:read', description: 'View Admin audit logs' },
			{
				key: 'admin:admin_audit:detail:read',
				description: 'Read full Admin audit detail payloads'
			}
		]
	},
	{
		category: 'Approvals',
		description: 'Manage approval and elevation workflows',
		permissions: [
			{ key: 'admin:approvals:read', description: 'View approval requests' },
			{ key: 'admin:approvals:write', description: 'Create and update approval requests' },
			{ key: 'admin:approvals:approve', description: 'Approve or deny approval steps' },
			{ key: 'admin:approvals:*', description: 'Full approval workflow access' }
		]
	},
	{
		category: 'Jobs',
		description: 'Manage async admin jobs and their output artifacts',
		permissions: [
			{ key: 'admin:jobs:read', description: 'View job status and summaries' },
			{ key: 'admin:jobs:write', description: 'Create and manage jobs' },
			{
				key: 'admin:jobs:artifact:read',
				description: 'Read full job result artifacts and chunks'
			},
			{ key: 'admin:jobs:*', description: 'Full job management access' }
		]
	},
	{
		category: 'Operational Logs',
		description: 'Read short-retention reason detail records',
		permissions: [
			{ key: 'admin:operational_logs:read', description: 'View operational log summaries' },
			{
				key: 'admin:operational_logs:detail:read',
				description: 'Read full operational log reason detail payloads'
			},
			{ key: 'admin:operational_logs:*', description: 'Full operational log access' }
		]
	},
	{
		category: 'Webhooks',
		description: 'Manage webhooks and read delivery payloads',
		permissions: [
			{ key: 'admin:webhooks:read', description: 'View webhook configurations' },
			{ key: 'admin:webhooks:write', description: 'Create and update webhooks' },
			{ key: 'admin:webhooks:delete', description: 'Delete webhooks' },
			{
				key: 'admin:webhooks:payload:read',
				description: 'Read full webhook delivery request/response payloads'
			}
		]
	},
	{
		category: 'IP Allowlist',
		description: 'Manage IP allowlist',
		permissions: [
			{ key: 'admin:ip_allowlist:read', description: 'View IP allowlist' },
			{ key: 'admin:ip_allowlist:write', description: 'Manage IP allowlist' }
		]
	},
	{
		category: 'End Users',
		description: 'Manage application end users',
		permissions: [
			{ key: 'admin:users:read', description: 'View end users' },
			{ key: 'admin:users:write', description: 'Create and update end users' },
			{ key: 'admin:users:delete', description: 'Delete end users' },
			{ key: 'admin:users:unlock', description: 'Unlock locked user accounts' },
			{ key: 'admin:users:*', description: 'Full end user management' }
		]
	},
	{
		category: 'OAuth Clients',
		description: 'Manage OAuth clients',
		permissions: [
			{ key: 'admin:clients:read', description: 'View OAuth clients' },
			{ key: 'admin:clients:write', description: 'Create and update OAuth clients' },
			{ key: 'admin:clients:delete', description: 'Delete OAuth clients' },
			{ key: 'admin:clients:*', description: 'Full OAuth client management' }
		]
	},
	{
		category: 'End User Roles',
		description: 'Manage end user roles',
		permissions: [
			{ key: 'admin:roles:read', description: 'View end user roles' },
			{ key: 'admin:roles:write', description: 'Create and update end user roles' },
			{ key: 'admin:roles:delete', description: 'Delete end user roles' },
			{ key: 'admin:roles:*', description: 'Full end user role management' }
		]
	},
	{
		category: 'Settings',
		description: 'Manage system settings',
		permissions: [
			{ key: 'admin:settings:read', description: 'View system settings' },
			{ key: 'admin:settings:write', description: 'Update system settings' }
		]
	},
	{
		category: 'Tenant Domains',
		description: 'Manage tenant vanity domains',
		permissions: [
			{ key: 'admin:tenant_domains:read', description: 'View tenant vanity domains' },
			{ key: 'admin:tenant_domains:write', description: 'Create and update tenant vanity domains' },
			{ key: 'admin:tenant_domains:delete', description: 'Delete tenant vanity domains' },
			{ key: 'admin:tenant_domains:*', description: 'Full tenant vanity domain management' }
		]
	},
	{
		category: 'Security',
		description: 'Manage security settings',
		permissions: [
			{ key: 'admin:security:read', description: 'View security settings' },
			{ key: 'admin:security:write', description: 'Update security settings' }
		]
	},
	{
		category: 'Audit Logs',
		description: 'View end user audit logs',
		permissions: [{ key: 'admin:audit:read', description: 'View end user audit logs' }]
	},
	{
		category: 'Wildcard',
		description: 'Full access to all functions',
		permissions: [{ key: '*', description: 'Full access to all admin functions' }]
	}
];
