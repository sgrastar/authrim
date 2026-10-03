/**
 * Where every Admin API beyond the Settings API will be used: its dedicated settings APIs, the
 * records admins create and look up, the actions they run and the logs they read. Operations
 * (api-operations.ts, generated from the specs) are grouped by path prefix, and each group is
 * placed on a page of the navigation, like the settings in inventory.ts. `placement.test.ts`
 * checks that every operation falls in exactly one group.
 *
 * Reviewed in Storybook (Pages › Settings map), beside the settings of each page. Group names
 * are working English names.
 *
 * A path belongs to the group with the longest matching prefix (a prefix matches the path
 * itself and the paths below it).
 */
import { API_OPERATIONS, type ApiOperation } from './api-operations';
import type { DraftPage } from './inventory';

export type ApiKind =
	/** A dedicated settings API: one configuration document, read and saved as a whole. */
	| 'settings'
	/** Records admins create, list and edit (users, apps, roles, …). */
	| 'records'
	/** Actions and long-running operations (jobs, rotations, backups, clean-ups). */
	| 'actions'
	/** Logs, statistics and status to read. */
	| 'monitoring'
	/** The Settings API itself (the settings of every page), and its history. */
	| 'settings-api'
	/** The signed-in admin's own account and session. */
	| 'account'
	/** Used by agents or by people outside the console (approval portals, health). */
	| 'outside';

export interface ApiGroup {
	id: string;
	name: string;
	kind: ApiKind;
	/** A page of the navigation or of the draft (inventory.ts), or one of API_PAGES. */
	page: string;
	/** Path prefixes; see the file comment. */
	paths: readonly string[];
	/** Settings API keys that hold the same values (the older dedicated API of those settings). */
	overlaps?: string;
	note?: string;
}

/** One API group on a page of the settings map, with its operations. */
export interface ApiRow {
	/** Number across the whole map (A1…), for pointing at a group in a review. */
	no: number;
	group: ApiGroup;
	operations: readonly ApiOperation[];
}

/** Pages only the API inventory uses. */
export const API_PAGES: readonly DraftPage[] = [
	{ id: 'overview', title: 'Overview (dashboard)', scope: 'tenant' },
	{ id: 'plat-overview', title: 'Platform overview (dashboard)', scope: 'platform' },
	{
		id: 'account',
		title: 'My account (header menu)',
		proposed: true,
		scope: 'tenant',
		note: 'The signed-in admin: passkeys, session, agent consents.'
	},
	{
		id: 'settings-api',
		title: 'Settings API (every settings page)',
		scope: 'tenant',
		note: 'What the settings pages read and save, with history and roll-back.'
	},
	{
		id: 'outside',
		title: 'Not a console page',
		scope: 'platform',
		note: 'Called by agents, by approvers through links, or by monitoring.'
	}
];

const A = '/api/admin';

export const API_GROUPS: readonly ApiGroup[] = [
	// -------------------------------------------------------------------------------------------
	// Overview
	{
		id: 'stats',
		name: 'Dashboard statistics',
		kind: 'monitoring',
		page: 'overview',
		paths: [`${A}/stats`, `${A}/access-control/stats`]
	},

	// -------------------------------------------------------------------------------------------
	// Users
	{
		id: 'users',
		name: 'Users',
		kind: 'records',
		page: 'users/all',
		paths: [`${A}/users`, `${A}/device-secrets`],
		note: 'One user’s tabs: roles, relationships, consents, sessions, devices, legal holds, PII, avatar.'
	},
	{
		id: 'user-jobs',
		name: 'User import and bulk update',
		kind: 'actions',
		page: 'users/all',
		paths: [`${A}/jobs/users`]
	},
	{
		id: 'organizations',
		name: 'Organizations',
		kind: 'records',
		page: 'users/organizations',
		paths: [`${A}/organizations`, `${A}/org-domain-mappings`, `${A}/jobs/organizations`]
	},
	{
		id: 'service-groups',
		name: 'Service groups',
		kind: 'records',
		page: 'users/service-groups',
		paths: [`${A}/service-groups`]
	},
	{
		id: 'guests',
		name: 'Guest accounts and retention',
		kind: 'records',
		page: 'users/lifecycle',
		paths: [`${A}/guest-users`, `${A}/account-lifecycle`]
	},
	{
		id: 'end-user-sessions',
		name: 'Sessions',
		kind: 'records',
		page: 'users/sessions',
		paths: [`${A}/sessions`],
		note: 'End users’ sessions of the tenant (the spec’s summaries say “admin sessions”: the admin view of them).'
	},
	{
		id: 'tenant-invitations',
		name: 'Tenant invitations',
		kind: 'records',
		page: 'users/invitations',
		paths: [`${A}/tenants/{id}/invitations`],
		note: 'Also under Platform › Tenants › Invitations.'
	},
	{
		id: 'support-ops',
		name: 'Support operations',
		kind: 'actions',
		page: 'users/support',
		paths: [`${A}/support-ops`]
	},
	{
		id: 'review-tasks',
		name: 'Review tasks (resolution center)',
		kind: 'records',
		page: 'users/resolution',
		paths: [`${A}/field-mapping/review-tasks`, `${A}/field-mapping/review-task-groups`]
	},

	// -------------------------------------------------------------------------------------------
	// Access control
	{
		id: 'check-api-keys',
		name: 'Check API keys',
		kind: 'records',
		page: 'access/apis',
		paths: [`${A}/check-api-keys`]
	},
	{ id: 'roles', name: 'Roles', kind: 'records', page: 'access/roles', paths: [`${A}/roles`] },
	{
		id: 'role-rules',
		name: 'Role assignment rules',
		kind: 'records',
		page: 'access/role-rules',
		paths: [`${A}/role-assignment-rules`]
	},
	{
		id: 'user-attributes',
		name: 'User attributes (verified)',
		kind: 'records',
		page: 'access/attributes',
		paths: [`${A}/attributes`]
	},
	{
		id: 'rebac',
		name: 'Relationships (definitions and tuples)',
		kind: 'records',
		page: 'access/relationships',
		paths: [`${A}/rebac`]
	},
	{
		id: 'policy-rules',
		name: 'Policy rules',
		kind: 'records',
		page: 'access/policies',
		paths: [`${A}/policies`],
		note: 'The tenant’s custom rules the Check API evaluates with feature.enable_abac and feature.enable_custom_rules.'
	},
	{
		id: 'resource-permissions',
		name: 'ID-level permissions',
		kind: 'records',
		page: 'access/policies',
		paths: [`${A}/resource-permissions`]
	},
	{
		id: 'custom-claims',
		name: 'Custom claims',
		kind: 'records',
		page: 'access/schema',
		paths: [`${A}/custom-claims`]
	},
	{
		id: 'token-claim-rules',
		name: 'Token claim rules',
		kind: 'records',
		page: 'access/schema',
		paths: [`${A}/token-claim-rules`]
	},
	{
		id: 'oidc-scopes',
		name: 'OIDC scopes',
		kind: 'records',
		page: 'access/schema',
		paths: [`${A}/field-mapping/oidc-scopes`]
	},
	{
		id: 'attribute-dictionary',
		name: 'Attribute fields and groups',
		kind: 'records',
		page: 'access/schema',
		paths: [`${A}/field-mapping/attribute-fields`, `${A}/field-mapping/attribute-groups`]
	},
	{
		id: 'mapping-profiles',
		name: 'Source and destination profiles, schemas',
		kind: 'records',
		page: 'access/profiles',
		paths: [
			`${A}/field-mapping/source-profiles`,
			`${A}/field-mapping/destination-profiles`,
			`${A}/field-mapping/catalogs`,
			`${A}/field-mapping/external-schemas`,
			`${A}/field-mapping/protocol-schemas`,
			`${A}/field-mapping/schema-readiness`
		]
	},
	{
		id: 'mapping-sets',
		name: 'Field mapping sets, templates and previews',
		kind: 'records',
		page: 'access/mapping-sets',
		paths: [
			`${A}/field-mapping/field-mapping-sets`,
			`${A}/field-mapping/templates`,
			`${A}/field-mapping/preview`
		]
	},
	{
		id: 'identity-mapping',
		name: 'Identity groups, entitlements, provisioning and source authority',
		kind: 'records',
		page: 'access/mapping-sets',
		paths: [
			`${A}/field-mapping/groups`,
			`${A}/field-mapping/entitlements`,
			`${A}/field-mapping/provisioning-assignment-rules`,
			`${A}/field-mapping/source-authority-contracts`,
			`${A}/field-mapping/lifecycle-signals`
		],
		note: 'No legacy page; placement to decide.'
	},
	{
		id: 'persistent-identifiers',
		name: 'Persistent identifiers and their keys',
		kind: 'records',
		page: 'access/identifiers',
		paths: [
			`${A}/field-mapping/persistent-identifier-profiles`,
			`${A}/field-mapping/key-registries`
		]
	},
	{
		id: 'access-trace',
		name: 'Access trace',
		kind: 'monitoring',
		page: 'access/simulator',
		paths: [`${A}/access-trace`]
	},

	// -------------------------------------------------------------------------------------------
	// Applications
	{
		id: 'clients',
		name: 'Apps (OAuth/OIDC clients)',
		kind: 'records',
		page: 'applications/all',
		paths: [`${A}/clients`, `${A}/effective-policy`],
		note: 'One app’s tabs: profile, consent overrides, cache mode, usage, secret; its settings are the Settings API.'
	},
	{
		id: 'client-presets',
		name: 'App profile presets and trust policies',
		kind: 'records',
		page: 'applications/all',
		paths: [`${A}/client-profile-presets`, `${A}/client-trust-policies`]
	},
	{
		id: 'flows',
		name: 'Service flows',
		kind: 'records',
		page: 'applications/all',
		paths: [`${A}/flows`, `${A}/flow-assignments`]
	},
	{
		id: 'webhooks',
		name: 'Webhooks',
		kind: 'records',
		page: 'applications/all',
		paths: [`${A}/webhooks`]
	},
	{
		id: 'registration-tokens',
		name: 'Registration and SCIM tokens',
		kind: 'records',
		page: 'applications/all',
		paths: [`${A}/iat-tokens`, `${A}/scim-tokens`]
	},
	{
		id: 'scim-settings',
		name: 'Inbound SCIM settings',
		kind: 'settings',
		page: 'applications/all',
		paths: [`${A}/scim-settings`]
	},
	{
		id: 'verifiable-credentials',
		name: 'Credential profiles and issued credentials',
		kind: 'records',
		page: 'applications/all',
		paths: [`${A}/credential-profiles`, `${A}/vc`],
		note: 'Issuing and verifying flows are service flow connections.'
	},
	{
		id: 'tenant-policy',
		name: 'Tenant policy profile',
		kind: 'settings',
		page: 'applications/defaults',
		paths: [`${A}/tenant-policy`],
		note: 'Token lifetime caps and PKCE/PAR requirements; overlaps the security.* and oauth.* defaults to be built.'
	},
	{
		id: 'certification-profiles',
		name: 'Certification profiles',
		kind: 'actions',
		page: 'applications/defaults',
		paths: [`${A}/certification-profiles`]
	},
	{
		id: 'native-sso',
		name: 'Native SSO',
		kind: 'settings',
		page: 'applications/defaults',
		paths: [`${A}/settings/native-sso`]
	},
	{
		id: 'logout-failures',
		name: 'Failed logout notifications',
		kind: 'monitoring',
		page: 'authentication/staying-signed-in',
		paths: [`${A}/logout-failures`]
	},

	// -------------------------------------------------------------------------------------------
	// Authentication
	{
		id: 'external-providers',
		name: 'Social and OIDC providers',
		kind: 'records',
		page: 'authentication/social',
		paths: [`${A}/external-providers`]
	},
	{
		id: 'external-token-refresh',
		name: 'External token refresh',
		kind: 'settings',
		page: 'authentication/token-refresh',
		paths: [`${A}/external-token-refresh`]
	},
	{
		id: 'saml-providers',
		name: 'SAML providers and metadata',
		kind: 'records',
		page: 'authentication/enterprise',
		paths: [
			`${A}/saml-providers`,
			`${A}/saml-metadata`,
			`${A}/saml-federation-sources`,
			`${A}/saml-attribute-presets`
		]
	},
	{
		id: 'saml-settings',
		name: 'SAML settings and local signing',
		kind: 'settings',
		page: 'authentication/enterprise',
		paths: [`${A}/saml-settings`]
	},
	{
		id: 'directory-auth',
		name: 'Directory authentication',
		kind: 'settings',
		page: 'authentication/directory',
		paths: [
			`${A}/tenants/{tenantId}/directory-auth`,
			`${A}/tenants/{tenantId}/directory-connectors`
		],
		note: 'Policy, connectors and their fleet, migration campaigns, pending users, support bundles.'
	},
	{
		id: 'federation-trust',
		name: 'Federation trust sources',
		kind: 'records',
		page: 'authentication/federation-trust',
		paths: [
			`${A}/field-mapping/federation-trust-sources`,
			`${A}/field-mapping/federation-metadata-documents`
		]
	},
	{
		id: 'security-alerts',
		name: 'Security alerts and threats',
		kind: 'monitoring',
		page: 'authentication/protection',
		paths: [`${A}/security`]
	},
	{
		id: 'rate-limit-override',
		name: 'Rate limit profile override (load tests)',
		kind: 'actions',
		page: 'authentication/protection',
		paths: [`${A}/rate-limits/profile-override`]
	},
	{
		id: 'admin-ip-allowlist',
		name: 'Admin IP allowlist',
		kind: 'records',
		page: 'authentication/ip-allowlist',
		paths: [`${A}/ip-allowlist`],
		note: 'Restricts admin access, not end users’ sign-in.'
	},

	// -------------------------------------------------------------------------------------------
	// Customization
	{
		id: 'login-ui-assets',
		name: 'Login UI images',
		kind: 'actions',
		page: 'customization/login-ui',
		paths: [`${A}/assets`]
	},
	{
		id: 'screens',
		name: 'Screens',
		kind: 'records',
		page: 'customization/screens',
		paths: [`${A}/screens`]
	},
	{
		id: 'launchers',
		name: 'App launchers',
		kind: 'records',
		page: 'customization/launchers',
		paths: [`${A}/launchers`]
	},
	{
		id: 'consent-policies',
		name: 'Consent policies and requirements',
		kind: 'records',
		page: 'customization/consent',
		paths: [
			`${A}/consent-policies`,
			`${A}/consent-requirements`,
			`${A}/sign-in-confirmation-policies`
		]
	},
	{
		id: 'consent-statements',
		name: 'Consent statements',
		kind: 'records',
		page: 'customization/statements',
		paths: [`${A}/consent-statements`]
	},
	{
		id: 'email-settings',
		name: 'Email settings',
		kind: 'settings',
		page: 'customization/emails',
		paths: [`${A}/tenants/{tenantId}/email-settings`]
	},

	// -------------------------------------------------------------------------------------------
	// Monitoring
	{
		id: 'audit-logs',
		name: 'Audit log',
		kind: 'monitoring',
		page: 'monitoring/audit',
		paths: [`${A}/audit-logs`]
	},
	{
		id: 'admin-audit-log',
		name: 'Admin activity',
		kind: 'monitoring',
		page: 'monitoring/admin-activity',
		paths: [`${A}/admin-audit-log`]
	},
	{
		id: 'admin-logging',
		name: 'Admin logging (coverage, policies, key rewrap)',
		kind: 'settings',
		page: 'monitoring/admin-logging',
		paths: [`${A}/admin-logging`]
	},
	{
		id: 'operational-logs',
		name: 'System logs',
		kind: 'monitoring',
		page: 'monitoring/system',
		paths: [`${A}/operational-logs`]
	},
	{
		id: 'diagnostic-logging',
		name: 'Diagnostic log export and storage test',
		kind: 'actions',
		page: 'monitoring/diagnostics',
		paths: [`${A}/diagnostic-logging`]
	},
	{
		id: 'email-deliveries',
		name: 'Email deliveries',
		kind: 'monitoring',
		page: 'monitoring/deliveries',
		paths: [`${A}/email-deliveries`]
	},
	{
		id: 'logging-policies',
		name: 'Logging policies, delivery and DLQ',
		kind: 'settings',
		page: 'monitoring/log-settings',
		paths: [`${A}/logging-policies`]
	},
	{
		id: 'logging-settings',
		name: 'Log level and tenant overrides',
		kind: 'settings',
		page: 'monitoring/log-settings',
		paths: [`${A}/settings/logging`]
	},
	{
		id: 'audit-storage',
		name: 'Audit storage, retention and PII',
		kind: 'settings',
		page: 'monitoring/log-settings',
		paths: [`${A}/settings/audit-storage`, `${A}/settings/audit`, `${A}/tenants/{tenantId}/audit`]
	},
	{
		id: 'log-destinations',
		name: 'Log destinations',
		kind: 'records',
		page: 'monitoring/destinations',
		paths: [`${A}/destinations`]
	},
	{
		id: 'storage-destinations',
		name: 'Storage destinations',
		kind: 'records',
		page: 'monitoring/destinations',
		paths: [`${A}/storage-destinations`]
	},

	// -------------------------------------------------------------------------------------------
	// Integrations
	{
		id: 'plugins',
		name: 'Plugins',
		kind: 'records',
		page: 'integrations/plugins',
		paths: [`${A}/plugins`, `${A}/platform/plugins`],
		note: 'Platform plugins (…/platform/plugins) are the same page in platform scope.'
	},
	{
		id: 'notifications',
		name: 'Notification center and delivery routes',
		kind: 'records',
		page: 'integrations/notifications',
		paths: [
			`${A}/notifications`,
			`${A}/field-mapping/operational-notifications`,
			`${A}/field-mapping/operational-notification-states`
		]
	},

	// -------------------------------------------------------------------------------------------
	// Settings (tenant)
	{
		id: 'tenant-info',
		name: 'Tenant endpoints',
		kind: 'monitoring',
		page: 'settings/general',
		paths: [`${A}/tenants/{id}/info`]
	},
	{
		id: 'signing-keys',
		name: 'Signing key rotation',
		kind: 'actions',
		page: 'settings/signing-keys',
		paths: [`${A}/signing-keys`]
	},
	{
		id: 'runtime-profiles',
		name: 'Runtime profiles and cache mode',
		kind: 'settings',
		page: 'settings/runtime',
		paths: [
			`${A}/runtime-profiles`,
			`${A}/tenants/{id}/runtime-profiles`,
			`${A}/settings/cache-mode`,
			`${A}/settings/ip-security`
		]
	},
	{
		id: 'sharding',
		name: 'Sharding',
		kind: 'settings',
		page: 'settings/runtime',
		paths: [
			`${A}/settings/challenge-shards`,
			`${A}/settings/code-shards`,
			`${A}/settings/session-shards`,
			`${A}/settings/revocation-shards`,
			`${A}/settings/region-shards`,
			`${A}/settings/refresh-token-sharding`
		],
		note: 'Platform infrastructure; the legacy page sits under settings.'
	},
	{
		id: 'tenant-domains',
		name: 'Custom domains',
		kind: 'records',
		page: 'settings/domains',
		paths: [`${A}/tenant-vanity-domains`]
	},
	{
		id: 'compliance',
		name: 'Compliance reports and access reviews',
		kind: 'records',
		page: 'settings/compliance',
		paths: [`${A}/compliance`]
	},
	{
		id: 'data-retention',
		name: 'Data retention',
		kind: 'settings',
		page: 'settings/compliance',
		paths: [`${A}/data-retention`, `${A}/tombstones`]
	},
	{
		id: 'admin-invitations',
		name: 'Admin invitations',
		kind: 'records',
		page: 'settings/team',
		paths: [`${A}/admin-invitations`]
	},

	// -------------------------------------------------------------------------------------------
	// Settings API itself
	{
		id: 'settings-api-tenant',
		name: 'Tenant settings',
		kind: 'settings-api',
		page: 'settings-api',
		paths: [`${A}/tenants/{tenantId}/settings`]
	},
	{
		id: 'settings-api-client',
		name: 'App settings',
		kind: 'settings-api',
		page: 'settings-api',
		paths: [`${A}/clients/{clientId}/settings`]
	},
	{
		id: 'settings-api-platform',
		name: 'Platform settings',
		kind: 'settings-api',
		page: 'settings-api',
		paths: [`${A}/platform/settings`]
	},
	{
		id: 'settings-api-meta',
		name: 'Catalog, history, roll-back and import of the older stores',
		kind: 'settings-api',
		page: 'settings-api',
		paths: [
			`${A}/settings/meta`,
			`${A}/settings/{category}`,
			`${A}/platform/settings/legacy-import`
		]
	},

	// -------------------------------------------------------------------------------------------
	// Platform: tenants
	{
		id: 'tenants',
		name: 'Tenants and their lifecycle',
		kind: 'records',
		page: 'plat-tenants/list',
		paths: [`${A}/tenants`]
	},
	{
		id: 'tenant-provisioning',
		name: 'Provisioning, cloning and placement migration',
		kind: 'actions',
		page: 'plat-tenants/provisioning',
		paths: [
			`${A}/tenants/{id}/provisioning`,
			`${A}/tenants/{id}/clone`,
			`${A}/tenants/{id}/placement-migrations`,
			`${A}/platform/control-plane/provisioning-authority`,
			`${A}/platform/control-plane/operations`
		]
	},
	{
		id: 'platform-domains',
		name: 'Tenant domains and mappings',
		kind: 'records',
		page: 'plat-tenants/domains',
		paths: [`${A}/platform/tenant-domain-mappings`, `${A}/platform/tenant-vanity-domains`]
	},
	{
		id: 'platform-tombstones',
		name: 'Tenant tombstones',
		kind: 'actions',
		page: 'plat-tenants/list',
		paths: [`${A}/platform/tombstones`]
	},

	// -------------------------------------------------------------------------------------------
	// Platform: admins
	{
		id: 'admins',
		name: 'Admins',
		kind: 'records',
		page: 'plat-admins/users',
		paths: [`${A}/admins`],
		note: 'Settings › Team shows the admins of one tenant.'
	},
	{
		id: 'admin-roles',
		name: 'Admin roles and assignments',
		kind: 'records',
		page: 'plat-admins/roles',
		paths: [`${A}/admin-roles`]
	},
	{
		id: 'admin-attributes',
		name: 'Admin attributes',
		kind: 'records',
		page: 'plat-admins/attributes',
		paths: [`${A}/admin-attributes`]
	},
	{
		id: 'admin-rebac',
		name: 'Admin relationships',
		kind: 'records',
		page: 'plat-admins/relationships',
		paths: [`${A}/admin-rebac-definitions`, `${A}/admin-relationships`]
	},
	{
		id: 'admin-policies',
		name: 'Admin policies',
		kind: 'records',
		page: 'plat-admins/policies',
		paths: [`${A}/admin-policies`, `${A}/admin-access-control`]
	},
	{
		id: 'machine-access',
		name: 'Machine access',
		kind: 'records',
		page: 'plat-admins/machine',
		paths: [`${A}/machine-access`]
	},
	{
		id: 'agent-access',
		name: 'Agent access: grants, plans, baselines, policies, task sets',
		kind: 'records',
		page: 'plat-admins/agents',
		paths: [
			`${A}/agent-grants`,
			`${A}/agent-config-plans`,
			`${A}/agent-bulk-plans`,
			`${A}/agent-baselines`,
			`${A}/agent-scope-policies`,
			`${A}/agent-task-sets`,
			`${A}/agent-templates`,
			`${A}/agent-secret-refs`,
			`${A}/settings/agent`
		]
	},

	// -------------------------------------------------------------------------------------------
	// Platform: infrastructure
	{
		id: 'releases',
		name: 'Release rollout and drift',
		kind: 'actions',
		page: 'plat-infra/releases',
		paths: [
			`${A}/platform/control-plane/release-rollout`,
			`${A}/platform/control-plane/drift-findings`
		]
	},
	{
		id: 'database-connections',
		name: 'Database connections',
		kind: 'records',
		page: 'plat-infra/database-connections',
		paths: [`${A}/database-connections`]
	},
	{
		id: 'scale',
		name: 'Capacity and read replication',
		kind: 'actions',
		page: 'plat-infra/scale',
		paths: [`${A}/platform/control-plane/capacity`, `${A}/platform/read-replication`]
	},
	{
		id: 'storage',
		name: 'Storage topology, shards, PII partitions and keys',
		kind: 'actions',
		page: 'plat-infra/storage',
		paths: [
			`${A}/platform/control-plane/storage-topology`,
			`${A}/platform/control-plane/shard-cleanup`,
			`${A}/platform/control-plane/lookup-hmac`,
			`${A}/settings/pii-partitions`,
			`${A}/platform/settings/pii-partitions`,
			`${A}/settings/domain-hash-keys`,
			`${A}/settings/encryption`
		]
	},
	{
		id: 'backup',
		name: 'Tenant backup, restore and recovery',
		kind: 'actions',
		page: 'plat-infra/backup',
		paths: [
			`${A}/tenant-backups`,
			`${A}/platform/control-plane/tenant-recovery`,
			`${A}/tenants/{id}/runtime-registry`
		]
	},
	{ id: 'jobs', name: 'Jobs', kind: 'actions', page: 'plat-infra/jobs', paths: [`${A}/jobs`] },

	// -------------------------------------------------------------------------------------------
	// Platform: approvals
	{
		id: 'approvals',
		name: 'Approval requests',
		kind: 'records',
		page: 'plat-approvals/queue',
		paths: [`${A}/approvals`]
	},
	{
		id: 'agent-elevations',
		name: 'Agent elevations',
		kind: 'actions',
		page: 'plat-approvals/elevations',
		paths: [`${A}/agent-elevations`]
	},

	// -------------------------------------------------------------------------------------------
	// The signed-in admin
	{
		id: 'me',
		name: 'Passkeys, session and agent consents',
		kind: 'account',
		page: 'account',
		paths: [`${A}/me`, `${A}/logout`, '/auth/step-up']
	},

	// -------------------------------------------------------------------------------------------
	// Outside the console
	{
		id: 'agent-surface',
		name: 'Agent read and write tools',
		kind: 'outside',
		page: 'outside',
		paths: [`${A}/agent-read`, `${A}/agent-write`, `${A}/agent-login-handoffs`],
		note: 'Called by agents through their grants.'
	},
	{
		id: 'approval-portals',
		name: 'Approval artifact and receipt portals',
		kind: 'outside',
		page: 'outside',
		paths: ['/api/approval-artifacts', '/api/approval-receipts'],
		note: 'Opened by approvers through links.'
	},
	{
		id: 'service',
		name: 'Health, avatars and API root',
		kind: 'outside',
		page: 'outside',
		paths: ['/health', '/api/health', '/api/avatars', '/api/v1']
	}
];

/** Whether a prefix covers a path: the path itself or a path below it. */
function covers(prefix: string, path: string): boolean {
	return path === prefix || path.startsWith(`${prefix}/`);
}

/** The group of a path: the one with the longest matching prefix (undefined: none). */
export function groupOf(path: string): ApiGroup | undefined {
	let best: { group: ApiGroup; length: number } | undefined;
	for (const group of API_GROUPS) {
		for (const prefix of group.paths) {
			if (covers(prefix, path) && (!best || prefix.length > best.length)) {
				best = { group, length: prefix.length };
			}
		}
	}
	return best?.group;
}

/** Each group's operations, in spec order. */
export const OPERATIONS_OF: ReadonlyMap<string, readonly ApiOperation[]> = new Map(
	API_GROUPS.map((group) => [group.id, API_OPERATIONS.filter((op) => groupOf(op.path) === group)])
);
