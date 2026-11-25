/**
 * Information architecture: every area (top-level category) and item (left nav) the console
 * knows about. Ported from the admin UI redesign mock (private/admin-ui-redesign-2026), which is
 * where the structure was decided.
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
		children: []
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
				requires: { permission: 'admin:users:read' }
			},
			{
				id: 'agents',
				label: 'nav.users.agents',
				platform: 'lookup'
			},
			{
				id: 'organizations',
				label: 'nav.users.orgs',
				platform: 'tenant',
				retire: 'retire.org'
			},
			{
				id: 'service-groups',
				label: 'nav.users.serviceGroups',
				platform: 'tenant'
			},
			{
				id: 'lifecycle',
				label: 'nav.users.lifecycle',
				platform: 'tenant'
			},
			{
				id: 'sessions',
				label: 'nav.users.sessions',
				platform: 'lookup'
			},
			{
				id: 'invitations',
				label: 'nav.users.invitations',
				platform: 'tenant'
			},
			{
				id: 'support',
				label: 'nav.users.support',
				platform: 'lookup'
			}
		]
	},
	{
		id: 'access',
		label: 'nav.access',
		icon: 'shield',
		scope: 'enduser',
		children: [
			{
				id: 'apis',
				label: 'nav.apps.apis'
			},
			{
				id: 'roles',
				label: 'nav.access.roles'
			},
			{
				id: 'role-rules',
				label: 'nav.access.roleRules'
			},
			{
				id: 'attributes',
				label: 'nav.access.attributes'
			},
			{
				id: 'relationships',
				label: 'nav.access.relationships'
			},
			{
				id: 'policies',
				label: 'nav.access.policies'
			},
			{
				id: 'schema-setting',
				label: 'nav.data.schema',
				platform: 'template'
			},
			{
				id: 'profiles',
				label: 'nav.data.profiles',
				platform: 'template'
			},
			{
				id: 'mapping-sets',
				label: 'nav.data.mappingSets',
				platform: 'template'
			},
			{
				id: 'simulator',
				label: 'nav.access.simulator',
				platform: 'tenant'
			}
		]
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
				ownsSide: true
			}
		]
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
				details: true
			},
			{
				id: 'session-profiles',
				label: 'nav.auth.sessionProfiles',
				// In platform scope: the platform's session profiles and its Default.
				details: true,
				// The profiles API answers to the session settings' access (SSO is held with them).
				requires: { settings: ['session'] }
			},
			{
				id: 'logout',
				label: 'nav.auth.logout',
				platform: 'tenant',
				requires: { settings: ['session'] }
			},
			{
				id: 'tokens',
				label: 'nav.auth.tokens',
				platform: 'tenant',
				requires: { settings: ['oauth', 'tokens', 'security', 'federation', 'assurance'] }
			},
			{
				id: 'social',
				label: 'nav.auth.social'
			},
			{
				id: 'token-refresh',
				label: 'nav.auth.tokenRefresh'
			},
			{
				id: 'enterprise',
				label: 'nav.auth.enterprise',
				platform: 'tenant',
				// The SAML settings (those categories), or the tenant's own SAML identity below them
				// (its read permission): either opens the page.
				requires: {
					settings: ['federation', 'institution'],
					permission: 'admin:saml_providers:read'
				}
			},
			{
				id: 'directory',
				label: 'nav.auth.directory'
			},
			{
				id: 'protection',
				label: 'nav.auth.protection',
				platform: 'tenant',
				requires: { settings: ['rate-limit'] }
			}
		]
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
				details: true
			},
			{
				id: 'login-ui',
				label: 'nav.custom.loginUi'
			},
			{
				id: 'screens',
				label: 'nav.custom.screens',
				// The screen builder: …/screens/new and …/screens/<screen id>.
				details: true
			},
			{
				id: 'account-page',
				label: 'nav.custom.accountPage',
				// The account page editor: …/account-page/<page id>.
				details: true
			},
			{
				id: 'launchers',
				label: 'nav.custom.launchers',
				// The launcher editor: …/launchers/new and …/launchers/<launcher id>.
				details: true
			},
			{
				id: 'statements',
				label: 'nav.custom.statements',
				// The statement page: …/statements/new and …/statements/<statement id>.
				details: true
			},
			{
				id: 'emails',
				label: 'nav.custom.emails'
			}
		]
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
				requires: { permission: 'admin:audit:read' }
			},
			{
				id: 'admin-activity',
				label: 'nav.mon.adminActivity',
				requires: { permission: 'admin:admin_audit:read' }
			},
			{
				id: 'admin-logging',
				label: 'nav.mon.adminLogging'
			},
			{
				id: 'system',
				label: 'nav.mon.system'
			},
			{
				id: 'diagnostics',
				label: 'nav.mon.diagnostics'
			},
			{
				id: 'deliveries',
				label: 'nav.mon.deliveries'
			},
			{
				id: 'log-settings',
				label: 'nav.mon.settings'
			},
			{
				id: 'destinations',
				label: 'nav.mon.destinations'
			}
		]
	},
	{
		id: 'integrations',
		label: 'nav.integrations',
		icon: 'plug',
		scope: 'tenant',
		children: [
			{
				id: 'plugins',
				label: 'nav.int.plugins'
			},
			{
				id: 'notifications',
				label: 'nav.int.notifications'
			}
		]
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
				platform: 'tenant'
			},
			{
				id: 'tenant-config',
				label: 'nav.set.tenantConfig'
			},
			{
				id: 'signing-keys',
				label: 'nav.set.signingKeys',
				platform: 'tenant'
			},
			{
				id: 'runtime',
				label: 'nav.set.runtime'
			},
			{
				id: 'domains',
				label: 'nav.set.domains',
				platform: 'tenant'
			},
			{
				id: 'compliance',
				label: 'nav.set.compliance'
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
				details: true
			},
			{
				id: 'team-groups',
				label: 'nav.set.teamGroups',
				platform: 'tenant',
				requires: { permission: 'admin:admin_users:read' },
				// …/team-groups/<id>: a group's page.
				details: true
			},
			{
				id: 'team-roles',
				label: 'nav.set.teamRoles',
				platform: 'tenant',
				requires: { permission: 'admin:admin_roles:read' },
				// …/team-roles/<id> and …/team-roles/new: a role's page.
				details: true
			},
			{
				id: 'team-ip-allowlist',
				label: 'nav.set.teamIpAllowlist',
				platform: 'tenant',
				// Which addresses the tenant's administrators may sign in from (not end users).
				requires: { permission: 'admin:ip_allowlist:read' }
			}
		]
	}
];

export const PLATFORM_AREAS: readonly NavArea[] = [
	{
		id: 'plat-overview',
		label: 'nav.platArea.overview',
		icon: 'gauge',
		scope: 'platform',
		children: []
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
				details: true
			},
			{
				id: 'discovery',
				label: 'nav.auth.discovery'
			},
			{
				id: 'domains',
				label: 'nav.pt.domains'
			},
			{
				id: 'invitations',
				label: 'nav.pt.invitations'
			}
		]
	},
	{
		id: 'plat-admins',
		label: 'nav.platArea.admins',
		icon: 'users',
		scope: 'platform',
		children: [
			{
				id: 'users',
				label: 'nav.pa.users'
			},
			{
				id: 'roles',
				label: 'nav.pa.roles'
			},
			{
				id: 'sign-in',
				label: 'nav.pa.signIn'
			},
			{
				id: 'attributes',
				label: 'nav.pa.attributes'
			},
			{
				id: 'relationships',
				label: 'nav.pa.relationships'
			},
			{
				id: 'policies',
				label: 'nav.pa.policies'
			},
			{
				id: 'machine',
				label: 'nav.pa.machine',
				details: true
			},
			{
				id: 'agents',
				label: 'nav.pa.agents'
			}
		]
	},
	{
		id: 'plat-infra',
		label: 'nav.platArea.infra',
		icon: 'stack',
		scope: 'platform',
		children: [
			{
				id: 'releases',
				label: 'nav.pi.releases'
			},
			{
				id: 'database-connections',
				label: 'nav.data.sources'
			},
			{
				id: 'scale',
				label: 'nav.pi.scale'
			},
			{
				id: 'storage',
				label: 'nav.pi.storage'
			},
			{
				id: 'backup',
				label: 'nav.pi.backup'
			},
			{
				id: 'jobs',
				label: 'nav.pi.jobs'
			}
		]
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
				badge: '3'
			},
			{
				id: 'elevations',
				label: 'nav.pv.elevations'
			}
		]
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
