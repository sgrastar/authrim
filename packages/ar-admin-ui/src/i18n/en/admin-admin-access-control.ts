const adminAdminAccessControl = {
	admin_admin_access_control_head_title: 'Admin Access Control Hub - Admin Dashboard - Authrim',
	admin_admin_access_control_title: 'Admin Access Control Hub',
	admin_admin_access_control_description:
		'Unified management for Admin RBAC, ABAC, ReBAC, and Policy-based access control for admin operators.',
	admin_admin_access_control_loading: 'Loading admin access control statistics...',
	admin_admin_access_control_load_failed: 'Failed to load admin access control statistics',
	admin_admin_access_control_retry: 'Retry',
	admin_admin_access_control_rbac_subtitle: 'Admin Roles',
	admin_admin_access_control_rbac_description:
		'Manage admin operator roles and permissions through role-based access control.',
	admin_admin_access_control_rbac_stats: '{roles:number} roles, {assignments:number} assignments',
	admin_admin_access_control_abac_subtitle: 'Admin Attributes',
	admin_admin_access_control_abac_description:
		'Define and manage admin operator attributes for attribute-based access control.',
	admin_admin_access_control_abac_stats: '{attributes:number} attributes ({active:number} active)',
	admin_admin_access_control_rebac_subtitle: 'Admin Relations',
	admin_admin_access_control_rebac_description:
		'Model complex relationships between admin operators for fine-grained access.',
	admin_admin_access_control_rebac_stats:
		'{definitions:number} definitions, {tuples:number} tuples',
	admin_admin_access_control_policies_title: 'Policies',
	admin_admin_access_control_policies_subtitle: 'Combined Admin Rules',
	admin_admin_access_control_policies_description:
		'Combine Admin RBAC, ABAC, and ReBAC conditions to create fine-grained access control policies for admin operators. Define complex rules that evaluate multiple factors to determine access decisions.',
	admin_admin_access_control_policies_stats: '{policies:number} policies ({active:number} active)',
	admin_admin_access_control_related_tools: 'Related Tools',
	admin_admin_access_control_admin_audit_log: 'Admin Audit Log',
	admin_admin_access_control_admin_audit_log_desc: 'Review admin actions',
	admin_admin_access_control_ip_allowlist: 'IP Allowlist',
	admin_admin_access_control_ip_allowlist_desc: 'Network access control'
} as const;

export default adminAdminAccessControl;
