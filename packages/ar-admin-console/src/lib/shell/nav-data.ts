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
				icon: 'users',
				platform: 'lookup',
				legacyRoutes: ['/admin/users', '/admin/users/[id]', '/admin/users/new']
			},
			{
				id: 'agents',
				label: 'nav.users.agents',
				icon: 'robot',
				platform: 'lookup',
				legacyRoutes: ['(new) エージェントアカウント']
			},
			{
				id: 'organizations',
				label: 'nav.users.orgs',
				icon: 'building',
				platform: 'tenant',
				retire: 'retire.org',
				legacyRoutes: ['/admin/organizations']
			},
			{
				id: 'service-groups',
				label: 'nav.users.serviceGroups',
				icon: 'stack',
				platform: 'tenant',
				legacyRoutes: ['/admin/service-groups']
			},
			{
				id: 'lifecycle',
				label: 'nav.users.lifecycle',
				icon: 'clock',
				platform: 'tenant',
				legacyRoutes: ['/admin/account-lifecycle']
			},
			{
				id: 'sessions',
				label: 'nav.users.sessions',
				icon: 'clock',
				platform: 'lookup',
				legacyRoutes: ['/admin/sessions']
			},
			{
				id: 'invitations',
				label: 'nav.users.invitations',
				icon: 'mail',
				platform: 'tenant',
				legacyRoutes: ['/admin/tenants/[id]/invitations', '(new) エンドユーザー招待']
			},
			{
				id: 'support',
				label: 'nav.users.support',
				icon: 'sparkle',
				platform: 'lookup',
				legacyRoutes: ['/admin/support-ops']
			},
			{
				id: 'resolution',
				label: 'nav.users.resolution',
				icon: 'check',
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
				icon: 'stack',
				legacyRoutes: ['(new) API / リソース定義']
			},
			{
				id: 'roles',
				label: 'nav.access.roles',
				icon: 'shield',
				legacyRoutes: ['/admin/roles', '/admin/roles/[id]']
			},
			{
				id: 'role-rules',
				label: 'nav.access.roleRules',
				icon: 'check',
				legacyRoutes: ['/admin/role-rules', '/admin/roles (割り当てルール タブ)']
			},
			{
				id: 'attributes',
				label: 'nav.access.attributes',
				icon: 'list',
				legacyRoutes: ['/admin/attributes']
			},
			{
				id: 'relationships',
				label: 'nav.access.relationships',
				icon: 'link',
				legacyRoutes: ['/admin/rebac', '/admin/rebac/definitions', '/admin/rebac/tuples']
			},
			{
				id: 'policies',
				label: 'nav.access.policies',
				icon: 'file',
				legacyRoutes: ['/admin/policies']
			},
			{
				id: 'schema',
				label: 'nav.data.schema',
				icon: 'list',
				platform: 'template',
				legacyRoutes: ['/admin/custom-claims', '/admin/custom-claims/[id]']
			},
			{
				id: 'profiles',
				label: 'nav.data.profiles',
				icon: 'stack',
				platform: 'template',
				legacyRoutes: ['/admin/field-mapping/profiles', '/admin/field-mapping/profiles/edit']
			},
			{
				id: 'mapping-sets',
				label: 'nav.data.mappingSets',
				icon: 'file',
				platform: 'template',
				legacyRoutes: ['/admin/field-mapping/field-mapping-sets', '/admin/field-mapping/edit']
			},
			{
				id: 'identifiers',
				label: 'nav.data.identifiers',
				icon: 'fingerprint',
				platform: 'template',
				legacyRoutes: ['/admin/field-mapping/persistent-identifiers']
			},
			{
				id: 'simulator',
				label: 'nav.access.simulator',
				icon: 'map',
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
				icon: 'app',
				platform: 'template',
				wide: true,
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
				icon: 'fingerprint',
				legacyRoutes: ['/admin/authentication-methods', '/admin/authentication-methods/[profileId]']
			},
			{
				id: 'staying-signed-in',
				label: 'nav.auth.stayingSignedIn',
				icon: 'clock',
				platform: 'tenant',
				requires: { settings: ['session', 'oauth'] },
				legacyRoutes: []
			},
			{
				id: 'social',
				label: 'nav.auth.social',
				icon: 'globe',
				legacyRoutes: ['/admin/external-idp', '/admin/external-idp/[id]']
			},
			{
				id: 'token-refresh',
				label: 'nav.auth.tokenRefresh',
				icon: 'activity',
				legacyRoutes: ['/admin/external-token-refresh']
			},
			{
				id: 'enterprise',
				label: 'nav.auth.enterprise',
				icon: 'building',
				legacyRoutes: ['/admin/saml', '/admin/saml/[id]', '/admin/saml/local']
			},
			{
				id: 'directory',
				label: 'nav.auth.directory',
				icon: 'stack',
				legacyRoutes: [
					'/admin/directory-authentication',
					'/admin/directory-authentication/fleet',
					'/admin/directory-authentication/migration'
				]
			},
			{
				id: 'federation-trust',
				label: 'nav.data.federationTrust',
				icon: 'building',
				platform: 'template',
				legacyRoutes: ['/admin/field-mapping/federation-trust']
			},
			{
				id: 'protection',
				label: 'nav.auth.protection',
				icon: 'lock',
				legacyRoutes: ['/admin/security']
			},
			{
				id: 'ip-allowlist',
				label: 'nav.auth.ipAllowlist',
				icon: 'shield',
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
				icon: 'brush',
				legacyRoutes: ['/admin/themes']
			},
			{
				id: 'login-ui',
				label: 'nav.custom.loginUi',
				icon: 'device',
				legacyRoutes: ['/admin/login-ui']
			},
			{
				id: 'screens',
				label: 'nav.custom.screens',
				icon: 'list',
				legacyRoutes: ['/admin/screens']
			},
			{
				id: 'account-page',
				label: 'nav.custom.accountPage',
				icon: 'app',
				legacyRoutes: ['/admin/account-page']
			},
			{
				id: 'launchers',
				label: 'nav.custom.launchers',
				icon: 'sparkle',
				legacyRoutes: ['/admin/launchers']
			},
			{
				id: 'consent',
				label: 'nav.custom.consent',
				icon: 'check',
				legacyRoutes: ['/admin/consent-policies', '/admin/consent-policies/[id]']
			},
			{
				id: 'statements',
				label: 'nav.custom.statements',
				icon: 'file',
				legacyRoutes: ['/admin/consent-statements', '/admin/consent-statements/[id]']
			},
			{
				id: 'emails',
				label: 'nav.custom.emails',
				icon: 'mail',
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
				icon: 'file',
				legacyRoutes: ['/admin/audit-logs', '/admin/audit-logs/[id]']
			},
			{
				id: 'admin-activity',
				label: 'nav.mon.adminActivity',
				icon: 'shield',
				legacyRoutes: ['/admin/admin-audit']
			},
			{
				id: 'admin-logging',
				label: 'nav.mon.adminLogging',
				icon: 'lock',
				legacyRoutes: ['/admin/admin-logging']
			},
			{
				id: 'system',
				label: 'nav.mon.system',
				icon: 'activity',
				legacyRoutes: ['/admin/operational-logs']
			},
			{
				id: 'diagnostics',
				label: 'nav.mon.diagnostics',
				icon: 'warning',
				legacyRoutes: ['/admin/diagnostic-logging', '/admin/diagnostic-logging/export']
			},
			{
				id: 'deliveries',
				label: 'nav.mon.deliveries',
				icon: 'mail',
				legacyRoutes: ['/admin/email-deliveries']
			},
			{
				id: 'log-settings',
				label: 'nav.mon.settings',
				icon: 'gear',
				legacyRoutes: ['/admin/logging-policies']
			},
			{
				id: 'destinations',
				label: 'nav.mon.destinations',
				icon: 'database',
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
				icon: 'plug',
				legacyRoutes: ['/admin/plugins']
			},
			{
				id: 'notifications',
				label: 'nav.int.notifications',
				icon: 'bell',
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
				icon: 'info',
				platform: 'tenant',
				legacyRoutes: ['/admin/info']
			},
			{
				id: 'tenant-config',
				label: 'nav.set.tenantConfig',
				icon: 'gear',
				legacyRoutes: ['/admin/settings', '/admin/settings/[category]']
			},
			{
				id: 'signing-keys',
				label: 'nav.set.signingKeys',
				icon: 'key',
				platform: 'tenant',
				legacyRoutes: ['/admin/settings/signing-keys']
			},
			{
				id: 'runtime',
				label: 'nav.set.runtime',
				icon: 'activity',
				legacyRoutes: [
					'/admin/settings/runtime-profiles',
					'/admin/settings/cache-mode',
					'/admin/settings/sharding'
				]
			},
			{
				id: 'domains',
				label: 'nav.set.domains',
				icon: 'globe',
				platform: 'tenant',
				legacyRoutes: ['/admin/tenant-vanity-domains', '/admin/platform/tenant-domain-mappings']
			},
			{
				id: 'compliance',
				label: 'nav.set.compliance',
				icon: 'check',
				legacyRoutes: ['/admin/compliance', '/admin/directory-authentication/compliance']
			},
			{
				id: 'team',
				label: 'nav.set.team',
				icon: 'users',
				platform: 'tenant',
				legacyRoutes: ['/admin/admins (このテナントの管理者のみ)']
			},
			{
				id: 'team-roles',
				label: 'nav.set.teamRoles',
				icon: 'shield',
				platform: 'tenant',
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
				icon: 'building',
				wide: true,
				legacyRoutes: ['/admin/tenants', '/admin/tenants/[id]']
			},
			{
				id: 'provisioning',
				label: 'nav.pt.provisioning',
				icon: 'plus',
				legacyRoutes: ['/admin/tenants/new', '/admin/tenants/clone']
			},
			{
				id: 'discovery',
				label: 'nav.auth.discovery',
				icon: 'map',
				legacyRoutes: ['/admin/tenant-discovery']
			},
			{
				id: 'domains',
				label: 'nav.pt.domains',
				icon: 'globe',
				legacyRoutes: ['/admin/tenant-vanity-domains', '/admin/platform/tenant-domain-mappings']
			},
			{
				id: 'invitations',
				label: 'nav.pt.invitations',
				icon: 'mail',
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
				icon: 'users',
				wide: true,
				legacyRoutes: ['/admin/admins (全テナント)', '/admin/admins/[id]']
			},
			{
				id: 'roles',
				label: 'nav.pa.roles',
				icon: 'shield',
				legacyRoutes: ['/admin/admin-rbac', '/admin/admin-rbac/[id]', '/admin/admin-roles']
			},
			{
				id: 'attributes',
				label: 'nav.pa.attributes',
				icon: 'list',
				legacyRoutes: ['/admin/admin-abac']
			},
			{
				id: 'relationships',
				label: 'nav.pa.relationships',
				icon: 'link',
				legacyRoutes: [
					'/admin/admin-rebac',
					'/admin/admin-rebac/definitions',
					'/admin/admin-rebac/tuples'
				]
			},
			{
				id: 'policies',
				label: 'nav.pa.policies',
				icon: 'file',
				legacyRoutes: ['/admin/admin-policies', '/admin/admin-access-control']
			},
			{
				id: 'machine',
				label: 'nav.pa.machine',
				icon: 'robot',
				legacyRoutes: ['/admin/machine-access']
			},
			{
				id: 'agents',
				label: 'nav.pa.agents',
				icon: 'robot',
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
				icon: 'stack',
				legacyRoutes: ['/admin/control-plane']
			},
			{
				id: 'database-connections',
				label: 'nav.data.sources',
				icon: 'database',
				legacyRoutes: ['/admin/database-connections', '/admin/database-connections/[id]']
			},
			{
				id: 'scale',
				label: 'nav.pi.scale',
				icon: 'activity',
				legacyRoutes: ['/admin/scale']
			},
			{
				id: 'storage',
				label: 'nav.pi.storage',
				icon: 'database',
				legacyRoutes: ['/admin/storage-topology']
			},
			{
				id: 'backup',
				label: 'nav.pi.backup',
				icon: 'file',
				legacyRoutes: ['/admin/dr-backup']
			},
			{
				id: 'jobs',
				label: 'nav.pi.jobs',
				icon: 'list',
				wide: true,
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
				icon: 'check',
				wide: true,
				badge: '3',
				legacyRoutes: ['/admin/approvals']
			},
			{
				id: 'elevations',
				label: 'nav.pv.elevations',
				icon: 'lock',
				wide: true,
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
		id: 'users'
	},
	{
		id: 'access'
	},
	{
		id: 'authentication'
	},
	{
		id: 'applications'
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
 * Header categories in platform scope. `inherited` categories hold the defaults every tenant
 * starts from; the rest exist only at platform level.
 */
export const PLATFORM_TOPNAV: readonly TopEntry[] = [
	{
		id: 'plat-overview'
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
		id: 'applications',
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
	}
];
