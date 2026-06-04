const adminAccessControl = {
	admin_access_control_head_title: 'Access Control Hub - Admin Dashboard - Authrim',
	admin_access_control_banner_title: 'End User Access Control',
	admin_access_control_banner:
		"This page manages access control for End Users (your application's users). For Admin Operator access control, visit ",
	admin_access_control_admin_hub: 'Admin Access Control Hub',
	admin_access_control_title: 'Access Control Hub',
	admin_access_control_description:
		'Unified management for RBAC, ABAC, ReBAC, and Policy-based access control.',
	admin_access_control_loading: 'Loading access control statistics...',
	admin_access_control_load_failed: 'Failed to load access control statistics',
	admin_access_control_retry: 'Retry',
	admin_access_control_rbac_subtitle: 'Roles',
	admin_access_control_rbac_description:
		'Manage user roles and permissions through role-based access control.',
	admin_access_control_rbac_stats: '{roles:number} roles, {assignments:number} assignments',
	admin_access_control_abac_subtitle: 'Attributes',
	admin_access_control_abac_description:
		'Define and manage user attributes for attribute-based access control.',
	admin_access_control_abac_stats: '{attributes:number} attributes ({active:number} active)',
	admin_access_control_rebac_subtitle: 'Relations',
	admin_access_control_rebac_description:
		'Model complex relationships between entities for fine-grained access.',
	admin_access_control_rebac_stats: '{definitions:number} definitions, {tuples:number} tuples',
	admin_access_control_policies_title: 'Policies',
	admin_access_control_policies_subtitle: 'Combined Rules',
	admin_access_control_policies_description:
		'Combine RBAC, ABAC, and ReBAC conditions to create fine-grained access control policies. Define complex rules that evaluate multiple factors to determine access decisions.',
	admin_access_control_policies_stats: '{policies:number} policies ({active:number} active)',
	admin_access_control_related_tools: 'Related Tools',
	admin_access_control_access_trace: 'Access Trace',
	admin_access_control_access_trace_desc: 'Debug access decisions',
	admin_access_control_role_rules: 'Role Assignment Rules',
	admin_access_control_role_rules_desc: 'Automatic role assignment'
} as const;

export default adminAccessControl;
