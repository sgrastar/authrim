import type { TranslationFunctions } from '$i18n/i18n-types';

export function formatAdminRoleType(type: string | null | undefined, LL: TranslationFunctions) {
	switch (type) {
		case 'system':
			return LL.admin_admin_rbac_type_system();
		case 'builtin':
			return LL.admin_admin_rbac_type_builtin();
		case 'custom':
			return LL.admin_admin_rbac_type_custom();
		default:
			return type || '';
	}
}

export function formatAdminRoleAssignmentStatus(
	status: 'active' | 'expired',
	LL: TranslationFunctions
) {
	return status === 'active' ? LL.admin_admin_rbac_active() : LL.admin_admin_rbac_expired();
}

export function formatAdminRoleScope(
	scopeType: string,
	scopeId: string | null | undefined,
	tenantId: string | null | undefined,
	LL: TranslationFunctions
) {
	if (scopeType === 'global') {
		return LL.admin_admin_rbac_scope_global();
	}
	if (scopeType === 'tenant') {
		return LL.admin_admin_rbac_scope_tenant_with_id({ id: scopeId || tenantId || '' });
	}
	const scope = `${scopeType}${scopeId ? `:${scopeId}` : ''}`;
	return LL.admin_admin_rbac_scope_unsupported({ scope });
}

export function formatAdminPermissionCategory(category: string, LL: TranslationFunctions) {
	switch (category) {
		case 'Admin Users':
			return LL.admin_admin_rbac_perm_category_admin_users();
		case 'Admin Roles':
			return LL.admin_admin_rbac_perm_category_admin_roles();
		case 'Admin Audit':
			return LL.admin_admin_rbac_perm_category_admin_audit();
		case 'Approvals':
			return LL.admin_admin_rbac_perm_category_approvals();
		case 'Jobs':
			return LL.admin_admin_rbac_perm_category_jobs();
		case 'Storage Destinations':
			return LL.admin_admin_rbac_perm_category_storage_destinations();
		case 'Destination Selection':
			return LL.admin_admin_rbac_perm_category_destination_selection();
		case 'Database Connections':
			return LL.admin_admin_rbac_perm_category_database_connections();
		case 'Database Routing':
			return LL.admin_admin_rbac_perm_category_database_routing();
		case 'Operational Logs':
			return LL.admin_admin_rbac_perm_category_operational_logs();
		case 'Webhooks':
			return LL.admin_admin_rbac_perm_category_webhooks();
		case 'External Identity Providers':
			return LL.admin_admin_rbac_perm_category_external_identity_providers();
		case 'SAML Providers':
			return LL.admin_admin_rbac_perm_category_saml_providers();
		case 'IP Allowlist':
			return LL.admin_admin_rbac_perm_category_ip_allowlist();
		case 'End Users':
			return LL.admin_admin_rbac_perm_category_end_users();
		case 'OAuth Clients':
			return LL.admin_admin_rbac_perm_category_oauth_clients();
		case 'Admin Machine Access':
			return LL.admin_admin_rbac_perm_category_admin_machine_access();
		case 'End User Roles':
			return LL.admin_admin_rbac_perm_category_end_user_roles();
		case 'Settings':
			return LL.admin_admin_rbac_perm_category_settings();
		case 'Tenant Domains':
			return LL.admin_admin_rbac_perm_category_tenant_domains();
		case 'Security':
			return LL.admin_admin_rbac_perm_category_security();
		case 'Audit Logs':
			return LL.admin_admin_rbac_perm_category_audit_logs();
		case 'Wildcard':
			return LL.admin_admin_rbac_perm_category_wildcard();
		default:
			return category;
	}
}

export function formatAdminPermissionCategoryDescription(
	category: string,
	LL: TranslationFunctions
) {
	switch (category) {
		case 'Admin Users':
			return LL.admin_admin_rbac_perm_category_admin_users_desc();
		case 'Admin Roles':
			return LL.admin_admin_rbac_perm_category_admin_roles_desc();
		case 'Admin Audit':
			return LL.admin_admin_rbac_perm_category_admin_audit_desc();
		case 'Approvals':
			return LL.admin_admin_rbac_perm_category_approvals_desc();
		case 'Jobs':
			return LL.admin_admin_rbac_perm_category_jobs_desc();
		case 'Storage Destinations':
			return LL.admin_admin_rbac_perm_category_storage_destinations_desc();
		case 'Destination Selection':
			return LL.admin_admin_rbac_perm_category_destination_selection_desc();
		case 'Database Connections':
			return LL.admin_admin_rbac_perm_category_database_connections_desc();
		case 'Database Routing':
			return LL.admin_admin_rbac_perm_category_database_routing_desc();
		case 'Operational Logs':
			return LL.admin_admin_rbac_perm_category_operational_logs_desc();
		case 'Webhooks':
			return LL.admin_admin_rbac_perm_category_webhooks_desc();
		case 'External Identity Providers':
			return LL.admin_admin_rbac_perm_category_external_identity_providers_desc();
		case 'SAML Providers':
			return LL.admin_admin_rbac_perm_category_saml_providers_desc();
		case 'IP Allowlist':
			return LL.admin_admin_rbac_perm_category_ip_allowlist_desc();
		case 'End Users':
			return LL.admin_admin_rbac_perm_category_end_users_desc();
		case 'OAuth Clients':
			return LL.admin_admin_rbac_perm_category_oauth_clients_desc();
		case 'Admin Machine Access':
			return LL.admin_admin_rbac_perm_category_admin_machine_access_desc();
		case 'End User Roles':
			return LL.admin_admin_rbac_perm_category_end_user_roles_desc();
		case 'Settings':
			return LL.admin_admin_rbac_perm_category_settings_desc();
		case 'Tenant Domains':
			return LL.admin_admin_rbac_perm_category_tenant_domains_desc();
		case 'Security':
			return LL.admin_admin_rbac_perm_category_security_desc();
		case 'Audit Logs':
			return LL.admin_admin_rbac_perm_category_audit_logs_desc();
		case 'Wildcard':
			return LL.admin_admin_rbac_perm_category_wildcard_desc();
		default:
			return category;
	}
}
