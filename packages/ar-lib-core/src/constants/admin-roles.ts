/**
 * Admin roles
 *
 * The one place that names the standard roles of the Admin side (Admin console and Admin API) and
 * says what each holds. Everything that decides on a role name (route gates, the access table,
 * sign-in, settings view and edit roles, the seed in `migrations/admin`) reads it from here, so a
 * role name is never typed as a string anywhere else.
 *
 * These are the roles of the people who run Authrim. The roles of the service's own users live in
 * another database (DB_CORE `roles`) and are another world; the `ar_` prefix keeps the two apart.
 */

/** The standard Admin roles. */
export const ADMIN_ROLES = {
  /** Every tenant and the platform itself. The only role that skips role checks. */
  SUPER_ADMIN: 'ar_super_admin',
  /** One tenant: its settings, apps, users and the admins and roles of that tenant. */
  TENANT_ADMIN: 'ar_tenant_admin',
  /** Answers users' questions: looks things up, unlocks, ends sessions, asks for sensitive operations. */
  SUPPORT: 'ar_support',
  /** Reads. No secrets. */
  VIEWER: 'ar_viewer',
} as const;

export type AdminRoleName = (typeof ADMIN_ROLES)[keyof typeof ADMIN_ROLES];

/**
 * A name that starts with this is reserved for the standard roles: a custom role cannot be created
 * or renamed to it, so a tenant cannot make a role that looks like one of them.
 */
export const RESERVED_ROLE_PREFIX = 'ar_';

export function isReservedAdminRoleName(name: string): boolean {
  return name.toLowerCase().startsWith(RESERVED_ROLE_PREFIX);
}

/** Role IDs in DB_ADMIN (`role_` + name). */
export const ADMIN_ROLE_IDS = {
  SUPER_ADMIN: `role_${ADMIN_ROLES.SUPER_ADMIN}`,
  TENANT_ADMIN: `role_${ADMIN_ROLES.TENANT_ADMIN}`,
  SUPPORT: `role_${ADMIN_ROLES.SUPPORT}`,
  VIEWER: `role_${ADMIN_ROLES.VIEWER}`,
} as const;

/**
 * The combinations a decision asks for. A gate names a group, not a list of roles.
 *
 * - `platform`: a platform-wide operation (needs a global assignment; see `hasGlobalAdminRole`).
 * - `tenantAdmin`: a tenant-level change. The super admin is in it for gates that list roles
 *   outright; the role middleware lets it through anyway.
 * - `anyAdmin`: every standard role. Who may sign in to the Admin console.
 */
export const ADMIN_ROLE_GROUPS = {
  platform: [ADMIN_ROLES.SUPER_ADMIN],
  tenantAdmin: [ADMIN_ROLES.TENANT_ADMIN, ADMIN_ROLES.SUPER_ADMIN],
  anyAdmin: [
    ADMIN_ROLES.SUPER_ADMIN,
    ADMIN_ROLES.TENANT_ADMIN,
    ADMIN_ROLES.SUPPORT,
    ADMIN_ROLES.VIEWER,
  ],
} as const satisfies Record<string, readonly AdminRoleName[]>;

/** What a tenant admin may hand out to another admin: the roles below its own level. */
export const TENANT_ASSIGNABLE_ROLES = [ADMIN_ROLES.SUPPORT, ADMIN_ROLES.VIEWER] as const;

export interface AdminRoleDefinition {
  name: AdminRoleName;
  id: string;
  displayName: string;
  description: string;
  /** Delegation order: a caller can only give a role of a lower level than any of its own. */
  hierarchyLevel: number;
  permissions: readonly string[];
}

/** Read access that all of the lower roles share. */
const READ_USERS_AND_SESSIONS = [
  'admin:users:read',
  'admin:users:status:read',
  'admin:sessions:read',
  'admin:account_support_context:read',
  'admin:account_legal_holds:read',
  'admin:account_assurance:read',
] as const;

/**
 * The tenant admin holds namespaces one by one and never `admin:*`: `admin:*` is what marks a
 * platform administrator. Left out on purpose, as they take effect across tenants: the control
 * plane, database connections and routing, tenants and their domains, runtime profiles, platform
 * settings and plugins, storage destinations, backups, platform logging, the DR key bundle of SAML
 * signing keys, job schedules and the break-glass operations.
 */
const TENANT_ADMIN_PERMISSIONS = [
  // People and sessions
  'admin:users:*',
  'admin:sessions:*',
  'admin:account_support_context:*',
  'admin:account_legal_holds:*',
  'admin:account_assurance:*',
  // Apps, authorization and the tenant's settings
  'admin:clients:*',
  'admin:scopes:*',
  'admin:roles:*',
  'admin:settings:read',
  'admin:settings:write',
  'admin:policy:simulate',
  'admin:policy:rebac:write',
  'admin:flows:validate',
  'admin:flows:compile',
  'admin:flows:publish',
  'admin:security:*',
  'admin:ip_allowlist:*',
  // Connections to other systems
  'admin:external_providers:*',
  'admin:external_token_refresh:*',
  'admin:directory_auth:*',
  'admin:saml_attribute_presets:*',
  'admin:saml_providers:list',
  'admin:saml_providers:read',
  'admin:saml_providers:create',
  'admin:saml_providers:update',
  'admin:saml_providers:delete',
  'admin:saml_providers:metadata:import',
  'admin:saml_providers:metadata:refresh',
  'admin:saml_providers:signing:publish_next',
  'admin:saml_providers:signing:promote',
  'admin:saml_providers:signing:retire_backup',
  'admin:webhooks:*',
  'admin:vc:*',
  'admin:auth_config_plans:*',
  'admin:bulk_plans:*',
  'admin:machine_access:*',
  // Agents
  'admin:agent_grants:*',
  'admin:agent_settings:*',
  'admin:agent_elevation:reconcile',
  'admin:agent_task_sets:*',
  'admin:agent_scope_policies:*',
  'admin:agent_templates:publish',
  'admin:agent_baselines:*',
  // Jobs
  'admin:jobs:read',
  'admin:jobs:write',
  'admin:jobs:artifact:read',
  // Audit and logs
  'admin:audit:*',
  'admin:admin_audit:*',
  'admin:operational_logs:*',
  'admin:logging:overview:read',
  'admin:logging:delivery_events:read',
  'admin:logging:exports:create',
  'admin:logging:tenant_overrides:read',
  'admin:logging:tenant_overrides:update',
  'admin:admin_logging:overview:read',
  'admin:admin_logging:coverage:read',
  'admin:admin_logging:repair:read',
  'admin:email_deliveries:read',
  'admin:email_deliveries:recipient:masked:read',
  'admin:email_deliveries:recipient:full:read',
  // Support operations: asks (support), approves and runs (here)
  'admin:support_ops:registry:read',
  'admin:support_ops:aggregate:read',
  'admin:support_ops:cohorts:preview',
  'admin:support_ops:cohorts:create',
  'admin:support_ops:actions:request',
  'admin:support_ops:actions:read',
  'admin:support_ops:actions:approve',
  'admin:support_ops:actions:execute',
  'admin:approvals:read',
  'admin:approvals:detail:read',
  'admin:approvals:write',
  'admin:approvals:approve',
  'admin:approvals:grant:issue',
  // Admins of the tenant
  'admin:admin_users:read',
  'admin:admin_users:write',
  'admin:admin_users:delete',
  'admin:admin_roles:read',
  'admin:admin_roles:write',
  'admin:admin_roles:delete',
] as const;

const SUPPORT_PERMISSIONS = [
  ...READ_USERS_AND_SESSIONS,
  'admin:users:unlock',
  'admin:sessions:revoke',
  'admin:account_support_context:write',
  'admin:clients:read',
  'admin:audit:read',
  'admin:operational_logs:read',
  // Support operations: can ask, cannot approve or run
  'admin:support_ops:registry:read',
  'admin:support_ops:aggregate:read',
  'admin:support_ops:cohorts:preview',
  'admin:support_ops:cohorts:create',
  'admin:support_ops:actions:request',
  'admin:support_ops:actions:read',
  'admin:approvals:read',
] as const;

/** Read only. Nothing that reveals a secret: client secrets, webhook payloads, full recipients. */
const VIEWER_PERMISSIONS = [
  ...READ_USERS_AND_SESSIONS,
  'admin:clients:read',
  'admin:scopes:read',
  'admin:roles:read',
  'admin:settings:read',
  'admin:security:read',
  'admin:ip_allowlist:read',
  'admin:external_providers:read',
  'admin:external_token_refresh:read',
  'admin:directory_auth:read',
  'admin:saml_attribute_presets:read',
  'admin:saml_providers:list',
  'admin:saml_providers:read',
  'admin:webhooks:read',
  'admin:vc:credential_profiles:read',
  'admin:auth_config_plans:read',
  'admin:bulk_plans:read',
  'admin:agent_grants:read',
  'admin:agent_settings:read',
  'admin:agent_task_sets:read',
  'admin:agent_scope_policies:read',
  'admin:agent_baselines:read',
  'admin:jobs:read',
  'admin:audit:read',
  'admin:admin_audit:read',
  'admin:operational_logs:read',
  'admin:logging:overview:read',
  'admin:logging:delivery_events:read',
  'admin:admin_logging:overview:read',
  'admin:email_deliveries:read',
  'admin:email_deliveries:recipient:masked:read',
  'admin:support_ops:registry:read',
  'admin:support_ops:aggregate:read',
  'admin:support_ops:actions:read',
  'admin:approvals:read',
] as const;

export const ADMIN_ROLE_DEFINITIONS: readonly AdminRoleDefinition[] = [
  {
    name: ADMIN_ROLES.SUPER_ADMIN,
    id: ADMIN_ROLE_IDS.SUPER_ADMIN,
    displayName: 'Super Administrator',
    description: 'Every tenant and the platform: all permissions',
    hierarchyLevel: 100,
    permissions: ['*'],
  },
  {
    name: ADMIN_ROLES.TENANT_ADMIN,
    id: ADMIN_ROLE_IDS.TENANT_ADMIN,
    displayName: 'Tenant Administrator',
    description: 'One tenant: settings, apps, users, support operations, and its admins and roles',
    hierarchyLevel: 80,
    permissions: TENANT_ADMIN_PERMISSIONS,
  },
  {
    name: ADMIN_ROLES.SUPPORT,
    id: ADMIN_ROLE_IDS.SUPPORT,
    displayName: 'Support',
    description: 'Looks up users, unlocks accounts, ends sessions and asks for support operations',
    hierarchyLevel: 40,
    permissions: SUPPORT_PERMISSIONS,
  },
  {
    name: ADMIN_ROLES.VIEWER,
    id: ADMIN_ROLE_IDS.VIEWER,
    displayName: 'Viewer',
    description: 'Read-only access to the Admin console, without secrets',
    hierarchyLevel: 20,
    permissions: VIEWER_PERMISSIONS,
  },
];

/** Whether `name` is one of the standard Admin roles. */
export function isStandardAdminRole(name: string): name is AdminRoleName {
  return (Object.values(ADMIN_ROLES) as string[]).includes(name);
}
