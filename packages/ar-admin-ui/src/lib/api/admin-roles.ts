/**
 * Admin Roles API Client
 *
 * Provides methods for managing roles and role assignments.
 * Supports system, builtin, and custom roles with permission management.
 */

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

/**
 * Role type classification
 */
export type RoleType = 'system' | 'builtin' | 'custom';

/**
 * Scope type for role assignments
 * Matches backend RBAC specification: 'global' | 'org' | 'resource'
 */
export type ScopeType = 'global' | 'org' | 'resource';

/**
 * Basic role information (for list view)
 */
export interface Role {
	id: string;
	tenant_id: string;
	name: string;
	display_name?: string;
	description?: string;
	is_system: boolean;
	created_at: number;
	updated_at: number;
}

/**
 * Detailed role information (for detail view)
 * Includes effective permissions resolved from inheritance
 */
export interface RoleDetail extends Role {
	permissions?: string[];
	inherits_from?: string;
	assignment_count: number;
	// Computed fields for UI convenience
	baseRoleId: string | null;
	addedPermissions: string[];
	effectivePermissions: string[];
}

/**
 * Role list response
 */
export interface RolesListResponse {
	roles: Role[];
}

/**
 * Role detail response
 */
export interface RoleDetailResponse {
	role: RoleDetail;
}

/**
 * Role assignment for a user
 */
export interface RoleAssignment {
	id: string;
	role_id: string;
	role_name: string;
	role_display_name?: string;
	is_system_role: boolean;
	scope: ScopeType;
	scope_target: string;
	granted_by?: string;
	expires_at: number | null;
	created_at: number;
}

/**
 * User roles response
 */
export interface UserRolesResponse {
	user_id: string;
	roles: RoleAssignment[];
}

/**
 * User assigned to a role (from role perspective)
 */
export interface RoleAssignedUser {
	assignment_id: string;
	user_id: string;
	user_email: string | null;
	user_name: string | null;
	scope: ScopeType;
	scope_target: string;
	granted_by: string | null;
	expires_at: number | null;
	assigned_at: number;
}

/**
 * Role assignments list response
 */
export interface RoleAssignmentsResponse {
	role_id: string;
	role_name: string;
	assignments: RoleAssignedUser[];
	pagination: {
		page: number;
		limit: number;
		total: number;
		totalPages: number;
		hasNext: boolean;
		hasPrev: boolean;
	};
}

/**
 * Create role request
 */
export interface CreateRoleRequest {
	name: string;
	description?: string;
	permissions: string[];
	inherits_from?: string;
}

/**
 * Update role request
 */
export interface UpdateRoleRequest {
	description?: string;
	permissions?: string[];
}

/**
 * Assign role request
 */
export interface AssignRoleRequest {
	role_id?: string;
	role_name?: string;
	scope?: ScopeType;
	scope_target?: string;
	expires_at?: number;
}

/**
 * Permission definition for UI display
 */
export interface PermissionDefinition {
	id: string;
	label: string;
	description: string;
}

/**
 * Permission category for grouped display
 */
export interface PermissionCategory {
	category: string;
	categoryLabel: string;
	permissions: PermissionDefinition[];
}

/**
 * Available permission categories with all defined permissions
 */
export const PERMISSION_DEFINITIONS: PermissionCategory[] = [
	{
		category: 'admin',
		categoryLabel: 'Admin',
		permissions: [
			{ id: 'admin:access', label: 'Admin UI Access', description: 'Access to Admin UI' }
		]
	},
	{
		category: 'users',
		categoryLabel: 'Users',
		permissions: [
			{ id: 'users:read', label: 'Read Users', description: 'View user list and details' },
			{ id: 'users:write', label: 'Write Users', description: 'Create and update users' },
			{ id: 'users:create', label: 'Create Users', description: 'Create new users' },
			{ id: 'users:update', label: 'Update Users', description: 'Update user details' },
			{ id: 'users:delete', label: 'Delete Users', description: 'Delete users' }
		]
	},
	{
		category: 'clients',
		categoryLabel: 'OAuth Clients',
		permissions: [
			{ id: 'clients:read', label: 'Read Clients', description: 'View client list and details' },
			{ id: 'clients:write', label: 'Write Clients', description: 'Create and update clients' },
			{ id: 'clients:delete', label: 'Delete Clients', description: 'Delete clients' }
		]
	},
	{
		category: 'sessions',
		categoryLabel: 'Sessions',
		permissions: [
			{ id: 'sessions:read', label: 'Read Sessions', description: 'View session list' },
			{ id: 'sessions:revoke', label: 'Revoke Sessions', description: 'Revoke user sessions' }
		]
	},
	{
		category: 'organizations',
		categoryLabel: 'Organizations',
		permissions: [
			{
				id: 'organizations:read',
				label: 'Read Organizations',
				description: 'View organization list and details'
			},
			{
				id: 'organizations:create',
				label: 'Create Organizations',
				description: 'Create new organizations'
			},
			{
				id: 'organizations:update',
				label: 'Update Organizations',
				description: 'Update organization details'
			},
			{
				id: 'organizations:delete',
				label: 'Delete Organizations',
				description: 'Delete organizations'
			}
		]
	},
	{
		category: 'stats',
		categoryLabel: 'Statistics',
		permissions: [
			{ id: 'stats:read', label: 'Read Statistics', description: 'View dashboard statistics' }
		]
	},
	{
		category: 'audit',
		categoryLabel: 'Audit Logs',
		permissions: [
			{ id: 'audit:read', label: 'Read Audit Logs', description: 'View audit log entries' }
		]
	},
	{
		category: 'settings',
		categoryLabel: 'Settings',
		permissions: [
			{ id: 'settings:read', label: 'Read Settings', description: 'View system settings' },
			{
				id: 'settings:write',
				label: 'Write Settings',
				description: 'Modify OAuth/OIDC, keys, rate limits'
			}
		]
	},
	{
		category: 'roles',
		categoryLabel: 'Roles',
		permissions: [
			{ id: 'roles:read', label: 'Read Roles', description: 'View role list and details' },
			{ id: 'roles:write', label: 'Write Roles', description: 'Create and update custom roles' },
			{ id: 'roles:delete', label: 'Delete Roles', description: 'Delete custom roles' },
			{
				id: 'roles:assign',
				label: 'Assign Roles',
				description: 'Assign/remove roles from users'
			}
		]
	},
	{
		category: 'webhooks',
		categoryLabel: 'Webhooks',
		permissions: [
			{ id: 'webhooks:read', label: 'Read Webhooks', description: 'View webhook configurations' },
			{
				id: 'webhooks:write',
				label: 'Write Webhooks',
				description: 'Create, update, and test webhooks'
			},
			{ id: 'webhooks:delete', label: 'Delete Webhooks', description: 'Delete webhooks' }
		]
	},
	{
		category: 'compliance',
		categoryLabel: 'Compliance',
		permissions: [
			{
				id: 'compliance:read',
				label: 'Read Compliance',
				description: 'View compliance status and reports'
			},
			{
				id: 'compliance:write',
				label: 'Write Compliance',
				description: 'Manage data retention, run cleanup'
			}
		]
	}
];

/**
 * Get all permission IDs as a flat array
 */
export function getAllPermissionIds(): string[] {
	return PERMISSION_DEFINITIONS.flatMap((cat) => cat.permissions.map((p) => p.id));
}

/**
 * Get permission label by ID
 */
export function getPermissionLabel(permissionId: string): string {
	for (const category of PERMISSION_DEFINITIONS) {
		const permission = category.permissions.find((p) => p.id === permissionId);
		if (permission) {
			return permission.label;
		}
	}
	return permissionId;
}

/**
 * Determine role type from role data
 */
export function getRoleType(role: Role | RoleDetail): RoleType {
	if (role.is_system) {
		return 'system';
	}
	// Builtin roles have specific names
	const builtinNames = ['admin', 'viewer', 'support', 'auditor'];
	if (builtinNames.includes(role.name.toLowerCase())) {
		return 'builtin';
	}
	return 'custom';
}

/**
 * Check if role can be edited (name/description)
 */
export function canEditRole(role: Role | RoleDetail): boolean {
	return getRoleType(role) === 'custom';
}

/**
 * Check if role can be deleted
 */
export function canDeleteRole(role: Role | RoleDetail): boolean {
	const roleType = getRoleType(role);
	if (roleType !== 'custom') {
		return false;
	}
	// Cannot delete if users are assigned
	if ('assignment_count' in role && role.assignment_count > 0) {
		return false;
	}
	return true;
}

export const adminRolesAPI = {
	/**
	 * List all roles
	 */
	async list(): Promise<RolesListResponse> {
		const response = await fetch(`${API_BASE_URL}/api/admin/roles`, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to fetch roles');
		}
		return response.json();
	},

	/**
	 * Get role details by ID
	 */
	async get(id: string): Promise<RoleDetailResponse> {
		const response = await fetch(`${API_BASE_URL}/api/admin/roles/${encodeURIComponent(id)}`, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to fetch role');
		}

		const data = await response.json();

		// Compute effective permissions for UI convenience
		const role = data.role;
		const permissions = role.permissions || [];

		return {
			role: {
				...role,
				baseRoleId: role.inherits_from || null,
				addedPermissions: permissions,
				effectivePermissions: permissions // TODO: Resolve inheritance on backend
			}
		};
	},

	/**
	 * Create a new custom role
	 */
	async create(data: CreateRoleRequest): Promise<Role> {
		const response = await fetch(`${API_BASE_URL}/api/admin/roles`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(data)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to create role');
		}
		return response.json();
	},

	/**
	 * Update an existing custom role
	 */
	async update(id: string, data: UpdateRoleRequest): Promise<Role> {
		const response = await fetch(`${API_BASE_URL}/api/admin/roles/${encodeURIComponent(id)}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(data)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to update role');
		}
		return response.json();
	},

	/**
	 * Delete a custom role
	 */
	async delete(id: string): Promise<{ success: boolean }> {
		const response = await fetch(`${API_BASE_URL}/api/admin/roles/${encodeURIComponent(id)}`, {
			method: 'DELETE',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to delete role');
		}
		return response.json();
	},

	/**
	 * Get user's role assignments
	 */
	async getUserRoles(userId: string): Promise<UserRolesResponse> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/users/${encodeURIComponent(userId)}/roles`,
			{
				credentials: 'include'
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to fetch user roles');
		}
		return response.json();
	},

	/**
	 * Assign a role to a user
	 */
	async assignRole(userId: string, data: AssignRoleRequest): Promise<{ success: boolean }> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/users/${encodeURIComponent(userId)}/roles`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify(data)
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to assign role');
		}
		return response.json();
	},

	/**
	 * Remove a role assignment from a user
	 */
	async removeRole(userId: string, assignmentId: string): Promise<{ success: boolean }> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/users/${encodeURIComponent(userId)}/roles/${encodeURIComponent(assignmentId)}`,
			{
				method: 'DELETE',
				credentials: 'include'
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to remove role');
		}
		return response.json();
	},

	/**
	 * Get effective permissions for a user
	 */
	async getUserEffectivePermissions(userId: string): Promise<{ permissions: string[] }> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/users/${encodeURIComponent(userId)}/effective-permissions`,
			{
				credentials: 'include'
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(
				error.error_description || error.message || 'Failed to fetch effective permissions'
			);
		}
		return response.json();
	},

	/**
	 * Get users assigned to a specific role
	 */
	async getRoleAssignments(
		roleId: string,
		page: number = 1,
		limit: number = 20
	): Promise<RoleAssignmentsResponse> {
		const params = new URLSearchParams({
			page: String(page),
			limit: String(limit)
		});

		const response = await fetch(
			`${API_BASE_URL}/api/admin/roles/${encodeURIComponent(roleId)}/assignments?${params}`,
			{
				credentials: 'include'
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(
				error.error_description || error.message || 'Failed to fetch role assignments'
			);
		}
		return response.json();
	}
};
