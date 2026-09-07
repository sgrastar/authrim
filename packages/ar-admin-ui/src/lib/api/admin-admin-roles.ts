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
	inherits_from: string | null;
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

export type AdminRoleAssignmentScopeType = 'global' | 'tenant' | 'org';

// Admin org scope is reserved for future resource-level enforcement.
// New AdminUI/API assignments should only create global or tenant bindings.
export type AssignableAdminRoleScopeType = 'global' | 'tenant';

export interface AdminRoleAssignmentRecord {
	id: string;
	tenant_id: string;
	admin_user_id: string;
	admin_role_id: string;
	scope_type: AdminRoleAssignmentScopeType;
	scope_id: string | null;
	expires_at: number | null;
	assigned_by: string | null;
	created_at: number;
}

export interface AdminRoleAssignmentWithUser extends AdminRoleAssignmentRecord {
	user: {
		id: string;
		email: string;
		name: string | null;
		status: string;
		is_active: boolean;
	} | null;
}

export interface AdminRoleAssignmentListResponse {
	items: AdminRoleAssignmentWithUser[];
	total: number;
}

export interface AssignAdminRoleInput {
	admin_user_id: string;
	scope_type: AssignableAdminRoleScopeType;
	scope_id?: string;
	expires_at?: number;
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
	inherits_from?: string | null;
}

/**
 * Update admin role input
 */
export interface UpdateAdminRoleInput {
	display_name?: string;
	description?: string;
	permissions?: string[];
	hierarchy_level?: number;
	inherits_from?: string | null;
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
	 * List role assignments
	 * GET /api/admin/admin-roles/:id/assignments
	 */
	async listAssignments(
		id: string,
		includeExpired: boolean = false
	): Promise<AdminRoleAssignmentListResponse> {
		const params = new URLSearchParams();
		if (includeExpired) params.set('include_expired', 'true');

		const queryString = params.toString();
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/admin-roles/${encodeURIComponent(id)}/assignments${
				queryString ? `?${queryString}` : ''
			}`,
			{
				credentials: 'include'
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to fetch role assignments');
		}

		return response.json();
	},

	/**
	 * Assign this role to an admin user
	 * POST /api/admin/admin-roles/:id/assignments
	 */
	async assignRole(id: string, data: AssignAdminRoleInput): Promise<AdminRoleAssignmentRecord> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/admin-roles/${encodeURIComponent(id)}/assignments`,
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
	 * Update a role assignment
	 * PATCH /api/admin/admin-roles/:id/assignments/:assignmentId
	 */
	async updateAssignment(
		id: string,
		assignmentId: string,
		data: {
			scope_type?: AssignableAdminRoleScopeType;
			scope_id?: string;
			expires_at?: number | null;
		}
	): Promise<AdminRoleAssignmentRecord> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/admin-roles/${encodeURIComponent(id)}/assignments/${encodeURIComponent(
				assignmentId
			)}`,
			{
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify(data)
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to update role assignment');
		}

		return response.json();
	},

	/**
	 * Remove a role assignment
	 * DELETE /api/admin/admin-roles/:id/assignments/:assignmentId
	 */
	async removeAssignment(
		id: string,
		assignmentId: string
	): Promise<{ success: boolean; message: string }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/admin-roles/${encodeURIComponent(id)}/assignments/${encodeURIComponent(
				assignmentId
			)}`,
			{
				method: 'DELETE',
				credentials: 'include'
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to remove role assignment');
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
			{
				key: 'admin:jobs:destination:select',
				description: 'Select approved storage destinations for job outputs'
			},
			{ key: 'admin:jobs:*', description: 'Full job management access' }
		]
	},
	{
		category: 'Storage Destinations',
		description: 'Manage reusable storage endpoints for logs, jobs, and DR backup',
		permissions: [
			{ key: 'admin:storage_destinations:list', description: 'List storage destinations' },
			{ key: 'admin:storage_destinations:read', description: 'View storage destination metadata' },
			{
				key: 'admin:storage_destinations:create',
				description: 'Create storage destinations'
			},
			{
				key: 'admin:storage_destinations:update',
				description: 'Update storage destination metadata'
			},
			{ key: 'admin:storage_destinations:delete', description: 'Delete storage destinations' },
			{
				key: 'admin:storage_destinations:credentials:write',
				description: 'Create or rotate storage destination credentials'
			},
			{
				key: 'admin:storage_destinations:test',
				description: 'Test storage destination connectivity'
			},
			{
				key: 'admin:storage_destinations:usage:read',
				description: 'View feature usage for storage destinations'
			},
			{ key: 'admin:storage_destinations:*', description: 'Full storage destination access' }
		]
	},
	{
		category: 'Destination Selection',
		description: 'Select approved storage destinations from feature settings',
		permissions: [
			{
				key: 'admin:diagnostic_logging:destination:select',
				description: 'Select diagnostic logging storage destination'
			},
			{
				key: 'admin:dr_backup:destination:select',
				description: 'Select DR backup storage destination'
			}
		]
	},
	{
		category: 'Database Connections',
		description: 'Manage platform database connection profiles',
		permissions: [
			{ key: 'admin:database_connections:list', description: 'List database connections' },
			{ key: 'admin:database_connections:read', description: 'View database connection metadata' },
			{ key: 'admin:database_connections:create', description: 'Create database connections' },
			{
				key: 'admin:database_connections:update',
				description: 'Update database connection metadata'
			},
			{ key: 'admin:database_connections:delete', description: 'Delete database connections' },
			{
				key: 'admin:database_connections:credentials:write',
				description: 'Create or rotate database connection credentials'
			},
			{ key: 'admin:database_connections:test', description: 'Test database connectivity' },
			{ key: 'admin:database_connections:*', description: 'Full database connection access' }
		]
	},
	{
		category: 'Database Routing',
		description: 'Future platform database routing and cutover operations',
		permissions: [
			{ key: 'admin:database_routing:read', description: 'View database routing state' },
			{ key: 'admin:database_routing:write', description: 'Stage database routing changes' },
			{ key: 'admin:database_routing:switch', description: 'Switch runtime database route' },
			{ key: 'admin:database_routing:rollback', description: 'Rollback database routing changes' },
			{ key: 'admin:database_routing:*', description: 'Full database routing access' }
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
		category: 'External Identity Providers',
		description: 'Manage social login and upstream federation providers',
		permissions: [
			{ key: 'admin:external_providers:read', description: 'View external identity providers' },
			{
				key: 'admin:external_providers:write',
				description: 'Create and update external identity providers'
			},
			{
				key: 'admin:external_providers:delete',
				description: 'Delete external identity providers'
			},
			{ key: 'admin:external_providers:*', description: 'Full external provider management' },
			{
				key: 'admin:external_token_refresh:read',
				description: 'View external IdP token refresh settings and run history'
			},
			{
				key: 'admin:external_token_refresh:write',
				description: 'Update external IdP token refresh settings'
			},
			{
				key: 'admin:external_token_refresh:run',
				description: 'Run external IdP token refresh'
			},
			{
				key: 'admin:external_token_refresh:*',
				description: 'Full external IdP token refresh operations'
			}
		]
	},
	{
		category: 'SAML Providers',
		description: 'Manage SAML federation providers and metadata rollover',
		permissions: [
			{ key: 'admin:saml_providers:list', description: 'List SAML providers' },
			{ key: 'admin:saml_providers:read', description: 'View SAML provider details' },
			{ key: 'admin:saml_providers:create', description: 'Create SAML providers' },
			{ key: 'admin:saml_providers:update', description: 'Update SAML providers' },
			{ key: 'admin:saml_providers:delete', description: 'Delete SAML providers' },
			{
				key: 'admin:saml_providers:metadata:import',
				description: 'Import SAML provider metadata'
			},
			{
				key: 'admin:saml_providers:metadata:refresh',
				description: 'Refresh SAML provider metadata'
			},
			{
				key: 'admin:saml_providers:signing:publish_next',
				description: 'Publish next SAML signing certificate'
			},
			{
				key: 'admin:saml_providers:signing:promote',
				description: 'Promote next SAML signing certificate'
			},
			{
				key: 'admin:saml_providers:signing:retire_backup',
				description: 'Retire backup SAML signing certificate'
			},
			{
				key: 'admin:saml_providers:signing:dr_bundle:export',
				description: 'Export encrypted SAML signing DR bundle'
			},
			{
				key: 'admin:saml_providers:signing:dr_bundle:import',
				description: 'Import encrypted SAML signing DR bundle'
			},
			{ key: 'admin:saml_providers:*', description: 'Full SAML provider management' },
			{ key: 'admin:saml_attribute_presets:read', description: 'View SAML attribute presets' }
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
			{ key: 'admin:clients:create', description: 'Create OAuth clients' },
			{ key: 'admin:clients:update', description: 'Update OAuth clients' },
			{ key: 'admin:clients:secret:rotate', description: 'Rotate OAuth client secrets' },
			{ key: 'admin:clients:delete', description: 'Delete OAuth clients' },
			{ key: 'admin:clients:*', description: 'Full OAuth client management' }
		]
	},
	{
		category: 'Admin Machine Access',
		description: 'Manage scoped machine principals and credentials',
		permissions: [
			{ key: 'admin:machine_access:read', description: 'View machine principals and credentials' },
			{
				key: 'admin:machine_access:write',
				description: 'Create and update machine principals, credentials, permissions, and scopes'
			},
			{
				key: 'admin:machine_access:delete',
				description: 'Disable principals and revoke machine credentials'
			},
			{ key: 'admin:machine_access:*', description: 'Full Admin Machine Access management' }
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
			{ key: 'admin:settings:write', description: 'Update system settings' },
			{
				key: 'admin:settings:assurance:update',
				description: 'Update tenant authentication assurance settings'
			},
			{
				key: 'admin:settings:security:update',
				description: 'Update tenant protocol security settings'
			},
			{
				key: 'admin:settings:token_exchange:update',
				description: 'Update tenant token exchange settings'
			},
			{ key: 'admin:settings:oauth:update', description: 'Update tenant OAuth settings' },
			{
				key: 'admin:settings:session:update',
				description: 'Update tenant session and logout settings'
			},
			{ key: 'admin:settings:login_ui:update', description: 'Update tenant login UI settings' },
			{ key: 'admin:policy:simulate', description: 'Simulate tenant authorization policies' },
			{ key: 'admin:flows:validate', description: 'Validate authentication Flows' },
			{ key: 'admin:flows:compile', description: 'Compile authentication Flows' },
			{ key: 'admin:flows:publish', description: 'Publish authentication Flows' }
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
