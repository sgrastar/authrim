/**
 * Information architecture: every area (top-level category) and item (left nav) the console
 * knows about. Ported from the admin UI redesign mock (private/admin-ui-redesign-2026), which is
 * where the structure was decided. `legacyRoutes` records which legacy Admin UI pages each item
 * takes over, so nothing is dropped while pages are rebuilt one by one.
 *
 * Labels are message keys. Edit this file (not the shell components) to change the navigation.
 */
import type { NavArea, TopEntry } from './nav-types';

export const TENANT_AREAS: readonly NavArea[] = [
	{
		id: 'overview',
		label: 'nav.overview',
		icon: 'gauge',
		scope: 'tenant',
		children: [],
		legacyRoutes: ['/admin']
	},
	{
		id: 'users',
		label: 'nav.users',
		icon: 'users',
		scope: 'enduser',
		children: [
			{
				id: 'all',
				label: 'nav.users.all',
				platform: 'lookup',
				details: true,
				requires: { permission: 'admin:users:read' },
				legacyRoutes: ['/admin/users', '/admin/users/[id]', '/admin/users/new']
			},
			{
				id: 'agents',
				label: 'nav.users.agents',
				platform: 'lookup',
				legacyRoutes: ['(new) エージェントアカウント']
			},
			{
				id: 'organizations',
				label: 'nav.users.orgs',
				platform: 'tenant',
				retire: 'retire.org',
				legacyRoutes: ['/admin/organizations']
			},
			{
				id: 'service-groups',
				label: 'nav.users.serviceGroups',
				platform: 'tenant',
				legacyRoutes: ['/admin/service-groups']
			},
			{
				id: 'lifecycle',
				label: 'nav.users.lifecycle',
				platform: 'tenant',
				legacyRoutes: ['/admin/account-lifecycle']
			},
			{
				id: 'sessions',
				label: 'nav.users.sessions',
				platform: 'lookup',
				legacyRoutes: ['/admin/sessions']
			},
			{
				id: 'invitations',
				label: 'nav.users.invitations',
				platform: 'tenant',
				legacyRoutes: ['/admin/tenants/[id]/invitations', '(new) エンドユーザー招待']
			},
			{
				id: 'support',
				label: 'nav.users.support',
				platform: 'lookup',
				legacyRoutes: ['/admin/support-ops']
			},
			{
				id: 'resolution',
				label: 'nav.users.resolution',
				platform: 'lookup',
				legacyRoutes: ['/admin/resolution-center', '/admin/field-mapping/resolution-center']
			}
		],
		legacyRoutes: []
	},
	{
		id: 'access',
		label: 'nav.access',
		icon: 'shield',
		scope: 'enduser',
		children: [
			{
				id: 'apis',
				label: 'nav.apps.apis',
				legacyRoutes: ['(new) API / リソース定義']
			},
			{
				id: 'roles',
				label: 'nav.access.roles',
				legacyRoutes: ['/admin/roles', '/admin/roles/[id]']
			},
			{
				id: 'role-rules',
				label: 'nav.access.roleRules',
				legacyRoutes: ['/admin/role-rules', '/admin/roles (割り当てルール タブ)']
			},
			{
				id: 'attributes',
				label: 'nav.access.attributes',
				legacyRoutes: ['/admin/attributes']
			},
			{
				id: 'relationships',
				label: 'nav.access.relationships',
				legacyRoutes: ['/admin/rebac', '/admin/rebac/definitions', '/admin/rebac/tuples']
			},
			{
				id: 'policies',
				label: 'nav.access.policies',
				legacyRoutes: ['/admin/policies']
			},
			{
				id: 'schema-setting',
				label: 'nav.data.schema',
				platform: 'template',
				legacyRoutes: ['/admin/custom-claims', '/admin/custom-claims/[id]']
			},
			{
				id: 'profiles',
				label: 'nav.data.profiles',
				platform: 'template',
				legacyRoutes: ['/admin/field-mapping/profiles', '/admin/field-mapping/profiles/edit']
			},
			{
				id: 'mapping-sets',
				label: 'nav.data.mappingSets',
				platform: 'template',
				legacyRoutes: ['/admin/field-mapping/field-mapping-sets', '/admin/field-mapping/edit']
			},
			{
				id: 'simulator',
				label: 'nav.access.simulator',
				platform: 'tenant',
				legacyRoutes: ['/admin/access-trace', '/admin/rebac (Permission Check)']
			}
		],
		legacyRoutes: []
	},
	{
		id: 'applications',
		label: 'nav.applications',
		icon: 'app',
		scope: 'client',
		children: [
			{
				id: 'all',
				label: 'nav.apps.all',
				platform: 'template',
				ownsSide: true,
				legacyRoutes: [
					'/admin/clients',
					'/admin/clients/[id]',
					'/admin/clients/new',
					'/admin/flows',
					'/admin/flows/[id]',
					'/admin/settings/flows',
					'/admin/webhooks',
					'/admin/webhooks/[id]/deliveries',
					'/admin/iat-tokens',
					'/admin/scim-tokens'
				]
			}
		],
		legacyRoutes: []
	},
	{
		id: 'authentication',
		label: 'nav.authentication',
		icon: 'key',
		scope: 'tenant',
		children: [
			{
				id: 'methods',
				label: 'nav.auth.methods',
				details: true,
				legacyRoutes: ['/admin/authentication-methods', '/admin/authentication-methods/[profileId]']
			},
			{
				id: 'session-profiles',
				label: 'nav.auth.sessionProfiles',
				// In platform scope: the platform's session profiles and its Default.
				details: true,
				// The profiles API answers to the session settings' access (SSO is held with them).
				requires: { settings: ['session'] },
				legacyRoutes: []
			},
			{
				id: 'logout',
				label: 'nav.auth.logout',
				platform: 'tenant',
				requires: { settings: ['session'] },
				legacyRoutes: []
			},
			{
				id: 'tokens',
				label: 'nav.auth.tokens',
				platform: 'tenant',
				requires: { settings: ['oauth', 'tokens', 'security', 'federation', 'assurance'] },
				legacyRoutes: []
			},
			{
				id: 'social',
				label: 'nav.auth.social',
				legacyRoutes: ['/admin/external-idp', '/admin/external-idp/[id]']
			},
			{
				id: 'token-refresh',
				label: 'nav.auth.tokenRefresh',
				legacyRoutes: ['/admin/external-token-refresh']
			},
			{
				id: 'enterprise',
				label: 'nav.auth.enterprise',
				platform: 'tenant',
				requires: { settings: ['federation', 'institution'] },
				legacyRoutes: ['/admin/saml', '/admin/saml/[id]', '/admin/saml/local']
			},
			{
				id: 'directory',
				label: 'nav.auth.directory',
				legacyRoutes: [
					'/admin/directory-authentication',
					'/admin/directory-authentication/fleet',
					'/admin/directory-authentication/migration'
				]
			},
			{
				id: 'federation-trust',
				label: 'nav.data.federationTrust',
				platform: 'template',
				legacyRoutes: ['/admin/field-mapping/federation-trust']
			},
			{
				id: 'protection',
				label: 'nav.auth.protection',
				platform: 'tenant',
				requires: { settings: ['rate-limit'] },
				legacyRoutes: ['/admin/security']
			},
			{
				id: 'ip-allowlist',
				label: 'nav.auth.ipAllowlist',
				legacyRoutes: ['/admin/ip-allowlist']
			}
		],
		legacyRoutes: []
	},
	{
		id: 'customization',
		label: 'nav.customization',
		icon: 'brush',
		scope: 'tenant',
		children: [
			{
				id: 'branding',
				label: 'nav.custom.branding',
				// The theme editor: …/branding/new and …/branding/<theme id>.
				details: true,
				legacyRoutes: ['/admin/themes']
			},
			{
				id: 'login-ui',
				label: 'nav.custom.loginUi',
				legacyRoutes: ['/admin/login-ui']
			},
			{
				id: 'screens',
				label: 'nav.custom.screens',
				// The screen builder: …/screens/new and …/screens/<screen id>.
				details: true,
				legacyRoutes: ['/admin/screens']
			},
			{
				id: 'account-page',
				label: 'nav.custom.accountPage',
				legacyRoutes: ['/admin/account-page']
			},
			{
				id: 'launchers',
				label: 'nav.custom.launchers',
				// The launcher editor: …/launchers/new and …/launchers/<launcher id>.
				details: true,
				legacyRoutes: ['/admin/launchers']
			},
			{
				id: 'statements',
				label: 'nav.custom.statements',
				// The statement page: …/statements/new and …/statements/<statement id>.
				details: true,
				legacyRoutes: ['/admin/consent-statements', '/admin/consent-statements/[id]']
			},
			{
				id: 'emails',
				label: 'nav.custom.emails',
				legacyRoutes: ['/admin/email-settings']
			}
		],
		legacyRoutes: []
	},
	{
		id: 'monitoring',
		label: 'nav.monitoring',
		icon: 'activity',
		scope: 'tenant',
		children: [
			{
				id: 'audit',
				label: 'nav.mon.audit',
				requires: { permission: 'admin:audit:read' },
				legacyRoutes: ['/admin/audit-logs', '/admin/audit-logs/[id]']
			},
			{
				id: 'admin-activity',
				label: 'nav.mon.adminActivity',
				requires: { permission: 'admin:admin_audit:read' },
				legacyRoutes: ['/admin/admin-audit']
			},
			{
				id: 'admin-logging',
				label: 'nav.mon.adminLogging',
				legacyRoutes: ['/admin/admin-logging']
			},
			{
				id: 'system',
				label: 'nav.mon.system',
				legacyRoutes: ['/admin/operational-logs']
			},
			{
				id: 'diagnostics',
				label: 'nav.mon.diagnostics',
				legacyRoutes: ['/admin/diagnostic-logging', '/admin/diagnostic-logging/export']
			},
			{
				id: 'deliveries',
				label: 'nav.mon.deliveries',
				legacyRoutes: ['/admin/email-deliveries']
			},
			{
				id: 'log-settings',
				label: 'nav.mon.settings',
				legacyRoutes: ['/admin/logging-policies']
			},
			{
				id: 'destinations',
				label: 'nav.mon.destinations',
				legacyRoutes: ['/admin/storage-destinations']
			}
		],
		legacyRoutes: []
	},
	{
		id: 'integrations',
		label: 'nav.integrations',
		icon: 'plug',
		scope: 'tenant',
		children: [
			{
				id: 'plugins',
				label: 'nav.int.plugins',
				legacyRoutes: ['/admin/plugins']
			},
			{
				id: 'notifications',
				label: 'nav.int.notifications',
				legacyRoutes: ['/admin/notifications']
			}
		],
		legacyRoutes: []
	},
	{
		id: 'settings',
		label: 'nav.settings',
		icon: 'gear',
		scope: 'tenant',
		children: [
			{
				id: 'general',
				label: 'nav.set.general',
				platform: 'tenant',
				legacyRoutes: ['/admin/info']
			},
			{
				id: 'tenant-config',
				label: 'nav.set.tenantConfig',
				legacyRoutes: ['/admin/settings', '/admin/settings/[category]']
			},
			{
				id: 'signing-keys',
				label: 'nav.set.signingKeys',
				platform: 'tenant',
				legacyRoutes: ['/admin/settings/signing-keys']
			},
			{
				id: 'runtime',
				label: 'nav.set.runtime',
				legacyRoutes: [
					'/admin/settings/runtime-profiles',
					'/admin/settings/cache-mode',
					'/admin/settings/sharding'
				]
			},
			{
				id: 'domains',
				label: 'nav.set.domains',
				platform: 'tenant',
				legacyRoutes: ['/admin/tenant-vanity-domains', '/admin/platform/tenant-domain-mappings']
			},
			{
				id: 'compliance',
				label: 'nav.set.compliance',
				legacyRoutes: ['/admin/compliance', '/admin/directory-authentication/compliance']
			},
			{
				id: 'team',
				label: 'nav.set.team',
				platform: 'tenant',
				// The administrators (their read permission) or how they sign in (those settings).
				requires: {
					settings: ['session', 'security', 'admin-invitations', 'machine-access'],
					permission: 'admin:admin_users:read'
				},
				// …/team/invite (later, an administrator's page).
				details: true,
				legacyRoutes: ['/admin/admins (このテナントの管理者のみ)']
			},
			{
				id: 'team-groups',
				label: 'nav.set.teamGroups',
				platform: 'tenant',
				requires: { permission: 'admin:admin_users:read' },
				// …/team-groups/<id>: a group's page.
				details: true,
				legacyRoutes: ['(new) 管理者グループ']
			},
			{
				id: 'team-roles',
				label: 'nav.set.teamRoles',
				platform: 'tenant',
				requires: { permission: 'admin:admin_roles:read' },
				// …/team-roles/<id> and …/team-roles/new: a role's page.
				details: true,
				legacyRoutes: ['/admin/admin-roles (このテナントへの割り当てのみ)']
			}
		],
		legacyRoutes: []
	}
];

export const PLATFORM_AREAS: readonly NavArea[] = [
	{
		id: 'plat-overview',
		label: 'nav.platArea.overview',
		icon: 'gauge',
		scope: 'platform',
		children: [],
		legacyRoutes: ['(new) 全テナントの状態サマリ']
	},
	{
		id: 'plat-tenants',
		label: 'nav.platArea.tenants',
		icon: 'building',
		scope: 'platform',
		children: [
			{
				id: 'list',
				label: 'nav.pt.list',
				// Creating a tenant starts from the list; copying one from its page.
				details: true,
				legacyRoutes: [
					'/admin/tenants',
					'/admin/tenants/[id]',
					'/admin/tenants/new',
					'/admin/tenants/clone'
				]
			},
			{
				id: 'discovery',
				label: 'nav.auth.discovery',
				legacyRoutes: ['/admin/tenant-discovery']
			},
			{
				id: 'domains',
				label: 'nav.pt.domains',
				legacyRoutes: ['/admin/tenant-vanity-domains', '/admin/platform/tenant-domain-mappings']
			},
			{
				id: 'invitations',
				label: 'nav.pt.invitations',
				legacyRoutes: ['/admin/tenants/[id]/invitations']
			}
		],
		legacyRoutes: []
	},
	{
		id: 'plat-admins',
		label: 'nav.platArea.admins',
		icon: 'users',
		scope: 'platform',
		children: [
			{
				id: 'users',
				label: 'nav.pa.users',
				legacyRoutes: ['/admin/admins (全テナント)', '/admin/admins/[id]']
			},
			{
				id: 'roles',
				label: 'nav.pa.roles',
				legacyRoutes: ['/admin/admin-rbac', '/admin/admin-rbac/[id]', '/admin/admin-roles']
			},
			{
				id: 'attributes',
				label: 'nav.pa.attributes',
				legacyRoutes: ['/admin/admin-abac']
			},
			{
				id: 'relationships',
				label: 'nav.pa.relationships',
				legacyRoutes: [
					'/admin/admin-rebac',
					'/admin/admin-rebac/definitions',
					'/admin/admin-rebac/tuples'
				]
			},
			{
				id: 'policies',
				label: 'nav.pa.policies',
				legacyRoutes: ['/admin/admin-policies', '/admin/admin-access-control']
			},
			{
				id: 'machine',
				label: 'nav.pa.machine',
				details: true,
				legacyRoutes: ['/admin/machine-access']
			},
			{
				id: 'agents',
				label: 'nav.pa.agents',
				legacyRoutes: [
					'/admin/agent-access',
					'/admin/agent-access/grants',
					'/admin/agent-access/plans',
					'/admin/agent-access/baselines',
					'/admin/agent-access/bulk-plans',
					'/admin/agent-access/templates',
					'/admin/agent-access/scope-policies',
					'/admin/agent-access/task-sets',
					'/admin/agent-access/secret-refs',
					'/admin/agent-access/settings'
				]
			}
		],
		legacyRoutes: []
	},
	{
		id: 'plat-infra',
		label: 'nav.platArea.infra',
		icon: 'stack',
		scope: 'platform',
		children: [
			{
				id: 'releases',
				label: 'nav.pi.releases',
				legacyRoutes: ['/admin/control-plane']
			},
			{
				id: 'database-connections',
				label: 'nav.data.sources',
				legacyRoutes: ['/admin/database-connections', '/admin/database-connections/[id]']
			},
			{
				id: 'scale',
				label: 'nav.pi.scale',
				legacyRoutes: ['/admin/scale']
			},
			{
				id: 'storage',
				label: 'nav.pi.storage',
				legacyRoutes: ['/admin/storage-topology']
			},
			{
				id: 'backup',
				label: 'nav.pi.backup',
				legacyRoutes: ['/admin/dr-backup']
			},
			{
				id: 'jobs',
				label: 'nav.pi.jobs',
				legacyRoutes: ['/admin/jobs']
			}
		],
		legacyRoutes: []
	},
	{
		id: 'plat-approvals',
		label: 'nav.platArea.approvals',
		icon: 'check',
		scope: 'platform',
		badge: '3',
		children: [
			{
				id: 'queue',
				label: 'nav.pv.queue',
				badge: '3',
				legacyRoutes: ['/admin/approvals']
			},
			{
				id: 'elevations',
				label: 'nav.pv.elevations',
				legacyRoutes: ['/admin/agent-access/elevations/[id]']
			}
		],
		legacyRoutes: []
	}
];

/** Header categories in tenant scope. `merges` shows several areas under one category. */
export const TENANT_TOPNAV: readonly TopEntry[] = [
	{
		id: 'overview'
	},
	{
		id: 'applications'
	},
	{
		id: 'users'
	},
	{
		id: 'access'
	},
	{
		id: 'authentication'
	},
	{
		id: 'customization'
	},
	{
		id: 'operate',
		label: 'nav.cluster.operate',
		icon: 'activity',
		scope: 'tenant',
		merges: ['monitoring', 'integrations']
	},
	{
		id: 'settings'
	}
];

/**
 * Header categories in platform scope. The platform's own come first; the `inherited` ones after
 * them hold the defaults every tenant starts from.
 */
export const PLATFORM_TOPNAV: readonly TopEntry[] = [
	{
		id: 'plat-overview'
	},
	{
		id: 'plat-tenants'
	},
	{
		id: 'plat-admins'
	},
	{
		id: 'plat-infra'
	},
	{
		id: 'plat-approvals'
	},
	{
		id: 'applications',
		inherited: true
	},
	{
		id: 'users',
		inherited: true
	},
	{
		id: 'access',
		inherited: true
	},
	{
		id: 'configure',
		label: 'nav.cluster.configure',
		icon: 'gear',
		scope: 'tenant',
		merges: ['authentication', 'customization'],
		inherited: true
	},
	{
		id: 'operate',
		label: 'nav.cluster.operate',
		icon: 'activity',
		scope: 'tenant',
		merges: ['monitoring', 'integrations', 'settings'],
		inherited: true
	}
];
