import type { TranslationFunctions } from '$i18n/i18n-types';
import type { RoleType } from '$lib/api/admin-roles';

export function formatRoleType(
	type: RoleType | null | undefined,
	LL: TranslationFunctions
): string {
	switch (type) {
		case 'system':
			return LL.admin_roles_type_system();
		case 'builtin':
			return LL.admin_roles_type_builtin();
		case 'custom':
			return LL.admin_roles_type_custom();
		default:
			return '';
	}
}

export function formatRoleFilterType(
	type: 'system' | 'builtin' | 'custom',
	LL: TranslationFunctions
) {
	return formatRoleType(type, LL);
}

export function formatScope(scope: string, LL: TranslationFunctions): string {
	switch (scope) {
		case 'global':
			return LL.admin_roles_scope_global();
		case 'org':
			return LL.admin_roles_scope_org();
		case 'resource':
			return LL.admin_roles_scope_resource();
		case 'organization':
			return LL.admin_roles_scope_organization();
		case 'client':
			return LL.admin_roles_scope_client();
		default:
			return scope;
	}
}

export function formatPermissionCategory(category: string, LL: TranslationFunctions): string {
	switch (category) {
		case 'admin':
			return LL.admin_roles_perm_category_admin();
		case 'users':
			return LL.admin_roles_perm_category_users();
		case 'clients':
			return LL.admin_roles_perm_category_clients();
		case 'sessions':
			return LL.admin_roles_perm_category_sessions();
		case 'organizations':
			return LL.admin_roles_perm_category_organizations();
		case 'stats':
			return LL.admin_roles_perm_category_stats();
		case 'audit':
			return LL.admin_roles_perm_category_audit();
		case 'settings':
			return LL.admin_roles_perm_category_settings();
		case 'roles':
			return LL.admin_roles_perm_category_roles();
		case 'webhooks':
			return LL.admin_roles_perm_category_webhooks();
		case 'compliance':
			return LL.admin_roles_perm_category_compliance();
		default:
			return category;
	}
}

export function formatPermissionLabel(permissionId: string, LL: TranslationFunctions): string {
	switch (permissionId) {
		case 'admin:access':
			return LL.admin_roles_perm_admin_access_label();
		case 'users:read':
			return LL.admin_roles_perm_users_read_label();
		case 'users:write':
			return LL.admin_roles_perm_users_write_label();
		case 'users:create':
			return LL.admin_roles_perm_users_create_label();
		case 'users:update':
			return LL.admin_roles_perm_users_update_label();
		case 'users:delete':
			return LL.admin_roles_perm_users_delete_label();
		case 'clients:read':
			return LL.admin_roles_perm_clients_read_label();
		case 'clients:write':
			return LL.admin_roles_perm_clients_write_label();
		case 'clients:delete':
			return LL.admin_roles_perm_clients_delete_label();
		case 'sessions:read':
			return LL.admin_roles_perm_sessions_read_label();
		case 'sessions:revoke':
			return LL.admin_roles_perm_sessions_revoke_label();
		case 'organizations:read':
			return LL.admin_roles_perm_organizations_read_label();
		case 'organizations:create':
			return LL.admin_roles_perm_organizations_create_label();
		case 'organizations:update':
			return LL.admin_roles_perm_organizations_update_label();
		case 'organizations:delete':
			return LL.admin_roles_perm_organizations_delete_label();
		case 'stats:read':
			return LL.admin_roles_perm_stats_read_label();
		case 'audit:read':
			return LL.admin_roles_perm_audit_read_label();
		case 'settings:read':
			return LL.admin_roles_perm_settings_read_label();
		case 'settings:write':
			return LL.admin_roles_perm_settings_write_label();
		case 'roles:read':
			return LL.admin_roles_perm_roles_read_label();
		case 'roles:write':
			return LL.admin_roles_perm_roles_write_label();
		case 'roles:delete':
			return LL.admin_roles_perm_roles_delete_label();
		case 'roles:assign':
			return LL.admin_roles_perm_roles_assign_label();
		case 'webhooks:read':
			return LL.admin_roles_perm_webhooks_read_label();
		case 'webhooks:write':
			return LL.admin_roles_perm_webhooks_write_label();
		case 'webhooks:delete':
			return LL.admin_roles_perm_webhooks_delete_label();
		case 'compliance:read':
			return LL.admin_roles_perm_compliance_read_label();
		case 'compliance:write':
			return LL.admin_roles_perm_compliance_write_label();
		default:
			return permissionId;
	}
}

export function formatPermissionDescription(
	permissionId: string,
	LL: TranslationFunctions
): string {
	switch (permissionId) {
		case 'admin:access':
			return LL.admin_roles_perm_admin_access_desc();
		case 'users:read':
			return LL.admin_roles_perm_users_read_desc();
		case 'users:write':
			return LL.admin_roles_perm_users_write_desc();
		case 'users:create':
			return LL.admin_roles_perm_users_create_desc();
		case 'users:update':
			return LL.admin_roles_perm_users_update_desc();
		case 'users:delete':
			return LL.admin_roles_perm_users_delete_desc();
		case 'clients:read':
			return LL.admin_roles_perm_clients_read_desc();
		case 'clients:write':
			return LL.admin_roles_perm_clients_write_desc();
		case 'clients:delete':
			return LL.admin_roles_perm_clients_delete_desc();
		case 'sessions:read':
			return LL.admin_roles_perm_sessions_read_desc();
		case 'sessions:revoke':
			return LL.admin_roles_perm_sessions_revoke_desc();
		case 'organizations:read':
			return LL.admin_roles_perm_organizations_read_desc();
		case 'organizations:create':
			return LL.admin_roles_perm_organizations_create_desc();
		case 'organizations:update':
			return LL.admin_roles_perm_organizations_update_desc();
		case 'organizations:delete':
			return LL.admin_roles_perm_organizations_delete_desc();
		case 'stats:read':
			return LL.admin_roles_perm_stats_read_desc();
		case 'audit:read':
			return LL.admin_roles_perm_audit_read_desc();
		case 'settings:read':
			return LL.admin_roles_perm_settings_read_desc();
		case 'settings:write':
			return LL.admin_roles_perm_settings_write_desc();
		case 'roles:read':
			return LL.admin_roles_perm_roles_read_desc();
		case 'roles:write':
			return LL.admin_roles_perm_roles_write_desc();
		case 'roles:delete':
			return LL.admin_roles_perm_roles_delete_desc();
		case 'roles:assign':
			return LL.admin_roles_perm_roles_assign_desc();
		case 'webhooks:read':
			return LL.admin_roles_perm_webhooks_read_desc();
		case 'webhooks:write':
			return LL.admin_roles_perm_webhooks_write_desc();
		case 'webhooks:delete':
			return LL.admin_roles_perm_webhooks_delete_desc();
		case 'compliance:read':
			return LL.admin_roles_perm_compliance_read_desc();
		case 'compliance:write':
			return LL.admin_roles_perm_compliance_write_desc();
		default:
			return permissionId;
	}
}
